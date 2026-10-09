'use strict';
// Job manager: queues Codex work, enforces path ownership between concurrent writers, runs the
// verify -> escalate loop, records outcomes for the router and findings for shared memory.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const store = require('./store');
const codex = require('./codex');
const router = require('./router');
const memory = require('./memory');

const ACTIVE = new Set(['queued', 'running']);
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'failed', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'files_changed', 'verification', 'findings', 'open_questions'],
  additionalProperties: false,
};

const rel = (root, p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/') || '.';
const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function jobsFile(projDir) { return path.join(projDir, 'jobs.json'); }

// Active write claims from every live session on this project (used by the edit-guard hook too).
function activeClaims(projDir, exceptId) {
  const db = store.readJson(jobsFile(projDir), { jobs: {} });
  return Object.values(db.jobs).filter(j => j.id !== exceptId && j.mode === 'implement' && ACTIVE.has(j.status) && store.pidAlive(j.pid))
    .map(j => ({ id: j.id, paths: j.paths.length ? j.paths : ['.'], status: j.status }));
}

function gitDirty(root) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: root, windowsHide: true, maxBuffer: 64 << 20 }).toString();
    const parts = out.split('\0'), files = new Set();
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      files.add(parts[i].slice(3));
      if (/^[RC]/.test(parts[i])) i++; // rename/copy: next field is the source path
    }
    return files;
  } catch { return new Set(); }
}

function detectVerify(root) {
  const has = f => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    const t = ((store.readJson(path.join(root, 'package.json'), {}) || {}).scripts || {}).test;
    if (t && !/no test specified/.test(t)) return 'npm test --silent';
  }
  if (has('pytest.ini') || (has('pyproject.toml') && /pytest/.test(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')))) return 'python -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test -q';
  if (has('go.mod')) return 'go test ./...';
  return null;
}

function runShell(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let out = '';
    const keep = d => { out = (out + d).slice(-6000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { out += '\n[tandem] verification timed out'; codex.killTree(child); }, timeoutMs);
    child.on('error', e => { out += String(e.message); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, code, tail: out.slice(-2500).trim(), ms: Date.now() - started }); });
  });
}

function parseReport(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.status === 'string') return j;
  } catch {}
  return { status: 'partial', summary: String(text || '(no final message)').slice(0, 1500), files_changed: [], verification: '', findings: [], open_questions: [], unstructured: true };
}

class JobManager {
  constructor(cfg, { onProgress } = {}) {
    this.cfg = cfg;
    this.onProgress = onProgress || (() => {});
    this.live = new Map(); // id -> { promise, child, cancelled }
    this.running = 0;
    this.waiters = [];
  }

  ctx(cwd) {
    const root = store.projectRoot(cwd || process.env.TANDEM_PROJECT_DIR || process.cwd());
    return { root, projDir: store.projectDir(root) };
  }

  // Mark jobs orphaned by a dead server process (crash, closed session) as interrupted.
  recover(projDir) {
    store.update(jobsFile(projDir), { jobs: {} }, db => {
      for (const j of Object.values(db.jobs)) if (ACTIVE.has(j.status) && !store.pidAlive(j.pid)) { j.status = 'interrupted'; j.finished = Date.now(); }
      const done = Object.values(db.jobs).filter(j => !ACTIVE.has(j.status)).sort((a, b) => b.created - a.created);
      for (const j of done.slice(50)) delete db.jobs[j.id];
    });
  }

  save(projDir, job) { store.update(jobsFile(projDir), { jobs: {} }, db => { db.jobs[job.id] = job; }); }

  list(cwd) {
    const { projDir } = this.ctx(cwd);
    this.recover(projDir);
    return Object.values(store.readJson(jobsFile(projDir), { jobs: {} }).jobs).sort((a, b) => b.created - a.created);
  }

