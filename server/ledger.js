'use strict';
// Cross-process job ledger (one per project). Every state change is a locked transaction on
// ledger.json, so several Claude sessions — each with its own MCP server — coordinate safely.
//
// Invariants (tested in test/ledger.test.js):
//  I1  At most one *running/integrating* in-place writer owns any path (no overlapping claims).
//  I2  running + integrating jobs ≤ the acquiring session's maxParallel, across all sessions.
//  I3  A job starts only after every job in `after` finished successfully (otherwise: skipped).
//  I4  Overlapping in-place writers start in submission order (ticket order ⇒ no starvation).
//  I5  A running job whose lease expired (owner dead or no heartbeat for LEASE_MS) becomes
//      `interrupted`; its claims are released. Owner writes carry the owner's session id, so a
//      reaped job can never be resurrected by a late write (fencing).
// Deadlock freedom: claims are taken all at once (no hold-and-wait) and `after` may only name
// earlier jobs, so the wait-for graph is acyclic.
const path = require('path');
const crypto = require('crypto');
const { update, readJson, pidAlive } = require('./store');

const VERSION = 2;
const LEASE_MS = 60000;
const HEARTBEAT_MS = 15000;
const KEEP_FINISHED = 60;
const ACTIVE = new Set(['queued', 'running', 'integrating']);
const HOLDING = new Set(['running', 'integrating']);
const SUCCESS = new Set(['verified', 'answered']); // unverified changes must not satisfy dependencies
// Stopped, not finished: the work can continue later (provider limit, session ended, owner crashed).
// Never pruned, and a dependent of one is suspended with it rather than skipped.
const RESUMABLE = new Set(['suspended', 'interrupted']);

const SESSION_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const file = projDir => path.join(projDir, 'ledger.json');
const empty = () => ({ version: VERSION, seq: 0, jobs: {} });

const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const anyOverlap = (as, bs) => as.some(a => bs.some(b => overlaps(a, b)));
const claimPaths = j => (j.paths && j.paths.length ? j.paths : ['.']);

// v1 kept jobs.json without seq/leases; import its history read-only.
function migrate(doc, projDir) {
  if (doc.version === VERSION) return;
  Object.assign(doc, { ...empty(), ...doc, version: VERSION });
  const v1 = readJson(path.join(projDir, 'jobs.json'), null);
  if (v1 && v1.jobs) {
    for (const j of Object.values(v1.jobs)) {
      if (doc.jobs[j.id]) continue;
      doc.jobs[j.id] = { ...j, seq: Number(String(j.id).slice(1)) || 0, isolation: 'inplace', after: [], owner: { pid: j.pid, sid: 'v1', hb: 0 }, status: ACTIVE.has(j.status) ? 'interrupted' : j.status };
      doc.seq = Math.max(doc.seq, doc.jobs[j.id].seq);
    }
  }
}

function expired(j, now) {
  return HOLDING.has(j.status) && (!pidAlive(j.owner && j.owner.pid) || now - ((j.owner && j.owner.hb) || 0) > LEASE_MS);
}

function reap(doc, now) {
  const reaped = [];
  for (const j of Object.values(doc.jobs)) {
    if (expired(j, now) || (j.status === 'queued' && !pidAlive(j.owner && j.owner.pid))) {
      j.status = 'interrupted';
      j.finished = now;
      j.note = j.worktree ? `owner died; worktree kept at ${j.worktree.path}` : 'owner died; any partial in-place changes were left untouched';
      if (j.worktree) { try { require('./worktree').unlinkLinks(j.worktree, j.root); } catch {} } // lazy: keeps the guard hook's fast path light
      reaped.push(j.id);
    }
  }
  const done = Object.values(doc.jobs).filter(j => !ACTIVE.has(j.status) && !RESUMABLE.has(j.status)).sort((a, b) => b.seq - a.seq);
  for (const j of done.slice(KEEP_FINISHED)) delete doc.jobs[j.id];
  return reaped;
}

// Version-less fallback so a missing ledger still imports v1 jobs.json once.
function txn(projDir, fn) { return update(file(projDir), {}, doc => { reap(doc, Date.now()); return fn(doc); }, d => migrate(d, projDir)); }

function submit(projDir, job) {
  return txn(projDir, doc => {
    for (const dep of job.after || []) if (!doc.jobs[dep]) throw new Error(`after: unknown job ${dep}`);
    const seq = ++doc.seq;
    const j = { ...job, id: `j${seq}`, seq, status: 'queued', created: Date.now(), owner: { pid: process.pid, sid: SESSION_ID, hb: Date.now() } };
    doc.jobs[j.id] = j;
    return structuredClone(j);
  });
}

