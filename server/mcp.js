#!/usr/bin/env node
'use strict';
// Tandem MCP server (stdio, newline-delimited JSON-RPC). Zero dependencies.
const fs = require('fs');
const path = require('path');
const { config, EFFORTS } = require('./config');
const { Orchestrator, MODES, DIFFICULTIES } = require('./jobs');
const codex = require('./codex');
const catalog = require('./catalog');
const policy = require('./policy');
const ledger = require('./ledger');
const memory = require('./memory');
const worktree = require('./worktree');
const store = require('./store');
const { frame } = require('./security');

const VERSION = require('../.claude-plugin/plugin.json').version;
const cfg = config();
store.publishDataDir();
const progressTokens = new Map(); // jobId -> progressToken of the call waiting on it
let progressCount = 0;
const orch = new Orchestrator(cfg, {
  onProgress: (id, message) => {
    const token = progressTokens.get(id);
    if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progressCount, message: `${id} ${message}` } });
  },
});
const FOREGROUND_CAP_MS = 9 * 60e3;

const str = (description, extra) => ({ type: 'string', description, ...extra });
const strs = description => ({ type: 'array', items: { type: 'string' }, description });
const TOOLS = [
  {
    name: 'codex_run',
    description: 'Delegate a task to OpenAI Codex. Tandem routes it to the cheapest Codex model/effort expected to succeed (within your ceilings), injects shared memory, verifies implement jobs with the project tests, and escalates on failure. Worth it for well-scoped work; not for edits you can make in a few tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Self-contained instructions: goal, acceptance criteria, relevant files/functions.'),
        mode: str('ask = read-only answer; implement = edit files (needs git); review = read-only review of the uncommitted diff.', { enum: MODES }),
        difficulty: str('Your estimate; it drives routing. trivial=mechanical, normal=typical fix/feature, hard=subtle multi-file logic, critical=high-risk.', { enum: DIFFICULTIES }),
        paths: strs('implement: files/dirs the job owns. Other writers are kept off them; overlapping jobs queue or run isolated. Strongly recommended.'),
        after: strs('Job ids that must finish successfully first (otherwise this job is skipped).'),
        context: str('Facts Codex needs that are not in the repo or memory. Keep short.'),
        verify: str('implement: command proving success, "auto" (detect npm/pytest/cargo/go tests; default) or "none".'),
        isolation: str('implement: auto (default: in place, or an isolated worktree when paths are busy), inplace, or worktree.', { enum: ['auto', 'inplace', 'worktree'] }),
        wait: { type: 'boolean', description: 'true (default): return the result. false: return a job id now; collect with codex_wait.' },
        dry_run: { type: 'boolean', description: 'Return the routing plan (models, efforts, estimates) without running anything.' },
        model: str('Optional explicit Codex model (must be permitted by the ceiling/allow-list).'),
        effort: str('Optional explicit reasoning effort (≤ ceiling).', { enum: EFFORTS }),
        max_attempts: { type: 'integer', minimum: 1, maximum: 4, description: 'Attempts incl. escalations (default 2).' },
        cwd: str('Project directory (default: session project).'),
        allow_non_git: { type: 'boolean', description: 'Allow implement outside a git repo (no isolation, no review safety net).' },
      },
      required: ['task', 'mode', 'difficulty'],
    },
  },
  {
    name: 'codex_wait',
    description: 'Wait for background Codex jobs started by this session and return their results.',
    inputSchema: { type: 'object', properties: { ids: strs('Job ids (default: all unfinished jobs of this session).'), timeout_s: { type: 'integer', minimum: 1, description: 'Max wait (default 540).' } } },
  },
  {
    name: 'codex_jobs',
    description: 'List recent Codex jobs for this project (all sessions), or act on one: cancel (stop a job of this session), show (full result), discard (delete a kept worktree), resume (continue a suspended/interrupted job where it stopped, in the background), takeover (mark a stopped job as done another way so it is never resumed).',
    inputSchema: { type: 'object', properties: { cancel: str('Job id to cancel.'), show: str('Job id to show in full.'), discard: str('Job id whose kept worktree to delete.'), resume: str('Suspended/interrupted job id to continue.'), takeover: str('Suspended/interrupted job id you completed yourself.'), note: str('takeover: what was done instead (short).'), cwd: str('Project directory.') } },
  },
  {
    name: 'memory_search',
    description: 'Search shared project memory (decisions, constraints, facts, issues, notes) written by Claude and Codex. Tentative entries are unconfirmed; STALE entries cite files that changed since. Check before re-exploring.',
    inputSchema: { type: 'object', properties: { query: str('Keywords; empty = most important recent.'), kinds: { type: 'array', items: { type: 'string', enum: memory.KINDS } }, limit: { type: 'integer', minimum: 1, maximum: 50 }, include_inactive: { type: 'boolean' }, cwd: str('Project directory.') } },
  },
  {
    name: 'memory_write',
    description: 'Save one durable, reusable project fact for all agents (not task chatter). Near-duplicates merge. Set verified only if you confirmed it yourself. Secrets are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: str('decision | constraint | fact | issue | note', { enum: memory.KINDS }),
        text: str('One or two sentences.'),
        files: strs('Files the fact depends on (enables staleness detection).'),
        verified: { type: 'boolean' },
        supersedes: strs('Ids of entries this replaces.'),
        cwd: str('Project directory.'),
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'memory_update',
    description: 'Change a memory entry: mark verified/tentative, set status (resolved, superseded, invalidated, active), or reword it.',
    inputSchema: { type: 'object', properties: { id: str('Entry id.'), status: str('New status.', { enum: memory.STATUSES }), verified: { type: 'boolean' }, text: str('Replacement text.'), cwd: str('Project directory.') }, required: ['id'] },
  },
  {
    name: 'tandem_checkpoint',
    description: 'Durable task state that survives this conversation, a Claude usage limit or a closed session (the tandem CLI reads it). Record the objective, acceptance criteria, constraints, decisions and plan items at milestones; mark items done as they land. An item with a delegate spec (codex_run arguments) authorizes Codex to run it without you via `tandem continue`. No arguments = show.',
    inputSchema: { type: 'object', properties: {
      objective: str('What the user asked for, in one or two sentences.'),
      acceptance: strs('Acceptance criteria (replaces the list).'),
      constraints: strs('User constraints that must survive (replaces the list).'),
      decisions: strs('Decisions taken (replaces the list).'),
      next: str('The next step, for whoever continues.'),
      items: { type: 'array', items: { type: 'object' }, description: 'Upsert by id: {id, title?, status? (todo|doing|done|blocked|dropped), delegate? (codex_run arguments, or null)}.' },
      cwd: str('Project directory.'),
    } },
  },
  {
    name: 'tandem_status',
    description: 'Codex install/login, permitted models (and why others are excluded), per-model availability, ceilings, routing estimates per task class, memory size, config problems and recent errors.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Re-run discovery now.' }, cwd: str('Project directory.') } },
  },
];