  submit(spec) {
    const { root, projDir } = this.ctx(spec.cwd);
    this.recover(projDir);
    const mode = ['ask', 'implement', 'review'].includes(spec.mode) ? spec.mode : 'ask';
    if (mode === 'implement' && !store.isGitRepo(root) && !spec.allow_non_git) {
      throw new Error('implement mode needs a git repository so changes can be reviewed and reverted (pass allow_non_git: true to override).');
    }
    const id = store.update(path.join(projDir, 'seq.json'), { n: 0 }, s => `j${++s.n}`);
    const job = {
      id, pid: process.pid, root, mode, status: 'queued', created: Date.now(),
      difficulty: router.DIFFICULTIES.includes(spec.difficulty) ? spec.difficulty : 'normal',
      task: String(spec.task || '').trim(), context: spec.context ? String(spec.context) : '',
      paths: (spec.paths || []).map(p => rel(root, p)), verify: spec.verify ?? 'auto',
      model: spec.model || null, effort: spec.effort || null, maxAttempts: Math.max(1, Math.min(4, spec.max_attempts || 2)),
      attempts: [], result: null,
    };
    if (!job.task) throw new Error('task required');
    this.save(projDir, job);
    const entry = { job, cancelled: false, child: null };
    entry.promise = this.schedule(job, projDir, entry).catch(e => {
      job.status = 'failed'; job.result = { error: String(e && e.stack || e) }; job.finished = Date.now();
      this.save(projDir, job);
      return job;
    });
    this.live.set(id, entry);
    return { job, promise: entry.promise };
  }

  async schedule(job, projDir, entry) {
    // Wait for a free slot and for no other live writer to own overlapping paths.
    for (;;) {
      if (entry.cancelled) return this.finish(job, projDir, 'cancelled', {});
      const blocked = job.mode === 'implement' && activeClaims(projDir, job.id)
        .some(c => c.status === 'running' && c.paths.some(p => (job.paths.length ? job.paths : ['.']).some(q => overlaps(p, q))));
      if (this.running < this.cfg.maxParallel && !blocked) break;
      await new Promise(r => { this.waiters.push(r); setTimeout(r, 2000); });
    }
    this.running++;
    try { return await this.execute(job, projDir, entry); } finally {
      this.running--;
      this.waiters.splice(0).forEach(r => r());
    }
  }

  finish(job, projDir, status, result) {
    job.status = status; job.result = result; job.finished = Date.now();
    this.save(projDir, job);
    return job;
  }

