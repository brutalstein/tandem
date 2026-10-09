'use strict';
// End-to-end orchestration against the simulated Codex CLI (test/fake-codex.js). These prove the
// orchestration logic; they are NOT evidence that the real provider integration works
// (that is test/real-integration.js, run manually).
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const codex = require('../server/codex');
const memory = require('../server/memory');
const policy = require('../server/policy');
const { Orchestrator } = require('../server/jobs');

const orch = (cfg = {}) => new Orchestrator({ ...H.CFG, ...cfg });
const run = (o, spec) => o.submit(spec).promise;
const waitFor = async (cond, ms = 15000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };
const clean = () => { H.resetEnv(); };

test('ask: answered, findings become tentative memory with provenance, evidence recorded', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok', findings: ['the build uses esbuild'] } });
  const j = await run(orch(), { cwd: dir, task: 'how is it built?', mode: 'ask', difficulty: 'trivial' });
  assert.equal(j.status, 'answered');
  assert.equal(H.calls(dir)[0].args.includes('read-only') || H.calls(dir)[0].args.some(a => /read-only/.test(a)), true);
  const pd = store.projectDir(dir);
  const m = memory.load(pd).entries.find(e => e.id === j.result.memoryIds[0]);
  assert.equal(m.confidence, 'tentative');
  assert.deepEqual({ agent: m.source.agent, job: m.source.job }, { agent: 'codex', job: j.id });
  assert.equal(policy.loadEvidence(pd).classes['ask|trivial'].length, 1);
  assert.ok(j.route && j.route.plan.length >= 1, 'auditable routing record stored');
});

test('implement in place: failed verification escalates; resume only on the same model', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'bad' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old', 'dirty.txt': 'x' });
  H.write(dir, { 'dirty.txt': 'user wip' }); // pre-existing user change must not be attributed to the job
  const j = await run(orch(), { cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt') });
  assert.equal(j.status, 'verified');
  assert.equal(j.isolation, 'inplace');
  assert.equal(j.attempts.length, 2);
  assert.equal(j.attempts[0].verified, false);
  assert.equal(j.attempts[1].verified, true);
  assert.deepEqual(j.result.changed, ['a.txt']);
  assert.equal(H.read(dir, 'dirty.txt'), 'user wip');
  const c = H.calls(dir);
  assert.equal(c[1].args[1] === 'resume', j.attempts[0].model === j.attempts[1].model);
  if (c[1].args[1] !== 'resume') assert.match(c[1].prompt, /previous attempt did not succeed/i);
});

test('unsupported model: marked unavailable, rerouted, job still succeeds', async () => {
  clean();
  const o = orch();
  const probe = H.repo({ default: { action: 'ok' } });
  const first = (await run(o, { cwd: probe, task: 'p', mode: 'ask', difficulty: 'normal' })).attempts[0].model;
  clean();
  const dir = H.repo({ default: { action: 'ok' }, [first]: { action: 'unsupported' } });
  const j = await run(o, { cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' });
  assert.equal(j.status, 'answered');
  assert.equal(j.attempts[0].errorKind, 'model_unavailable');
  assert.notEqual(j.attempts.at(-1).model, first);
  assert.ok(codex.unavailable()[first]);
});

test('rate limit: provider-wide backoff; later jobs fail fast without spawning Codex', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ratelimit' } });
  const o = orch();
  const j = await run(o, { cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' });
  assert.equal(j.status, 'codex_unavailable');
  assert.match(j.result.error, /usage\/rate limit/);
  assert.ok(codex.unavailable()['*'].until > Date.now() + 2 * 3600e3 - 60e3, 'retry-after parsed (2h 5m)');
  const n = H.calls(dir).length;
  const j2 = await run(o, { cwd: dir, task: 'q2', mode: 'ask', difficulty: 'normal' });
  assert.equal(j2.status, 'codex_unavailable');
  assert.equal(H.calls(dir).length, n);
});

test('auth failure and transient errors', async () => {
  clean();
  const auth = await run(orch(), { cwd: H.repo({ default: { action: 'auth' } }), task: 'q', mode: 'ask', difficulty: 'normal' });
  assert.equal(auth.status, 'codex_unavailable');
  clean();
  const dir = H.repo({ default: { action: 'transient' } });
  const t = await run(orch(), { cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal', max_attempts: 1 });
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts.length, 2, 'one same-rung retry on a transient error');
  assert.equal(t.attempts[0].model + t.attempts[0].effort, t.attempts[1].model + t.attempts[1].effort);
});

test('integrity: a pass obtained by editing the test definition is not "verified"', async () => {
  clean();
  const pkg = s => JSON.stringify({ name: 'x', scripts: { test: s } });
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'package.json': pkg('node -e "process.exit(0)"') }] }, { 'package.json': pkg('node -e "process.exit(1)"') });
  const j = await run(orch(), { cwd: dir, task: 'make tests pass', mode: 'implement', difficulty: 'normal', paths: ['package.json'] });
  assert.equal(j.result.verification.ok, true);
  assert.equal(j.status, 'unverified');
  assert.deepEqual(j.result.integrity.verifyDefinitionChanged, ['package.json']);
});

test('in-place scope audit detects edits to already-dirty tracked files', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'good', 'b.txt': 'overwrite' }] },
    { 'a.txt': 'old', 'b.txt': 'base' });
  H.write(dir, { 'b.txt': 'existing user edit' });
  const j = await run(orch(), { cwd: dir, task: 'edit a only', mode: 'implement', difficulty: 'normal',
    paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'inplace' });
  assert.equal(j.status, 'failed_verification');
  assert.deepEqual(j.result.outOfScope, ['b.txt']);
});

