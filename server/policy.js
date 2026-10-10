'use strict';
// Routing policy: choose the escalation sequence of rungs that minimises the expected total cost of
// reaching a successful (verified) result. Full derivation and assumptions: docs/ROUTING.md.
//
//   E[cost | s] = Σ_i  Π_{j<i} (1 − q_j) · C(s_i)   +   Π_j (1 − q_j) · F
//   q_1 = p(s_1),  q_i = p(s_i)·(1 − ρ) for i > 1   (a failure is evidence the task is harder)
//
// p(r | class) – additive logistic model shared by all task classes:
//     logit p = α[class] + γ[model] + ε[effort]
//   Gaussian priors (class difficulty; model/effort rank as a weak hint), MAP fit by Newton's
//   method on recency-weighted observations, Laplace posterior. Every observation informs every
//   class, and no ordering between models is imposed: a "smaller" model that keeps succeeding is
//   preferred on evidence alone. Predictions use the posterior predictive (uncertain ⇒ toward ½).
// C(r)  – per-attempt cost, shrunk to a calibrated prior.
// F     – cost of ending without success (the lead redoes the work): failureMult × max C.
// The minimising sequence is found exactly by DP over non-decreasing rung indices (a retry may stay
//   on the same rung, which resumes the same Codex thread), ≤ 4 attempts.
// Exploration: seeded Thompson sampling from the Laplace posterior picks the first rung; vetoed if
//   its expected cost under the posterior exceeds EXPLORE_MAX_REGRET × the best plan (1.25: chosen in
//   bench/router-sim.js over 1.1 and 1.5, see docs/ROUTING.md).
const path = require('path');
const { readJson, update } = require('./store');
const { key, RUNG_EFFORTS } = require('./catalog');

const PRIOR_LOGIT = { trivial: 2.0, normal: 0.8, hard: -0.4, critical: -1.2 };
const READONLY_BONUS = 0.5;
const CAP_SLOPE = 3;
const SD_CLASS = 1.0, SD_MODEL = 1.0, SD_EFFORT = 0.5;
const HALF_LIFE_MS = 30 * 864e5;
const RECENCY_LAMBDA = 0.97;
const COND_WEIGHT = 0.5;
const RHO_DEFAULT = 0.25;
const MAX_OBS_PER_CLASS = 80;
const EXPLORE_MAX_REGRET = Number(process.env.TANDEM_EXPLORE_MAX_REGRET) || 1.25; // explore only if E[cost] ≤ this × best plan
const FAILURE_MULT = Number(process.env.TANDEM_FAILURE_MULT) || 2;
const REF_TOKENS = 60000, REF_SECONDS = 60;
const EVIDENCE_VERSION = 2;

const sigmoid = x => 1 / (1 + Math.exp(-x));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- deterministic randomness ----------
function rngFrom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

// ---------- small dense linear algebra (n ≤ ~40) ----------
function cholesky(A) { // A symmetric positive definite → lower L with A = L Lᵀ
  const n = A.length, L = A.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}
function solveL(L, b) { const n = b.length, x = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * x[k]; x[i] = s / L[i][i]; } return x; }
function solveLt(L, b) { const n = b.length, x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; } return x; }

// ---------- evidence ----------
function evidenceFile(projDir) { return path.join(projDir, 'router-evidence.json'); }

// v1 kept aggregate first-attempt counts in router-stats.json; convert them to observations once.
function migrate(doc, projDir) {
  if (doc.version === EVIDENCE_VERSION) return;
  doc.version = EVIDENCE_VERSION;
  doc.classes = doc.classes || {};
  const v1 = readJson(path.join(projDir, 'router-stats.json'), null);
  if (!v1) return;
  for (const [cls, s] of Object.entries(v1)) {
    for (const [rk, t] of Object.entries(s.totals || {})) {
      const [model, effort] = rk.split('@');
      const tok = t.jobs ? t.tokens / t.attempts : 0, sec = t.jobs ? t.ms / t.attempts / 1000 : 0;
      for (let i = 0; i < Math.min(t.jobs, 20); i++) {
        (doc.classes[cls] = doc.classes[cls] || []).push({ t: Date.now() - 864e5, r: `${model}@${effort}`, ok: i < t.firstOk, cond: false, tin: tok, tc: 0, tout: 0, sec, migrated: true });
      }
    }
  }
}

