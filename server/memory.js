'use strict';
// Shared project memory (schema v2).
//
// Entry: { id, kind, text, files:[{path, hash}], confidence: 'verified'|'tentative', status,
//          source:{agent, model?, job?}, created, updated, lastUsed, uses, supersedes? }
//  kind        decision | constraint | fact | issue | note
//  status      active | resolved | superseded | invalidated | expired
//  confidence  only Claude (or a passing verification) can make an entry 'verified'; model
//              findings always enter as 'tentative' and are shown as such to every agent.
// Guarantees: sanitised + secret-redacted text; near-duplicates merged; contradicted entries retired
// via `supersedes`; STALE when a cited file's content hash changes; tentative entries unused for
// 30 days expire; ≤ ACTIVE_CAP active and ≤ INACTIVE_CAP inactive entries; all writes are locked
// transactions with .bak recovery.
const fs = require('fs');
const path = require('path');
const { update, readJson, sha1 } = require('./store');
const { sanitize, redactSecrets, confine } = require('./security');

const VERSION = 2;
const KINDS = ['decision', 'constraint', 'fact', 'issue', 'note'];
const STATUSES = ['active', 'resolved', 'superseded', 'invalidated', 'expired'];
const ACTIVE_CAP = 400, INACTIVE_CAP = 200;
const TENTATIVE_TTL_MS = 30 * 864e5;
const DUP_THRESHOLD = 0.7;
const STOP = new Set('the a an and or of to in on for is are be with this that it as at by from not no use uses used was were has have its into than then when which'.split(' '));

const file = projDir => path.join(projDir, 'memory.json');
const empty = () => ({ version: VERSION, seq: 0, entries: [] });

function tokens(text) { return String(text).toLowerCase().split(/[^a-z0-9_.\/-]+/).filter(t => t.length > 1 && !STOP.has(t)); }
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / ((A.size + B.size - inter) || 1);
}

// v1: { seq, entries:[{ verified, source:'claude'|'codex:x', files:[{path, mtimeMs}], kind incl. 'done' }] }
function migrate(db) {
  if (db.version === VERSION) return;
  db.version = VERSION;
  db.seq = db.seq || 0;
  db.entries = (db.entries || []).map(e => ({
    id: e.id, kind: e.kind === 'done' ? 'note' : (KINDS.includes(e.kind) ? e.kind : 'note'),
    text: sanitize(e.text), files: (e.files || []).map(f => ({ path: f.path, hash: null })),
    confidence: e.verified ? 'verified' : 'tentative', status: STATUSES.includes(e.status) ? e.status : 'active',
    source: typeof e.source === 'string' ? { agent: e.source.split(':')[0], model: e.source.split(':')[1] } : (e.source || { agent: 'claude' }),
    created: e.created || Date.now(), updated: e.updated || Date.now(), lastUsed: e.updated || Date.now(), uses: e.hits || 0,
  }));
}

function load(projDir) { const db = readJson(file(projDir), empty()); migrate(db); return db; }
function txn(projDir, fn) { return update(file(projDir), empty, fn, migrate); }

function fileHash(root, p) {
  try { return sha1(fs.readFileSync(path.resolve(root, p))); } catch { return null; }
}
// Cache per call so each cited file is hashed at most once per search.
function staleChecker(root) {
  const cache = new Map();
  return e => (e.files || []).some(f => {
    if (!f.hash) return false;
    if (!cache.has(f.path)) cache.set(f.path, fileHash(root, f.path));
    return cache.get(f.path) !== f.hash;
  });
}

function write(projDir, root, { kind = 'note', text, files = [], verified = false, source = { agent: 'claude' }, supersedes }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const red = redactSecrets(sanitize(text));
  const clean = red.text;
  if (!clean) throw new Error('text required');
  const stamps = files.slice(0, 20).map(p => { const rel = confine(root, p); return { path: rel, hash: fileHash(root, rel) }; });
  return txn(projDir, db => {
    const now = Date.now();
    for (const id of [].concat(supersedes || [])) {
      const old = db.entries.find(e => e.id === id);
      if (old && old.status === 'active') { old.status = 'superseded'; old.updated = now; }
    }
    const tk = tokens(clean);
    const dup = db.entries.find(e => e.status === 'active' && e.kind === kind && jaccard(tokens(e.text), tk) >= DUP_THRESHOLD);
    if (dup) {
      // A tentative restatement never downgrades or overwrites a verified entry.
      if (dup.confidence === 'verified' && !verified) { dup.uses++; return { id: dup.id, action: 'kept-verified', redacted: red.found }; }
      dup.text = clean; dup.updated = now; dup.source = source;
      if (verified) dup.confidence = 'verified';
      if (stamps.length) dup.files = stamps;
      return { id: dup.id, action: 'merged', redacted: red.found };
    }
    const id = `m${++db.seq}`;
    db.entries.push({ id, kind, text: clean, files: stamps, confidence: verified ? 'verified' : 'tentative', status: 'active', source, created: now, updated: now, lastUsed: now, uses: 0, ...(supersedes ? { supersedes: [].concat(supersedes) } : {}) });
    housekeep(db, now);
    return { id, action: 'added', redacted: red.found };
  });
}

