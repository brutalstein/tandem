'use strict';
// Isolated execution in a git worktree, and safe integration of its result.
//
// snapshot(): records the user's *current* working state (tracked + untracked, .gitignore respected)
//   as a dangling commit using a temporary index — the user's index, HEAD, branches and files are
//   never touched.
// create():   checks the snapshot out in a detached worktree under the plugin data dir and links
//   dependency folders (node_modules, .venv …) so verification can run there.
// integrate(): per changed file, three-way: base = snapshot, ours = current user file,
//   theirs = worktree result.  ours == base → take theirs;  ours == theirs → nothing to do;
//   both changed text → `git merge-file`; otherwise conflict. All-or-nothing: if any file
//   conflicts nothing is written; every write is re-checked against the planned "ours" right
//   before it happens and rolled back if the user changed the file in the meantime.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { DATA, mkdirp, projectKey } = require('./store');

// Refuse path traversal and symlink/junction traversal, including in existing parents.
// Lexical confinement alone is insufficient: fs.readFileSync/writeFileSync follow links.
// This is defense-in-depth against accidental and model-created links, not an OS sandbox.
function safeTarget(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes(String.fromCharCode(0)) || path.isAbsolute(relative))
    throw new Error('invalid integration path');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw new Error('integration path escapes repository');
  let cur = resolvedRoot;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let stat;
    try { stat = fs.lstatSync(cur); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink()) throw new Error('symlink or junction in integration path: ' + relative);
    if (cur === target && stat.isDirectory()) throw new Error('integration target is a directory: ' + relative);
  }
  return target;
}

// Only remove worktrees directly managed by Tandem for this exact repository.
function assertManaged(root, wtPath) {
  const parent = path.resolve(DATA, 'worktrees', projectKey(root));
  const rel = path.relative(parent, path.resolve(wtPath));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || rel.includes(path.sep))
    throw new Error('refusing to remove an unmanaged worktree');
  try { if (fs.lstatSync(wtPath).isSymbolicLink()) throw new Error('refusing to remove a symlinked worktree'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return path.resolve(wtPath);
}

const GIT_ID = { GIT_AUTHOR_NAME: 'tandem', GIT_AUTHOR_EMAIL: 'tandem@localhost', GIT_COMMITTER_NAME: 'tandem', GIT_COMMITTER_EMAIL: 'tandem@localhost' };

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, windowsHide: true, maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'pipe'], ...opts, env: { ...process.env, ...GIT_ID, ...(opts.env || {}) } });
}
const gitText = (cwd, args, opts) => git(cwd, args, opts).toString().trim();

function hasHead(root) { try { gitText(root, ['rev-parse', '--verify', 'HEAD']); return true; } catch { return false; } }

// Exclude linked dependency dirs from snapshots/diffs. Naming an already-ignored path in a pathspec
// makes `git add` fail, so only existing, non-ignored links get an explicit exclude.
const excludes = (cwd, links) => links.filter(l => fs.existsSync(path.join(cwd, l)) &&
  spawnSync('git', ['check-ignore', '-q', '--', l], { cwd, windowsHide: true }).status !== 0).map(l => `:(exclude)${l}`);