test('test content tampering cannot yield verified even when the configured check passes', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'good', 'a.test.js': 'weakened' }] },
    { 'a.txt': 'old', 'a.test.js': 'original test' });
  const j = await run(orch(), { cwd: dir, task: 'fix', mode: 'implement', difficulty: 'normal',
    paths: ['a.txt', 'a.test.js'], verify: H.CHECK('a.txt'), isolation: 'inplace' });
  assert.equal(j.result.verification.ok, true);
  assert.equal(j.status, 'unverified');
  assert.deepEqual(j.result.integrity.modifiedTests, ['a.test.js']);
  assert.equal((policy.loadEvidence(store.projectDir(dir)).classes['implement|normal'] || []).filter(x => x.ok).length, 0,
    'tampered check result must not train routing as success');
});

test('worktree isolation (auto): a second writer on busy paths runs isolated and integrates after', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { 'TASK-A': { writes: { 'src/a.js': 'good' }, delayMs: 1500 }, 'TASK-B': { writes: { 'src/b.js': 'good' } } } }, { 'src/a.js': 'old', 'src/b.js': 'old' });
  const o = orch();
  const pa = run(o, { cwd: dir, task: 'TASK-A', mode: 'implement', difficulty: 'normal', paths: ['src'], verify: H.CHECK('src/a.js') });
  await waitFor(() => H.calls(dir).length >= 1);
  const pb = run(o, { cwd: dir, task: 'TASK-B', mode: 'implement', difficulty: 'normal', paths: ['src/b.js'], verify: H.CHECK('src/b.js') });
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.status, 'verified');
  assert.equal(b.status, 'verified');
  assert.equal(b.isolation, 'worktree');
  assert.ok(b.started < a.finished, 'B ran concurrently with A instead of queueing');
  assert.deepEqual(b.result.integration.applied, [{ path: 'src/b.js', how: 'fast-forward' }]);
  assert.equal(H.read(dir, 'src/a.js'), 'good');
  assert.equal(H.read(dir, 'src/b.js'), 'good');
  assert.ok(!b.result.worktreeKept && !fs.existsSync(b.worktree.path), 'clean worktree removed');
});