  async execute(job, projDir, entry) {
    const { cfg } = this;
    job.status = 'running'; job.started = Date.now();
    this.save(projDir, job);
    const env = await codex.discover();
    const unav = codex.unavailable();
    if (!env.installed) return this.finish(job, projDir, 'codex_unavailable', { error: 'Codex CLI not installed (npm i -g @openai/codex).' });
    if (!env.loggedIn) return this.finish(job, projDir, 'codex_unavailable', { error: `Codex not logged in (${env.login}). Run: codex login` });
    if (unav['*']) return this.finish(job, projDir, 'codex_unavailable', { error: `Codex rate-limited until ${new Date(unav['*'].until).toLocaleTimeString()}: ${unav['*'].reason}` });

    let rungs = router.ladder(env.models, cfg, unav);
    if (job.model || job.effort) {
      const model = job.model || (rungs[router.startIndex(rungs, job.difficulty, job.mode, projDir)] || {}).model;
      if (!model || !router.withinCeiling(model, cfg.codexMaxModel)) return this.finish(job, projDir, 'rejected', { error: `model ${model} is above the configured ceiling ${cfg.codexMaxModel} or unknown` });
      const effort = job.effort || 'medium';
      if (!router.effortAllowed(effort, cfg.codexMaxEffort)) return this.finish(job, projDir, 'rejected', { error: `effort ${effort} exceeds ceiling ${cfg.codexMaxEffort}` });
      rungs = [{ model, effort, tier: 0 }, ...rungs.filter(r => r.model !== model || router.EFFORTS.indexOf(r.effort) > router.EFFORTS.indexOf(effort))];
    }
    if (!rungs.length) return this.finish(job, projDir, 'codex_unavailable', { error: `no Codex model within ceiling ${cfg.codexMaxModel} is available` });

    const startIdx = job.model || job.effort ? 0 : router.startIndex(rungs, job.difficulty, job.mode, projDir);
    const schemaFile = path.join(store.DATA, 'output-schema.json');
    if (!fs.existsSync(schemaFile)) store.writeJson(schemaFile, OUTPUT_SCHEMA);
    const verifyCmd = job.mode !== 'implement' || job.verify === 'none' ? null : job.verify === 'auto' ? detectVerify(job.root) : job.verify;
    const dirtyBefore = job.mode === 'implement' ? gitDirty(job.root) : new Set();

    let idx = startIdx, threadId = null, threadModel = null, lastFail = null, report = null, verification = null;
    let firstOk = null, transientRetried = false, extra = 0;
    const usage = { input: 0, cached: 0, output: 0 };
    const changed = new Set();

    for (let n = 1; n <= job.maxAttempts + extra; n++) {
      if (entry.cancelled) break;
      const rung = rungs[Math.min(idx, rungs.length - 1)];
      const resume = threadId && threadModel === rung.model;
      const prompt = n === 1 || !resume ? this.prompt(job, projDir, lastFail) : this.retryPrompt(lastFail);
      const args = this.args(job, rung, resume ? threadId : null, schemaFile);
      this.onProgress(job.id, `attempt ${n}: ${rung.model}@${rung.effort}`);
      const run = codex.runCodex({
        args, prompt, cwd: job.root, timeoutMs: cfg.jobTimeoutMs,
        onEvent: ev => { if (ev.type === 'item.completed' && ev.item && ev.item.type === 'command_execution') this.onProgress(job.id, `$ ${String(ev.item.command).slice(0, 80)}`); },
      });
      entry.child = run.child;
      const res = await run.done;
      entry.child = null;
      usage.input += res.usage ? res.usage.input : 0; usage.cached += res.usage ? res.usage.cached : 0; usage.output += res.usage ? res.usage.output : 0;
      (res.files || []).forEach(f => changed.add(rel(job.root, f)));
      const att = { model: rung.model, effort: rung.effort, ms: res.durationMs, tokens: res.usage ? res.usage.input + res.usage.output : 0, error: res.error ? String(res.error).slice(0, 300) : null, errorKind: res.errorKind };
      job.attempts.push(att);
      this.save(projDir, job);

      if (entry.cancelled) break;
      if (!res.ok) {
        if (res.errorKind === 'model_unavailable') {
          codex.markUnavailable(rung.model, String(res.error).slice(0, 200), 24 * 3600e3);
          // Rebuild so an older model of the same family can stand in; explicit overrides just drop the model.
          rungs = job.model || job.effort ? rungs.filter(r => r.model !== rung.model) : router.ladder(env.models, cfg, codex.unavailable());
          if (!rungs.length) return this.finish(job, projDir, 'codex_unavailable', { error: 'no remaining Codex model is available to this account', attempts: job.attempts });
          idx = Math.min(idx, rungs.length - 1); extra++; continue;
        }
        if (res.errorKind === 'rate_limited') {
          codex.markUnavailable('*', String(res.error).slice(0, 200), codex.retryAfterMs(res.error));
          return this.done(job, projDir, 'codex_unavailable', { error: `Codex usage/rate limit reached: ${String(res.error).slice(0, 300)}. Do the work in Claude instead.`, usage, changed, dirtyBefore, firstOk: false, rung: rungs[startIdx] });
        }
        if (res.errorKind === 'auth' || res.errorKind === 'missing') return this.finish(job, projDir, 'codex_unavailable', { error: res.error });
        if (res.errorKind !== 'timeout' && !transientRetried) { transientRetried = true; extra++; continue; }
        lastFail = { kind: 'error', text: String(res.error).slice(-1500), report };
        if (firstOk === null) firstOk = false;
        idx++; threadId = res.threadId || threadId; threadModel = res.threadId ? rung.model : threadModel;
        continue;
      }

      threadId = res.threadId; threadModel = rung.model;
      report = parseReport(res.finalText);
      (report.files_changed || []).forEach(f => changed.add(rel(job.root, f)));
      if (job.mode !== 'implement') { firstOk = firstOk ?? report.status === 'done'; break; }
      if (report.status === 'blocked') { firstOk = firstOk ?? false; break; }
      if (!verifyCmd) { firstOk = firstOk ?? report.status === 'done'; break; }
      this.onProgress(job.id, `verifying: ${verifyCmd}`);
      verification = await runShell(verifyCmd, job.root, cfg.verifyTimeoutMs);
      verification.command = verifyCmd;
      att.verified = verification.ok;
      this.save(projDir, job);
      if (verification.ok && report.status === 'done') { firstOk = firstOk ?? true; break; }
      if (firstOk === null) firstOk = false;
      lastFail = { kind: 'verify', text: `Verification command \`${verifyCmd}\` ${verification.ok ? 'passed but you reported status ' + report.status : 'failed (exit ' + verification.code + ')'}:\n${verification.tail}`, report };
      idx++; // escalate one rung for the next attempt
    }

    if (entry.cancelled) return this.done(job, projDir, 'cancelled', { report, verification, usage, changed, dirtyBefore, firstOk: false, rung: rungs[startIdx] });
    let status;
    if (job.mode !== 'implement') status = report ? (report.status === 'done' ? 'answered' : report.status) : 'failed';
    else if (!report) status = 'failed';
    else if (verification) status = verification.ok && report.status === 'done' ? 'verified' : 'failed_verification';
    else status = report.status === 'done' ? 'unverified' : report.status;
    return this.done(job, projDir, status, { report, verification, usage, changed, dirtyBefore, firstOk: !!firstOk, rung: rungs[Math.min(startIdx, rungs.length - 1)], lastError: lastFail && lastFail.kind === 'error' ? lastFail.text : null });
  }