function housekeep(db, now) {
  for (const e of db.entries) {
    if (e.status === 'active' && e.confidence === 'tentative' && now - Math.max(e.lastUsed, e.updated) > TENTATIVE_TTL_MS) { e.status = 'expired'; e.updated = now; }
  }
  const active = db.entries.filter(e => e.status === 'active');
  const inactive = db.entries.filter(e => e.status !== 'active');
  const value = e => (e.confidence === 'verified' ? 4 : 0) + (['decision', 'constraint'].includes(e.kind) ? 3 : 0) + Math.min(e.uses, 5) + Math.max(0, 3 - (now - e.lastUsed) / (10 * 864e5));
  active.sort((a, b) => value(b) - value(a));
  inactive.sort((a, b) => b.updated - a.updated);
  const keepActive = active.slice(0, ACTIVE_CAP);
  for (const e of active.slice(ACTIVE_CAP)) { e.status = 'expired'; inactive.unshift(e); }
  db.entries = [...keepActive, ...inactive.slice(0, INACTIVE_CAP)].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

function setStatus(projDir, id, { status, verified, text }) {
  if (status && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  return txn(projDir, db => {
    const e = db.entries.find(x => x.id === id);
    if (!e) return null;
    if (status) e.status = status;
    if (verified !== undefined) e.confidence = verified ? 'verified' : 'tentative';
    if (text) e.text = redactSecrets(sanitize(text)).text;
    e.updated = Date.now();
    return { id, status: e.status, confidence: e.confidence };
  });
}

// BM25 over text + cited paths, boosted by confidence, durable kinds and recency; stale entries are
// demoted, not hidden. `touch` records use (only for retrievals that actually feed an agent).
function search(projDir, root, { query = '', kinds, limit = 8, includeInactive = false, touch = false } = {}) {
  const db = load(projDir);
  const pool = db.entries.filter(e => (includeInactive || e.status === 'active') && (!kinds || kinds.includes(e.kind)));
  const q = [...new Set(tokens(query))];
  const docs = pool.map(e => tokens(e.text + ' ' + (e.files || []).map(f => f.path).join(' ')));
  const avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1);
  const df = new Map(q.map(t => [t, docs.reduce((n, d) => n + (d.includes(t) ? 1 : 0), 0)]));
  const now = Date.now();
  const stale = staleChecker(root);
  const scored = [];
  pool.forEach((e, i) => {
    let s = 0;
    for (const t of q) {
      const tf = docs[i].reduce((n, x) => n + (x === t ? 1 : 0), 0);
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * docs[i].length / (avg || 1)));
    }
    if (q.length && s === 0) return;
    const boost = (e.confidence === 'verified' ? 1.3 : 1) * (['decision', 'constraint'].includes(e.kind) ? 1.2 : 1) * (1 + 0.2 * Math.exp(-(now - e.updated) / (7 * 864e5)));
    scored.push({ e, s: (q.length ? s : 1) * boost });
  });
  scored.sort((a, b) => b.s - a.s);
  const out = [];
  for (const { e } of scored) {
    if (out.length >= limit) break;
    out.push({ ...e, stale: stale(e) });
  }
  out.sort((a, b) => Number(a.stale) - Number(b.stale)); // fresh first, preserving rank otherwise
  if (touch && out.length) {
    const ids = new Set(out.map(e => e.id));
    try { txn(projDir, d => { for (const e of d.entries) if (ids.has(e.id)) { e.uses++; e.lastUsed = now; } }); } catch {}
  }
  return out;
}

function fmt(e) {
  const flags = [e.confidence, e.stale ? 'STALE' : '', e.status !== 'active' ? e.status : ''].filter(Boolean).join(',');
  const src = e.source ? [e.source.agent, e.source.model, e.source.job].filter(Boolean).join(':') : '?';
  const files = (e.files || []).length ? ` [${e.files.map(f => f.path).join(', ')}]` : '';
  return `${e.id} ${e.kind} (${flags}; ${src}): ${e.text}${files}`;
}

function counts(projDir) {
  const db = load(projDir);
  const c = { active: 0, verified: 0, tentative: 0, inactive: 0 };
  for (const e of db.entries) { if (e.status === 'active') { c.active++; c[e.confidence]++; } else c.inactive++; }
  return c;
}

module.exports = { VERSION, KINDS, STATUSES, ACTIVE_CAP, write, search, setStatus, fmt, counts, tokens, jaccard, migrate, load, file };
