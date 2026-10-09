'use strict';
// Catalog -> eligible models -> rungs (model × effort) with a prior capability score.
// Model names are never trusted as a capability ranking on their own: the family/version
// heuristic only seeds priors and the ceiling check; observed outcomes drive routing (policy.js).
const { EFFORTS } = require('./config');

// Weak hint from today's catalog descriptions (fast/efficient < balanced < workhorse < frontier).
// Unknown families still work: they are placed by catalog metadata, and the ceiling check refuses
// to auto-permit them unless the user allow-lists them.
const FAMILY_HINT = { luna: 1, terra: 2, sol: 3, astra: 4 };
const RUNG_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function parseSlug(slug) {
  const m = /^([a-z]+)-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(slug || '');
  return m ? { prefix: m[1], version: m[2].split('.').map(Number), family: m[3] } : null;
}

function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Is `slug` permitted under the user's restriction? Returns { allowed, reason } so every
// exclusion is explainable in tandem_status.
function ceilingCheck(slug, cfg) {
  if (cfg.codexAllowedModels && cfg.codexAllowedModels.length) {
    return cfg.codexAllowedModels.includes(slug) ? { allowed: true, reason: 'allow-listed' } : { allowed: false, reason: 'not in codex_allowed_models' };
  }
  const ceiling = cfg.codexMaxModel;
  if (slug === ceiling) return { allowed: true, reason: 'is the ceiling' };
  const s = parseSlug(slug), c = parseSlug(ceiling);
  if (!s || !c || !FAMILY_HINT[s.family] || !FAMILY_HINT[c.family] || s.prefix !== c.prefix) {
    return { allowed: false, reason: `cannot be ranked against ceiling ${ceiling}; allow-list it to use it` };
  }
  const v = cmpVersion(s.version, c.version);
  if (v < 0) return { allowed: true, reason: `older generation than ${ceiling}` };
  if (v === 0 && FAMILY_HINT[s.family] <= FAMILY_HINT[c.family]) return { allowed: true, reason: `same generation, family ≤ ${c.family}` };
  return { allowed: false, reason: `above ceiling ${ceiling}` };
}

function describeScore(desc) {
  const d = String(desc || '').toLowerCase();
  if (/frontier|most (capable|demanding)/.test(d)) return 4;
  if (/workhorse|general/.test(d)) return 3;
  if (/balanced|straightforward/.test(d)) return 2;
  if (/fast|efficient|small|mini|cheap/.test(d)) return 1;
  return 2.5;
}

// Eligible models with reasons for every exclusion. Keeps the newest version per family
// (an older same-family model is used only when the newer one is unavailable).
function eligible(models, cfg, unavailable = {}) {
  const excluded = [];
  const best = new Map();
  for (const m of models || []) {
    const allowList = cfg.codexAllowedModels && cfg.codexAllowedModels.includes(m.slug);
    if (m.visibility === 'hide' && !allowList) { excluded.push([m.slug, 'hidden in catalog']); continue; }
    if (unavailable[m.slug]) { excluded.push([m.slug, `unavailable: ${unavailable[m.slug].reason}`]); continue; }
    const c = ceilingCheck(m.slug, cfg);
    if (!c.allowed) { excluded.push([m.slug, c.reason]); continue; }
    const p = parseSlug(m.slug);
    const fam = p ? p.family : m.slug;
    const cur = best.get(fam);
    if (!cur || (p && cmpVersion(p.version, parseSlug(cur.slug).version) > 0)) {
      if (cur) excluded.push([cur.slug, `superseded by ${m.slug}`]);
      best.set(fam, m);
    } else excluded.push([m.slug, `superseded by ${cur.slug}`]);
  }
  const strength = m => {
    const p = parseSlug(m.slug);
    const fam = p && FAMILY_HINT[p.family] ? FAMILY_HINT[p.family] : describeScore(m.description);
    return fam * 100 + (p ? p.version.reduce((a, x, i) => a + x / 10 ** i, 0) : 0);
  };
  const list = [...best.values()].sort((a, b) => strength(a) - strength(b));
  return { models: list, excluded };
}

// Rungs ordered by prior capability. cap ∈ [0,1] combines model rank (70 %) and effort (30 %).
function rungs(models, cfg, unavailable) {
  const { models: ms } = eligible(models, cfg, unavailable);
  const out = [];
  ms.forEach((m, i) => {
    const mr = ms.length > 1 ? i / (ms.length - 1) : 0.5;
    for (const e of RUNG_EFFORTS) {
      if (m.efforts.length && !m.efforts.includes(e)) continue;
      if (EFFORTS.indexOf(e) > EFFORTS.indexOf(cfg.codexMaxEffort)) continue;
      out.push({ model: m.slug, effort: e, tier: i, cap: 0.7 * mr + 0.3 * (RUNG_EFFORTS.indexOf(e) / (RUNG_EFFORTS.length - 1)) });
    }
  });
  return out.sort((a, b) => a.cap - b.cap || a.tier - b.tier);
}

const key = r => `${r.model}@${r.effort}`;

module.exports = { FAMILY_HINT, RUNG_EFFORTS, parseSlug, cmpVersion, ceilingCheck, eligible, rungs, key };