  done(job, projDir, status, { report, verification, usage, changed, dirtyBefore, firstOk, rung, lastError, error }) {
    const result = { report, usage, error: error || lastError || null };
    if (verification) result.verification = { command: verification.command, ok: verification.ok, code: verification.code, tail: verification.ok ? '' : verification.tail.slice(-1200) };
    if (job.mode === 'implement') {
      const others = activeClaims(projDir, job.id).flatMap(c => c.paths);
      for (const f of gitDirty(job.root)) if (!dirtyBefore.has(f) && !others.some(p => overlaps(p, f))) changed.add(f);
      result.changed = [...changed].sort();
      result.outOfScope = job.paths.length ? result.changed.filter(f => !job.paths.some(p => overlaps(p, f))) : [];
      result.concurrentWriters = activeClaims(projDir, job.id).map(c => c.id);
    }
    // Share what was learned. Codex findings stay unverified until Claude confirms them.
    const ids = [];
    try {
      const src = `codex:${(job.attempts[job.attempts.length - 1] || {}).model || '?'}`;
      for (const f of ((report && report.findings) || []).slice(0, 5)) ids.push(memory.write(projDir, job.root, { kind: 'fact', text: f, source: src }).id);
      if (job.mode === 'implement' && report) {
        const kind = status === 'verified' || status === 'unverified' ? 'done' : 'issue';
        ids.push(memory.write(projDir, job.root, { kind, text: `Codex ${job.id} (${status}): ${job.task.slice(0, 160)} -> ${(report.summary || '').slice(0, 200)}`, files: (result.changed || []).slice(0, 10), verified: status === 'verified', source: src }).id);
      }
    } catch {}
    result.memoryIds = ids;
    if (rung && job.attempts.length && !['cancelled', 'codex_unavailable'].includes(status)) {
      try {
        router.recordOutcome(projDir, {
          mode: job.mode, difficulty: job.difficulty, firstOk, rung,
          tokens: job.attempts.reduce((a, x) => a + x.tokens, 0), ms: job.attempts.reduce((a, x) => a + x.ms, 0),
          attempts: job.attempts.length, finalOk: ['verified', 'answered', 'unverified'].includes(status),
        });
      } catch {}
    }
    return this.finish(job, projDir, status, result);
  }

