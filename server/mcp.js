#!/usr/bin/env node
'use strict';
// Tandem MCP server (stdio, newline-delimited JSON-RPC). Zero dependencies.
const { config } = require('./config');
const { JobManager } = require('./jobs');
const codex = require('./codex');
const router = require('./router');
const memory = require('./memory');
const store = require('./store');
const path = require('path');

const cfg = config();
const progressTokens = new Map(); // jobId -> progressToken of the call that is waiting on it
const jobs = new JobManager(cfg, {
  onProgress: (id, message) => {
    const token = progressTokens.get(id);
    if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: Date.now() % 1e9, message: `${id} ${message}` } });
  },
});
const FOREGROUND_CAP_MS = 9 * 60e3;

const str = (description, extra) => ({ type: 'string', description, ...extra });
const TOOLS = [
  {
    name: 'codex_run',
    description: 'Delegate a task to OpenAI Codex. Tandem picks the cheapest capable Codex model/effort, injects shared memory, runs tests to verify implement jobs, and escalates on failure. Use for well-scoped work; not worth it for edits you can do in a few tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Self-contained instructions: goal, acceptance criteria, relevant files/functions.'),
        mode: str('ask = read-only analysis/answer; implement = edit files (needs git); review = read-only review of uncommitted diff.', { enum: ['ask', 'implement', 'review'] }),
        difficulty: str('Your estimate; drives model/effort choice. trivial=mechanical, normal=typical feature/fix, hard=subtle multi-file logic, critical=high-risk/complex.', { enum: router.DIFFICULTIES }),
        paths: { type: 'array', items: { type: 'string' }, description: 'implement: files/dirs Codex owns. Other writers are kept off them; overlapping jobs queue. Strongly recommended.' },
        context: str('Facts Codex needs that are not in the repo or memory (decisions, constraints). Keep short.'),
        verify: str('implement: shell command proving success, "auto" (detect npm/pytest/cargo/go tests; default) or "none".'),
        wait: { type: 'boolean', description: 'true (default): return the result. false: return a job id now; collect with codex_wait.' },
        model: str('Optional explicit Codex model (must be within the ceiling).'),
        effort: str('Optional explicit reasoning effort.', { enum: router.EFFORTS }),
        max_attempts: { type: 'integer', minimum: 1, maximum: 4, description: 'Attempts incl. escalations (default 2).' },
        cwd: str('Project directory (default: session project).'),
        allow_non_git: { type: 'boolean', description: 'Allow implement outside a git repo.' },
      },
      required: ['task', 'mode', 'difficulty'],
    },
  },
  {
    name: 'codex_wait',
    description: 'Wait for background Codex jobs and return their results.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Job ids (default: all running in this session).' }, timeout_s: { type: 'integer', description: 'Max wait (default 540).' } } },
  },
  {
    name: 'codex_jobs',
    description: 'List recent Codex jobs for this project (all sessions) with status and path claims. Pass cancel to stop a job.',
    inputSchema: { type: 'object', properties: { cancel: str('Job id to cancel.'), cwd: str('Project directory.') } },
  },
  {
    name: 'memory_search',
    description: 'Search shared project memory (decisions, constraints, facts, issues, completed work) written by Claude and Codex agents. Check before re-exploring.',
    inputSchema: { type: 'object', properties: { query: str('Keywords; empty = most important recent.'), kinds: { type: 'array', items: { type: 'string', enum: memory.KINDS } }, limit: { type: 'integer' }, include_inactive: { type: 'boolean' }, cwd: str('Project directory.') } },
  },
  {
    name: 'memory_write',
    description: 'Save one durable, reusable project fact for all agents (not task chatter). Near-duplicates are merged. Set verified only if you confirmed it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: str('decision | constraint | fact | issue | done | note', { enum: memory.KINDS }),
        text: str('One or two sentences.'),
        files: { type: 'array', items: { type: 'string' }, description: 'Files the fact depends on (enables staleness detection).' },
        verified: { type: 'boolean' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Ids of entries this replaces.' },
        source: str('Who wrote it (default claude).'),
        cwd: str('Project directory.'),
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'memory_update',
    description: 'Mark a memory entry verified/unverified, resolved, superseded, or reword it.',
    inputSchema: { type: 'object', properties: { id: str('Entry id.'), status: str('active | resolved | superseded', { enum: ['active', 'resolved', 'superseded'] }), verified: { type: 'boolean' }, text: str('Replacement text.'), cwd: str('Project directory.') }, required: ['id'] },
  },
  {
    name: 'tandem_status',
    description: 'Show Codex installation/login, eligible models and routing ladder, ceilings, rate-limit state, router learning stats, and memory size.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Re-run discovery now.' }, cwd: str('Project directory.') } },
  },
];

