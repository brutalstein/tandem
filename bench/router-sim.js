#!/usr/bin/env node
'use strict';
// Routing simulation study (deterministic, no provider calls).
//   node bench/router-sim.js [--seeds 30] [--out bench/data/router-sim.json]
//
// Question: does the v2 policy (server/policy.js, used unmodified) reach verified results at lower
// expected cost than simple alternatives, including when its priors are WRONG?
//
// World model (deliberately not the policy's own prior):
//   task i of class c has latent difficulty θ_i ~ N(μ_c, 1)  → failures are correlated within a task
//   P(success | rung r, task i) = σ(θ_i + skill_world(r))
//   tokens per attempt = T0 · TIER^model · EFFORT^effort · LogNormal(0, 0.3); TIER=1.08, EFFORT=1.38 as
//   measured on 24 real attempts (override: SIM_TIER_COST, SIM_EFFORT_COST)
//   cost of a task = Σ attempt tokens + F · [unsolved],  F = 2 × mean tokens of the most expensive rung
// Up to 2 attempts per task for every policy. Metric: mean cost per task (lower is better).
// The oracle knows the world exactly and picks the best static 2-step plan per class (Monte Carlo).
const fs = require('fs');
const path = require('path');
const catalog = require('../server/catalog');
const policy = require('../server/policy');

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SEEDS = Number(arg('--seeds', 30));
const OUT = arg('--out', null);

// Snapshot of a real catalog (codex-cli 0.154.0, ChatGPT account, 2026-10) so the study is reproducible.
const MODELS = [
  { slug: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], visibility: 'list', description: 'Older fast and efficient model.' },
  { slug: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], visibility: 'list', description: 'Older balanced model for straightforward work.' },
  { slug: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], visibility: 'list', description: 'Older generation workhorse model.' },
  { slug: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], visibility: 'list', description: 'Frontier intelligence for the most demanding work.' },
];
const CFG = { codexMaxModel: 'gpt-6.1-sol', codexAllowedModels: [], codexMaxEffort: 'xhigh', objective: 'tokens', exploration: false };
const RUNGS = catalog.rungs(MODELS, CFG, {});
const MODEL_IDX = Object.fromEntries(MODELS.map((m, i) => [m.slug, i]));
const EFF_IDX = { low: 0, medium: 1, high: 2, xhigh: 3 };
const CLASSES = ['trivial', 'normal', 'hard', 'critical'];
const MU = { trivial: 1.5, normal: 0.3, hard: -0.8, critical: -1.5 };
const T0 = 20000;
const TIER_COST = Number(process.env.SIM_TIER_COST) || 1.08, EFFORT_COST = Number(process.env.SIM_EFFORT_COST) || 1.38;
const meanTokens = r => T0 * TIER_COST ** MODEL_IDX[r.model] * EFFORT_COST ** EFF_IDX[r.effort] * Math.exp(0.3 ** 2 / 2);
const F = 2 * Math.max(...RUNGS.map(meanTokens));
const sigmoid = x => 1 / (1 + Math.exp(-x));

const WORLDS = {
  // capability rises with model and effort, as the prior assumes
  monotone: { n: 300, skill: r => 3 * (r.cap - 0.5) },
  // cheap rungs are nearly as good as expensive ones: the prior is too pessimistic about them
  flat: { n: 300, skill: r => 0.6 * (r.cap - 0.5) + 0.6 },
  // family order is wrong: terra is the strongest model, astra no better than sol
  inverted: { n: 300, skill: r => ({ 'gpt-5.6-luna': -0.8, 'gpt-5.6-terra': 1.0, 'gpt-5.6-sol': 0.3, 'gpt-6-astra': 0.4 }[r.model] + 0.25 * EFF_IDX[r.effort]) },
  // halfway through, the cheap models get much better (a provider update)
  drift: { n: 400, skill: (r, t, n) => 3 * (r.cap - 0.5) + (t >= n / 2 && MODEL_IDX[r.model] <= 1 ? 2.0 : 0) },
  // very little data: 32 tasks
  sparse: { n: 32, skill: r => 3 * (r.cap - 0.5) },
};

// ---------- deterministic RNG ----------
const rngOf = policy.rngFrom;
const gauss = rng => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };

// ---------- policies: (cls, state) -> first rung index; (cls, at, state) -> next rung index | null ----------
const idxOf = (model, effort) => RUNGS.findIndex(r => r.model === model && r.effort === effort);
const nextModelSameEffort = i => { const r = RUNGS[i]; const m = MODELS[MODEL_IDX[r.model] + 1]; if (!m) return null; const j = idxOf(m.slug, r.effort); return j >= 0 ? j : idxOf(m.slug, 'low'); };
const V1_START = { trivial: ['gpt-5.6-luna', 'low'], normal: ['gpt-5.6-terra', 'medium'], hard: ['gpt-5.6-sol', 'high'], critical: ['gpt-6-astra', 'high'] };
const v2 = exploration => ({
  init: () => ({ ev: { version: 2, classes: {} } }),
  first: (cls, st, seed) => policy.decide(null, { cls: 'implement|' + cls, rungs: RUNGS, cfg: { ...CFG, exploration }, maxAttempts: 2, seed, evidence: st.ev }).seq[0],
  next: (cls, at, st) => policy.next(null, { cls: 'implement|' + cls, rungs: RUNGS, cfg: CFG, at, attemptsLeft: 1, evidence: st.ev }),
  learn: (cls, st, obs) => policy.append(st.ev, 'implement|' + cls, obs),
});
const POLICIES = {
  'fixed-top': { first: () => idxOf('gpt-6-astra', 'xhigh'), next: (cls, at) => at },
  'codex-default': { first: () => idxOf('gpt-6-astra', 'medium'), next: (cls, at) => at }, // plain Codex: default model, default effort, retry
  'cheapest-escalate': { first: () => 0, next: (cls, at) => nextModelSameEffort(at) },
  'v1-static': { first: cls => idxOf(...V1_START[cls]), next: (cls, at) => { const r = RUNGS[at]; const e = ['low', 'medium', 'high', 'xhigh'][EFF_IDX[r.effort] + 1]; const j = e ? idxOf(r.model, e) : -1; return j >= 0 ? j : nextModelSameEffort(at); } },
  'v2-mean': v2(false),
  'v2-thompson': v2(true),
};

// Oracle: best static (first, second|null) plan per class and world phase, by Monte Carlo on the true world.
function oraclePlans(world, phaseT) {
  const rng = rngOf('oracle');
  const plans = {};
  for (const cls of CLASSES) {
    const thetas = Array.from({ length: 4000 }, () => MU[cls] + gauss(rng));
    const p = RUNGS.map(r => thetas.map(th => sigmoid(th + world.skill(r, phaseT, world.n))));
    const T = RUNGS.map(meanTokens);
    let best = { E: Infinity };
    for (let i = 0; i < RUNGS.length; i++) {
      const pf = p[i].reduce((a, x) => a + (1 - x), 0) / thetas.length;
      const solo = T[i] + pf * F;
      if (solo < best.E) best = { E: solo, plan: [i, null] };
      for (let j = 0; j < RUNGS.length; j++) {
        const pff = p[i].reduce((a, x, k) => a + (1 - x) * (1 - p[j][k]), 0) / thetas.length; // P(fail i and fail j), same task
        const E = T[i] + pf * T[j] + pff * F;
        if (E < best.E) best = { E, plan: [i, j] };
      }
    }
    plans[cls] = best.plan;
  }
  return plans;
}

function simulate(worldName, polName, seed) {
  const world = WORLDS[worldName];
  const pol = polName === 'oracle' ? null : POLICIES[polName];
  const st = pol && pol.init ? pol.init() : {};
  const orc = polName === 'oracle' ? { early: oraclePlans(world, 0), late: oraclePlans(world, world.n) } : null;
  const rng = rngOf(`${worldName}:${seed}`); // same task stream and noise for every policy (paired design)
  let cost = 0, solved = 0, attempts = 0, tokens = 0;
  const use = {};
  for (let t = 0; t < world.n; t++) {
    const cls = CLASSES[Math.floor(rng() * CLASSES.length)];
    const theta = MU[cls] + gauss(rng);
    const draws = [rng(), rng()], noise = [gauss(rng), gauss(rng)];
    let at = orc ? (t < world.n / 2 ? orc.early : orc.late)[cls][0] : pol.first(cls, st, `${seed}:${t}`);
    let ok = false;
    for (let k = 0; k < 2 && at !== null && at !== undefined; k++) {
      const r = RUNGS[at];
      const tk = T0 * TIER_COST ** MODEL_IDX[r.model] * EFFORT_COST ** EFF_IDX[r.effort] * Math.exp(0.3 * noise[k]);
      ok = draws[k] < sigmoid(theta + world.skill(r, t, world.n));
      cost += tk; tokens += tk; attempts++;
      use[catalog.key(r)] = (use[catalog.key(r)] || 0) + 1;
      if (pol && pol.learn) pol.learn(cls, st, { r: catalog.key(r), ok, cond: k > 0, tin: tk, tc: 0, tout: 0, sec: 0 });
      if (ok) break;
      at = k === 0 ? (orc ? (t < world.n / 2 ? orc.early : orc.late)[cls][1] : pol.next(cls, at, st)) : null;
    }
    if (ok) solved++; else cost += F;
  }
  return { cost: cost / world.n, success: solved / world.n, attempts: attempts / world.n, tokens: tokens / world.n, use };
}

