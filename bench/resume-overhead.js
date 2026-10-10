#!/usr/bin/env node
'use strict';
// Checkpoint and resume overhead against the simulated Codex CLI (no provider access needed).
//   node bench/resume-overhead.js [n=10] [--out file.json]
// suspend:  provider process started -> job durably suspended after a usage limit mid-turn (the fake fails at
//           once, so this is Tandem's checkpoint: partial work kept in the worktree, resume state written).
// resume:   resume() -> provider process started, vs submit() -> provider process started.
const fs = require('fs');
const path = require('path');
const H = require('../test/helpers');
const store = require('../server/store');
const { Orchestrator } = require('../server/jobs');

const N = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const summ = xs => ({ n: xs.length, p50: +q(xs, 0.5).toFixed(1), p95: +q(xs, 0.95).toFixed(1) });
const spec = dir => ({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: 'none', isolation: 'worktree' });

(async () => {
  const o = new Orchestrator({ ...H.CFG, maxParallel: 1 });
  const m = { spawnToSuspendedMs: [], submitToSpawnMs: [], resumeToSpawnMs: [], resumeStateBytes: [] };
  for (let i = 0; i < N + 2; i++) { // the first two runs warm caches and are dropped
    const keep = i >= 2;
    H.resetEnv();
    const s = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half' }] }, { 'a.txt': 'old' });
    let t = Date.now();
    const j = await o.submit(spec(s)).promise;
    if (j.status !== 'suspended') throw new Error(`expected suspended, got ${j.status}`);
    if (keep) {
      m.spawnToSuspendedMs.push(Date.now() - H.calls(s)[0].t);
      m.submitToSpawnMs.push(H.calls(s)[0].t - t);
      m.resumeStateBytes.push(fs.statSync(path.join(store.projectDir(s), 'resume', j.id + '.json')).size);
    }
    fs.writeFileSync(path.join(s, '.fake-scenario.json'), JSON.stringify({ default: { action: 'ok' } }));
    H.resetEnv();
    t = Date.now();
    const r = await o.resume(j.id, s, { now: true }).promise;
    if (r.status === 'suspended' || r.status === 'failed') throw new Error(`resume ended ${r.status}`);
    if (keep) m.resumeToSpawnMs.push(H.calls(s).at(-1).t - t);
  }
  const out = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, summ(v)]));
  out.resumeExtraToSpawnMsP50 = +(out.resumeToSpawnMs.p50 - out.submitToSpawnMs.p50).toFixed(1);
  out.platform = `${process.platform} node ${process.version}`;
  console.log(out);
  const i = process.argv.indexOf('--out');
  if (i > 0) { fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true }); fs.writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 2)); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