const k = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

function formatJob(j) {
  const r = j.result || {};
  const rep = r.report || {};
  const L = [`job ${j.id} [${j.mode}/${j.difficulty}] ${j.status.toUpperCase()}` + (j.finished ? ` in ${Math.round((j.finished - (j.started || j.created)) / 1000)}s` : '')];
  if (j.attempts && j.attempts.length) L.push('attempts: ' + j.attempts.map(a => `${a.model}@${a.effort}${a.verified === true ? ' ✓' : a.verified === false ? ' ✗' : ''}${a.errorKind ? ' (' + a.errorKind + ')' : ''}`).join(' -> '));
  if (r.usage) L.push(`tokens: in ${k(r.usage.input)} (cached ${k(r.usage.cached)}), out ${k(r.usage.output)}`);
  if (rep.summary) L.push(`codex (${rep.status}): ${rep.summary}`);
  if (r.verification) L.push(`verification: \`${r.verification.command}\` ${r.verification.ok ? 'PASSED' : 'FAILED (exit ' + r.verification.code + ')'}` + (r.verification.tail ? `\n${r.verification.tail}` : ''));
  else if (j.mode === 'implement' && rep.status) L.push(`verification: none run by Tandem (codex claims: ${rep.verification || 'nothing'}) — verify before trusting`);
  if (r.changed) L.push(`changed: ${r.changed.join(', ') || 'none'}`);
  if (r.outOfScope && r.outOfScope.length) L.push(`OUT OF SCOPE changes: ${r.outOfScope.join(', ')}`);
  if (r.concurrentWriters && r.concurrentWriters.length) L.push(`note: jobs ${r.concurrentWriters.join(', ')} were writing concurrently`);
  if (rep.findings && rep.findings.length) L.push('findings:\n' + rep.findings.map(f => '- ' + f).join('\n'));
  if (rep.open_questions && rep.open_questions.length) L.push('open questions:\n' + rep.open_questions.map(f => '- ' + f).join('\n'));
  if (r.error) L.push(`error: ${r.error}`);
  if (r.memoryIds && r.memoryIds.length) L.push(`memory: ${r.memoryIds.join(', ')}`);
  return L.join('\n');
}

async function waitFor(ids, timeoutMs) {
  const want = ids && ids.length ? ids : [...jobs.live.entries()].filter(([, e]) => ['queued', 'running'].includes(e.job.status)).map(([id]) => id);
  await jobs.wait(want, timeoutMs);
  return want.map(id => {
    const j = (jobs.live.get(id) || {}).job;
    if (!j) return `job ${id} was not started by this session (see codex_jobs)`;
    return ['queued', 'running'].includes(j.status) ? `job ${j.id} still ${j.status}; call codex_wait again` : formatJob(j);
  }).join('\n\n') || 'no running jobs';
}

