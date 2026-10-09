#!/usr/bin/env node
'use strict';
// Local cost of Tandem's per-job safety work, for one server version, on a generated repository.
// No provider is called. Compare versions by pointing --server at another checkout's server/ dir:
//   node bench/safety-overhead.js --server ../other/server --files 20000 --out out.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SERVER = path.resolve(arg('--server', path.join(__dirname, '..', 'server')));
const FILES = Number(arg('--files', 200));
const REPS = Number(arg('--reps', 5));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-safety-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');

const store = require(path.join(SERVER, 'store.js'));
const wt = require(path.join(SERVER, 'worktree.js'));
const verify = require(path.join(SERVER, 'verify.js'));
const jobs = require(path.join(SERVER, 'jobs.js'));
const ledger = require(path.join(SERVER, 'ledger.js'));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function repo() {
  const dir = path.join(TMP, 'repo');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
  // 10 % of files are tests; 2 KB each; plus an ignored dependency folder.
  for (let i = 0; i < FILES; i++) {
    const p = path.join(dir, `src/m${i % 50}`, i % 10 === 0 ? `f${i}.test.js` : `f${i}.js`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `// file ${i}\n` + 'x'.repeat(2000) + '\n');
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=b', '-c', 'user.email=b@b', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'src', 'm0', 'f1.js'), 'user edit\n'); // a dirty file
  return dir;
}

function time(fn, reps = REPS) {
  const ms = [];
  for (let i = 0; i < reps; i++) { const t = process.hrtime.bigint(); fn(i); ms.push(Number(process.hrtime.bigint() - t) / 1e6); }
  ms.sort((a, b) => a - b);
  return { median: +ms[Math.floor(ms.length / 2)].toFixed(1), min: +ms[0].toFixed(1), max: +ms.at(-1).toFixed(1) };
}

const root = repo();
const projDir = store.projectDir(root);
const r = { server: path.relative(process.cwd(), SERVER) || '.', files: FILES, reps: REPS, platform: `${process.platform} ${os.release()}`, node: process.version, ms: {} };

r.ms.gitStatus = time(() => jobs.gitDirty(root));
r.ms.snapshot = time(() => wt.snapshot(root, []));
if (verify.testFingerprint) r.ms.testFingerprint = time(() => verify.testFingerprint(root));
r.ms.worktreeCreateRemove = time(i => {
  const snap = wt.snapshot(root, ['node_modules']);
  const w = wt.create(root, `jb${i}`, snap.commit, ['node_modules']);
  wt.remove(root, w);
});
// Integration of 20 changed files: plan (three-way inputs) and apply (journaled where supported), timed
// apart from the worktree setup around them.
const plans = [], applies = [];
for (let i = 0; i < REPS; i++) {
  const w = wt.create(root, `ji${i}`, wt.snapshot(root, ['node_modules']).commit, ['node_modules']);
  for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(w.path, `src/m${k}`, `f${k + 50}.js`), `changed ${i}
`);
  const changed = wt.changes(w);
  let p;
  plans.push(time(() => { p = wt.plan(root, w, changed); }, 1).median);
  const jf = path.join(projDir, 'integrations', 'jb.json');
  applies.push(time(() => {
    if (wt.journal) wt.journal(jf, root, w.path, p.actions);
    const a = wt.apply(root, p.actions);
    if (wt.journal) fs.rmSync(jf, { force: true });
    if (a.error) throw new Error(a.error);
  }, 1).median);
  wt.remove(root, w);
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
r.ms.plan20 = { median: med(plans) };
r.ms.apply20 = { median: med(applies) };
r.ms.ledgerTxn = time(() => ledger.list(projDir), 50);
if (ledger.concurrentWrites) r.ms.concurrentWrites = time(() => ledger.concurrentWrites(projDir, 'j1'), 50);

fs.rmSync(TMP, { recursive: true, force: true });
const out = arg('--out');
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(r, null, 2)); }
console.log(JSON.stringify(r));