function snapshot(root, links = []) {
  const tmpIndex = path.join(os.tmpdir(), `tandem-idx-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const gitDir = gitText(root, ['rev-parse', '--git-dir']);
  const realIndex = path.resolve(root, gitDir, 'index');
  try {
    // Start from a copy of the real index so unchanged files keep their stat cache (no re-hashing).
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(root, ['add', '-A', '--', '.', ...excludes(root, links)], { env });
    const tree = gitText(root, ['write-tree'], { env });
    const parents = hasHead(root) ? ['-p', 'HEAD'] : [];
    const commit = gitText(root, ['commit-tree', tree, ...parents, '-m', 'tandem snapshot'], { env });
    return { commit, tree };
  } finally { try { fs.unlinkSync(tmpIndex); } catch {} }
}

function create(root, jobId, base, links = []) {
  const dir = path.join(mkdirp(path.join(DATA, 'worktrees', projectKey(root))), jobId);
  if (fs.existsSync(dir)) throw new Error('worktree already exists; refusing to discard interrupted work: ' + dir);
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, base]);
  const linked = [];
  for (const l of links) {
    const src = path.join(root, l), dst = path.join(dir, l);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(l);
    }
  }
  return { path: dir, base, linked };
}

// Files changed in the worktree relative to base: [{ path, status: 'A'|'M'|'D' }].
// Renames are reported as delete + add so each path is integrated independently.
function changes(wt) {
  git(wt.path, ['add', '-A', '--', '.', ...excludes(wt.path, wt.linked || [])]);
  const out = git(wt.path, ['diff', '--cached', '--name-status', '--no-renames', '-z', wt.base]).toString();
  const parts = out.split('\0').filter(Boolean);
  const res = [];
  for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i][0], path: parts[i + 1] });
  return res;
}

function read(file) { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
const isText = b => b === null || !b.subarray(0, 8000).includes(0);
// Line endings: with core.autocrlf / eol attributes the working-tree bytes of an unchanged file can
// differ from git's filtered form (e.g. a tool wrote LF, checkout would write CRLF). Compare text
// EOL-normalised, and write results in the user's existing EOL style.
const lf = b => (b && isText(b) ? Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : b);
const crlf = b => Buffer.from(b.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
const inStyleOf = (content, ours) => (content === null || ours === null || !isText(content) || !isText(ours) ? content
  : ours.includes('\r\n') ? crlf(lf(content)) : lf(content));

// Base content in working-tree form (eol/smudge filters applied), or null if absent in base.
function baseContent(root, base, p) {
  const r = spawnSync('git', ['cat-file', '--filters', `${base}:${p}`], { cwd: root, windowsHide: true, maxBuffer: 256 << 20 });
  return r.status === 0 ? r.stdout : null;
}

function mergeText(root, ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-merge-'));
  try {
    const f = n => path.join(dir, n);
    fs.writeFileSync(f('ours'), ours); fs.writeFileSync(f('base'), base); fs.writeFileSync(f('theirs'), theirs);
    const r = spawnSync('git', ['merge-file', '-p', f('ours'), f('base'), f('theirs')], { cwd: root, windowsHide: true, maxBuffer: 256 << 20 });
    return r.status === 0 ? r.stdout : null; // >0 = conflicts, <0 = error
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Plan the integration without writing anything.
function plan(root, wt, changed) {
  const actions = [], conflicts = [];
  for (const c of changed) {
    let dst;
    try {
      dst = safeTarget(root, c.path);
      if (c.status !== 'D') safeTarget(wt.path, c.path);
    } catch (e) {
      conflicts.push({ path: c.path, reason: 'unsafe integration path: ' + e.message });
      continue;
    }
    const base = baseContent(root, wt.base, c.path);
    const ours = read(dst);
    const theirs = c.status === 'D' ? null : read(path.join(wt.path, c.path));
    if (same(lf(ours), lf(theirs))) continue;
    if (same(lf(ours), lf(base))) { actions.push({ path: c.path, ours, write: inStyleOf(theirs, ours), how: 'fast-forward' }); continue; }
    if (ours !== null && base !== null && theirs !== null && isText(ours) && isText(base) && isText(theirs)) {
      const merged = mergeText(root, lf(ours), lf(base), lf(theirs));
      if (merged) { actions.push({ path: c.path, ours, write: inStyleOf(merged, ours), how: 'merged' }); continue; }
      conflicts.push({ path: c.path, reason: 'both changed the same lines' });
    } else conflicts.push({ path: c.path, reason: ours === null ? 'you deleted a file the job changed' : theirs === null ? 'the job deleted a file you changed' : 'binary or added on both sides' });
  }
  return { actions, conflicts };
}

// Atomic per-file replacement prevents truncated files on a write failure. It is not
// a multi-file transaction: abrupt process death may still leave a partial merge.
function atomicReplace(root, relative, content, expected) {
  const dst = safeTarget(root, relative);
  if (!same(read(dst), expected)) throw new Error(relative + ' changed during integration');
  if (content === null) { fs.rmSync(dst, { force: true }); return; }
  mkdirp(path.dirname(dst));
  safeTarget(root, relative); // reject parents that became links while making directories
  const tmp = dst + '.tandem-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    // Check again after preparing the replacement; rename replaces a leaf symlink,
    // rather than following it. Parent-directory races remain an OS-level limitation.
    safeTarget(root, relative);
    if (!same(read(dst), expected)) throw new Error(relative + ' changed during integration');
    try {
      const st = fs.statSync(dst);
      if (st.isFile()) fs.chmodSync(tmp, st.mode);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.renameSync(tmp, dst);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function apply(root, actions) {
  const done = [];
  try {
    for (const a of actions) {
      atomicReplace(root, a.path, a.write, a.ours);
      done.push(a);
    }
    return { applied: done.map(a => ({ path: a.path, how: a.how })) };
  } catch (e) {
    // Roll back only files that still hold exactly what we wrote; never clobber a newer user edit.
    return { applied: [], error: e.message, rolledBack: revert(root, done) };
  }
}

// Undo applied actions where the file still holds exactly what we wrote. Returns paths restored.
function revert(root, actions) {
  const restored = [];
  for (const a of [...actions].reverse()) {
    try {
      const dst = safeTarget(root, a.path);
      if (!same(read(dst), a.write)) continue;
      atomicReplace(root, a.path, a.ours, a.write);
      restored.push(a.path);
    } catch { /* Never overwrite unexpected changes or links during recovery. */ }
  }
  return restored;
}

function integrate(root, wt, changed) {
  const p = plan(root, wt, changed);
  if (p.conflicts.length) return { applied: [], conflicts: p.conflicts };
  return { ...apply(root, p.actions), conflicts: [] };
}

// Unlink dependency links. Anything that deletes recursively through them would delete the user's real
// folder — `git worktree remove --force` follows Windows junctions. Called before removal and whenever a
// worktree outlives its job (kept on conflict, owner crashed), so a user's own cleanup is safe too.
function unlinkLinks(wt) {
  for (const l of wt.linked || []) {
    const p = path.join(wt.path, l);
    try { if (!fs.lstatSync(p).isSymbolicLink()) continue; } catch { continue; }
    try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  }
}

function remove(root, wt) {
  assertManaged(root, wt.path);
  unlinkLinks(wt);
  fs.rmSync(wt.path, { recursive: true, force: true }); // Node's rm never follows links (git's removal does)
  try { git(root, ['worktree', 'prune']); } catch {}
}

// Has the user's working state moved since `tree` was snapshotted?
function drifted(root, tree, links) { try { return snapshot(root, links).tree !== tree; } catch { return true; } }

module.exports = { snapshot, create, changes, plan, apply, revert, integrate, remove, unlinkLinks, drifted, hasHead, safeTarget, assertManaged };