test('worktree conflict: user edit on the same lines wins; result kept for review', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok', delayMs: 800 }, writes: [{ 'a.txt': 'job line\n' }] }, { 'a.txt': 'base line\n', '.gitignore': 'node_modules/\n' });
  H.write(dir, { 'node_modules/m/index.js': 'mod' });
  const p = run(orch(), { cwd: dir, task: 'edit a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: 'none', isolation: 'worktree' });
  await waitFor(() => H.calls(dir).length >= 1);
  H.write(dir, { 'a.txt': 'user line\n' });
  const j = await p;
  assert.equal(j.status, 'conflict');
  assert.equal(H.read(dir, 'a.txt'), 'user line\n');
  assert.ok(fs.existsSync(j.result.worktreeKept));
  assert.equal(H.read(j.result.worktreeKept, 'a.txt'), 'job line\n');
  assert.ok(!fs.existsSync(path.join(j.result.worktreeKept, 'node_modules')), 'kept worktree holds no dependency link');
  H.git(dir, 'worktree', 'remove', '--force', j.result.worktreeKept);
  assert.equal(H.read(dir, 'node_modules/m/index.js'), 'mod', 'user cleanup cannot reach node_modules');
});

test('worktree: out-of-scope changes are not integrated; deleted tests downgrade verification', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'good', 'other.txt': 'sneaky', 'test/a.test.js': null }] }, { 'a.txt': 'old', 'other.txt': 'o', 'test/a.test.js': 'x' });
  const j = await run(orch(), { cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'worktree' });
  assert.equal(j.status, 'unverified');
  assert.deepEqual(j.result.integrity.deletedTests, ['test/a.test.js']);
  assert.deepEqual(j.result.outOfScope.sort(), ['other.txt', 'test/a.test.js']);
  assert.equal(H.read(dir, 'a.txt'), 'old', 'nothing integrated');
  assert.ok(fs.existsSync(j.result.worktreeKept), 'kept, not discarded');
});

test('worktree: main tree drift + failing re-verification reverts the integration', async () => {
  clean();
  const check = `node -e "const f=require('fs');process.exit(f.readFileSync('a.txt','utf8')==='good'&&f.readFileSync('u.txt','utf8')!=='bad'?0:1)"`;
  const dir = H.repo({ default: { action: 'ok', delayMs: 800 }, writes: [{ 'a.txt': 'good' }] }, { 'a.txt': 'old', 'u.txt': 'fine' });
  const p = run(orch(), { cwd: dir, task: 'fix', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: check, isolation: 'worktree' });
  await waitFor(() => H.calls(dir).length >= 1);
  H.write(dir, { 'u.txt': 'bad' });
  const j = await p;
  assert.equal(j.status, 'failed_verification');
  assert.equal(j.result.integration.mainTreeDrifted, true);
  assert.equal(j.result.integration.postVerify.ok, false);
  assert.deepEqual(j.result.integration.reverted, ['a.txt']);
  assert.equal(H.read(dir, 'a.txt'), 'old');
  assert.equal(H.read(dir, 'u.txt'), 'bad', 'user change untouched');
});

test('dependencies, cancellation and argument/ceiling validation', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { 'FAILS': { action: 'crash' }, 'HANGS': { action: 'hang' } } });
  const o = orch();
  const a = o.submit({ cwd: dir, task: 'FAILS', mode: 'ask', difficulty: 'normal', max_attempts: 1 });
  const b = o.submit({ cwd: dir, task: 'after', mode: 'ask', difficulty: 'normal', after: [a.job.id] });
  assert.equal((await a.promise).status, 'failed');
  const bj = await b.promise;
  assert.equal(bj.status, 'skipped');
  assert.equal(H.calls(dir).filter(c => /after/.test(c.prompt)).length, 0);

  const h = o.submit({ cwd: dir, task: 'HANGS', mode: 'ask', difficulty: 'normal' });
  await waitFor(() => H.calls(dir).some(c => /HANGS/.test(c.prompt)));
  assert.equal(o.cancel(h.job.id), true);
  assert.equal((await h.promise).status, 'cancelled');

  assert.throws(() => o.submit({ cwd: dir, task: 'x', mode: 'implement', difficulty: 'normal', paths: ['../escape'] }), /escapes/);
  assert.throws(() => o.submit({ cwd: dir, task: '', mode: 'ask' }), /task/);
  assert.throws(() => o.submit({ cwd: dir, task: 'x', mode: 'nuke' }), /mode/);
  const nogit = store.mkdirp(path.join(H.TMP, 'nogit'));
  assert.throws(() => o.submit({ cwd: nogit, task: 'x', mode: 'implement' }), /git repository/);
  const above = await run(o, { cwd: dir, task: 'x', mode: 'ask', model: 'gpt-7-sol' });
  assert.equal(above.status, 'rejected');
  assert.match(above.result.error, /above ceiling/);
  const eff = await run(orch({ codexMaxEffort: 'medium' }), { cwd: dir, task: 'x', mode: 'ask', effort: 'xhigh' });
  assert.equal(eff.status, 'rejected');
});

