'use strict';
// Shared project memory: small, typed, deduplicated entries with provenance and verification state.
// Entries that cite files are flagged stale when a cited file changes after the entry was written.
const fs = require('fs');
const path = require('path');
const { update, readJson } = require('./store');

const KINDS = ['decision', 'constraint', 'fact', 'issue', 'done', 'note'];
const CAP = 400;
const STOP = new Set('the a an and or of to in on for is are be with this that it as at by from not no use uses used'.split(' '));

function tokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_.\/-]+/).filter(t => t.length > 1 && !STOP.has(t));
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / ((A.size + B.size - inter) || 1);
}

function file(projDir) { return path.join(projDir, 'memory.json'); }

function fileStamp(root, p) {
  try { return { path: p, mtimeMs: Math.round(fs.statSync(path.resolve(root, p)).mtimeMs) }; } catch { return { path: p, mtimeMs: 0 }; }
}

function isStale(root, e) {
  return (e.files || []).some(f => fileStamp(root, f.path).mtimeMs !== f.mtimeMs);
}

function write(projDir, root, { kind = 'note', text, files = [], verified = false, source = 'claude', supersedes }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  text = String(text || '').trim().slice(0, 600);
  if (!text) throw new Error('text required');
  return update(file(projDir), { seq: 0, entries: [] }, db => {
    const now = Date.now();
    const stamps = files.map(p => fileStamp(root, p));
    for (const id of [].concat(supersedes || [])) {
      const old = db.entries.find(e => e.id === id);
      if (old) { old.status = 'superseded'; old.updated = now; }
    }
    const tk = tokens(text);
    const dup = db.entries.find(e => e.status === 'active' && e.kind === kind && jaccard(tokens(e.text), tk) >= 0.7);
    if (dup) {
      dup.text = text; dup.updated = now; dup.verified = dup.verified || verified; dup.source = source;
      if (stamps.length) dup.files = stamps;
      return { id: dup.id, action: 'merged' };
    }
    const id = `m${++db.seq}`;
    db.entries.push({ id, kind, text, files: stamps, verified, source, status: 'active', created: now, updated: now, hits: 0 });
    prune(db);
    return { id, action: 'added' };
  });
}

// Keep the store bounded: drop inactive entries first, then old unverified low-value ones.
function prune(db) {
  if (db.entries.length <= CAP) return;
  const score = e => (e.status !== 'active' ? 0 : 1) * (1 + (e.verified ? 2 : 0) + (['decision', 'constraint'].includes(e.kind) ? 2 : 0) + Math.min(e.hits, 5)) * 1e13 + e.updated;
  db.entries.sort((a, b) => score(b) - score(a));
  db.entries.length = CAP;
}

function setStatus(projDir, id, patch) {
  return update(file(projDir), { seq: 0, entries: [] }, db => {
    const e = db.entries.find(x => x.id === id);
    if (!e) return null;
    if (patch.status) e.status = patch.status;
    if (patch.verified !== undefined) e.verified = !!patch.verified;
    if (patch.text) e.text = String(patch.text).slice(0, 600);
    e.updated = Date.now();
    return { id, status: e.status, verified: e.verified };
  });
}

// BM25-style lexical ranking with boosts for verified, durable kinds, and recency.
function search(projDir, root, { query = '', kinds, limit = 8, includeInactive = false } = {}) {
  const db = readJson(file(projDir), { entries: [] });
  const pool = db.entries.filter(e => (includeInactive || e.status === 'active') && (!kinds || kinds.includes(e.kind)));
  const q = tokens(query);
  const docs = pool.map(e => tokens(e.text + ' ' + (e.files || []).map(f => f.path).join(' ')));
  const avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1);
  const df = t => docs.filter(d => d.includes(t)).length;
  const idf = Object.fromEntries(q.map(t => [t, Math.log(1 + (docs.length - df(t) + 0.5) / (df(t) + 0.5))]));
  const now = Date.now();
  const scored = pool.map((e, i) => {
    let s = 0;
    for (const t of q) {
      const tf = docs[i].filter(x => x === t).length;
      if (tf) s += idf[t] * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * docs[i].length / (avg || 1)));
    }
    if (q.length && s === 0) return null;
    const boost = (e.verified ? 1.3 : 1) * (['decision', 'constraint'].includes(e.kind) ? 1.2 : 1) * (1 + 0.2 * Math.exp(-(now - e.updated) / (7 * 864e5)));
    return { e, s: (q.length ? s : 1) * boost };
  }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, limit);
  if (scored.length) {
    const ids = new Set(scored.map(x => x.e.id));
    try { update(file(projDir), { seq: 0, entries: [] }, d => { for (const e of d.entries) if (ids.has(e.id)) e.hits++; }); } catch {}
  }
  return scored.map(({ e }) => ({ ...e, stale: isStale(root, e) }));
}

function fmt(e) {
  const flags = [e.verified ? 'verified' : 'unverified', e.stale ? 'STALE' : '', e.status !== 'active' ? e.status : ''].filter(Boolean).join(',');
  const files = (e.files || []).length ? ` [${e.files.map(f => f.path).join(', ')}]` : '';
  return `${e.id} ${e.kind} (${flags}, ${e.source}): ${e.text}${files}`;
}

function counts(projDir) {
  const db = readJson(file(projDir), { entries: [] });
  return db.entries.filter(e => e.status === 'active').length;
}

module.exports = { KINDS, write, search, setStatus, fmt, counts, tokens, jaccard };