// Minimal argument validation against each tool's own schema (types, enums, required).
function check(name, a) {
  const schema = TOOLS.find(t => t.name === name).inputSchema;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error('arguments must be an object');
  const errs = [];
  for (const r of schema.required || []) if (a[r] === undefined) errs.push(`${r} is required`);
  for (const [k, v] of Object.entries(a)) {
    const s = schema.properties[k];
    if (!s) { errs.push(`unknown argument ${k}`); continue; }
    const ok = s.type === 'array' ? Array.isArray(v) && v.every(x => typeof x === (s.items.type || 'string') && (!s.items.enum || s.items.enum.includes(x)))
      : s.type === 'integer' ? Number.isInteger(v) && (s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum)
      : typeof v === s.type && (!s.enum || s.enum.includes(v));
    if (!ok) errs.push(`${k}: expected ${s.type}${s.enum ? ' (' + s.enum.join('|') + ')' : ''}`);
  }
  if (errs.length) throw new Error('invalid arguments: ' + errs.join('; '));
  return a;
}

const { formatJob, k, list } = require('./format');
const checkpoint = require('./checkpoint');
const capabilities = require('./capabilities');

async function waitFor(ids, timeoutMs) {
  const want = ids && ids.length ? ids : [...orch.live.entries()].filter(([, e]) => !e.settled).map(([id]) => id);
  await orch.wait(want, timeoutMs);
  return want.map(id => {
    const e = orch.live.get(id);
    if (!e) return `job ${id} was not started by this session (see codex_jobs)`;
    return e.settled ? formatJob(e.job) : `job ${id} still running; call codex_wait again`;
  }).join('\n\n') || 'no unfinished jobs in this session';
}

