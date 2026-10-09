'use strict';
// Ledger invariants I1–I5 (see server/ledger.js), including real multi-process concurrency and
// owner crashes. No Codex involved.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const store = require('../server/store');
const ledger = require('../server/ledger');

let k = 0;
const proj = () => store.mkdirp(path.join(H.TMP, 'ledger', `p${++k}`));
const job = (o = {}) => ({ root: H.TMP, mode: 'implement', difficulty: 'normal', task: 't', paths: [], after: [], ...o });
const LEDGER = JSON.stringify(path.join(H.ROOT, 'server', 'ledger.js'));

test('I3: dependencies gate start; failed dependency skips; unknown dependency rejected', () => {
  const pd = proj();
  const a = ledger.submit(pd, job({ mode: 'ask' }));
  const b = ledger.submit(pd, job({ mode: 'ask', after: [a.id] }));
  const c = ledger.submit(pd, job({ mode: 'ask', after: [b.id] }));
  assert.throws(() => ledger.submit(pd, job({ after: ['j999'] })), /unknown job/);
  assert.match(ledger.tryAcquire(pd, b.id, { maxParallel: 4 }).wait, /waiting for j1/);
  assert.ok(ledger.tryAcquire(pd, a.id, { maxParallel: 4 }).acquired);
  ledger.patch(pd, a.id, { status: 'answered' });
  assert.ok(ledger.tryAcquire(pd, b.id, { maxParallel: 4 }).acquired);
  ledger.patch(pd, b.id, { status: 'failed' });
  assert.match(ledger.tryAcquire(pd, c.id, { maxParallel: 4 }).skip, /ended failed/);
  assert.equal(ledger.get(pd, c.id).status, 'skipped');
});

test('an unverified dependency never unblocks downstream work', () => {
  const pd = proj();
  const a = ledger.submit(pd, job({ mode: 'implement' }));
  const b = ledger.submit(pd, job({ after: [a.id] }));
  assert.ok(ledger.tryAcquire(pd, a.id, { maxParallel: 2 }).acquired);
  ledger.patch(pd, a.id, { status: 'unverified' });
  assert.match(ledger.tryAcquire(pd, b.id, { maxParallel: 2 }).skip, /ended unverified/);
});

test('I2: global slot limit; fair share lets the earlier ready job go first', () => {
  const pd = proj();
  const a = ledger.submit(pd, job({ mode: 'ask' }));
  const b = ledger.submit(pd, job({ mode: 'ask' }));
  const c = ledger.submit(pd, job({ mode: 'ask' }));
  assert.ok(ledger.tryAcquire(pd, a.id, { maxParallel: 1 }).acquired);
  assert.match(ledger.tryAcquire(pd, b.id, { maxParallel: 1 }).wait, /slots busy/);
  ledger.patch(pd, a.id, { status: 'answered' });
  assert.match(ledger.tryAcquire(pd, c.id, { maxParallel: 1 }).wait, /fair share: j2/);
  assert.ok(ledger.tryAcquire(pd, b.id, { maxParallel: 1 }).acquired);
});

test('I1/I4: overlapping in-place writers serialise; auto isolates instead of waiting', () => {
  const pd = proj();
  const a = ledger.submit(pd, job({ paths: ['src'] }));
  const b = ledger.submit(pd, job({ paths: ['src/a.js'] }));
  const c = ledger.submit(pd, job({ paths: ['docs'] }));
  const d = ledger.submit(pd, job({ paths: ['src/b.js'] }));
  assert.equal(ledger.tryAcquire(pd, a.id, { maxParallel: 4, isolationPref: 'inplace' }).isolation, 'inplace');
  assert.match(ledger.tryAcquire(pd, b.id, { maxParallel: 4, isolationPref: 'inplace' }).wait, /paths owned/);
  assert.equal(ledger.tryAcquire(pd, c.id, { maxParallel: 4, isolationPref: 'inplace' }).isolation, 'inplace', 'disjoint paths run together');
  assert.equal(ledger.tryAcquire(pd, d.id, { maxParallel: 4, isolationPref: 'auto' }).isolation, 'worktree');
  assert.deepEqual(ledger.heldClaims(pd).map(x => x.id).sort(), [a.id, c.id], 'worktree jobs hold no claims while running');
  assert.ok(ledger.tryIntegrate(pd, d.id, ['src/b.js']).wait, 'integration waits for the in-place owner');
  ledger.patch(pd, a.id, { status: 'verified' });
  assert.ok(ledger.tryIntegrate(pd, d.id, ['src/b.js']).acquired);
  assert.deepEqual(ledger.heldClaims(pd).find(x => x.id === d.id).paths, ['src/b.js']);
  assert.ok(ledger.tryAcquire(pd, b.id, { maxParallel: 5, isolationPref: 'inplace' }).acquired, 'disjoint from the integration');
  const e = ledger.submit(pd, job({ paths: ['src/b.js'] }));
  assert.match(ledger.tryAcquire(pd, e.id, { maxParallel: 5, isolationPref: 'inplace' }).wait, /paths owned/, 'integration claim blocks writers too');
});

