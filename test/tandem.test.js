'use strict';
// Unit + integration tests. Integration tests drive the real job manager / MCP server / hooks
// against test/fake-codex.js (simulated Codex), so they are deterministic and cost no quota.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
process.env.TANDEM_CODEX_BIN = path.join(__dirname, 'fake-codex.js');

const router = require('../server/router');
const memory = require('../server/memory');
const codex = require('../server/codex');
const store = require('../server/store');
const { JobManager, overlaps, rel, parseReport, jobsFile } = require('../server/jobs');

const ROOT = path.join(__dirname, '..');
const CFG = { codexMaxModel: 'gpt-6.1-sol', codexMaxEffort: 'xhigh', claudeMaxModel: 'opus', maxParallel: 2, leanCodex: true, jobTimeoutMs: 20000, verifyTimeoutMs: 20000 };
let repoN = 0;

function repo(scenario, files = {}) {
  const dir = path.join(TMP, `repo${++repoN}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.fake-scenario.json\n.fake-log.jsonl\n');
  for (const [p, c] of Object.entries({ 'README.md': 'x\n', ...files })) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.fake-scenario.json'), JSON.stringify(scenario));
  return dir;
}
const calls = dir => fs.existsSync(path.join(dir, '.fake-log.jsonl')) ? fs.readFileSync(path.join(dir, '.fake-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const resetEnv = () => { try { fs.unlinkSync(codex.ENV_FILE); } catch {} };
const CHECK = file => `node -e "process.exit(require('fs').readFileSync('${file}','utf8').trim()==='good'?0:1)"`;

// ---------------- router ----------------
test('ceiling: generation first, then family', () => {
  assert.equal(router.withinCeiling('gpt-6-astra', 'gpt-6.1-sol'), true);
  assert.equal(router.withinCeiling('gpt-6.1-sol', 'gpt-6.1-sol'), true);
  assert.equal(router.withinCeiling('gpt-6.1-astra', 'gpt-6.1-sol'), false);
  assert.equal(router.withinCeiling('gpt-7-luna', 'gpt-6.1-sol'), false);
  assert.equal(router.withinCeiling('gpt-reserve', 'gpt-6.1-sol'), false);
  assert.equal(router.withinCeiling('gpt-5.6-terra', 'gpt-5.6-luna'), false);
});

const MODELS = [
  { slug: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], visibility: 'list' },
  { slug: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh'], visibility: 'list' },
  { slug: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'], visibility: 'list' },
  { slug: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high'], visibility: 'list' },
  { slug: 'gpt-5.5-luna', efforts: ['low', 'medium'], visibility: 'list' },
  { slug: 'gpt-7-sol', efforts: ['low'], visibility: 'list' },
  { slug: 'gpt-reserve', efforts: ['low'], visibility: 'hide' },
];

test('ladder: newest per family, cheapest first, ceilings and availability respected', () => {
  const r = router.ladder(MODELS, CFG, {});
  assert.deepEqual(r.map(x => `${x.model}@${x.effort}`), [
    'gpt-5.6-luna@low', 'gpt-5.6-luna@medium', 'gpt-5.6-terra@medium', 'gpt-5.6-terra@high',
    'gpt-5.6-sol@medium', 'gpt-5.6-sol@high', 'gpt-6-astra@medium', 'gpt-6-astra@high', 'gpt-6-astra@xhigh']);
  const capped = router.ladder(MODELS, { ...CFG, codexMaxEffort: 'high' }, { 'gpt-5.6-luna': {} });
  assert.equal(capped[0].model, 'gpt-5.5-luna', 'falls back to older luna when the newest is unavailable');
  assert.ok(capped.every(x => x.effort !== 'xhigh'));
  assert.deepEqual(router.ladder(MODELS, { ...CFG, codexMaxModel: 'gpt-5.6-luna' }, {}).map(x => x.effort), ['low', 'medium', 'high'], 'single model: full effort range it supports');
});

test('difficulty start rungs and adaptive offsets', () => {
  const r = router.ladder(MODELS, CFG, {});
  const at = d => `${r[router.baseStart(r, d)].model}@${r[router.baseStart(r, d)].effort}`;
  assert.equal(at('trivial'), 'gpt-5.6-luna@low');
  assert.equal(at('normal'), 'gpt-5.6-terra@medium');
  assert.equal(at('hard'), 'gpt-5.6-sol@high');
  assert.equal(at('critical'), 'gpt-6-astra@high');
  const pd = store.mkdirp(path.join(TMP, 'adapt'));
  const rung = r[2];
  const rec = ok => router.recordOutcome(pd, { mode: 'implement', difficulty: 'normal', firstOk: ok, rung, tokens: 10, ms: 1, attempts: 1, finalOk: true });
  for (let i = 0; i < 3; i++) assert.equal(rec(false), 0);
  assert.equal(rec(false), 1, 'four first-attempt failures raise the start');
  assert.equal(router.startIndex(r, 'normal', 'implement', pd), 3);
  for (let i = 0; i < 7; i++) rec(true);
  assert.equal(rec(true), -1, 'a long success streak probes one rung cheaper');
  assert.equal(router.startIndex(r, 'normal', 'implement', pd), 2);
});

// ---------------- memory ----------------
test('memory: dedupe, supersede, ranking, staleness, cap', () => {
  const pd = store.mkdirp(path.join(TMP, 'mem'));
  const root = store.mkdirp(path.join(TMP, 'memroot'));
  fs.writeFileSync(path.join(root, 'auth.js'), 'a');
  const a = memory.write(pd, root, { kind: 'decision', text: 'Use JWT tokens for API authentication', files: ['auth.js'], verified: true });
  assert.equal(memory.write(pd, root, { kind: 'decision', text: 'Use JWT tokens for the API authentication' }).action, 'merged');
  memory.write(pd, root, { kind: 'fact', text: 'Database migrations live in db/migrate and run with npm run migrate' });
  const b = memory.write(pd, root, { kind: 'decision', text: 'Use opaque session cookies instead of tokens', supersedes: a.id });
  let hits = memory.search(pd, root, { query: 'authentication tokens' });
  assert.ok(!hits.some(e => e.id === a.id), 'superseded entries are hidden');
  assert.equal(memory.search(pd, root, { query: 'migrations' })[0].kind, 'fact');
  assert.equal(memory.search(pd, root, { query: 'JWT', includeInactive: true })[0].id, a.id);
  memory.setStatus(pd, a.id, { status: 'active' });
  fs.utimesSync(path.join(root, 'auth.js'), new Date(), new Date(Date.now() + 5000));
  hits = memory.search(pd, root, { query: 'JWT' });
  assert.equal(hits[0].stale, true, 'cited file changed -> stale');
  assert.ok(memory.search(pd, root, { query: 'cookies' }).some(e => e.id === b.id));
  for (let i = 0; i < 420; i++) memory.write(pd, root, { kind: 'note', text: `unique note number ${i} about subsystem${i}` });
  assert.ok(memory.counts(pd) <= 400);
  assert.ok(memory.search(pd, root, { query: 'cookies' }).length, 'decisions survive pruning');
  assert.throws(() => memory.write(pd, root, { kind: 'bogus', text: 'x' }));
});

// ---------------- helpers ----------------
test('paths, report parsing, error classification', () => {
  assert.equal(overlaps('src', 'src/a.js'), true);
  assert.equal(overlaps('src/a.js', 'src/ab.js'), false);
  assert.equal(overlaps('.', 'x'), true);
  assert.equal(rel('/r', 'src\\a.js'.replace(/\\/g, path.sep)), 'src/a.js');
  assert.equal(parseReport('not json').status, 'partial');
  assert.equal(parseReport('{"status":"done","summary":"s"}').status, 'done');
  assert.equal(codex.classifyError("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."), 'model_unavailable');
  assert.equal(codex.classifyError("You've hit your usage limit. Try again in 2h 5m."), 'rate_limited');
  assert.equal(codex.classifyError('401 Unauthorized'), 'auth');
  assert.equal(codex.classifyError('stream disconnected'), 'transient');
  assert.equal(codex.retryAfterMs('Try again in 2h 5m.'), 2 * 3600e3 + 5 * 60e3);
  assert.equal(codex.retryAfterMs('later'), 15 * 60e3);
});

// ---------------- job manager (simulated Codex) ----------------
test('implement: verified on first attempt, lean args, prompt via stdin, memory written', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ok', findings: ['The parser lives in src/parse.js'] }, writes: [{ 'src/a.txt': 'good' }] });
  const jm = new JobManager(CFG);
  const { promise } = jm.submit({ cwd: dir, task: 'make a.txt good', mode: 'implement', difficulty: 'trivial', paths: ['src'], verify: CHECK('src/a.txt') });
  const j = await promise;
  assert.equal(j.status, 'verified', JSON.stringify(j.result));
  assert.equal(j.attempts.length, 1);
  assert.deepEqual(j.result.changed, ['src/a.txt']);
  assert.deepEqual(j.result.outOfScope, []);
  const c = calls(dir)[0];
  assert.equal(c.model, 'gpt-5.6-luna');
  for (const flag of ['--json', '--output-schema', '--disable', 'plugins', 'sandbox_mode="workspace-write"', 'model_reasoning_effort="low"', '-']) assert.ok(c.args.includes(flag), flag);
  assert.ok(!c.args.includes('--ephemeral'), 'implement sessions must be resumable');
  assert.match(c.prompt, /make a\.txt good/);
  assert.match(c.prompt, /SCOPE: modify only these paths: src/);
  const pd = store.projectDir(dir);
  const mem = memory.search(pd, dir, { query: 'parser' });
  assert.equal(mem[0].source, 'codex:gpt-5.6-luna');
  assert.equal(mem[0].verified, false, 'codex findings start unverified');
  assert.ok(memory.search(pd, dir, { kinds: ['done'] })[0].verified);
});

test('implement: failed verification resumes same model at higher effort, then passes', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'bad' }, { 'a.txt': 'good' }] });
  const j = await new JobManager(CFG).submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'trivial', paths: ['a.txt'], verify: CHECK('a.txt') }).promise;
  assert.equal(j.status, 'verified');
  assert.deepEqual(j.attempts.map(a => `${a.model}@${a.effort}:${a.verified}`), ['gpt-5.6-luna@low:false', 'gpt-5.6-luna@medium:true']);
  const second = calls(dir)[1];
  assert.deepEqual(second.args.slice(0, 3), ['exec', 'resume', 'thread-0']);
  assert.match(second.prompt, /Verification command .* failed/);
  const stats = store.readJson(path.join(store.projectDir(dir), 'router-stats.json'), {});
  assert.equal(stats['implement|trivial'].totals['gpt-5.6-luna@low'].firstOk, 0);
});

test('implement: verification never passes -> failed_verification, not success', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'bad' }, { 'a.txt': 'bad' }] });
  const j = await new JobManager(CFG).submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'trivial', verify: CHECK('a.txt') }).promise;
  assert.equal(j.status, 'failed_verification');
  assert.equal(j.result.verification.ok, false);
});

test('unavailable model is skipped and remembered; extra attempt not charged', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ok' }, 'gpt-5.6-luna': { action: 'unsupported' } });
  const j = await new JobManager(CFG).submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'trivial', max_attempts: 1 }).promise;
  assert.equal(j.status, 'answered');
  assert.deepEqual(j.attempts.map(a => a.model), ['gpt-5.6-luna', 'gpt-5.5-luna']);
  assert.ok(codex.unavailable()['gpt-5.6-luna']);
  const c = calls(dir)[1];
  assert.ok(c.args.includes('--ephemeral') && c.args.includes('sandbox_mode="read-only"'));
});

test('rate limit stops delegation and short-circuits later jobs', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ratelimit' } });
  const jm = new JobManager(CFG);
  const j = await jm.submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' }).promise;
  assert.equal(j.status, 'codex_unavailable');
  assert.match(j.result.error, /usage limit/);
  const j2 = await jm.submit({ cwd: dir, task: 'q2', mode: 'ask', difficulty: 'normal' }).promise;
  assert.equal(j2.status, 'codex_unavailable');
  assert.equal(calls(dir).length, 1, 'no second Codex call while rate-limited');
  resetEnv();
});

test('not logged in -> codex_unavailable without running', async () => {
  resetEnv();
  process.env.FAKE_LOGGED_OUT = '1';
  try {
    const dir = repo({ default: { action: 'ok' } });
    const j = await new JobManager(CFG).submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' }).promise;
    assert.equal(j.status, 'codex_unavailable');
    assert.match(j.result.error, /codex login/);
  } finally { delete process.env.FAKE_LOGGED_OUT; resetEnv(); }
});

test('model above ceiling is rejected when requested explicitly', async () => {
  const dir = repo({ default: { action: 'ok' } });
  const j = await new JobManager(CFG).submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal', model: 'gpt-7-sol' }).promise;
  assert.equal(j.status, 'rejected');
  assert.equal(calls(dir).length, 0);
});

test('concurrency: overlapping writers serialize, disjoint writers run in parallel', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'ok', delayMs: 700 } });
  const jm = new JobManager(CFG);
  const t0 = Date.now();
  const a = jm.submit({ cwd: dir, task: 'A', mode: 'implement', difficulty: 'trivial', paths: ['src'], verify: 'none' });
  await new Promise(r => setTimeout(r, 100));
  const b = jm.submit({ cwd: dir, task: 'B', mode: 'implement', difficulty: 'trivial', paths: ['src/x.js'], verify: 'none' });
  const [ja, jb] = await Promise.all([a.promise, b.promise]);
  assert.ok(jb.started >= ja.finished - 50, 'overlapping job waited for the owner to finish');
  const c = jm.submit({ cwd: dir, task: 'C', mode: 'implement', difficulty: 'trivial', paths: ['lib'], verify: 'none' });
  const d = jm.submit({ cwd: dir, task: 'D', mode: 'implement', difficulty: 'trivial', paths: ['docs'], verify: 'none' });
  const [jc, jd] = await Promise.all([c.promise, d.promise]);
  assert.ok(jd.started < jc.finished, 'disjoint jobs overlapped in time');
  assert.equal(jc.status, 'unverified', 'no verification run -> unverified, never "verified"');
  assert.ok(Date.now() - t0 < 15000);
});

test('cancel kills a running job; timeout is reported as failure', async () => {
  resetEnv();
  const dir = repo({ default: { action: 'hang' } });
  const jm = new JobManager(CFG);
  const { job, promise } = jm.submit({ cwd: dir, task: 'hang', mode: 'ask', difficulty: 'trivial' });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(jm.cancel(job.id), true);
  assert.equal((await promise).status, 'cancelled');
  const quick = new JobManager({ ...CFG, jobTimeoutMs: 1500 });
  const t = await quick.submit({ cwd: dir, task: 'hang', mode: 'ask', difficulty: 'trivial', max_attempts: 1 }).promise;
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts[0].errorKind, 'timeout');
});

test('crash recovery marks orphaned jobs interrupted; implement requires git', () => {
  const dir = repo({ default: { action: 'ok' } });
  const pd = store.projectDir(dir);
  store.update(jobsFile(pd), { jobs: {} }, db => { db.jobs.j99 = { id: 'j99', pid: 999999, status: 'running', mode: 'implement', paths: [], created: Date.now(), task: 'x' }; });
  assert.equal(new JobManager(CFG).list(dir).find(j => j.id === 'j99').status, 'interrupted');
  const plain = store.mkdirp(path.join(TMP, 'nogit', 'p'));
  assert.throws(() => new JobManager(CFG).submit({ cwd: plain, task: 'x', mode: 'implement', difficulty: 'trivial' }), /git repository/);
});

// ---------------- hooks ----------------
function hook(script, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', script)], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('guard hook: blocks edits to Codex-owned paths and over-ceiling subagents', () => {
  const dir = repo({ default: { action: 'ok' } });
  store.update(jobsFile(store.projectDir(dir)), { jobs: {} }, db => { db.jobs.j1 = { id: 'j1', pid: process.pid, status: 'running', mode: 'implement', paths: ['src'], created: Date.now(), task: 'x' }; });
  const denied = hook('guard.js', { tool_name: 'Edit', cwd: dir, tool_input: { file_path: path.join(dir, 'src', 'a.js') } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /j1/);
  assert.equal(hook('guard.js', { tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, 'lib', 'b.js') } }), null);
  assert.equal(hook('guard.js', { tool_name: 'Agent', tool_input: { model: 'fable' } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook('guard.js', { tool_name: 'Agent', tool_input: { model: 'opus' } }), null);
  assert.equal(hook('guard.js', { tool_name: 'Agent', tool_input: { model: 'sonnet' } }, { CLAUDE_PLUGIN_OPTION_CLAUDE_MAX_MODEL: 'haiku' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook('guard.js', 'garbage'), null, 'fails open on bad input');
});

test('session-start hook: brief with Codex state and key memory', async () => {
  resetEnv();
  await codex.discover();
  const dir = repo({ default: { action: 'ok' } });
  memory.write(store.projectDir(dir), dir, { kind: 'constraint', text: 'Never call the payments API from tests', verified: true });
  const out = hook('session-start.js', { cwd: dir, source: 'startup' }, { CLAUDE_PROJECT_DIR: dir });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Codex ready \(codex-cli 9\.9\.9\): gpt-5\.6-luna, gpt-5\.6-terra, gpt-5\.6-sol, gpt-6-astra/);
  assert.match(ctx, /payments API/);
  assert.ok(ctx.length < 2000);
});

// ---------------- MCP server protocol ----------------
test('MCP server: initialize, list tools, memory round trip, status', async () => {
  const dir = repo({ default: { action: 'ok' } });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp.js')], { cwd: dir, env: { ...process.env, TANDEM_PROJECT_DIR: dir } });
  let buf = '';
  const pending = new Map();
  srv.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'tandem');
    const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.deepEqual(tools.sort(), ['codex_jobs', 'codex_run', 'codex_wait', 'memory_search', 'memory_update', 'memory_write', 'tandem_status']);
    assert.match(await call('memory_write', { kind: 'fact', text: 'Build uses esbuild via npm run build' }), /added m\d+/);
    assert.match(await call('memory_search', { query: 'esbuild' }), /esbuild/);
    assert.match(await call('codex_run', { task: 'what is this repo', mode: 'ask', difficulty: 'trivial' }), /ANSWERED/);
    assert.match(await call('tandem_status', {}), /ladder: gpt-5\.6-luna@low/);
    assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  } finally { srv.stdin.end(); srv.kill(); }
});