async function plan(a) {
  const { projDir } = orch.ctx(a.cwd);
  const env = await codex.discover();
  const rungs = catalog.rungs(env.models, cfg, codex.unavailable());
  if (!rungs.length) return 'no permitted and available Codex model; see tandem_status';
  const cls = `${a.mode}|${a.difficulty}`;
  const d = policy.decide(projDir, { cls, rungs, cfg: { ...cfg, exploration: false }, maxAttempts: a.max_attempts || 2 });
  // Measured history of this task class in this project: what delegating it actually cost and yielded.
  const past = ledger.list(projDir).filter(j => `${j.mode}|${j.difficulty}` === cls && j.finished && j.result && j.result.usage);
  const med = xs => (xs.length ? xs.sort((a, b) => a - b)[xs.length >> 1] : 0);
  const ok = past.filter(j => ['verified', 'answered'].includes(j.status)).length;
  const hist = past.length ? `; this project's ${cls} jobs: ${ok}/${past.length} succeeded, median ${Math.round(med(past.map(j => j.finished - (j.started || j.created))) / 1000)}s, median Codex input ${k(med(past.map(j => j.result.usage.input)))} (cached ${k(med(past.map(j => j.result.usage.cached)))})` : `; no finished ${cls} jobs in this project yet`;
  return `plan for ${cls}: ${d.record.plan.map(p => `${p.r} (p=${p.p}, n=${p.n}, cost=${p.C})`).join(' -> ')}; expected cost ${d.record.E} (unit: ${cfg.objective}), ρ=${d.record.rho}, ${d.record.nObs} observations${hist}`;
}

