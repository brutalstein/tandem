'use strict';
// Isolated worktrees: snapshotting never touches user state; integration is three-way, all-or-nothing,
// race-checked and never overwrites a user edit.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const wt = require('../server/worktree');

const setup = (files, links = ['node_modules']) => {
  const root = H.repo(null, files);
  const before = { head: H.git(root, 'rev-parse', 'HEAD'), status: H.git(root, 'status', '--porcelain'), index: fs.readFileSync(path.join(root, '.git', 'index')) };
  const snap = wt.snapshot(root, links);
  const w = wt.create(root, 'j' + Math.random().toString(36).slice(2, 7), snap.commit, links);
  return { root, snap, w, before };
};
const finish = (root, w) => wt.integrate(root, w, wt.changes(w));

test('snapshot captures modified + untracked files and leaves HEAD, index and status untouched', () => {
  const root = H.repo(null, { 'a.txt': 'base\n', '.gitignore': 'ignored.log\nnode_modules/\n' });
  H.write(root, { 'a.txt': 'user edit\n', 'new.txt': 'untracked\n', 'ignored.log': 'x', 'node_modules/m/index.js': 'mod' });
  H.git(root, 'add', 'a.txt'); // staged state must survive too
  const head = H.git(root, 'rev-parse', 'HEAD'), status = H.git(root, 'status', '--porcelain');
  const index = fs.readFileSync(path.join(root, '.git', 'index'));
  const snap = wt.snapshot(root, ['node_modules']);
  assert.equal(H.git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(H.git(root, 'status', '--porcelain'), status);
  assert.ok(fs.readFileSync(path.join(root, '.git', 'index')).equals(index), 'index byte-identical');
  assert.equal(H.git(root, 'show', `${snap.commit}:a.txt`), 'user edit');
  assert.equal(H.git(root, 'show', `${snap.commit}:new.txt`), 'untracked');
  assert.throws(() => H.git(root, 'show', `${snap.commit}:ignored.log`));
  const w = wt.create(root, 'jlink', snap.commit, ['node_modules']);
  assert.equal(fs.readFileSync(path.join(w.path, 'node_modules', 'm', 'index.js'), 'utf8'), 'mod', 'dependency dir linked');
  assert.deepEqual(wt.changes(w), [], 'link is not a change');
  wt.remove(root, w);
  assert.ok(!fs.existsSync(w.path));
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'm', 'index.js')), 'removing the worktree never deletes the linked target');
});

test('integration and cleanup reject symlinks/junctions and unmanaged paths', () => {
  const root = H.repo(null, { 'a.txt': 'base\n' });
  const outside = path.join(H.TMP, 'outside-protected');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'untouched');
  fs.symlinkSync(outside, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => wt.safeTarget(root, 'alias/secret.txt'), /symlink|junction/);
  assert.throws(() => wt.safeTarget(root, '../outside-protected/secret.txt'), /escapes/);
  const attempt = wt.apply(root, [{ path: 'alias/secret.txt', ours: Buffer.from('untouched'), write: Buffer.from('broken') }]);
  assert.match(attempt.error, /symlink|junction/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'untouched');
  assert.throws(() => wt.remove(root, { path: outside, linked: [] }), /unmanaged/);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
});

test('fast-forward, add and delete land when the user did not touch those files', () => {
  const { root, w } = setup({ 'a.txt': 'a\n', 'gone.txt': 'g\n' });
  H.write(w.path, { 'a.txt': 'a2\n', 'sub/new.txt': 'n\n', 'gone.txt': null });
  const r = finish(root, w);
  assert.deepEqual(r.conflicts, []);
  assert.equal(H.read(root, 'a.txt'), 'a2\n');
  assert.equal(H.read(root, 'sub/new.txt'), 'n\n');
  assert.equal(H.read(root, 'gone.txt'), null);
});

test('concurrent user edits: non-overlapping lines merge; same lines conflict and nothing is written', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const { root, w } = setup({ 'm.txt': lines, 'other.txt': 'o\n' });
  H.write(w.path, { 'm.txt': lines.replace('line 2\n', 'job 2\n') });
  H.write(root, { 'm.txt': lines.replace('line 17\n', 'user 17\n') });
  assert.deepEqual(finish(root, w).conflicts, []);
  assert.match(H.read(root, 'm.txt'), /job 2\n[\s\S]*user 17\n/);

  const s2 = setup({ 'm.txt': lines, 'other.txt': 'o\n' });
  H.write(s2.w.path, { 'm.txt': lines.replace('line 5\n', 'job 5\n'), 'other.txt': 'job other\n' });
  H.write(s2.root, { 'm.txt': lines.replace('line 5\n', 'user 5\n') });
  const r = finish(s2.root, s2.w);
  assert.equal(r.conflicts.length, 1);
  assert.equal(H.read(s2.root, 'm.txt'), lines.replace('line 5\n', 'user 5\n'), 'user edit kept');
  assert.equal(H.read(s2.root, 'other.txt'), 'o\n', 'all-or-nothing: no partial integration');
});

