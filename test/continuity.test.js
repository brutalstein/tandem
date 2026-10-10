'use strict';
// Provider failover and resumption against the simulated Codex CLI. These prove the suspend/resume
// logic; they do NOT prove continuity with the real provider (see docs/VERIFICATION.md).
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codex = require('../server/codex');
const store = require('../server/store');
const { Orchestrator } = require('../server/jobs');

const orch = (cfg = {}) => new Orchestrator({ ...H.CFG, ...cfg });
const waitFor = async (cond, ms = 15000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };
const scenario = (dir, s) => fs.writeFileSync(path.join(dir, '.fake-scenario.json'), JSON.stringify(s));
const clean = () => { H.resetEnv(); };
// The worktree is removed after successful integration. Canonicalize its existing
// parent, not the deleted leaf; macOS maps /var to /private/var.
const canonicalWorktreePath = p => path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));

test('A: usage limit mid-run in a worktree: suspended with partial work kept; resume continues the same thread and worktree', async () => {
  clean();
  const dir = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old' });
  const o = orch();
  const j = await o.submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'worktree' }).promise;
  assert.equal(j.status, 'suspended');
  assert.equal(j.result.suspension.waitFor, 'time');
  assert.ok(j.result.suspension.until > Date.now() + 3600e3, 'provider reset time recorded');
  const wt = j.result.resumeFrom.worktree.path;
  assert.equal(H.read(wt, 'a.txt'), 'half', 'partial work preserved in the kept worktree');
  assert.equal(H.read(dir, 'a.txt'), 'old', 'nothing integrated');
  assert.ok(j.result.resumeFrom.threadId);

  // Still limited: resuming without --now re-suspends without spawning Codex (no quota spent).
  const n = H.calls(dir).length;
  const again = await o.resume(j.id, dir).promise;
  assert.equal(again.status, 'suspended');
  assert.equal(H.calls(dir).length, n);

  // Provider back.
  scenario(dir, { default: { action: 'ok' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir, { now: true }).promise;
  assert.equal(r.status, 'verified');
  assert.equal(H.read(dir, 'a.txt'), 'good', 'integrated after resume');
  const last = H.calls(dir).at(-1);
  assert.equal(last.args[1], 'resume', 'same Codex conversation continued');
  assert.equal(last.args[2], j.result.resumeFrom.threadId);
  assert.match(last.prompt, /interrupted/);
  assert.equal(canonicalWorktreePath(last.cwd), canonicalWorktreePath(wt), 'same worktree after platform path canonicalization');
  assert.equal(r.resumed, 2);
  assert.equal(r.attempts.filter(a => a.before).length, 1, 'earlier attempt history kept, marked');
  assert.ok(!codex.unavailable()['*'], 'a completed turn clears the provider outage');
  assert.ok(!fs.existsSync(path.join(store.projectDir(dir), 'resume', j.id + '.json')), 'resume state removed once finished');
});

test('A: in place: partial edits stay attributed to the job across a resume; user edits from before stay untouched', async () => {
  clean();
  const dir = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old', 'u.txt': 'u' });
  H.write(dir, { 'u.txt': 'user wip' });
  const o = orch();
  const j = await o.submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'inplace' }).promise;
  assert.equal(j.status, 'suspended');
  assert.equal(H.read(dir, 'a.txt'), 'half');
  scenario(dir, { default: { action: 'ok' }, writes: [{}, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir, { now: true }).promise;
  assert.equal(r.status, 'verified');
  assert.equal(r.isolation, 'inplace');
  assert.deepEqual(r.result.changed, ['a.txt']);
  assert.equal(H.read(dir, 'u.txt'), 'user wip');
});

test('A: files changed while suspended: the resumed job continues isolated, never over the user edit', async () => {
  clean();
  const dir = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old', 'b.txt': 'b' });
  const o = orch();
  const j = await o.submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'inplace' }).promise;
  assert.equal(j.status, 'suspended');
  H.write(dir, { 'b.txt': 'user edit while stopped' });
  scenario(dir, { default: { action: 'ok' }, writes: [{}, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir, { now: true }).promise;
  assert.equal(r.isolation, 'worktree');
  assert.match(r.note, /isolated worktree/);
  assert.equal(r.status, 'verified');
  assert.equal(H.read(dir, 'a.txt'), 'good');
  assert.equal(H.read(dir, 'b.txt'), 'user edit while stopped');
});