test('I5: dead owner or expired lease is reaped; late writes are fenced off', () => {
  const pd = proj();
  const a = ledger.submit(pd, job({ mode: 'ask' }));
  ledger.tryAcquire(pd, a.id, { maxParallel: 2 });
  const doc = JSON.parse(fs.readFileSync(ledger.file(pd), 'utf8'));
  doc.jobs[a.id].owner.hb = Date.now() - ledger.LEASE_MS - 1000;
  fs.writeFileSync(ledger.file(pd), JSON.stringify(doc));
  assert.equal(ledger.get(pd, a.id).status, 'interrupted');
  assert.equal(ledger.patch(pd, a.id, { status: 'verified' }), false, 'reaped job cannot be resurrected');
  assert.equal(ledger.get(pd, a.id).status, 'interrupted');
});

test('reaping a crashed worktree job unlinks its dependency links (the user dir survives later cleanup)', () => {
  const pd = proj();
  const target = store.mkdirp(path.join(H.TMP, 'ledger', `deps${k}`, 'm'));
  fs.writeFileSync(path.join(target, 'f.js'), 'keep');
  const wtPath = store.mkdirp(path.join(store.DATA, 'worktrees', store.projectKey(H.TMP), `jcrash${k}`));
  fs.symlinkSync(path.dirname(target), path.join(wtPath, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const a = ledger.submit(pd, job({ paths: ['x'] }));
  ledger.tryAcquire(pd, a.id, { maxParallel: 2, isolationPref: 'worktree' });
  ledger.patch(pd, a.id, { worktree: { path: wtPath, linked: ['node_modules'] } });
  const doc = JSON.parse(fs.readFileSync(ledger.file(pd), 'utf8'));
  doc.jobs[a.id].owner.hb = Date.now() - ledger.LEASE_MS - 1000;
  fs.writeFileSync(ledger.file(pd), JSON.stringify(doc));
  assert.equal(ledger.get(pd, a.id).status, 'interrupted');
  assert.ok(!fs.existsSync(path.join(wtPath, 'node_modules')), 'link removed');
  assert.ok(fs.existsSync(path.join(target, 'f.js')), 'target intact');
});

test('crash: a process that dies holding a job releases it', () => {
  const pd = proj();
  const r = spawnSync(process.execPath, ['-e', `const l=require(${LEDGER});const j=l.submit(${JSON.stringify(pd)},{root:'.',mode:'implement',paths:['x'],after:[]});l.tryAcquire(${JSON.stringify(pd)},j.id,{maxParallel:2,isolationPref:'inplace'});process.exit(0)`], { env: process.env });
  assert.equal(r.status, 0);
  assert.equal(ledger.heldClaims(pd).length, 0, 'hooks ignore claims of dead owners even before reaping');
  const j = ledger.list(pd)[0];
  assert.equal(j.status, 'interrupted');
  assert.match(j.note, /owner died/);
  const b = ledger.submit(pd, job({ paths: ['x'] }));
  assert.ok(ledger.tryAcquire(pd, b.id, { maxParallel: 2, isolationPref: 'inplace' }).acquired);
});

test('v1 jobs.json is imported once with running jobs marked interrupted', () => {
  const pd = proj();
  fs.writeFileSync(path.join(pd, 'jobs.json'), JSON.stringify({ jobs: { j3: { id: 'j3', status: 'running', pid: 1, mode: 'ask', paths: [] }, j4: { id: 'j4', status: 'verified', mode: 'implement', paths: ['a'] } } }));
  const l = ledger.list(pd);
  assert.equal(l.find(j => j.id === 'j3').status, 'interrupted');
  assert.equal(l.find(j => j.id === 'j4').status, 'verified');
  assert.equal(ledger.submit(pd, job()).id, 'j5', 'sequence continues after imported ids');
});

test('multi-process stress: 6 sessions × 6 jobs never overlap claims or exceed slots', async () => {
  const pd = proj();
  const script = `
    const l = require(${LEDGER});
    const pd = ${JSON.stringify(pd)};
    const P = ['a', 'a/x', 'b', 'c', 'a/y', 'b/z'];
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let i = 0; i < 6; i++) {
      const paths = [P[(i * 7 + process.pid) % P.length]];
      const j = l.submit(pd, { root: '.', mode: 'implement', paths, after: [] });
      let r;
      while (!(r = l.tryAcquire(pd, j.id, { maxParallel: 3, isolationPref: 'inplace' })).acquired) sleep(5 + Math.random() * 10);
      const s = Date.now();
      sleep(10 + Math.random() * 30);
      const e = Date.now();
      if (!l.patch(pd, j.id, { status: 'verified', result: { s, e } })) process.exit(2);
    }`;
  const procs = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', script], { env: process.env, stdio: 'inherit' }));
  const codes = await Promise.all(procs.map(c => new Promise(r => c.on('close', r))));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  const jobs = ledger.list(pd);
  assert.equal(jobs.length, 36);
  assert.ok(jobs.every(j => j.status === 'verified'));
  for (const a of jobs) for (const b of jobs) {
    if (a.id >= b.id) continue;
    const overlapT = a.result.s < b.result.e && b.result.s < a.result.e;
    if (overlapT) assert.ok(!ledger.anyOverlap(a.paths, b.paths), `${a.id}(${a.paths}) and ${b.id}(${b.paths}) held overlapping paths together`);
  }
  const points = jobs.flatMap(j => [[j.result.s, 1], [j.result.e, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0;
  for (const [, d] of points) { cur += d; max = Math.max(max, cur); }
  assert.ok(max <= 3, `max concurrency ${max}`);
});