test('delete/modify and binary changes on both sides are conflicts', () => {
  const { root, w } = setup({ 'd.txt': 'd\n', 'b.bin': Buffer.from([0, 1, 2, 3]) });
  H.write(w.path, { 'd.txt': null, 'b.bin': Buffer.from([0, 9, 9]) });
  H.write(root, { 'd.txt': 'user changed\n', 'b.bin': Buffer.from([0, 7]) });
  const r = finish(root, w);
  assert.deepEqual(r.conflicts.map(c => c.path).sort(), ['b.bin', 'd.txt']);
  assert.equal(H.read(root, 'd.txt'), 'user changed\n');
});

test('race: a user edit between plan and apply aborts and rolls back earlier writes', () => {
  const { root, w } = setup({ 'a.txt': 'a\n', 'z.txt': 'z\n' });
  H.write(w.path, { 'a.txt': 'job a\n', 'z.txt': 'job z\n' });
  const p = wt.plan(root, w, wt.changes(w));
  assert.equal(p.actions.length, 2);
  H.write(root, { 'z.txt': 'user z\n' }); // after planning
  const r = wt.apply(root, p.actions);
  assert.match(r.error, /z.txt changed during integration/);
  assert.equal(H.read(root, 'a.txt'), 'a\n', 'rolled back');
  assert.equal(H.read(root, 'z.txt'), 'user z\n', 'user edit untouched');
});

test('revert restores only files that still hold what integration wrote', () => {
  const { root, w } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  H.write(w.path, { 'a.txt': 'job a\n', 'b.txt': 'job b\n' });
  const p = wt.plan(root, w, wt.changes(w));
  wt.apply(root, p.actions);
  H.write(root, { 'b.txt': 'user after\n' });
  assert.deepEqual(wt.revert(root, p.actions), ['a.txt']);
  assert.equal(H.read(root, 'a.txt'), 'a\n');
  assert.equal(H.read(root, 'b.txt'), 'user after\n');
});

test('line-ending filters: CRLF checkouts integrate as fast-forward, not as conflicts', () => {
  const root = H.repo(null, { '.gitattributes': '*.txt text eol=crlf\n', 'c.txt': 'one\ntwo\n' });
  fs.rmSync(path.join(root, 'c.txt'));
  H.git(root, 'checkout', '--', 'c.txt');
  assert.equal(H.read(root, 'c.txt'), 'one\r\ntwo\r\n');
  const snap = wt.snapshot(root, []);
  const w = wt.create(root, 'jcrlf', snap.commit, []);
  H.write(w.path, { 'c.txt': 'one\r\nTWO\r\n' });
  const r = finish(root, w);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.applied[0].how, 'fast-forward');
  assert.equal(H.read(root, 'c.txt'), 'one\r\nTWO\r\n');
});

test('drifted detects user changes since the snapshot', () => {
  const { root, snap } = setup({ 'a.txt': 'a\n' });
  assert.equal(wt.drifted(root, snap.tree, ['node_modules']), false);
  H.write(root, { 'a.txt': 'changed\n' });
  assert.equal(wt.drifted(root, snap.tree, ['node_modules']), true);
});

test('autocrlf: an LF file the user never re-checked-out integrates cleanly and keeps LF', () => {
  const root = H.repo(null, { 'lib/c.js': 'a\nb\nc\n' });
  H.git(root, 'config', 'core.autocrlf', 'true'); // the common Windows setting; also converts on Linux
  assert.equal(H.read(root, 'lib/c.js'), 'a\nb\nc\n', 'working file still LF');
  const snap = wt.snapshot(root, []);
  const w = wt.create(root, 'jauto', snap.commit, []);
  assert.equal(H.read(w.path, 'lib/c.js'), 'a\r\nb\r\nc\r\n', 'worktree checkout uses CRLF');
  H.write(w.path, { 'lib/c.js': 'a\r\nB\r\nc\r\n' });
  const r = finish(root, w);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.applied[0].how, 'fast-forward');
  assert.equal(H.read(root, 'lib/c.js'), 'a\nB\nc\n', 'user EOL style preserved');
  // a concurrent user edit elsewhere in the file still merges
  const s2 = wt.snapshot(root, []);
  const w2 = wt.create(root, 'jauto2', s2.commit, []);
  H.write(w2.path, { 'lib/c.js': 'a\r\nB\r\nC\r\n' });
  H.write(root, { 'lib/c.js': 'A\nB\nc\n' });
  const r2 = finish(root, w2);
  assert.deepEqual(r2.conflicts, []);
  assert.equal(H.read(root, 'lib/c.js'), 'A\nB\nC\n');
});