function loadEvidence(projDir) {
  // No version on the fallback: a missing file still gets the one-time v1 import.
  const doc = readJson(evidenceFile(projDir), { classes: {} });
  if (doc.version !== EVIDENCE_VERSION) migrate(doc, projDir);
  return doc;
}

// obs: { r: 'model@effort', ok, cond, tin, tc, tout, sec }
function append(doc, cls, obs) {
  const list = doc.classes[cls] = doc.classes[cls] || [];
  list.push({ t: Date.now(), ...obs });
  if (list.length > MAX_OBS_PER_CLASS) list.splice(0, list.length - MAX_OBS_PER_CLASS);
}
function record(projDir, cls, obs) {
  update(evidenceFile(projDir), { classes: {} }, doc => append(doc, cls, obs), doc => migrate(doc, projDir));
}

function effTokens(o) { return Math.max(0, (o.tin || 0) - (o.tc || 0)) + 0.1 * (o.tc || 0) + (o.tout || 0); }

function costOf(o, refs, objective) {
  const t = effTokens(o) / refs.tok, s = (o.sec || 0) / refs.sec;
  return objective === 'tokens' ? t : objective === 'time' ? s : 0.5 * (t + s);
}

// ---------- success model ----------
function classPrior(cls) {
  const [mode, difficulty] = cls.split('|');
  return (PRIOR_LOGIT[difficulty] ?? PRIOR_LOGIT.normal) + (mode !== 'implement' ? READONLY_BONUS : 0);
}