// ---------- statistics ----------
const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const T975 = { 9: 2.262, 19: 2.093, 29: 2.045, 49: 2.010, 99: 1.984 };
const tq = df => T975[df] || (df > 99 ? 1.96 : 2.045);
const ci = xs => { const h = tq(xs.length - 1) * sd(xs) / Math.sqrt(xs.length); return [mean(xs) - h, mean(xs) + h]; };

const t0 = Date.now();
const out = { meta: { date: new Date().toISOString(), node: process.version, seeds: SEEDS, rungs: RUNGS.map(catalog.key), F, worldCost: { tier: TIER_COST, effort: EFFORT_COST }, note: 'cost unit = tokens; lower is better; CIs are 95% t-intervals over seeds; deltas are paired by seed' }, worlds: {} };
for (const w of Object.keys(WORLDS)) {
  const names = [...Object.keys(POLICIES), 'oracle'];
  const runs = Object.fromEntries(names.map(p => [p, Array.from({ length: SEEDS }, (_, s) => simulate(w, p, s))]));
  const ref = runs['v2-thompson'].map(r => r.cost);
  out.worlds[w] = { tasks: WORLDS[w].n, policies: {} };
  for (const p of names) {
    const c = runs[p].map(r => r.cost);
    const d = c.map((x, i) => x - ref[i]);
    out.worlds[w].policies[p] = {
      cost: +mean(c).toFixed(0), costCI: ci(c).map(x => +x.toFixed(0)),
      success: +mean(runs[p].map(r => r.success)).toFixed(3), attempts: +mean(runs[p].map(r => r.attempts)).toFixed(2),
      tokens: +mean(runs[p].map(r => r.tokens)).toFixed(0),
      vsV2: p === 'v2-thompson' ? null : { delta: +mean(d).toFixed(0), ci: ci(d).map(x => +x.toFixed(0)), pctOfV2: +(100 * mean(d) / mean(ref)).toFixed(1) },
      regretVsOracle: +(100 * (mean(c) / mean(runs.oracle.map(r => r.cost)) - 1)).toFixed(1),
    };
  }
  console.log(`\n${w} (${WORLDS[w].n} tasks × ${SEEDS} seeds)`);
  console.table(Object.fromEntries(names.map(p => { const x = out.worlds[w].policies[p]; return [p, { cost: x.cost, '95% CI': x.costCI.join('–'), success: x.success, attempts: x.attempts, 'vs v2 %': x.vsV2 ? x.vsV2.pctOfV2 : '—', 'regret %': x.regretVsOracle }]; })));
}
// Decision latency of the real policy with a full evidence store (80 obs × 8 classes).
const ev = { version: 2, classes: {} };
for (const c of ['ask', 'implement']) for (const d of CLASSES) for (let i = 0; i < 80; i++) policy.append(ev, `${c}|${d}`, { r: catalog.key(RUNGS[i % RUNGS.length]), ok: i % 3 > 0, cond: i % 5 === 0, tin: 30000, tc: 1000, tout: 800, sec: 30 });
const L = [];
for (let i = 0; i < 300; i++) { const s = process.hrtime.bigint(); policy.decide(null, { cls: 'implement|hard', rungs: RUNGS, cfg: { ...CFG, exploration: true }, maxAttempts: 4, seed: i, evidence: ev }); L.push(Number(process.hrtime.bigint() - s) / 1e6); }
L.sort((a, b) => a - b);
out.decideLatencyMs = { p50: +L[150].toFixed(3), p95: +L[285].toFixed(3), rungs: RUNGS.length, maxAttempts: 4 };
out.meta.runtimeSec = +((Date.now() - t0) / 1000).toFixed(1);
console.log('\ndecide() latency', out.decideLatencyMs, `| total ${out.meta.runtimeSec}s`);
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); }
if (process.env.SIM_DEBUG) {
  const [w, p] = process.env.SIM_DEBUG.split(':');
  const r = simulate(w, p, 0);
  console.log(w, p, JSON.stringify(Object.entries(r.use).sort((a, b) => b[1] - a[1]).slice(0, 8)));
}