test('a worktree that outlives its job holds no dependency link, so `git worktree remove --force` is safe', () => {
  const root = H.repo(null, { 'a.txt': 'a\n', '.gitignore': 'node_modules/\n' });
  H.write(root, { 'node_modules/m/index.js': 'mod' });
  const w = wt.create(root, 'jkeep', wt.snapshot(root, ['node_modules']).commit, ['node_modules']);
  assert.ok(fs.lstatSync(path.join(w.path, 'node_modules')).isSymbolicLink());
  wt.unlinkLinks(w);
  assert.ok(!fs.existsSync(path.join(w.path, 'node_modules')), 'link gone');
  H.git(root, 'worktree', 'remove', '--force', w.path); // what a user would run (follows junctions on Windows)
  assert.equal(H.read(root, 'node_modules/m/index.js'), 'mod', 'user dependencies intact');
});

test('create never reuses or deletes an existing directory: a reused job id gets a fresh worktree', () => {
  const root = H.repo(null, { 'a.txt': 'a\n' });
  const snap = wt.snapshot(root, []);
  const one = wt.create(root, 'jdup', snap.commit, []);
  H.write(one.path, { 'kept.txt': 'interrupted work' });
  const two = wt.create(root, 'jdup', snap.commit, []); // e.g. job ids restarted after the ledger was lost
  assert.notEqual(two.path, one.path);
  assert.equal(H.read(one.path, 'kept.txt'), 'interrupted work');
  assert.doesNotThrow(() => wt.assertManaged(root, two.path));
  wt.remove(root, one); wt.remove(root, two);
});

test('Windows: replacing a file another program holds open without delete sharing waits, then lands', { skip: process.platform !== 'win32' }, async () => {
  const root = H.repo(null, { 'a.txt': 'base\n' });
  const file = path.join(root, 'a.txt');
  // FileShare ReadWrite (no Delete), as many editors, indexers and sync clients open files.
  const ps = require('child_process').spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','Read','ReadWrite'); 'held'; Start-Sleep -Milliseconds 500; $f.Close()`]);
  await new Promise((resolve, reject) => { ps.stdout.once('data', resolve); ps.once('error', reject); });
  const t0 = Date.now();
  const res = wt.apply(root, [{ path: 'a.txt', ours: Buffer.from('base\n'), write: Buffer.from('new\n'), how: 'fast-forward' }]);
  const waited = Date.now() - t0;
  await new Promise(r => ps.once('close', r));
  assert.equal(res.error, undefined);
  assert.equal(H.read(root, 'a.txt'), 'new\n');
  assert.ok(waited >= 100, `contended for ${waited} ms`);
  assert.deepEqual(fs.readdirSync(root).filter(n => n.endsWith('.tmp')), [], 'no temporary file left');
});

test('journal recovery undoes a partial multi-file integration and never clobbers a later user edit', () => {
  const root = H.repo(null, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
  const act = (p, ours, write) => ({ path: p, ours: Buffer.from(ours), write: Buffer.from(write), how: 'fast-forward' });
  const actions = [act('a.txt', 'a0\n', 'a1\n'), act('b.txt', 'b0\n', 'b1\n'), act('c.txt', 'c0\n', 'c1\n')];
  const jf = path.join(H.TMP, 'journal-test', 'j1.json');
  wt.journal(jf, root, '/kept/worktree', actions);
  wt.apply(root, actions.slice(0, 2)); // the owner died after two of three writes...
  fs.writeFileSync(path.join(root, 'c.txt.tandem-0123456789abcdef.tmp'), 'c1\n'); // ...while replacing the third
  H.write(root, { 'b.txt': 'user edit after the crash\n' });
  const r = wt.recover(jf);
  assert.deepEqual(r.restored, ['a.txt']);
  assert.deepEqual(r.changedSince, ['b.txt']);
  assert.deepEqual([H.read(root, 'a.txt'), H.read(root, 'b.txt'), H.read(root, 'c.txt')], ['a0\n', 'user edit after the crash\n', 'c0\n']);
  assert.deepEqual(fs.readdirSync(root).filter(n => n.endsWith('.tmp')), []);
  assert.ok(!fs.existsSync(jf));
  assert.equal(wt.recover(jf), null, 'idempotent');
});