async function status(a) {
  const env = await codex.discover({ force: !!a.refresh });
  const unav = codex.unavailable();
  const { root, projDir } = orch.ctx(a.cwd);
  const elig = catalog.eligible(env.models, cfg, unav);
  const rungs = catalog.rungs(env.models, cfg, unav);
  const avail = codex.availability(env);
  const c = memory.counts(projDir);
  const L = [
    `tandem ${VERSION} | codex: ${env.installed ? env.version : 'NOT INSTALLED'} | ${env.login}`,
    `ceilings: codex ${cfg.codexMaxModel} @ ${cfg.codexMaxEffort}${cfg.codexAllowedModels.length ? ` (allow-list: ${cfg.codexAllowedModels.join(', ')})` : ''}; claude ${cfg.claudeMaxModel} | parallel ${cfg.maxParallel} | isolation ${cfg.isolation} | objective ${cfg.objective} | lean ${cfg.leanCodex}`,
    `permitted: ${elig.models.map(m => `${m.slug} [${avail[m.slug] || 'listed'}]`).join(', ') || 'NONE'}`,
    `excluded: ${elig.excluded.map(([s, why]) => `${s} (${why})`).join(', ') || 'none'}`,
    `rungs: ${rungs.map(catalog.key).join(' < ') || 'EMPTY'}`,
    `unavailable: ${Object.entries(unav).map(([m, x]) => `${m} until ${new Date(x.until).toLocaleString()} (${x.reason})`).join('; ') || 'none'}`,
    `memory: ${c.active} active (${c.verified} verified, ${c.tentative} tentative), ${c.inactive} inactive | project ${root}`,
  ];
  const inv = capabilities.scan(root);
  const by = (p, sc) => inv.skills.filter(s => s.platform === p && (!sc || s.scope === sc)).length;
  const used = Object.entries(capabilities.usage(ledger.list(projDir))).map(([n, x]) => `${n} ${x.verified}/${x.jobs} succeeded`);
  L.push(`skills: codex ${by('codex')} (${inv.skills.filter(s => s.platform === 'codex' && !s.implicit).length} explicit-only), claude ${by('claude')} (${by('claude', 'plugin')} from plugins); ${inv.dupes.length} duplicates ignored${used.length ? '; pointed at in jobs: ' + used.join(', ') : ''}`);
  if (env.configModel && !elig.models.some(m => m.slug === env.configModel)) L.push(`note: your Codex config default model "${env.configModel}" is not usable here; Tandem always passes an explicit model.`);
  if (rungs.length) L.push(...policy.summary(projDir, rungs, cfg).map(s => 'routing ' + s));
  if (cfg.problems.length) L.push('CONFIG PROBLEMS: ' + cfg.problems.join('; '));
  const errLog = path.join(store.DATA, 'errors.log');
  if (fs.existsSync(errLog)) {
    const tail = fs.readFileSync(errLog, 'utf8').trim().split('\n').slice(-3);
    if (tail[0]) L.push(`recent internal errors (${errLog}):\n${list(tail.map(t => t.slice(0, 300)))}`);
  }
  return L.join('\n');
}

