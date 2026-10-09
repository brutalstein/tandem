'use strict';
// Verification: detect a project's check command, run it with a hard timeout, and fingerprint the
// files that define it so a job cannot "pass" by weakening its own test definition.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { sha1, readJson } = require('./store');
const { killTree } = require('./codex');

const DEFINITION_FILES = ['package.json', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py', 'Cargo.toml', 'go.mod', 'Makefile', 'jest.config.js', 'vitest.config.ts', 'vitest.config.js'];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;

function detect(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    const t = ((readJson(path.join(dir, 'package.json'), {}) || {}).scripts || {}).test;
    if (t && !/no test specified/.test(t)) return 'npm test --silent';
  }
  if (has('pytest.ini') || (has('pyproject.toml') && /pytest/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')))) return 'python -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test -q';
  if (has('go.mod')) return 'go test ./...';
  return null;
}

// package.json contributes only its `scripts` (dependency bumps are not a verification change).
function fingerprint(dir) {
  const fp = {};
  for (const f of DEFINITION_FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    fp[f] = f === 'package.json' ? sha1(JSON.stringify((readJson(p, {}) || {}).scripts || {})) : sha1(fs.readFileSync(p));
  }
  return fp;
}

function definitionChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => before[f] !== after[f]);
}

const deletedTests = changes => changes.filter(c => c.status === 'D' && TEST_FILE.test(c.path)).map(c => c.path);

// Include tracked AND untracked test files. Existing dirty tests are hashed before and
// after execution, so modifying an already-dirty test also invalidates verification.
function testFingerprint(dir) {
  const fp = {};
  let names;
  try {
    names = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {
      cwd: dir, windowsHide: true, maxBuffer: 64 << 20,
    }).toString('utf8').split('\\0');
  } catch (e) { return { __scan_error__: String(e.message).slice(0, 200) }; }
  for (const rel of new Set(names.filter(p => TEST_FILE.test(p.replace(/\\\\/g, '/'))))) {
    const full = path.join(dir, rel);
    try {
      const st = fs.lstatSync(full);
      fp[rel] = st.isSymbolicLink() ? 'symlink' : st.isFile() ? sha1(fs.readFileSync(full)) : 'not-a-file';
    } catch (e) { fp[rel] = 'error:' + e.code; }
  }
  return fp;
}
const testChanges = (before, after) =>
  [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(f => (before || {})[f] !== (after || {})[f]);

function run(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let out = '', timedOut = false;
    const keep = d => { out = (out + d).slice(-8000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', e => { out += String(e.message); });
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, tail: (out + (timedOut ? '\n[tandem] verification timed out' : '')).slice(-2500).trim(), ms: Date.now() - started, command });
    };
    child.on('close', finish);
    // A test command may leave a process (dev server, watcher) holding the output pipe: don't wait for it.
    child.on('exit', code => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 1500).unref());
  });
}

module.exports = { detect, fingerprint, definitionChanges, deletedTests, testFingerprint, testChanges, run, TEST_FILE };
