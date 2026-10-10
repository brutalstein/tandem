'use strict';
// Whole-strategy decision: who should do this task — a deterministic tool, Claude itself, a Claude subagent, or
// Codex — and how it should be checked. Sits above the Codex routing policy (policy.js), which it reuses for the
// Codex side; it never routes Codex models itself. Derivation and assumptions: docs/ROUTING.md §6.
//
// Currency: effective tokens (uncached input + 0.1 × cached input + output), the same as the policy's `tokens`
// objective. Claude tokens are multiplied by `claude_cost_weight` (how much scarcer or dearer a Claude token is
// to you than a Codex token; 1 = equal). Codex cost comes from the policy (calibrated on this project's
// observations); Claude cost is not observable by Tandem, so it is a bounded estimate from measured task size.
// Each option is an interval [lo, hi]; the decision compares geometric midpoints, calls a difference under 25 % a
// tie, and breaks ties toward the simpler strategy. `uncertain` marks overlapping intervals.
const fs = require('fs');
const path = require('path');

// Assumptions (not measurements), each a range. TURN: one Claude turn re-sends the cached conversation
// (10k–50k tokens at 0.1). SUBAGENT_TURN: a fresh subagent's small context. SPAWN: a subagent's first prompt.
// CARRY: what the main conversation reads stays in it and is re-sent, cached (0.1), on the session's later turns
// (5–30 of them); this is what delegating or a subagent saves beyond the work itself.
const TURN = [1000, 5000], SUBAGENT_TURN = [300, 1000], SPAWN = [3000, 8000], CARRY = [0.5, 3];
const CHECK_OUT = 1500, ANSWER = [300, 1500], TIE = 1.25;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'target']);

// Measured size of the scoped files (bytes / 4 ≈ tokens). null when no paths were given or none of them exists yet.
function contextSize(root, paths) {
  if (!paths || !paths.length) return null;
  let bytes = 0, files = 0;
  const walk = (p, depth) => {
    if (files > 5000 || depth > 12) return;
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isFile()) { bytes += st.size; files++; } else if (st.isDirectory()) {
      let names; try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names) if (!SKIP.has(n)) walk(path.join(p, n), depth + 1);
    }
  };
  for (const p of paths) walk(path.resolve(root, p), 0);
  return files ? { tokens: Math.round(bytes / 4), files } : null; // nothing there yet (new files): size unknown
}

// A question a search answers exactly ("where is X defined", "list the files that import Y"). Conservative: any
// sign of judgement (why, explain, review, should, best, …) keeps it with a model.
const LOCATE = /^\s*(where (is|are)|which files?|find (all |every )?(uses?|usages?|references?|callers?|occurrences?|definitions?)|list (all |every )?(files|uses?|usages?|callers?|occurrences?)|in which file)\b/i;
const JUDGEMENT = /\b(why|how does|explain|review|should|best|better|correct|bug|safe|design|architecture|intended)\b/i;
const isLocate = q => LOCATE.test(q) && !JUDGEMENT.test(q) && q.length < 300;

const mid = ([lo, hi]) => Math.sqrt(Math.max(lo, 1) * Math.max(hi, 1));
const add = (...xs) => xs.reduce((a, x) => (Array.isArray(x) ? [a[0] + x[0], a[1] + x[1]] : [a[0] + x, a[1] + x]), [0, 0]);
const mul = (k, [lo, hi]) => (Array.isArray(k) ? [k[0] * lo, k[1] * hi] : [k * lo, k * hi]);
const round = ([lo, hi]) => [Math.round(lo), Math.round(hi)];

