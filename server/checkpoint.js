'use strict';
// The project's durable task checkpoint: what the lead is trying to achieve and how far it got, kept
// outside any model conversation so work can be continued by another provider, a new session, or the
// CLI. Items carrying a `delegate` spec were authorized for Codex by whoever wrote them; only those
// may be started without the lead (tandem continue). Everything else waits for Claude or the user.
const path = require('path');
const store = require('./store');

const STATUSES = ['todo', 'doing', 'done', 'blocked', 'dropped'];
const file = projDir => path.join(projDir, 'checkpoint.json');
const empty = () => ({ v: 1, updated: 0, objective: '', acceptance: [], constraints: [], decisions: [], next: '', items: [] });
const strs = (xs, max = 40) => (Array.isArray(xs) ? xs.map(x => String(x).slice(0, 500)).slice(0, max) : []);

function load(projDir) { return store.readJson(file(projDir), null) || empty(); }

// Merge: scalar fields and lists replace when given; items upsert by id (fields merge).
function save(projDir, patch, by = 'claude') {
  return store.update(file(projDir), empty, cp => {
    for (const f of ['objective', 'next']) if (patch[f] !== undefined) cp[f] = String(patch[f]).slice(0, 2000);
    for (const f of ['acceptance', 'constraints', 'decisions']) if (patch[f] !== undefined) cp[f] = strs(patch[f]);
    for (const it of patch.items || []) {
      if (!it || typeof it.id !== 'string' || !it.id.trim()) throw new Error('checkpoint item needs an id');
      if (it.status !== undefined && !STATUSES.includes(it.status)) throw new Error(`item ${it.id}: status must be one of ${STATUSES.join(', ')}`);
      let cur = cp.items.find(x => x.id === it.id);
      if (!cur) { if (cp.items.length >= 200) throw new Error('checkpoint is limited to 200 items'); cp.items.push(cur = { id: it.id.slice(0, 40), title: '', status: 'todo', delegate: null, job: null }); }
      if (it.title !== undefined) cur.title = String(it.title).slice(0, 300);
      if (it.status !== undefined) cur.status = it.status;
      if (it.delegate !== undefined) cur.delegate = it.delegate ? { ...it.delegate } : null; // validated when submitted
      if (it.job !== undefined) cur.job = it.job;
    }
    cp.updated = Date.now(); cp.by = by;
    return structuredClone(cp);
  });
}

// Item state follows its job: a job that succeeded completes the item; one that stopped leaves it in progress.
function reconcile(projDir, jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const cp = load(projDir);
  const done = cp.items.filter(it => it.job && it.status !== 'done' && byId.has(it.job) && ['verified', 'answered', 'taken_over'].includes(byId.get(it.job).status));
  return done.length ? save(projDir, { items: done.map(it => ({ id: it.id, status: 'done' })) }, 'tandem') : cp;
}

function summary(cp, jobs = []) {
  if (!cp.updated) return 'checkpoint: none';
  const byId = new Map(jobs.map(j => [j.id, j]));
  const L = [`checkpoint (${new Date(cp.updated).toLocaleString()} by ${cp.by || '?'}): ${cp.objective || '(no objective)'}`];
  if (cp.acceptance.length) L.push('acceptance: ' + cp.acceptance.join(' | '));
  if (cp.constraints.length) L.push('constraints: ' + cp.constraints.join(' | '));
  if (cp.decisions.length) L.push('decisions: ' + cp.decisions.join(' | '));
  for (const it of cp.items) {
    const j = it.job && byId.get(it.job);
    L.push(`  [${it.status}] ${it.id} ${it.title}${it.delegate ? ' (delegable)' : ''}${j ? ` -> ${j.id} ${j.status}` : ''}`);
  }
  if (cp.next) L.push('next: ' + cp.next);
  return L.join('\n');
}

module.exports = { STATUSES, load, save, reconcile, summary, file };
