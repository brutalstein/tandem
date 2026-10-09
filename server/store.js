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
    fs.appendFileSync(f, `${new Date().toISOString()} ${where}: ${String(err && err.stack || err).split('\n').slice(0, 4).join(' | ')}\n`);
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

function renameRetry(from, to) {
  // Windows: rename fails transiently while a reader or AV scanner holds the target.
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepMs(25);
    }
  }
}

function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
  renameRetry(tmp, file);
}

// Lock file content "<pid> <time>": a lock whose owner died is broken at once; a live owner's lock
// is broken only after LOCK_STALE_MS (a hung holder), so a slow-but-alive writer is never preempted early.
function withLock(file, fn) {
  const lock = file + '.lock';
  mkdirp(path.dirname(file));
  const deadline = Date.now() + 20000;
  for (let wait = 2; ; wait = Math.min(wait * 2, 40)) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try {
        const [pid, t] = fs.readFileSync(lock, 'utf8').split(' ').map(Number);
        // Never steal a live owner's lock because a transaction ran longer than expected.
        // Fail with a timeout instead of allowing two writers into the same critical section.
        const age = Date.now() - (t || fs.statSync(lock).mtimeMs);
        if (pid && !pidAlive(pid) && age >= 1000) fs.unlinkSync(lock);
        else if (!pid && age > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      sleepMs(wait);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Read-modify-write transaction. `migrate` upgrades older document versions in place.
function update(file, fallback, mutator, migrate) {
  return withLock(file, () => {
    const value = readJson(file, typeof fallback === 'function' ? fallback() : structuredClone(fallback));
    if (migrate) migrate(value);
    const result = mutator(value);
    writeJson(file, value);
    return result;
  });
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

module.exports = { DATA, mkdirp, projectRoot, projectKey, projectDir, isGitRepo, readJson, writeJson, withLock, update, pidAlive, sleepMs, logError, sha1 };
