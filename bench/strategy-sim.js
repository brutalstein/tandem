#!/usr/bin/env node
'use strict';
// Sensitivity study of the whole-strategy decision (server/strategy.js) against simple policies. SYNTHETIC: the
// "true" costs below are drawn from distributions chosen independently of strategy.js's assumptions (wider, and
// shifted in some scenarios), so the study shows how the decision degrades when its assumptions are wrong. It is
// not evidence of real-world savings; that needs the real benchmark (bench/bench.js) with an approved budget.
//   node bench/strategy-sim.js [--tasks 2000] [--seed 1] [--out artifacts/strategy-sim.json]
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../server/strategy');
const { rngFrom } = require('../server/policy');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--tasks', 2000)), SEED = Number(arg('--seed', 1)), OUT = arg('--out', null);
const rng = rngFrom(SEED);
const logn = (median, spread) => median * Math.exp(spread * Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng()));

// One fixture directory per size bucket: the decision measures real files.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ssim-'));
const SIZES = [500, 2000, 8000, 30000, 100000]; // tokens of scoped code
for (const t of SIZES) { fs.mkdirSync(path.join(root, 's' + t)); for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, 's' + t, `f${i}.js`), 'x'.repeat(t)); } // 4 files × t bytes = t tokens

// Scenarios: how wrong strategy.js's Claude-side assumptions are. `turn` = true cost per Claude turn, `carry` =
// true later-turn re-send factor, `codexBias` = true Codex cost relative to the policy's estimate.
const SCENARIOS = {
  'assumptions hold': { turn: 2500, carry: 1.2, codexBias: 1 },
  'Claude cheaper than assumed': { turn: 800, carry: 0.3, codexBias: 1 },
  'Claude dearer than assumed': { turn: 7000, carry: 4, codexBias: 1 },
  'Codex dearer than estimated': { turn: 2500, carry: 1.2, codexBias: 2 },
};
const policies = {
  'always-claude': () => 'claude',
  'always-codex': () => 'codex',
  'threshold-10k': t => (t.T > 10000 ? 'codex' : 'claude'),
  tandem: (t, w) => { const s = S.decide(t.task, root, { tokens: t.codexEst, nObs: 6 }, { claudeCostWeight: w }).strategy; return s === 'claude-subagent' ? 'claude' : s; },
};

function trueCost(t, who, sc, w) {
  const files = 4, impl = t.task.mode === 'implement';
  if (who === 'codex') return t.codexEst * sc.codexBias * t.noiseCodex + w * (3 * sc.turn + (impl ? 0.2 * t.T : 800) * (1 + sc.carry));
  const turns = impl ? 3 + files + 2 : 2 + files;
  return w * t.noiseClaude * (t.T + t.T * sc.carry + turns * sc.turn + (impl ? 0.15 * t.T + 3000 : 800));
}

const results = {};
for (const [name, sc] of Object.entries(SCENARIOS)) for (const w of [1, 3]) {
  const tot = Object.fromEntries(Object.keys(policies).map(p => [p, 0])); let oracle = 0;
  const r2 = rngFrom(SEED + 7);
  for (let i = 0; i < N; i++) {
    const T = SIZES[Math.floor(r2() * SIZES.length)]; // tokens across the 4 scoped files
    const mode = r2() < 0.7 ? 'implement' : 'ask', difficulty = ['trivial', 'normal', 'hard'][Math.floor(r2() * 3)];
    const codexEst = logn({ trivial: 12000, normal: 30000, hard: 50000 }[difficulty] * (1 + T / 200000), 0.4);
    const t = { T, codexEst, noiseCodex: logn(1, 0.35), noiseClaude: logn(1, 0.35), task: { mode, difficulty, prompt: 'implement the change described in the ticket', paths: ['s' + T], verify: mode === 'implement' ? 'npm test' : null } };
    const c = { claude: trueCost(t, 'claude', sc, w), codex: trueCost(t, 'codex', sc, w) };
    oracle += Math.min(c.claude, c.codex);
    for (const [p, f] of Object.entries(policies)) tot[p] += c[f(t, w)];
  }
  results[`${name}, Claude ×${w}`] = Object.fromEntries(Object.entries(tot).map(([p, v]) => [p, +(v / oracle).toFixed(3)]));
}
fs.rmSync(root, { recursive: true, force: true });
console.log('Total cost relative to the per-task oracle (1.000 = always the cheaper option; lower is better). SYNTHETIC.');
console.table(results);
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ synthetic: true, tasks: N, seed: SEED, results }, null, 2)); }

// Decisions on the real corpus (bench/corpus.js + tasks.js), no provider calls. Codex cost per difficulty is
// anchored on the real pilot (cheapest trivial run 9.4k, normal/hard implement 35–48k effective tokens) with no
// project observations, i.e. the widest band. Read-only tasks are scoped to the whole repository.
{
  const { TASKS } = require('./tasks');
  const PRIOR = { trivial: 12000, normal: 30000, hard: 45000, critical: 60000 };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-scorpus-'));
  const rows = {};
  for (const w of [1, 3]) for (const [name, t] of Object.entries(TASKS)) {
    const dir = path.join(base, name); // files only: the decision measures sizes, git is not needed
    for (const [p, c] of Object.entries(t.files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
    const s = S.decide({ mode: t.mode, difficulty: t.difficulty, prompt: t.task, paths: t.paths || ['.'], verify: t.verify || null }, dir, { tokens: PRIOR[t.difficulty], nObs: 0 }, { claudeCostWeight: w });
    (rows[name] = rows[name] || { category: t.category })[`Claude ×${w}`] = s.strategy + (s.uncertain ? '?' : '');
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log('\nDecision per corpus task (? = estimates overlap). Pilot-anchored Codex prior, no project observations.');
  console.table(rows);
  if (OUT) { const o = JSON.parse(fs.readFileSync(OUT, 'utf8')); o.corpusDecisions = rows; fs.writeFileSync(OUT, JSON.stringify(o, null, 2)); }
}
