'use strict';
// Verification: detect a project's check command, run it with a hard timeout, and fingerprint the
// files that define it so a job cannot "pass" by weakening its own test definition.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { sha1, readJson } = require('./store');
const { killTree, codexCommand } = require('./codex');

const DEFINITION_FILES = ['package.json', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py', 'Cargo.toml', 'go.mod', 'Makefile', 'jest.config.js', 'vitest.config.ts', 'vitest.config.js'];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;
const CONFTEST = /(^|\/)conftest\.py$/i;

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
    names = fs.existsSync(path.join(dir, '.git')) ? execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {
      cwd: dir, windowsHide: true, maxBuffer: 64 << 20,
    }).toString('utf8').split(String.fromCharCode(0)) : walk(dir);
  } catch (e) { return { __scan_error__: String(e.message).slice(0, 200) }; }
  for (const rel of new Set(names.filter(p => TEST_FILE.test(p) || CONFTEST.test(p)))) {
    fp[rel] = hashNoFollow(path.join(dir, rel));
  }
  return fp;
}
// Hash what is at `full` without following a link: O_NOFOLLOW where the OS has it; on Windows the
// opened handle is compared with the path's own lstat, so a link swapped in between is still reported.
function hashNoFollow(full) {
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd), l = fs.lstatSync(full);
    if (l.isSymbolicLink() || l.ino !== st.ino || l.dev !== st.dev) return 'symlink';
    return st.isFile() ? sha1(fs.readFileSync(fd)) : 'not-a-file';
  } catch (e) {
    return e.code === 'ELOOP' ? 'symlink' : e.code === 'EISDIR' ? 'not-a-file' : 'error:' + e.code;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Outside git (allow_non_git): list files without descending into links or dependency folders.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target']);
function walk(root, rel = '', out = []) {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory() && !SKIP_DIRS.has(d.name)) walk(root, p, out);
    else if (!d.isDirectory()) out.push(p);
    if (out.length > 200000) throw new Error('too many files to scan for tests');
  }
  return out;
}

// Changing or deleting an existing test weakens the check; adding a test does not, except a pytest
// conftest.py, which is auto-loaded configuration that can skip or rewrite other tests.
const testChanges = (before = {}, after = {}) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(f => Object.hasOwn(before, f) ? before[f] !== after[f] : CONFTEST.test(f));

// The check could not start because its own program is missing. That says nothing about the change,
// so it is neither routing evidence nor a reason to escalate. Only the command's first word counts: a
// missing program deeper in the test run may be the change's fault and stays an ordinary failure.
function environmentFailure(v) {
  if (v.isolation === 'unavailable') return `the check was not run because the verification sandbox is not usable: ${v.tail}. Fix the Codex sandbox (SECURITY.md), or set verify_isolation=contain (accept readable credential stores) or off (no sandbox)`;
  if (v.ok || v.timedOut) return null;
  const prog = String(v.command).trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  if (!prog) return null;
  const esc = prog.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s'"/\\\\:])${esc}(\\.exe|\\.cmd)?['"]?(: command not found|: not found| is not recognized as an internal or external command)`, 'im');
  return re.test(v.tail) ? `the check program "${prog}" is not installed or not on PATH` : null;
}

// ---- isolation: a check executes code the job wrote ----
// It runs inside the Codex OS sandbox (Seatbelt on macOS, bubblewrap/Landlock on Linux, the elevated sandbox users
// on Windows): writes confined to the workspace and temp, no network, environment reduced to the core variables,
// and these credential stores neither readable nor writable. Where a secret lives in one file, the file is denied:
// on Windows every denied folder is re-ACLed recursively on each run.
const IS_WIN = process.platform === 'win32';
const SECRET_PATHS = ['.codex/auth.json', '.claude/.credentials.json', '.ssh', '.gnupg', '.aws', '.azure', '.kube/config',
  '.docker/config.json', '.config/gh/hosts.yml', '.config/gcloud', '.git-credentials', '.netrc', '.npmrc', '.pypirc',
  '.cargo/credentials', '.cargo/credentials.toml', 'AppData/Roaming/GitHub CLI/hosts.yml'];

function denyList(extra = []) {
  const out = new Set();
  for (const p of [...SECRET_PATHS.map(s => path.join(os.homedir(), s)), ...extra]) {
    if (!path.isAbsolute(p) || !fs.existsSync(p)) continue;
    out.add(path.resolve(p));
    try { out.add(fs.realpathSync(p)); } catch {} // a linked store is denied at its target too
  }
  return [...out];
}

function sandboxArgs(cwd, command, extraDeny) {
  const deny = denyList(extraDeny).map(p => `${JSON.stringify(p.replace(/\\/g, '/'))}="deny"`);
  const a = ['sandbox', '-P', 'tandem-verify', '-C', cwd, '-c', 'permissions.tandem-verify.extends=":workspace"',
    ...(deny.length ? ['-c', `permissions.tandem-verify.filesystem={${deny.join(',')}}`] : []),
    '-c', 'shell_environment_policy.inherit=core'];
  // cmd.exe cannot parse the quoting Codex applies to arguments, so the command travels in the environment.
  return IS_WIN ? [...a, '-c', 'shell_environment_policy.set.TANDEM_VERIFY_CMD=' + JSON.stringify(command), 'cmd.exe', '/d', '/s', '/c', '%TANDEM_VERIFY_CMD%']
    : [...a, '/bin/sh', '-c', command];
}