test('B/C: a stopped job can be taken over (never resumed afterwards); provider down at start suspends without spawning', async () => {
  clean();
  process.env.FAKE_LOGGED_OUT = '1';
  let j;
  const dir = H.repo();
  try {
    j = await orch().submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' }).promise;
  } finally { delete process.env.FAKE_LOGGED_OUT; clean(); }
  assert.equal(j.status, 'suspended');
  assert.equal(j.result.suspension.kind, 'auth_required');
  assert.equal(H.calls(dir).length, 0);
  const o = orch();
  const t = o.takeOver(j.id, dir, 'claude', 'answered inline');
  assert.equal(t.status, 'taken_over');
  assert.throws(() => o.resume(j.id, dir), /taken_over/);
});

test('session end: live jobs are suspended (resumable), not cancelled; resume finishes them', async () => {
  clean();
  const dir = H.repo({ default: { action: 'hang' } });
  const o = orch();
  const { job, promise } = o.submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' });
  await waitFor(() => H.calls(dir).length >= 1);
  assert.deepEqual(o.suspendAll('session_ended', 'session ended'), [job.id]);
  const j = await promise;
  assert.equal(j.status, 'suspended');
  assert.equal(j.result.suspension.kind, 'session_ended');
  scenario(dir, { default: { action: 'ok' } });
  const r = await orch().resume(j.id, dir).promise;
  assert.equal(r.status, 'answered');
});

test('dependency: a dependent of a suspended job is suspended with it, and runs after both resume', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { FIRST: { action: 'ratelimit' } } });
  const o = orch();
  const a = await o.submit({ cwd: dir, task: 'FIRST', mode: 'ask', difficulty: 'normal' }).promise;
  assert.equal(a.status, 'suspended');
  clean(); codex.clearUnavailable('*');
  const b = await o.submit({ cwd: dir, task: 'SECOND', mode: 'ask', difficulty: 'normal', after: [a.id] }).promise;
  assert.equal(b.status, 'suspended');
  assert.equal(b.result.suspension.kind, 'dependency');
  scenario(dir, { default: { action: 'ok' } });
  const firstP = o.resume(a.id, dir).promise;
  const second = o.resume(b.id, dir).promise; // queued: waits for its dependency, now queued again
  const first = await firstP;
  assert.equal(first.status, 'answered');
  assert.equal((await second).status, 'answered');
});