test('in-place: changes outside the declared paths are reported as out of scope', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'good', 'b.txt': 'surprise' }] }, { 'a.txt': 'old', 'b.txt': 'b' });
  const j = await run(orch(), { cwd: dir, task: 'fix', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'inplace' });
  assert.equal(j.status, 'failed_verification', 'scope violations cannot be verified');
  assert.deepEqual(j.result.outOfScope, ['b.txt']);
});

// ---- v1 regressions kept ----
test('never-passing verification is failed_verification; no verifier is unverified, never verified', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, writes: [{ 'a.txt': 'bad' }, { 'a.txt': 'bad' }] }, { 'a.txt': 'old' });
  const j = await run(orch(), { cwd: dir, task: 'fix', mode: 'implement', difficulty: 'trivial', paths: ['a.txt'], verify: H.CHECK('a.txt') });
  assert.equal(j.status, 'failed_verification');
  const n = await run(orch(), { cwd: H.repo({ default: { action: 'ok' }, writes: [{ 'x.txt': '1' }] }), task: 'x', mode: 'implement', difficulty: 'trivial', paths: ['x.txt'], verify: 'none' });
  assert.equal(n.status, 'unverified');
});

test('not logged in and timeouts', async () => {
  clean();
  process.env.FAKE_LOGGED_OUT = '1';
  try {
    const j = await run(orch(), { cwd: H.repo(), task: 'q', mode: 'ask', difficulty: 'normal' });
    assert.equal(j.status, 'codex_unavailable');
    assert.match(j.result.error, /codex login/);
  } finally { delete process.env.FAKE_LOGGED_OUT; clean(); }
  const t = await run(orch({ jobTimeoutMs: 1500 }), { cwd: H.repo({ default: { action: 'hang' } }), task: 'q', mode: 'ask', difficulty: 'normal', max_attempts: 1 });
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts[0].errorKind, 'timeout');
});

test('coordination: a worker is told what concurrent writers are changing (no duplicated work)', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { 'TASK-ISO': { delayMs: 1500, writes: { 'lib/x.js': 'x' } }, 'TASK-WIDE': { writes: { 'a.txt': 'a' } } } });
  const o = orch();
  const iso = o.submit({ cwd: dir, task: 'TASK-ISO', mode: 'implement', difficulty: 'normal', paths: ['lib/x.js'], verify: 'none', isolation: 'worktree' });
  await waitFor(() => H.calls(dir).length >= 1);
  const wide = o.submit({ cwd: dir, task: 'TASK-WIDE', mode: 'implement', difficulty: 'normal', paths: ['.'], verify: 'none', isolation: 'inplace' });
  await Promise.all([iso.promise, wide.promise]);
  const p = H.calls(dir).find(c => c.prompt.includes('TASK-WIDE')).prompt;
  assert.match(p, /Other agents are changing these paths right now; do not modify them: lib\/x\.js/);
  assert.doesNotMatch(H.calls(dir).find(c => c.prompt.includes('TASK-ISO')).prompt, /Other agents/, 'own scope is never listed as forbidden');
});