// task: { mode, difficulty, prompt, context, paths, verify }; codex: { tokens, nObs } expected Codex effective tokens
// for the routed plan (from policy.decide with objective tokens), or null when no Codex model is usable.
function decide(task, root, codex, cfg) {
  const w = cfg.claudeCostWeight || 1;
  const why = [], unknown = ['Claude-side tokens (estimated from task size; Tandem cannot observe Claude usage)'];
  const impl = task.mode === 'implement', checked = impl && !!task.verify;
  const review = impl && ['hard', 'critical'].includes(task.difficulty)
    ? 'you read the whole diff against the acceptance criteria (a different provider than the worker)' : checked ? 'the passing check' : 'read the result';

  if (task.mode === 'ask' && isLocate(task.prompt || '')) {
    return { strategy: 'tool', why: ['a text or symbol search answers this exactly; no model call needed (rg / grep / your editor\'s symbol search)'], review: 'none', options: {}, unknown: [] };
  }
  if (!codex) return { strategy: 'claude', why: ['no permitted Codex model is usable now'], review, options: {}, unknown };

  const size = contextSize(root, task.paths);
  const T = size ? size.tokens : null, files = size ? Math.min(size.files, 6) : 0;
  const taskTok = Math.round(((task.prompt || '').length + (task.context || '').length) / 4);
  const band = codex.nObs >= 3 ? [0.75, 1.33] : [0.5, 2];
  if (codex.nObs < 3) unknown.push(`Codex cost for this task class (${codex.nObs} observations in this project; prior-based)`);
  const codexCost = mul(band, [codex.tokens, codex.tokens]);

  let direct, sub = null;
  if (T === null) {
    unknown.push('task size (no paths given, or the files do not exist yet)');
  } else {
    const read = mul([0.5, 1.5], [Math.min(T, 150000), Math.min(T, 150000)]);
    const turns = impl ? [2 + (checked ? 1 : 0), 4 + (checked ? 2 : 0) + files] : [1 + Math.min(files, 1), 2 + files];
    const out = impl ? add(mul([0.05, 0.3], [T, T]), 300) : ANSWER;
    direct = add(read, mul(CARRY, read), mul(turns, TURN), out, checked ? [CHECK_OUT, 3 * CHECK_OUT] : 0);
    const summary = [1000, 5000]; // what a subagent hands back to you
    if (!impl) sub = add(SPAWN, read, mul([2, 6], SUBAGENT_TURN), summary, mul(CARRY, summary));
  }
  const seen = impl && T !== null ? add(mul([0.05, 0.5], [T, T]), 300) : ANSWER; // the diff or answer you read
  const delegated = add(mul(w, add(mul([1, 1.5], [taskTok, taskTok]), mul([2, 3], TURN), seen, mul(CARRY, seen))), codexCost);
  const options = { codex: round(delegated) };
  if (direct) options.claude = round(mul(w, direct));
  if (sub) options['claude-subagent'] = round(mul(w, sub));

  let strategy, uncertain = false;
  if (!direct) {
    // No size, no estimate: fall back to the scoping rule (small or unchecked work stays with you).
    strategy = task.difficulty === 'trivial' || !checked ? 'claude' : 'codex';
    why.push(task.difficulty === 'trivial' ? 'trivial task: delegation overhead (≥9k Codex tokens measured even for a trivial question) is unlikely to pay off'
      : checked ? 'scoped implementation with a check; pass `paths` for a cost estimate' : 'no check to verify delegated work against; pass `paths` and `verify` for a cost estimate');
  } else {
    // Simplest first: ties go to the earlier entry.
    const ranked = Object.entries(options).sort((a, b) => ['claude', 'claude-subagent', 'codex'].indexOf(a[0]) - ['claude', 'claude-subagent', 'codex'].indexOf(b[0]));
    let best = ranked[0];
    for (const o of ranked.slice(1)) if (mid(o[1]) * TIE < mid(best[1])) best = o;
    strategy = best[0];
    const others = ranked.filter(o => o !== best);
    why.push(`estimated ${strategy} ≈ ${Math.round(mid(best[1]) / 1000)}k vs ${others.map(([k, v]) => `${k} ≈ ${Math.round(mid(v) / 1000)}k`).join(', ')} effective tokens${w !== 1 ? ` (Claude × ${w})` : ''}`);
    if (others.some(([, v]) => mid(v) < mid(best[1]))) why.push('within 25 %: the simpler strategy wins the tie');
    uncertain = others.some(([, v]) => v[0] < best[1][1] && best[1][0] < v[1]);
  }
  if (strategy === 'codex' && !checked && impl) why.push('no `verify` check: the result cannot be verified, only reviewed');
  return { strategy, uncertain, why, review, options, size: size || undefined, unknown };
}

module.exports = { decide, contextSize, isLocate };
