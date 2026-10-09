'use strict';
// Model routing: build a cost-ordered ladder of (model, effort) rungs from the *discovered* catalog,
// capped by the user's ceiling, then pick a starting rung per task difficulty. The start adapts
// from recorded first-attempt outcomes; failures escalate one rung at a time.
const path = require('path');
const { update, readJson } = require('./store');

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Family ordering inferred from catalog descriptions: fast/efficient < balanced < workhorse < frontier.
const FAMILY = { luna: 1, terra: 2, sol: 3, astra: 4 };
const DIFFICULTIES = ['trivial', 'normal', 'hard', 'critical'];

function parseSlug(slug) {
  const m = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(slug || '');
  if (!m || !FAMILY[m[2]]) return null;
  return { version: m[1].split('.').map(Number), family: FAMILY[m[2]] };
}

function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Generation first, then family: with ceiling gpt-6.1-sol, gpt-6-astra (older generation) is allowed,
// gpt-6.1-astra and gpt-7-* are not. Unparseable slugs are never auto-selected.
function withinCeiling(slug, ceiling) {
  const s = parseSlug(slug), c = parseSlug(ceiling);
  if (!s) return false;
  if (!c) return slug === ceiling;
  const v = cmpVersion(s.version, c.version);
  return v < 0 || (v === 0 && s.family <= c.family);
}

function effortAllowed(effort, maxEffort) { return EFFORTS.indexOf(effort) <= EFFORTS.indexOf(maxEffort); }

// Listed models within the ceiling, newest version per family, cheapest family first.
function eligibleModels(models, cfg, unavailable = {}) {
  const best = new Map();
  for (const m of models) {
    const p = parseSlug(m.slug);
    if (!p || m.visibility === 'hide' || unavailable[m.slug] || !withinCeiling(m.slug, cfg.codexMaxModel)) continue;
    const cur = best.get(p.family);
    if (!cur || cmpVersion(p.version, parseSlug(cur.slug).version) > 0) best.set(p.family, m);
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
}

function ladder(models, cfg, unavailable) {
  const ms = eligibleModels(models, cfg, unavailable);
  const rungs = [];
  ms.forEach((m, i) => {
    const want = ms.length === 1 ? ['low', 'medium', 'high', 'xhigh']
      : i === 0 ? ['low', 'medium'] : i === ms.length - 1 ? ['medium', 'high', 'xhigh'] : ['medium', 'high'];
    for (const e of want) {
      if ((!m.efforts.length || m.efforts.includes(e)) && effortAllowed(e, cfg.codexMaxEffort)) rungs.push({ model: m.slug, effort: e, tier: i });
    }
  });
  return rungs;
}

function baseStart(rungs, difficulty) {
  if (!rungs.length) return -1;
  const tiers = rungs[rungs.length - 1].tier + 1;
  const find = (tier, effort) => {
    const i = rungs.findIndex(r => r.tier === tier && r.effort === effort);
    return i >= 0 ? i : rungs.findIndex(r => r.tier === tier);
  };
  switch (difficulty) {
    case 'trivial': return 0;
    case 'hard': return find(Math.max(0, tiers - 2), 'high');
    case 'critical': return find(tiers - 1, 'high');
    default: return find(Math.floor((tiers - 1) / 2), 'medium');
  }
}

// ---- adaptive start offsets ----
const WINDOW = 10;
function statsFile(projDir) { return path.join(projDir, 'router-stats.json'); }

function startIndex(rungs, difficulty, mode, projDir) {
  const base = baseStart(rungs, difficulty);
  if (base < 0) return -1;
  const s = (readJson(statsFile(projDir), {}) || {})[`${mode}|${difficulty}`];
  return Math.max(0, Math.min(rungs.length - 1, base + ((s && s.offset) || 0)));
}

// Record whether the first attempt succeeded at the starting rung, and the whole job's cost.
// Raise the start after repeated first-attempt failures; probe one rung cheaper after a streak of successes.
function recordOutcome(projDir, { mode, difficulty, firstOk, rung, tokens, ms, attempts, finalOk }) {
  return update(statsFile(projDir), {}, all => {
    const key = `${mode}|${difficulty}`;
    const s = all[key] = all[key] || { offset: 0, recent: [], totals: {} };
    s.recent = [...s.recent, firstOk ? 1 : 0].slice(-WINDOW);
    const t = s.totals[`${rung.model}@${rung.effort}`] = s.totals[`${rung.model}@${rung.effort}`] || { jobs: 0, firstOk: 0, finalOk: 0, tokens: 0, ms: 0, attempts: 0 };
    t.jobs++; t.firstOk += firstOk ? 1 : 0; t.finalOk += finalOk ? 1 : 0; t.tokens += tokens; t.ms += ms; t.attempts += attempts;
    const n = s.recent.length, ok = s.recent.reduce((a, b) => a + b, 0);
    let changed = 0;
    if (n >= 4 && ok / n < 0.5 && s.offset < 3) changed = 1;
    else if (n >= 8 && ok / n >= 0.9 && s.offset > -2) changed = -1;
    if (changed) { s.offset += changed; s.recent = []; }
    return changed;
  });
}

module.exports = { EFFORTS, DIFFICULTIES, parseSlug, withinCeiling, effortAllowed, eligibleModels, ladder, baseStart, startIndex, recordOutcome };