  args(job, rung, resumeThread, schemaFile) {
    const a = resumeThread ? ['exec', 'resume', resumeThread] : ['exec'];
    a.push('--json', '--skip-git-repo-check', '-m', rung.model,
      '-c', `model_reasoning_effort="${rung.effort}"`,
      '-c', `sandbox_mode="${job.mode === 'implement' ? 'workspace-write' : 'read-only'}"`,
      '--output-schema', schemaFile);
    if (this.cfg.leanCodex) a.push('-c', 'skills.max_context_tokens=100', '--disable', 'plugins');
    if (job.mode !== 'implement') a.push('--ephemeral');
    a.push('-');
    return a;
  }

  prompt(job, projDir, lastFail) {
    const L = ['You are a Codex worker delegated by Claude Code (the lead engineer) via the Tandem orchestrator.', '', `TASK (${job.mode}):`, job.task];
    if (job.context) L.push('', 'CONTEXT FROM LEAD:', job.context);
    if (job.mode === 'implement') {
      L.push('', job.paths.length ? `SCOPE: modify only these paths: ${job.paths.join(', ')}` : 'SCOPE: modify only what the task needs; keep the change minimal.');
      const others = activeClaims(projDir, job.id).flatMap(c => c.paths);
      if (others.length) L.push(`Other agents own these paths right now; do not modify them: ${[...new Set(others)].join(', ')}`);
    } else L.push('', 'READ-ONLY: do not modify any files.');
    if (job.mode === 'review') L.push('Review the uncommitted changes (`git status`, `git diff HEAD`). Report concrete defects with file:line, most severe first; skip style nits. Put each defect in findings.');
    const mem = memory.search(projDir, job.root, { query: job.task + ' ' + job.paths.join(' '), limit: 6 });
    if (mem.length) L.push('', 'SHARED PROJECT MEMORY (unverified items may be wrong; STALE means a cited file changed since):', ...mem.map(e => '- ' + memory.fmt(e)));
    if (lastFail) {
      L.push('', 'A previous attempt did not succeed. The working tree may contain its partial changes; review and fix them.');
      if (lastFail.report) L.push(`Previous summary: ${String(lastFail.report.summary || '').slice(0, 600)}`);
      L.push(lastFail.text);
    }
    L.push('', 'RULES: no destructive commands (no deleting data, no git reset/clean/push, no history rewrites); do not commit. The lead has already scoped this task: do not build or refresh code indexes/knowledge graphs or write any file outside the scope. Report honestly: if anything is incomplete, failing, or unverified, use status partial/failed/blocked. findings = durable project facts other agents should know (max 5, one line each, empty if none).');
    return L.join('\n');
  }

  retryPrompt(lastFail) {
    return `${lastFail.text}\n\nFix the problem. Same scope, rules and final JSON format as before.`;
  }

  cancel(id) {
    const e = this.live.get(id);
    if (!e) return false;
    e.cancelled = true;
    if (e.child) codex.killTree(e.child);
    this.waiters.splice(0).forEach(r => r());
    return true;
  }

  // Wait until all given jobs (default: all live ones) finish or the timeout passes.
  async wait(ids, timeoutMs) {
    const targets = (ids && ids.length ? ids : [...this.live.keys()]).map(id => this.live.get(id)).filter(Boolean);
    let timer;
    await Promise.race([Promise.all(targets.map(t => t.promise)), new Promise(r => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }
}

module.exports = { JobManager, activeClaims, overlaps, rel, detectVerify, parseReport, jobsFile, OUTPUT_SCHEMA };