test('crash: an interrupted job (owner died) resumes from its recorded worktree instead of starting over', async () => {
  clean();
  const dir = H.repo({ default: { action: 'hang' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old' });
  const spec = { cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'worktree' };
  const child = require('child_process').spawn(process.execPath, ['-e',
    `const { Orchestrator } = require(${JSON.stringify(path.join(H.ROOT, 'server', 'jobs.js'))});
     new Orchestrator(${JSON.stringify(H.CFG)}).submit(${JSON.stringify(spec)});`], { stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  await waitFor(() => H.calls(dir).length >= 1);
  codex.killTree(child);
  await exited;
  const o = orch();
  const j = o.list(dir).find(x => x.task === 'fix a');
  assert.equal(j.status, 'interrupted');
  H.write(j.worktree.path, { 'a.txt': 'half' }); // the dead run's partial work
  scenario(dir, { default: { action: 'ok' }, writes: [{}, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir).promise;
  assert.equal(r.status, 'verified');
  assert.equal(canonicalWorktreePath(H.calls(dir).at(-1).cwd), canonicalWorktreePath(j.worktree.path), 'continued in the same canonical worktree');
  assert.match(H.calls(dir).at(-1).prompt, /interrupted/);
  assert.equal(H.read(dir, 'a.txt'), 'good');
});

test('CLI continue --wait: waits in the foreground until the recorded limit reset, then resumes', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ratelimit' } });
  const j = await orch().submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' }).promise;
  assert.equal(j.status, 'suspended');
  const until = Date.now() + 1500; // the provider's reset, made short for the test
  require('../server/ledger').annotate(store.projectDir(dir), j.id, { result: { ...j.result, suspension: { ...j.result.suspension, until } } });
  codex.clearUnavailable('*'); codex.markUnavailable('*', 'limit', 1500, 'rate_limited');
  scenario(dir, { default: { action: 'ok' } });
  const t0 = Date.now();
  const r = require('child_process').spawnSync(process.execPath, [path.join(H.ROOT, 'bin', 'tandem.js'), 'continue', '--wait', '--cwd', dir], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 >= 1500, 'did not start before the reset');
  assert.match(r.stdout, /ANSWERED/);
});

test('CLI Ctrl+C: running jobs are suspended (resumable), not lost', { skip: process.platform === 'win32' && 'SIGINT cannot be delivered to a child process on Windows' }, async () => {
  clean();
  const dir = H.repo({ default: { action: 'ratelimit' } });
  const j = await orch().submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal' }).promise;
  assert.equal(j.status, 'suspended');
  scenario(dir, { default: { action: 'hang' } });
  const n = H.calls(dir).length;
  const child = require('child_process').spawn(process.execPath, [path.join(H.ROOT, 'bin', 'tandem.js'), 'resume', j.id, '--now', '--cwd', dir], { stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  await waitFor(() => H.calls(dir).length > n);
  child.kill('SIGINT');
  await exited;
  const after = orch().list(dir).find(x => x.id === j.id);
  assert.equal(after.status, 'suspended');
  assert.equal(after.result.suspension.kind, 'user_interrupt');
});

// ---- regressions from the independent review of this branch ----
const ledgerM = require('../server/ledger');
const cliRun = (dir, ...a) => require('child_process').spawnSync(process.execPath, [path.join(H.ROOT, 'bin', 'tandem.js'), ...a, '--cwd', dir], { encoding: 'utf8', timeout: 60000 });

test('review: a job that ran isolated resumes in its kept worktree even when auto isolation would now pick in place', async () => {
  clean();
  const dir = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half' }, { 'a.txt': 'good' }] }, { 'a.txt': 'old' });
  const o = orch();
  const j = await o.submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'worktree' }).promise;
  ledgerM.annotate(store.projectDir(dir), j.id, { isolationPref: 'auto' }); // as if it had been isolated only because the paths were busy
  scenario(dir, { default: { action: 'ok' }, writes: [{}, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir, { now: true }).promise;
  assert.equal(r.status, 'verified');
  assert.equal(fs.realpathSync(H.calls(dir).at(-1).cwd), fs.realpathSync(j.result.resumeFrom.worktree.path)); // macOS: /var is /private/var
  assert.equal(H.read(dir, 'a.txt'), 'good');
});

test('review: a session end while a verified job waits to integrate suspends it and keeps its work', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { HOLDER: { action: 'hang' }, FIXER: { writes: { 'a.txt': 'good' } } } }, { 'a.txt': 'old' });
  const o = orch();
  const holder = o.submit({ cwd: dir, task: 'HOLDER', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: 'none', isolation: 'inplace' });
  await waitFor(() => H.calls(dir).length >= 1);
  const fixer = o.submit({ cwd: dir, task: 'FIXER', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'worktree' });
  await waitFor(() => { const x = ledgerM.get(store.projectDir(dir), fixer.job.id); return x && (x.attempts || []).some(a => a.verified); }, 30000);
  await new Promise(r => setTimeout(r, 300)); // now waiting for the in-place holder's claim
  o.suspendAll('session_ended', 'test');
  const [f] = await Promise.all([fixer.promise, holder.promise]);
  assert.equal(f.status, 'suspended');
  assert.equal(H.read(f.result.resumeFrom.worktree.path, 'a.txt'), 'good', 'verified work kept');
  assert.equal(H.read(dir, 'a.txt'), 'old');
});

test('review: a missing check program never turns an incomplete report into an integrable result', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok', status: 'partial' }, writes: [{ 'a.txt': 'half' }] }, { 'a.txt': 'old' });
  const j = await orch().submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: 'tandem-no-such-program-xyz', isolation: 'worktree' }).promise;
  assert.equal(j.status, 'partial');
  assert.equal(H.read(dir, 'a.txt'), 'old', 'not integrated');
});

test('review: stored and current ceilings both apply on resume (the stricter wins)', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' } });
  const wide = { codexMaxModel: 'gpt-6.1-sol', codexAllowedModels: [], codexMaxEffort: 'xhigh' };
  const o = orch({ codexMaxEffort: 'low' });
  const j = await o.submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'critical', ceiling: wide }).promise;
  assert.ok(j.attempts.every(a => a.effort === 'low' || a.effort === 'minimal'), JSON.stringify(j.attempts));
  const x = await o.submit({ cwd: dir, task: 'q', mode: 'ask', difficulty: 'normal', effort: 'high', ceiling: wide }).promise;
  assert.equal(x.status, 'rejected');
});

