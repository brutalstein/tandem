'use strict';
// Persistent state. Every shared file is a versioned JSON document, mutated only inside update(),
// which holds a cross-process lock file, writes atomically (tmp + rename) and keeps the previous
// good copy as <file>.bak so a torn or corrupted write is recoverable.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA = process.env.TANDEM_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.tandem');
const LOCK_STALE_MS = 30000;

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function projectRoot(dir) {
  const start = path.resolve(dir || process.cwd());
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return start;
  }
}

function isGitRepo(root) { return fs.existsSync(path.join(root, '.git')); }

function projectKey(root) {
  const norm = process.platform === 'win32' ? root.toLowerCase() : root;
  return path.basename(root).replace(/[^\w-]/g, '_').slice(0, 40) + '-' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

function projectDir(root) { return mkdirp(path.join(DATA, 'projects', projectKey(root))); }

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function logError(where, err) {
  try {
    const f = path.join(mkdirp(DATA), 'errors.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.1');
    const raw = String(err && err.stack || err).split('\n').slice(0, 4).join(' | ');
    const safe = require('./security').redactSecrets(raw).text;
    fs.appendFileSync(f, `${new Date().toISOString()} ${where}: ${safe}\n`);
  } catch {}
}

function parseFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// Missing file -> fallback. Corrupted file -> last good .bak (logged) -> fallback.
function readJson(file, fallback) {
  try { return parseFile(file); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    try { const v = parseFile(file + '.bak'); logError('readJson', `recovered ${file} from .bak (${e.message})`); return v; } catch {}
    logError('readJson', `unreadable ${file}: ${e.message}`);
    return fallback;
  }
}

// Windows: rename and delete fail transiently while a reader, editor, indexer or AV scanner holds the file.
function retryBusy(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepMs(25);
    }
  }
}
const renameRetry = (from, to) => retryBusy(() => fs.renameSync(from, to));

function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
  renameRetry(tmp, file);
}

// Lock file content "<pid> <time> <token>". A lock is stale when its owner is dead or it is older
// than LOCK_STALE_MS. The age bound is what keeps a reused PID (a dead owner's PID now held by an
// unrelated live process) from blocking every writer forever. Transactions take milliseconds, so a
// live owner only crosses it when suspended; it then loses the lock, and the fence in update()
// makes its late commit fail instead of overwriting the new owner's state.
function holdsLock(lock, token) {
  try { return fs.readFileSync(lock, 'utf8').split(' ')[2] === token; } catch { return false; }
}

// Break a stale lock without check-then-act races: move it aside, and if what was moved is not the
// lock that was judged stale (another waiter broke it and a new owner took it meanwhile), put it back.
function breakLock(lock, seen) {
  const tomb = `${lock}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.stale`;
  try { fs.renameSync(lock, tomb); } catch { return; }
  try {
    if (fs.readFileSync(tomb, 'utf8') !== seen) { try { fs.linkSync(tomb, lock); } catch {} }
  } finally { try { fs.unlinkSync(tomb); } catch {} }
}

function withLock(file, fn) {
  const lock = file + '.lock';
  mkdirp(path.dirname(file));
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + 20000;
  for (let wait = 2; ; wait = Math.min(wait * 2, 40)) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()} ${token}`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try {
        const seen = fs.readFileSync(lock, 'utf8');
        const [pid, t] = seen.split(' ').map(Number);
        const age = Date.now() - (t || fs.statSync(lock).mtimeMs);
        if ((pid && !pidAlive(pid)) || age > LOCK_STALE_MS) breakLock(lock, seen);
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      sleepMs(wait);
    }
  }
  // Release only our own lock: after a stall it may belong to someone else.
  try { return fn(() => holdsLock(lock, token)); } finally { if (holdsLock(lock, token)) try { fs.unlinkSync(lock); } catch {} }
}

// Read-modify-write transaction. `migrate` upgrades older document versions in place. A transaction
// that lost its lock is discarded and re-run on fresh state, so mutators must not have side effects
// beyond the document other than idempotent ones.
function update(file, fallback, mutator, migrate) {
  for (let attempt = 1; ; attempt++) {
    try {
      return withLock(file, held => {
        const value = readJson(file, typeof fallback === 'function' ? fallback() : structuredClone(fallback));
        if (migrate) migrate(value);
        const result = mutator(value);
        // Fence: never commit after losing the lock. shortcut: a stall between this check and the
        // rename can still lose an update; closing that needs OS-level locks Node does not expose.
        if (!held()) throw Object.assign(new Error(`lock lost before commit: ${file}.lock (transaction discarded)`), { code: 'ELOCKLOST' });
        writeJson(file, value);
        return result;
      });
    } catch (e) { if (e.code !== 'ELOCKLOST' || attempt >= 5) throw e; }
  }
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

module.exports = { DATA, mkdirp, projectRoot, projectKey, projectDir, isGitRepo, readJson, writeJson, withLock, update, pidAlive, sleepMs, retryBusy, renameRetry, logError, sha1 };
