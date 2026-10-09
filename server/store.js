'use strict';
// Persistent state: per-project JSON files under the plugin data dir, written atomically under a lock
// so several Claude sessions (each with its own MCP server) and the hooks can share them safely.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA = process.env.TANDEM_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.tandem');

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function projectRoot(dir) {
  let d = path.resolve(dir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(dir || process.cwd());
    d = up;
  }
}

function isGitRepo(root) { return fs.existsSync(path.join(root, '.git')); }

function projectDir(root) {
  const norm = process.platform === 'win32' ? root.toLowerCase() : root;
  const key = path.basename(root).replace(/[^\w-]/g, '_').slice(0, 40) + '-' +
    crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
  return mkdirp(path.join(DATA, 'projects', key));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  // Windows: rename can fail transiently while a reader or AV scanner holds the target.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepMs(25);
    }
  }
}

function withLock(file, fn) {
  const lock = file + '.lock';
  mkdirp(path.dirname(file));
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) fs.unlinkSync(lock); } catch {}
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      sleepMs(15);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Read-modify-write under lock. The mutator edits `value` in place and may return a result.
function update(file, fallback, mutator) {
  return withLock(file, () => {
    const value = readJson(file, fallback);
    const result = mutator(value);
    writeJson(file, value);
    return result;
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { DATA, mkdirp, projectRoot, projectDir, isGitRepo, readJson, writeJson, withLock, update, pidAlive, sleepMs };