// Try to move a queued job to running. Returns { acquired, isolation } | { wait: reason } | { skip: reason } | { gone: status }.
// `isolationPref`: 'inplace' | 'worktree' | 'auto' (auto = in place unless that would have to wait for a path owner).
function tryAcquire(projDir, id, { maxParallel, isolationPref = 'auto', canIsolate = true }) {
  return txn(projDir, doc => {
    const j = doc.jobs[id];
    if (!j || j.owner.sid !== SESSION_ID) return { gone: j ? 'not owner' : 'missing' };
    if (j.status !== 'queued') return { gone: j.status };
    for (const dep of j.after || []) {
      const d = doc.jobs[dep];
      if (!d) { j.status = 'skipped'; j.finished = Date.now(); j.note = `dependency ${dep} no longer in ledger`; return { skip: j.note }; }
      if (ACTIVE.has(d.status)) return { wait: `waiting for ${dep}` };
      if (RESUMABLE.has(d.status)) {
        j.status = 'suspended'; j.finished = Date.now();
        j.result = { suspension: { kind: 'dependency', reason: `dependency ${dep} is ${d.status}`, at: Date.now() } };
        return { suspend: j.result.suspension.reason };
      }
      if (!SUCCESS.has(d.status) && d.status !== 'taken_over') { j.status = 'skipped'; j.finished = Date.now(); j.note = `dependency ${dep} ended ${d.status}`; return { skip: j.note }; }
    }
    const others = Object.values(doc.jobs).filter(o => o.id !== id);
    const holding = others.filter(o => HOLDING.has(o.status));
    if (holding.length >= maxParallel) return { wait: `all ${maxParallel} slots busy` };
    // Slot fairness: an earlier queued job of a live session that is ready to run goes first.
    const earlierReady = others.find(o => o.status === 'queued' && o.seq < j.seq && pidAlive(o.owner.pid) && (o.after || []).every(d => doc.jobs[d] && SUCCESS.has(doc.jobs[d].status)) && !(o.mode === 'implement' && o.isolation !== 'worktree' && pathBlocked(o, others.concat(j))));
    if (earlierReady) return { wait: `fair share: ${earlierReady.id} is ahead` };

    let isolation = j.mode === 'implement' ? (isolationPref === 'worktree' && canIsolate ? 'worktree' : 'inplace') : 'none';
    if (isolation === 'inplace' && pathBlocked(j, others)) {
      if (isolationPref === 'auto' && canIsolate) isolation = 'worktree';
      else return { wait: 'paths owned by another writer' };
    }
    j.status = 'running';
    j.isolation = isolation;
    j.started = Date.now();
    j.owner.hb = Date.now();
    return { acquired: true, isolation };
  });
}

// I1 + I4: blocked by a holding in-place writer, or by an earlier queued in-place writer, on overlapping paths.
function pathBlocked(j, others) {
  const mine = claimPaths(j);
  return others.some(o => {
    if (o.status === 'integrating') return anyOverlap(o.integrating, mine);
    return o.mode === 'implement' && o.isolation !== 'worktree' && anyOverlap(claimPaths(o), mine) &&
      (HOLDING.has(o.status) || (o.status === 'queued' && o.seq < j.seq && pidAlive(o.owner.pid)));
  });
}

// Integration of an isolated job: claim the paths it changed, briefly, like an in-place writer.
function tryIntegrate(projDir, id, paths) {
  return txn(projDir, doc => {
    const j = doc.jobs[id];
    if (!j || j.owner.sid !== SESSION_ID || j.status !== 'running') return { gone: j ? j.status : 'missing' };
    const others = Object.values(doc.jobs).filter(o => o.id !== id);
    const busy = others.find(o => HOLDING.has(o.status) && (o.isolation === 'inplace' || o.status === 'integrating') && anyOverlap(o.status === 'integrating' ? o.integrating : claimPaths(o), paths));
    if (busy) return { wait: `${busy.id} owns overlapping paths` };
    j.status = 'integrating';
    j.integrating = paths.length ? paths : ['.'];
    j.owner.hb = Date.now();
    return { acquired: true };
  });
}

// Owner-fenced patch. Returns false (and changes nothing) if this session no longer owns the job.
function patch(projDir, id, fields) {
  return txn(projDir, doc => {
    const j = doc.jobs[id];
    if (!j || j.owner.sid !== SESSION_ID || !ACTIVE.has(j.status)) return false;
    Object.assign(j, fields);
    if (!ACTIVE.has(j.status)) { j.finished = j.finished || Date.now(); delete j.integrating; }
    j.owner.hb = Date.now();
    return true;
  });
}

// Record facts on a job that has ended (e.g. crash recovery done by another session). Not owner-fenced.
function annotate(projDir, id, fields) {
  return txn(projDir, doc => { const j = doc.jobs[id]; if (j && !ACTIVE.has(j.status)) Object.assign(j, fields); return !!j; });
}