// Is the sandbox usable, and does it really deny the credential stores? Measured, not assumed: on Windows Codex
// enforces deny rules as ACLs, and observed runs both enforced them and silently did not (an explicit allow on
// the file, an ACL lost when the file was replaced). The probe opens each denied path from inside the sandbox
// and reports only which ones opened; it reads no content. Concurrent checks share one probe: on Windows a
// changed policy makes Codex re-ACL the home folder (minutes on a large one), and a probe killed meanwhile
// leaves its setup helper running beside the next one.
const PROBE = "const fs=require('fs');const ps=JSON.parse(Buffer.from(process.argv[1],'base64').toString());"
  + "console.log('TANDEM_PROBE '+JSON.stringify(ps.filter(p=>{try{fs.statSync(p).isDirectory()?fs.readdirSync(p):fs.closeSync(fs.openSync(p,'r'));return true}catch{return false}})))";
let probe = null;
function sandboxCheck(bin, cwd, extraDeny, timeoutMs) {
  if (!bin) return Promise.resolve({ problem: 'Codex CLI not found' });
  if (probe && (!probe.at || Date.now() - probe.at < 60e3)) return probe.done;
  const deny = denyList(extraDeny);
  const cmd = `"${process.execPath}" -e "${PROBE}" ${Buffer.from(JSON.stringify(deny)).toString('base64')}`;
  const p = { at: 0 };
  p.done = new Promise(resolve => execFile(bin[0], [...bin[1], ...sandboxArgs(cwd, cmd, extraDeny)], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
    (err, out, errOut) => {
      p.at = Date.now();
      const m = /TANDEM_PROBE (\[.*\])/.exec(String(out));
      if (err || !m) {
        const why = String(errOut || '').split(/\r?\n/).filter(l => l.trim() && !/^WARNING/.test(l)).pop();
        return resolve({ problem: (err && err.killed ? `sandbox start-up exceeded ${Math.round(timeoutMs / 1000)} s` : why || String(err ? err.message : 'no probe result')).slice(0, 300) });
      }
      resolve({ problem: null, unprotected: JSON.parse(m[1]) });
    }));
  probe = p;
  return p.done;
}

// opts: config ({ verifyIsolation, verifyDenyPaths }). sandbox: the check runs only if every denied path is
// really unreadable in the sandbox. contain: also when some are readable (writes, network and environment are
// still confined). off: unsandboxed.
async function run(command, cwd, timeoutMs, opts = {}) {
  if (opts.verifyIsolation === 'off') return exec(command, cwd, timeoutMs, null);
  const bin = codexCommand();
  const s = await sandboxCheck(bin, cwd, opts.verifyDenyPaths, timeoutMs);
  const exposed = s.unprotected && s.unprotected.length ? s.unprotected : null;
  const refuse = s.problem || (exposed && opts.verifyIsolation !== 'contain'
    && `it does not deny reading ${exposed.length} credential store(s), e.g. ${exposed[0]}`);
  if (refuse) return { ok: false, code: null, timedOut: false, tail: refuse, ms: 0, command, isolation: 'unavailable' };
  const r = await exec(command, cwd, timeoutMs, [bin[0], [...bin[1], ...sandboxArgs(cwd, command, opts.verifyDenyPaths)]]);
  if (exposed) { r.isolation = 'contain'; r.readable = exposed.length; }
  return r;
}

function exec(command, cwd, timeoutMs, sandboxed) {
  return new Promise(resolve => {
    const started = Date.now();
    const opt = { cwd, windowsHide: true, detached: !IS_WIN };
    const child = sandboxed ? spawn(sandboxed[0], sandboxed[1], opt) : spawn(command, { ...opt, shell: true });
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
      // What the check left behind in its process group dies with it (POSIX; a process that left the group survives).
      if (!IS_WIN) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      resolve({ ok: code === 0 && !timedOut, code, timedOut, tail: (out + (timedOut ? '\n[tandem] verification timed out' : '')).slice(-2500).trim(), ms: Date.now() - started, command, isolation: sandboxed ? 'sandbox' : 'none' });
    };
    child.on('close', finish);
    // A test command may leave a process (dev server, watcher) holding the output pipe: don't wait for it.
    child.on('exit', code => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 1500).unref());
  });
}

const resetSandboxProbe = () => { probe = null; }; // tests switch between a working and a failing sandbox
module.exports = { environmentFailure, detect, fingerprint, definitionChanges, deletedTests, testFingerprint, testChanges, run, sandboxArgs, denyList, resetSandboxProbe, TEST_FILE };