// Fit logit p = α[class] + γ[model] + ε[effort] (MAP + Laplace). Returns parameter layout, mean and
// the Cholesky factor of the posterior precision.
function fitSuccess(evidence, cls, rungs, now) {
  const classes = [...new Set([cls, ...Object.keys(evidence.classes || {})])];
  const models = [...new Set(rungs.map(r => r.model))];
  const efforts = RUNG_EFFORTS.filter(e => rungs.some(r => r.effort === e));
  const tierOf = Object.fromEntries(rungs.map(r => [r.model, r.tier]));
  const maxTier = Math.max(0, ...rungs.map(r => r.tier));
  const idx = { c: new Map(classes.map((c, i) => [c, i])), m: new Map(models.map((m, i) => [m, classes.length + i])), e: new Map(efforts.map((e, i) => [e, classes.length + models.length + i])) };
  const P = classes.length + models.length + efforts.length;
  const mu = new Float64Array(P), prec = new Float64Array(P);
  classes.forEach((c, i) => { mu[i] = classPrior(c); prec[i] = 1 / SD_CLASS ** 2; });
  models.forEach(m => { const mr = maxTier ? tierOf[m] / maxTier : 0.5; mu[idx.m.get(m)] = CAP_SLOPE * 0.7 * (mr - 0.5); prec[idx.m.get(m)] = 1 / SD_MODEL ** 2; });
  efforts.forEach(e => { const er = RUNG_EFFORTS.indexOf(e) / (RUNG_EFFORTS.length - 1); mu[idx.e.get(e)] = CAP_SLOPE * 0.3 * (er - 0.5); prec[idx.e.get(e)] = 1 / SD_EFFORT ** 2; });

  const rows = []; // [ci, mi, ei, y, w]
  for (const [c, list] of Object.entries(evidence.classes || {})) {
    list.forEach((o, i) => {
      const [m, e] = String(o.r).split('@');
      if (!idx.m.has(m) || !idx.e.has(e)) return;
      // Self-reported completions are weak evidence, not equivalent to an independent check.
      const trust = o.verified === false ? 0.35 : 1;
      const w = Math.pow(0.5, Math.max(0, now - (o.t || now)) / HALF_LIFE_MS) * Math.pow(RECENCY_LAMBDA, list.length - 1 - i) * (o.cond ? COND_WEIGHT : 1) * trust;
      rows.push([idx.c.get(c), idx.m.get(m), idx.e.get(e), o.ok ? 1 : 0, w]);
    });
  }
  const theta = Float64Array.from(mu);
  let L;
  for (let it = 0; it < 30; it++) {
    const g = new Float64Array(P), A = Array.from({ length: P }, () => new Float64Array(P));
    for (let j = 0; j < P; j++) { g[j] = -prec[j] * (theta[j] - mu[j]); A[j][j] = prec[j]; }
    for (const [a, b, c, y, w] of rows) {
      const p = sigmoid(theta[a] + theta[b] + theta[c]);
      const r = w * (y - p), h = w * p * (1 - p), ix = [a, b, c];
      for (const u of ix) { g[u] += r; for (const v of ix) A[u][v] += h; }
    }
    L = cholesky(A);
    const step = solveLt(L, solveL(L, g));
    let mx = 0;
    for (let j = 0; j < P; j++) { theta[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-7) break;
  }
  const pos = r => [idx.c.get(cls), idx.m.get(r.model), idx.e.get(r.effort)];
  return { theta, L, P, pos };
}

// Posterior predictive success probability of each rung for `cls` (probit approximation).
function predictive(fit, rungs) {
  return rungs.map(r => {
    const ix = fit.pos(r);
    const m = ix.reduce((a, j) => a + fit.theta[j], 0);
    const x = new Float64Array(fit.P); ix.forEach(j => { x[j] += 1; });
    const z = solveL(fit.L, x);
    const v = z.reduce((a, t) => a + t * t, 0); // xᵀ A⁻¹ x
    return sigmoid(m / Math.sqrt(1 + Math.PI * v / 8));
  });
}

// One joint draw from the Laplace posterior → success probability of each rung.
function sampleP(fit, rungs, rng) {
  const z = Float64Array.from({ length: fit.P }, () => normal(rng));
  const d = solveLt(fit.L, z); // ~ N(0, A⁻¹)
  return rungs.map(r => sigmoid(fit.pos(r).reduce((a, j) => a + fit.theta[j] + d[j], 0)));
}

// ---------- estimation ----------
// Prior per-attempt cost relative to the cheapest rung. Fitted on 24 real attempts (codex-cli 0.154.0,
// 2026-10-09; log-linear, balanced objective): each effort step ×1.38 tokens / ×1.51 time, each model
// tier ×1.08. Effort is confounded with task difficulty there, so this is a prior only; data replaces it.
const relCost = r => Math.pow(1.1, r.tier) * Math.pow(1.45, ['low', 'medium', 'high', 'xhigh'].indexOf(r.effort));

function estimate(evidence, cls, rungs, cfg, now = Date.now()) {
  const all = Object.values(evidence.classes || {}).flat();
  const refs = { tok: median(all.map(effTokens).filter(x => x > 0)) || REF_TOKENS, sec: median(all.map(o => o.sec).filter(x => x > 0)) || REF_SECONDS };
  const obs = evidence.classes[cls] || [];
  const est = rungs.map(r => ({ r, k: key(r), n: 0, costs: [], pooled: [] }));
  const byKey = Object.fromEntries(est.map(e => [e.k, e]));
  for (const o of obs) { const e = byKey[o.r]; if (e) { e.n++; e.costs.push(costOf(o, refs, cfg.objective)); } }
  for (const [c, list] of Object.entries(evidence.classes || {})) {
    if (c !== cls) for (const o of list) if (byKey[o.r]) byKey[o.r].pooled.push(costOf(o, refs, cfg.objective));
  }
  // Calibrate relative prior costs to observed units.
  const ratios = est.flatMap(e => [...e.costs, ...e.pooled].map(c => c / relCost(e.r)));
  const scale = median(ratios) || 1 / relCost(rungs[Math.floor(rungs.length / 2)] || { tier: 0, effort: 'medium' });
  for (const e of est) {
    // Shrink toward the calibrated prior; other classes' costs on this rung count half.
    const sum = e.costs.reduce((x, y) => x + y, 0) + 0.5 * e.pooled.reduce((x, y) => x + y, 0);
    const n = e.costs.length + 0.5 * e.pooled.length;
    e.C = (scale * relCost(e.r) + sum) / (1 + n);
  }
  const fit = fitSuccess(evidence, cls, rungs, now);
  predictive(fit, rungs).forEach((p, i) => { est[i].p = p; });
  // Failure correlation ρ: learned once enough post-failure attempts exist.
  const condObs = obs.filter(o => o.cond && byKey[o.r]);
  let rho = RHO_DEFAULT;
  if (condObs.length >= 8) {
    const expected = condObs.reduce((a, o) => a + byKey[o.r].p, 0);
    rho = Math.min(0.8, Math.max(0, 1 - condObs.filter(o => o.ok).length / (expected || 1)));
  }
  const F = FAILURE_MULT * Math.max(...est.map(e => e.C), 1e-9);
  return { est, rho, F, refs, n: obs.length, sample: rng => sampleP(fit, rungs, rng) };
}

// Exact DP over non-decreasing rung indices (a retry may repeat a rung). Returns { seq, E }.
function plan(ps, Cs, { K, F, rho, after = -1, cond = false, mustAttempt = true }) {
  const memo = new Map();
  const best = (i, k, c, must) => {
    const id = `${i}|${k}|${c}|${must}`;
    if (memo.has(id)) return memo.get(id);
    let res = must ? { E: Infinity, seq: [] } : { E: F, seq: [] };
    if (k > 0) {
      for (let j = Math.max(i, 0); j < ps.length; j++) {
        const q = ps[j] * (c ? 1 - rho : 1);
        const rest = best(j, k - 1, true, false);
        const E = Cs[j] + (1 - q) * rest.E;
        if (E < res.E - 1e-12) res = { E, seq: [j, ...rest.seq] };
      }
    }
    if (res.E === Infinity) res = { E: F, seq: [] };
    memo.set(id, res);
    return res;
  };
  return best(after, K, cond, mustAttempt);
}

// Route a new job. Returns { seq: [rung indices], record } with an auditable decision record.
// `evidence` (optional) is an in-memory evidence document, used by the simulator instead of the file.
function decide(projDir, { cls, rungs, cfg, maxAttempts, seed, evidence }) {
  const { est, rho, F, n, refs, sample } = estimate(evidence || loadEvidence(projDir), cls, rungs, cfg);
  const ps = est.map(e => e.p), Cs = est.map(e => e.C);
  const exploit = plan(ps, Cs, { K: maxAttempts, F, rho });
  let first = exploit.seq[0], explored = false;
  if (cfg.exploration && seed !== undefined) {
    const cand = plan(sample(rngFrom(seed)), Cs, { K: maxAttempts, F, rho }).seq[0];
    if (cand !== undefined && cand !== first) {
      const candE = Cs[cand] + (1 - ps[cand]) * plan(ps, Cs, { K: maxAttempts - 1, F, rho, after: cand, cond: true, mustAttempt: false }).E;
      if (candE <= EXPLORE_MAX_REGRET * exploit.E) { first = cand; explored = true; }
    }
  }
  const rest = plan(ps, Cs, { K: maxAttempts - 1, F, rho, after: first, cond: true, mustAttempt: false });
  const seq = [first, ...rest.seq];
  const E = Cs[first] + (1 - ps[first]) * rest.E;
  const fmt = i => ({ r: est[i].k, p: +est[i].p.toFixed(3), n: est[i].n, C: +est[i].C.toFixed(3) });
  return { seq, E, record: { cls, nObs: n, refTokens: Math.round(refs.tok), rho: +rho.toFixed(2), F: +F.toFixed(3), E: +E.toFixed(3), explored, plan: seq.map(fmt), bestExploit: exploit.seq.map(i => est[i].k) } };
}

// After a failed attempt at rung index `at`, pick the next rung (same or more capable) or null to stop.
function next(projDir, { cls, rungs, cfg, at, attemptsLeft, evidence }) {
  if (attemptsLeft <= 0) return null;
  const { est, rho, F } = estimate(evidence || loadEvidence(projDir), cls, rungs, cfg);
  const r = plan(est.map(e => e.p), est.map(e => e.C), { K: attemptsLeft, F, rho, after: at, cond: true, mustAttempt: false });
  return r.seq.length ? r.seq[0] : null;
}

// Summary for tandem_status: per class, the current first choice and its estimates.
function summary(projDir, rungs, cfg) {
  const ev = loadEvidence(projDir);
  return Object.keys(ev.classes || {}).sort().map(cls => {
    const { est, rho, F } = estimate(ev, cls, rungs, cfg);
    const top = plan(est.map(e => e.p), est.map(e => e.C), { K: 2, F, rho }).seq;
    return `${cls}: ${ev.classes[cls].length} obs; plan ${top.map(i => `${est[i].k} (p=${est[i].p.toFixed(2)}, n=${est[i].n})`).join(' -> ')}`;
  });
}

module.exports = { decide, next, record, append, estimate, plan, rngFrom, loadEvidence, classPrior, costOf, effTokens, evidenceFile, PRIOR_LOGIT, EVIDENCE_VERSION, migrate, summary, fitSuccess, predictive, cholesky };