test('review: edits the stopped run made in place stay in the scope check after a drift-forced isolated resume', async () => {
  clean();
  const dir = H.repo({ default: { action: 'partial_ratelimit' }, writes: [{ 'a.txt': 'half', 'z.txt': 'stray' }] }, { 'a.txt': 'old', 'b.txt': 'b' });
  const o = orch();
  const j = await o.submit({ cwd: dir, task: 'fix a', mode: 'implement', difficulty: 'normal', paths: ['a.txt'], verify: H.CHECK('a.txt'), isolation: 'inplace' }).promise;
  assert.equal(j.status, 'suspended');
  H.write(dir, { 'b.txt': 'user edit while stopped' });
  scenario(dir, { default: { action: 'ok' }, writes: [{}, { 'a.txt': 'good' }] });
  const r = await o.resume(j.id, dir, { now: true }).promise;
  assert.equal(r.isolation, 'worktree');
  assert.deepEqual(r.result.changedBeforeResume, ['a.txt', 'z.txt'], 'the run\'s own edits, not the user\'s b.txt');
  assert.equal(r.status, 'unverified');
  assert.match(r.result.error, /z\.txt/);
  assert.equal(H.read(dir, 'b.txt'), 'user edit while stopped');
});

test('review: a dependency the lead took over satisfies its dependents', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { FIRST: { action: 'ratelimit' } } });
  const o = orch();
  const a = await o.submit({ cwd: dir, task: 'FIRST', mode: 'ask', difficulty: 'normal' }).promise;
  clean(); codex.clearUnavailable('*');
  const b = await o.submit({ cwd: dir, task: 'SECOND', mode: 'ask', difficulty: 'normal', after: [a.id] }).promise;
  assert.equal(b.status, 'suspended');
  o.takeOver(a.id, dir, 'claude', 'did it inline');
  assert.equal((await o.resume(b.id, dir).promise).status, 'answered');
});

test('review CLI: continue runs dependency-suspended jobs after their dependency; old jobs without ceilings and bad ids start nothing', async () => {
  clean();
  const dir = H.repo({ default: { action: 'ok' }, byPrompt: { FIRST: { action: 'ratelimit' } } });
  const o = orch();
  const a = await o.submit({ cwd: dir, task: 'FIRST', mode: 'ask', difficulty: 'normal' }).promise;
  clean(); codex.clearUnavailable('*');
  const b = await o.submit({ cwd: dir, task: 'SECOND', mode: 'ask', difficulty: 'normal', after: [a.id] }).promise;
  const c = await o.submit({ cwd: dir, task: 'FIRST legacy', mode: 'ask', difficulty: 'normal' }).promise;
  ledgerM.annotate(store.projectDir(dir), c.id, { ceiling: null }); // a job from before ceilings were recorded
  clean(); codex.clearUnavailable('*'); // c hit the limit too; the provider is back now
  const bad = cliRun(dir, 'resume', b.id, 'j999');
  assert.notEqual(bad.status, 0);
  assert.equal(ledgerM.get(store.projectDir(dir), b.id).status, 'suspended', 'nothing started');
  assert.match(cliRun(dir, 'resume', c.id).stderr, /resume it from Claude Code/);
  scenario(dir, { default: { action: 'ok' } });
  const r = cliRun(dir, 'continue', '--now'); // the limit's recorded reset is 2 h away; the user says it is back
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pd = store.projectDir(dir);
  assert.deepEqual([a, b, c].map(x => ledgerM.get(pd, x.id).status), ['answered', 'answered', 'suspended']);
});