const handlers = {
  async codex_run(a, meta) {
    if (a.dry_run) return plan(a);
    const { job, promise } = orch.submit(a);
    if (meta && meta.progressToken !== undefined) progressTokens.set(job.id, meta.progressToken);
    if (a.wait === false) return `job ${job.id} queued (${job.mode}, ${job.difficulty}). Collect with codex_wait.`;
    let timer;
    const finished = await Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(null), FOREGROUND_CAP_MS); })]);
    clearTimeout(timer);
    progressTokens.delete(job.id);
    return finished ? formatJob(finished) : `job ${job.id} still running after ${FOREGROUND_CAP_MS / 60000} min; collect with codex_wait.`;
  },
  async codex_wait(a, meta) {
    const ids = a.ids || [...orch.live.keys()];
    if (meta && meta.progressToken !== undefined) for (const id of ids) progressTokens.set(id, meta.progressToken);
    try { return await waitFor(a.ids, Math.min((a.timeout_s || 540) * 1000, FOREGROUND_CAP_MS)); } finally { for (const id of ids) progressTokens.delete(id); }
  },
  async codex_jobs(a) {
    const { root, projDir } = orch.ctx(a.cwd);
    if (a.cancel) return orch.cancel(a.cancel) ? `cancelling ${a.cancel}` : `job ${a.cancel} is not running in this session`;
    if (a.show) { const j = ledger.get(projDir, a.show); return j ? formatJob(j, true) : `no job ${a.show}`; }
    if (a.resume) {
      const { job } = orch.resume(a.resume, a.cwd);
      return `job ${job.id} resumed (queued, ${job.mode}, attempt history kept). Collect with codex_wait.`;
    }
    if (a.takeover) { const j = orch.takeOver(a.takeover, a.cwd, 'claude', a.note); return `job ${j.id} marked taken_over; it will not be resumed${j.result && j.result.worktreeKept ? `. Its partial work is still in ${j.result.worktreeKept}` : ''}`; }
    if (a.discard) {
      const j = ledger.get(projDir, a.discard);
      const kept = j && j.result && j.result.worktreeKept;
      if (!kept || !fs.existsSync(kept)) return `job ${a.discard} has no kept worktree`;
      if (ledger.ACTIVE.has(j.status)) return `job ${a.discard} is still ${j.status}`;
      // The persisted ledger is not a filesystem authority. Deletion must stay
      // within the managed worktree directory for this project.
      worktree.assertManaged(root, kept);
      worktree.remove(root, { path: kept, linked: (j.worktree && j.worktree.linked) || [] });
      return `deleted worktree ${kept}`;
    }
    return ledger.list(projDir).slice(0, 15).map(j => `${j.id} ${j.status}${j.result && j.result.suspension ? ` (${j.result.suspension.kind})` : ''} [${j.mode}/${j.difficulty}]${j.paths && j.paths.length ? ' paths=' + j.paths.join(',') : ''}${j.after && j.after.length ? ' after=' + j.after.join(',') : ''}${j.owner && j.owner.sid !== ledger.SESSION_ID ? ' (other session)' : ''}: ${j.task.slice(0, 100)}`).join('\n') || 'no jobs';
  },
  async memory_search(a) {
    const { root, projDir } = orch.ctx(a.cwd);
    const res = memory.search(projDir, root, { query: a.query || '', kinds: a.kinds, limit: a.limit || 8, includeInactive: a.include_inactive });
    return res.length ? frame('shared memory', res.map(memory.fmt).join('\n')) : 'no matching memory';
  },
  async memory_write(a) {
    const { root, projDir } = orch.ctx(a.cwd);
    const r = memory.write(projDir, root, { kind: a.kind, text: a.text, files: a.files || [], verified: !!a.verified, source: { agent: 'claude' }, supersedes: a.supersedes });
    return `${r.action} ${r.id}${r.redacted ? ' (secrets redacted)' : ''}`;
  },
  async memory_update(a) {
    const { projDir } = orch.ctx(a.cwd);
    const r = memory.setStatus(projDir, a.id, a);
    return r ? `${r.id}: ${r.status}, ${r.confidence}` : `no entry ${a.id}`;
  },
  async tandem_checkpoint(a) {
    const { root, projDir } = orch.ctx(a.cwd);
    const jobs = ledger.list(projDir);
    if (Object.keys(a).every(x => x === 'cwd')) return checkpoint.summary(checkpoint.reconcile(projDir, jobs), jobs);
    const items = (a.items || []).map(it => {
      if (!it || !it.delegate) return it;
      const d = it.delegate;
      orch.validate(d, root); // reject a bad spec now, not when the lead is gone
      if (!['task', 'mode', 'difficulty'].every(f => d[f] !== undefined)) throw new Error(`item ${it.id}: delegate needs task, mode and difficulty`);
      // Authorization is recorded with the item: the ceilings in force now, not the CLI's defaults later.
      return { ...it, delegate: { ...d, cwd: undefined, wait: undefined, dry_run: undefined, ceiling: { codexMaxModel: cfg.codexMaxModel, codexAllowedModels: cfg.codexAllowedModels, codexMaxEffort: cfg.codexMaxEffort } } };
    });
    const cp = checkpoint.save(projDir, { ...a, items }, 'claude');
    return 'saved\n' + checkpoint.summary(cp, jobs);
  },
  tandem_status: status,
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function onMessage(msg) {
  const { id, method, params = {} } = msg;
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tandem', version: VERSION } });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const h = handlers[params.name];
      if (!h) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      try {
        return reply({ content: [{ type: 'text', text: await h(check(params.name, params.arguments || {}), params._meta) }] });
      } catch (e) {
        if (!/^invalid arguments|^arguments must/.test(e.message)) store.logError(`tool ${params.name}`, e);
        return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  if (buf.length > 64 << 20) { buf = ''; send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message too large' } }); return; }
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    onMessage(msg);
  }
});
// The session ended: stop live jobs as resumable (suspended), never as lost work.
process.stdin.on('end', () => { orch.suspendAll('session_ended', 'the Claude Code session ended while the job was running'); setTimeout(() => process.exit(0), 1500).unref(); });
// Warm the discovery cache so the first delegation does not pay for it.
codex.discover().catch(e => store.logError('discover', e));