async function status(a) {
  const env = await codex.discover({ force: !!a.refresh });
  const unav = codex.unavailable();
  const rungs = router.ladder(env.models, cfg, unav);
  const root = store.projectRoot(a.cwd || process.env.TANDEM_PROJECT_DIR || process.cwd());
  const projDir = store.projectDir(root);
  const stats = store.readJson(path.join(projDir, 'router-stats.json'), {});
  const L = [
    `codex: ${env.installed ? env.version : 'NOT INSTALLED'} | ${env.login}${env.configModel ? ` | config default model ${env.configModel}` : ''}`,
    `ceilings: codex ${cfg.codexMaxModel} @ ${cfg.codexMaxEffort}; claude ${cfg.claudeMaxModel} | parallel codex jobs: ${cfg.maxParallel} | lean prompts: ${cfg.leanCodex}`,
    `catalog: ${env.models.map(m => m.slug + (m.visibility === 'hide' ? '(hidden)' : '') + (router.withinCeiling(m.slug, cfg.codexMaxModel) ? '' : '(above ceiling)')).join(', ') || 'empty'}`,
    `ladder: ${rungs.map(r => `${r.model}@${r.effort}`).join(' < ') || 'EMPTY — no usable model'}`,
    `start rungs: ${router.DIFFICULTIES.map(d => `${d}=${(rungs[router.startIndex(rungs, d, 'implement', projDir)] || {}).model || '-'}@${(rungs[router.startIndex(rungs, d, 'implement', projDir)] || {}).effort || '-'}`).join(' ')}`,
    `unavailable: ${Object.entries(unav).map(([m, x]) => `${m} until ${new Date(x.until).toLocaleString()} (${x.reason})`).join('; ') || 'none'}`,
    `memory: ${memory.counts(projDir)} active entries | project ${root}`,
  ];
  for (const [key, s] of Object.entries(stats)) {
    L.push(`router ${key}: offset ${s.offset >= 0 ? '+' : ''}${s.offset}; ` + Object.entries(s.totals).map(([r, t]) => `${r} ${t.firstOk}/${t.jobs} first-try, ${t.finalOk}/${t.jobs} final, avg ${k(Math.round(t.tokens / t.jobs))} tok, ${(t.attempts / t.jobs).toFixed(1)} att`).join('; '));
  }
  return L.join('\n');
}

const handlers = {
  async codex_run(a, meta) {
    const { job, promise } = jobs.submit(a);
    if (meta && meta.progressToken !== undefined) progressTokens.set(job.id, meta.progressToken);
    if (a.wait === false) return `job ${job.id} started (${job.mode}, ${job.difficulty}). Collect with codex_wait.`;
    let timer;
    const finished = await Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(null), FOREGROUND_CAP_MS); })]);
    clearTimeout(timer);
    progressTokens.delete(job.id);
    return finished ? formatJob(finished) : `job ${job.id} still running after ${FOREGROUND_CAP_MS / 60000} min; collect with codex_wait.`;
  },
  async codex_wait(a, meta) {
    for (const id of a.ids || jobs.live.keys()) if (meta && meta.progressToken !== undefined) progressTokens.set(id, meta.progressToken);
    return waitFor(a.ids, Math.min((a.timeout_s || 540) * 1000, FOREGROUND_CAP_MS));
  },
  async codex_jobs(a) {
    if (a.cancel) return jobs.cancel(a.cancel) ? `cancelling ${a.cancel}` : `job ${a.cancel} is not running in this session`;
    const list = jobs.list(a.cwd).slice(0, 15);
    return list.map(j => `${j.id} ${j.status} [${j.mode}/${j.difficulty}]${j.paths.length ? ' paths=' + j.paths.join(',') : ''}${j.pid !== process.pid ? ' (other session)' : ''}: ${j.task.slice(0, 100)}`).join('\n') || 'no jobs';
  },
  async memory_search(a) {
    const { root, projDir } = jobs.ctx(a.cwd);
    const res = memory.search(projDir, root, { query: a.query || '', kinds: a.kinds, limit: a.limit || 8, includeInactive: a.include_inactive });
    return res.map(memory.fmt).join('\n') || 'no matching memory';
  },
  async memory_write(a) {
    const { root, projDir } = jobs.ctx(a.cwd);
    const r = memory.write(projDir, root, { kind: a.kind, text: a.text, files: a.files || [], verified: !!a.verified, source: a.source || 'claude', supersedes: a.supersedes });
    return `${r.action} ${r.id}`;
  },
  async memory_update(a) {
    const { projDir } = jobs.ctx(a.cwd);
    const r = memory.setStatus(projDir, a.id, a);
    return r ? `${r.id}: ${r.status}, ${r.verified ? 'verified' : 'unverified'}` : `no entry ${a.id}`;
  },
  tandem_status: status,
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function onMessage(msg) {
  const { id, method, params = {} } = msg;
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') {
      return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tandem', version: require('../.claude-plugin/plugin.json').version } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const h = handlers[params.name];
      if (!h) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      try {
        return reply({ content: [{ type: 'text', text: await h(params.arguments || {}, params._meta) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.on('data', d => {
  buf += d;
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
// Client gone: stop our Codex children rather than leaving them running unattended.
process.stdin.on('end', () => { for (const id of jobs.live.keys()) jobs.cancel(id); setTimeout(() => process.exit(0), 1500); });
// Warm the discovery cache so the first delegation does not pay for it.
codex.discover().catch(() => {});