// Continue a stopped job in this session: back to the queue with a new owner. The job keeps its id,
// spec and history; resumeFrom carries what the next run may reuse (thread, worktree, snapshots).
function resume(projDir, id) {
  return txn(projDir, doc => {
    const j = doc.jobs[id];
    if (!j) throw new Error(`unknown job ${id}`);
    if (!RESUMABLE.has(j.status)) throw new Error(`job ${id} is ${j.status}; only suspended or interrupted jobs can be resumed`);
    (j.history = j.history || []).push({ at: Date.now(), from: j.status, by: SESSION_ID, reason: (j.result && j.result.suspension && j.result.suspension.reason) || j.note || null });
    // A crashed owner left no summary: continue from its recorded worktree (in place, the drift check decides).
    j.resumeFrom = (j.result && j.result.resumeFrom) || { worktree: j.worktree || null };
    if (j.resumeFrom.worktree) j.isolationPref = 'worktree'; // continue where its partial work is
    Object.assign(j, { status: 'queued', owner: { pid: process.pid, sid: SESSION_ID, hb: Date.now() }, resumed: (j.resumed || 0) + 1 });
    delete j.finished; delete j.result; delete j.integrating;
    return structuredClone(j);
  });
}

// Someone else (Claude, or the user) did the work of a stopped job: it must never be resumed and repeated.
function takeOver(projDir, id, by, note) {
  return txn(projDir, doc => {
    const j = doc.jobs[id];
    if (!j) throw new Error(`unknown job ${id}`);
    if (!RESUMABLE.has(j.status) && j.status !== 'queued') throw new Error(`job ${id} is ${j.status}`);
    if (j.status === 'queued' && pidAlive(j.owner.pid) && j.owner.sid !== SESSION_ID) throw new Error(`job ${id} is queued in another live session`);
    (j.history = j.history || []).push({ at: Date.now(), from: j.status, by: SESSION_ID, reason: 'taken over' });
    Object.assign(j, { status: 'taken_over', finished: Date.now(), takenOverBy: String(by || 'claude').slice(0, 40), note: String(note || '').slice(0, 300) });
    return structuredClone(j);
  });
}

function heartbeat(projDir, ids) {
  return txn(projDir, doc => {
    let n = 0;
    for (const id of ids) {
      const j = doc.jobs[id];
      if (j && j.owner.sid === SESSION_ID && ACTIVE.has(j.status)) { j.owner.hb = Date.now(); n++; }
    }
    return n;
  });
}

function list(projDir) {
  return txn(projDir, doc => Object.values(doc.jobs).sort((a, b) => b.seq - a.seq).map(j => structuredClone(j)));
}

function get(projDir, id) { return txn(projDir, doc => (doc.jobs[id] ? structuredClone(doc.jobs[id]) : null)); }

// Lock-free read for hooks: path claims currently held by in-place writers or integrations.
function heldClaims(projDir) {
  const doc = readJson(file(projDir), null);
  if (!doc || !doc.jobs) return [];
  const now = Date.now();
  return Object.values(doc.jobs)
    .filter(j => HOLDING.has(j.status) && !expired(j, now) && (j.status === 'integrating' || (j.mode === 'implement' && j.isolation === 'inplace')))
    .map(j => ({ id: j.id, paths: j.status === 'integrating' ? j.integrating : claimPaths(j), status: j.status }));
}

// Paths other Tandem jobs could have written in the main tree while job `id` ran: claims of in-place
// writers and paths of integrations that were live at any point since it started. A scope audit of
// `id` must not attribute these to it. Edits by the user or Claude cannot be attributed this way.
function concurrentWrites(projDir, id) {
  const doc = readJson(file(projDir), null);
  const me = doc && doc.jobs && doc.jobs[id];
  if (!me) return [];
  const since = me.started || me.created;
  const paths = [];
  for (const o of Object.values(doc.jobs)) {
    if (o.id === id || o.mode !== 'implement' || (!HOLDING.has(o.status) && !(o.finished > since))) continue;
    if (o.isolation === 'inplace') paths.push(...claimPaths(o));
    else if (o.integrating) paths.push(...o.integrating);
    else if (o.result && o.result.integration && o.result.integration.applied) paths.push(...o.result.integration.applied.map(a => a.path));
  }
  return [...new Set(paths)];
}

module.exports = { VERSION, LEASE_MS, HEARTBEAT_MS, ACTIVE, HOLDING, SUCCESS, RESUMABLE, resume, takeOver, SESSION_ID, file, submit, tryAcquire, tryIntegrate, patch, annotate, heartbeat, list, get, heldClaims, concurrentWrites, overlaps, anyOverlap, migrate, reap };
