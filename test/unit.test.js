'use strict';
// Unit + property tests for the pure / single-module parts. Simulated (fake Codex) only.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const security = require('../server/security');
const catalog = require('../server/catalog');
const policy = require('../server/policy');
const codex = require('../server/codex');
const memory = require('../server/memory');
const verify = require('../server/verify');
const store = require('../server/store');
const { parseReport } = require('../server/jobs');

// ---------------- security ----------------
test('redactSecrets: known credential shapes are removed, prose is kept', () => {
  const samples = [
    'sk-proj-' + 'a'.repeat(40), 'sk-ant-' + 'b'.repeat(30), 'ghp_' + 'c'.repeat(36), 'github_pat_' + 'd'.repeat(40),
    'AKIA' + 'E'.repeat(16), 'AIza' + 'f'.repeat(35), 'xoxb-1234567890-abc', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  ];
  for (const s of samples) {
    const r = security.redactSecrets(`config uses ${s} here`);
    assert.ok(!r.text.includes(s), s);
    assert.ok(r.found >= 1);
    assert.match(r.text, /config uses .*\[REDACTED\]/);
  }
  const kv = security.redactSecrets('password = hunter2hunter2 and token: abcdefgh12345');
  assert.equal(kv.text, 'password = [REDACTED] and token: [REDACTED]');
  assert.equal(security.redactSecrets('the token lifetime is configurable').found, 0);
});

test('sanitize: strips ANSI, control, zero-width and bidi characters; bounds length', () => {
  assert.equal(security.sanitize('\u001b[31mred\u001b[0m\u0000 a​b‮c\n\nd'), 'red abc d');
  const long = security.sanitize('x'.repeat(1000), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith('…'));
  assert.equal(security.sanitize(undefined), '');
});

test('confine: repo-relative POSIX paths only', () => {
  const root = path.resolve(H.TMP, 'root');
  assert.equal(security.confine(root, 'src/a.js'), 'src/a.js');
  assert.equal(security.confine(root, './src/../b.js'), 'b.js');
  assert.equal(security.confine(root, path.join(root, 'c', 'd.js')), 'c/d.js');
  assert.equal(security.confine(root, '.'), '.');
  for (const bad of ['../x', '../../etc/passwd', path.resolve(H.TMP, 'other', 'f'), '', '   ']) assert.throws(() => security.confine(root, bad), bad);
});

// ---------------- catalog ----------------
test('ceilingCheck: generation first, then family; unknown names need the allow-list', () => {
  const cfg = { codexMaxModel: 'gpt-6.1-sol', codexAllowedModels: [] };
  const allowed = s => catalog.ceilingCheck(s, cfg).allowed;
  assert.equal(allowed('gpt-6-astra'), true);
  assert.equal(allowed('gpt-6.1-sol'), true);
  assert.equal(allowed('gpt-6.1-luna'), true);
  assert.equal(allowed('gpt-6.1-astra'), false);
  assert.equal(allowed('gpt-7-luna'), false);
  assert.equal(allowed('gpt-reserve'), false);
  assert.equal(allowed('gpt-6-nova'), false, 'unknown family is never auto-permitted');
  assert.match(catalog.ceilingCheck('gpt-6-nova', cfg).reason, /allow-list/);
  const al = { ...cfg, codexAllowedModels: ['gpt-6-nova'] };
  assert.equal(catalog.ceilingCheck('gpt-6-nova', al).allowed, true);
  assert.equal(catalog.ceilingCheck('gpt-5.6-luna', al).allowed, false, 'allow-list replaces the heuristic');
});

test('eligible + rungs: explainable exclusions, newest per family, effort ceiling, availability', () => {
  const e = catalog.eligible(H.MODELS, H.CFG, {});
  assert.deepEqual(e.models.map(m => m.slug), ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra']);
  const why = Object.fromEntries(e.excluded);
  assert.match(why['gpt-reserve'], /hidden/);
  assert.match(why['gpt-7-sol'], /above ceiling/);
  assert.match(why['gpt-5.5-luna'], /superseded/);
  const r = catalog.rungs(H.MODELS, { ...H.CFG, codexMaxEffort: 'high' }, { 'gpt-5.6-luna': { reason: 'x', until: Infinity } });
  assert.ok(r.every(x => ['low', 'medium', 'high'].includes(x.effort)));
  assert.equal(r[0].model, 'gpt-5.5-luna', 'older luna used when the newest is unavailable');
  for (let i = 1; i < r.length; i++) assert.ok(r[i].cap >= r[i - 1].cap, 'rungs sorted by prior capability');
  assert.ok(r.every(x => H.MODELS.find(m => m.slug === x.model).efforts.includes(x.effort)), 'only supported efforts');
});

// ---------------- policy ----------------
function bruteForce(ps, Cs, { K, F, rho }) {
  let best = Infinity;
  const rec = (after, k, seq) => {
    if (seq.length) {
      let E = 0, surv = 1;
      seq.forEach((j, i) => { E += surv * Cs[j]; surv *= 1 - ps[j] * (i ? 1 - rho : 1); });
      best = Math.min(best, E + surv * F);
    }
    if (k === 0) return;
    for (let j = Math.max(after, 0); j < ps.length; j++) rec(j, k - 1, [...seq, j]); // retries may repeat a rung
  };
  rec(-1, K, []);
  return best;
}

test('plan: DP equals brute force on 300 random instances (property)', () => {
  const rng = policy.rngFrom('plan-prop');
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rng() * 8);
    const ps = Array.from({ length: n }, () => rng());
    const Cs = Array.from({ length: n }, () => 0.05 + rng() * 3);
    const o = { K: 1 + Math.floor(rng() * 4), F: 0.5 + rng() * 8, rho: rng() * 0.8 };
    const dp = policy.plan(ps, Cs, o);
    assert.ok(Math.abs(dp.E - bruteForce(ps, Cs, o)) < 1e-9, `instance ${t}`);
    assert.ok(dp.seq.length >= 1 && dp.seq.length <= o.K);
    for (let i = 1; i < dp.seq.length; i++) assert.ok(dp.seq[i] >= dp.seq[i - 1]);
  }
});

test('cholesky: L·Lᵀ reproduces random SPD matrices', () => {
  const rng = policy.rngFrom('chol');
  for (let t = 0; t < 50; t++) {
    const n = 2 + Math.floor(rng() * 12);
    const B = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() - 0.5));
    const A = B.map((r, i) => r.map((_, j) => B[i].reduce((x, v, k) => x + v * B[j][k], 0) + (i === j ? 0.1 : 0)));
    const L = policy.cholesky(A);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0; for (let k = 0; k < n; k++) s += L[i][k] * L[j][k];
      assert.ok(Math.abs(s - A[i][j]) < 1e-9);
    }
  }
});

// Synthetic evidence from a known world where the catalog's family order is WRONG (terra > astra).
function syntheticEvidence(rungs, truth, perClass = 80) {
  const rng = policy.rngFrom('synthetic');
  const ev = { version: 2, classes: {} };
  for (const d of ['trivial', 'normal', 'hard', 'critical']) {
    for (let i = 0; i < perClass; i++) {
      const r = rungs[Math.floor(rng() * rungs.length)];
      const p = 1 / (1 + Math.exp(-(truth.alpha[d] + truth.gamma[r.model] + truth.eps[r.effort])));
      policy.append(ev, 'implement|' + d, { r: catalog.key(r), ok: rng() < p, cond: false, tin: 30000, tc: 0, tout: 500, sec: 30 });
    }
  }
  return ev;
}

test('success model: learns an ordering that contradicts the catalog prior', () => {
  const rungs = catalog.rungs(H.MODELS, H.CFG, {});
  const truth = { alpha: { trivial: 1, normal: 0, hard: -1, critical: -2 }, gamma: { 'gpt-5.6-luna': -1, 'gpt-5.6-terra': 1.5, 'gpt-5.6-sol': 0, 'gpt-6-astra': -0.5 }, eps: { low: 0, medium: 0.2, high: 0.4, xhigh: 0.6 } };
  const ev = syntheticEvidence(rungs, truth);
  const { est } = policy.estimate(ev, 'implement|normal', rungs, H.CFG);
  const p = k => est.find(e => e.k === k).p;
  assert.ok(p('gpt-5.6-terra@low') > p('gpt-6-astra@low'), 'terra learned to beat astra');
  assert.ok(p('gpt-5.6-terra@low') > p('gpt-5.6-luna@low'));
  const cold = policy.estimate({ version: 2, classes: {} }, 'implement|normal', rungs, H.CFG).est;
  assert.ok(cold.find(e => e.k === 'gpt-6-astra@low').p > cold.find(e => e.k === 'gpt-5.6-terra@low').p, 'cold prior still follows the family hint');
  // Evidence from other classes informs a class with no observations of its own.
  const ev2 = { version: 2, classes: { 'implement|hard': ev.classes['implement|hard'] } };
  const unseen = policy.estimate(ev2, 'implement|normal', rungs, H.CFG).est;
  assert.ok(unseen.find(e => e.k === 'gpt-5.6-terra@low').p > unseen.find(e => e.k === 'gpt-6-astra@low').p, 'shared model effects transfer across classes');
});

test('success model: Laplace samples are centred on the posterior predictive', () => {
  const rungs = catalog.rungs(H.MODELS, H.CFG, {});
  const truth = { alpha: { trivial: 1, normal: 0, hard: -1, critical: -2 }, gamma: { 'gpt-5.6-luna': 0, 'gpt-5.6-terra': 0.5, 'gpt-5.6-sol': 1, 'gpt-6-astra': 1.5 }, eps: { low: 0, medium: 0.2, high: 0.4, xhigh: 0.6 } };
  const ev = syntheticEvidence(rungs, truth, 20);
  const e = policy.estimate(ev, 'implement|hard', rungs, H.CFG);
  const rng = policy.rngFrom('laplace');
  const N = 4000, sums = new Array(rungs.length).fill(0);
  for (let i = 0; i < N; i++) e.sample(rng).forEach((p, j) => { sums[j] += p; });
  sums.forEach((s, j) => assert.ok(Math.abs(s / N - e.est[j].p) < 0.03, `${e.est[j].k}: ${s / N} vs ${e.est[j].p}`));
});

test('policy learns: repeated success on a cheap rung makes it first; repeated failure moves routing away', () => {
  const rungs = catalog.rungs(H.MODELS, H.CFG, {});
  const cheap = rungs[0];
  const good = store.mkdirp(path.join(H.TMP, 'pol-good'));
  const bad = store.mkdirp(path.join(H.TMP, 'pol-bad'));
  const cls = 'implement|hard';
  const first = pd => rungs[policy.decide(pd, { cls, rungs, cfg: H.CFG, maxAttempts: 2 }).seq[0]];
  const cold = first(good);
  assert.notEqual(catalog.key(cold), catalog.key(cheap), 'cold start for hard work is not the cheapest rung');
  for (let i = 0; i < 12; i++) {
    policy.record(good, cls, { r: catalog.key(cheap), ok: true, tin: 20000, tc: 5000, tout: 500, sec: 20 });
    policy.record(bad, cls, { r: catalog.key(cold), ok: false, tin: 60000, tc: 5000, tout: 900, sec: 50 });
  }
  assert.equal(catalog.key(first(good)), catalog.key(cheap));
  assert.notEqual(catalog.key(first(bad)), catalog.key(cold), 'repeated failures move routing off the failing rung');
  const d = policy.decide(good, { cls, rungs, cfg: H.CFG, maxAttempts: 2 });
  assert.equal(d.record.nObs, 12);
  assert.ok(Array.isArray(d.record.plan) && d.record.plan[0].r);
});

test('decide: exploration is seeded (reproducible) and regret-bounded', () => {
  const rungs = catalog.rungs(H.MODELS, H.CFG, {});
  const pd = store.mkdirp(path.join(H.TMP, 'pol-explore'));
  const cfg = { ...H.CFG, exploration: true };
  let explored = 0;
  for (let i = 0; i < 60; i++) {
    const a = policy.decide(pd, { cls: 'ask|normal', rungs, cfg, maxAttempts: 2, seed: 'job' + i });
    const b = policy.decide(pd, { cls: 'ask|normal', rungs, cfg, maxAttempts: 2, seed: 'job' + i });
    assert.deepEqual(a.seq, b.seq);
    const exploit = policy.decide(pd, { cls: 'ask|normal', rungs, cfg: H.CFG, maxAttempts: 2 });
    assert.ok(a.E <= 1.5 * exploit.E + 1e-9, 'explored plan within the regret bound');
    if (a.record.explored) explored++;
  }
  assert.ok(explored > 0, 'cold start explores sometimes');
});

test('policy migrates v1 router-stats into observations once', () => {
  const pd = store.mkdirp(path.join(H.TMP, 'pol-migrate'));
  fs.writeFileSync(path.join(pd, 'router-stats.json'), JSON.stringify({ 'implement|normal': { offset: 0, totals: { 'gpt-5.6-terra@medium': { jobs: 4, firstOk: 3, finalOk: 4, tokens: 200000, attempts: 5, ms: 100000 } } } }));
  const ev = policy.loadEvidence(pd);
  assert.equal(ev.classes['implement|normal'].length, 4);
  assert.equal(ev.classes['implement|normal'].filter(o => o.ok).length, 3);
});

// ---------------- codex adapter ----------------
test('classifyError and retryAfterMs', () => {
  const cases = {
    "You've hit your usage limit. Try again in 2h 5m.": 'rate_limited', '429 Too Many Requests': 'rate_limited',
    '401 Unauthorized': 'auth', "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.": 'model_unavailable',
    'stream disconnected before completion: 503': 'transient', 'ECONNRESET': 'transient', 'something odd': 'error',
  };
  for (const [m, k] of Object.entries(cases)) assert.equal(codex.classifyError(m), k, m);
  assert.equal(codex.retryAfterMs('try again in 2h 5m'), (2 * 60 + 5) * 60e3);
  assert.equal(codex.retryAfterMs('resets in 90 seconds'), 90e3);
  assert.equal(codex.retryAfterMs('no hint'), 15 * 60e3);
  assert.equal(codex.retryAfterMs('in 400 hours'), 24 * 3600e3, 'capped at 24h');
  // Real Codex wording (codex-cli 0.154.0, ChatGPT account), local wall-clock time.
  const now = new Date(2026, 9, 9, 11, 59).getTime();
  const real = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:18 PM.";
  assert.equal(codex.classifyError(real), 'rate_limited');
  assert.equal(codex.retryAfterMs(real, now), (4 * 60 + 19 + 1) * 60e3);
  assert.equal(codex.retryAfterMs('try again at 12:05 AM', now), (12 * 60 + 6 + 1) * 60e3, 'past time = tomorrow');
  assert.equal(codex.retryAfterMs('try again at 13:00', now), (61 + 1) * 60e3, '24-hour clock');
});

test('buildArgs: prompt via stdin, resume form, lean flags', () => {
  const a = codex.buildArgs({ sandbox: 'read-only', model: 'm', effort: 'low', lean: true, ephemeral: true, schemaFile: 's.json' });
  assert.equal(a[0], 'exec');
  assert.equal(a.at(-1), '-');
  assert.ok(a.includes('--ephemeral') && a.includes('--output-schema') && a.includes('plugins'));
  const r = codex.buildArgs({ sandbox: 'workspace-write', model: 'm', effort: 'high', resumeThread: 't1' });
  assert.deepEqual(r.slice(0, 3), ['exec', 'resume', 't1']);
  assert.ok(!r.includes('-s') && !r.includes('-C'), 'resume has no -s/-C flags');
  assert.ok(r.includes('sandbox_mode="workspace-write"'));
});

const turn = (dir, extra = {}) => codex.runTurn({ args: codex.buildArgs({ sandbox: 'read-only', model: 'gpt-5.6-luna', effort: 'low' }), prompt: 'hi', cwd: dir, timeoutMs: 15000, ...extra });

test('runTurn: tolerates garbage, oversized and split multibyte lines (fuzz)', async () => {
  const dir = H.repo({ default: { action: 'garbage' } });
  const r = await turn(dir).done;
  assert.equal(r.ok, true);
  assert.ok(r.badLines >= 1);
  assert.ok(r.usage.input > 0);
});

test('runTurn: a stream hiccup that recovers is not a failure; a crash is', async () => {
  const flaky = await turn(H.repo({ default: { action: 'flaky' } })).done;
  assert.equal(flaky.ok, true);
  assert.ok(flaky.warnings.some(w => /Reconnecting/.test(w)));
  const crash = await turn(H.repo({ default: { action: 'crash' } })).done;
  assert.equal(crash.ok, false);
  assert.match(crash.error, /exited \(3\)/);
});

test('runTurn: timeout kills the process tree', async () => {
  const r = await turn(H.repo({ default: { action: 'hang' } }), { timeoutMs: 1500 }).done;
  assert.equal(r.timedOut, true);
  assert.equal(r.errorKind, 'timeout');
  assert.ok(r.durationMs < 10000);
});

test('runTurn: an orphaned grandchild holding stdout cannot hang the turn', async () => {
  const r = await turn(H.repo({ default: { action: 'orphan' } })).done;
  assert.equal(r.ok, false);
  assert.ok(r.durationMs < 6000, `resolved after ${r.durationMs} ms`);
});

test('parseReport: untrusted output is bounded, sanitised and secret-free', () => {
  const p = parseReport(JSON.stringify({ status: 'done', summary: 'ok sk-proj-' + 'z'.repeat(40), files_changed: ['a'], verification: 'v', findings: Array(20).fill('f\u001b[31m'), open_questions: [] }));
  assert.equal(p.status, 'done');
  assert.ok(!p.summary.includes('zzzz'));
  assert.equal(p.findings.length, 5);
  assert.equal(p.findings[0], 'f');
  const bad = parseReport('I did it!');
  assert.equal(bad.status, 'partial');
  assert.equal(bad.unstructured, true);
  assert.equal(parseReport(JSON.stringify({ status: 'weird', summary: 1 })).status, 'partial');
});

// ---------------- memory ----------------
test('memory: dedupe, verified never downgraded, redaction, supersede, staleness', () => {
  const root = H.repo(null, { 'src/a.js': 'v1' });
  const pd = store.projectDir(root);
  const a = memory.write(pd, root, { kind: 'decision', text: 'Use pnpm for all package installs', files: ['src/a.js'], verified: true });
  assert.equal(a.action, 'added');
  const b = memory.write(pd, root, { kind: 'decision', text: 'Use pnpm for all package installs!', source: { agent: 'codex' } });
  assert.equal(b.action, 'kept-verified');
  assert.equal(b.id, a.id);
  const s = memory.write(pd, root, { kind: 'fact', text: 'api key is sk-proj-' + 'q'.repeat(30) });
  assert.ok(s.redacted >= 1);
  assert.ok(!memory.load(pd).entries.find(e => e.id === s.id).text.includes('qqqq'));
  assert.throws(() => memory.write(pd, root, { kind: 'fact', text: 'x', files: ['../outside'] }), /escapes/);
  const c = memory.write(pd, root, { kind: 'decision', text: 'Use npm workspaces instead of pnpm', supersedes: a.id });
  assert.equal(memory.load(pd).entries.find(e => e.id === a.id).status, 'superseded');
  assert.ok(!memory.search(pd, root, { query: 'pnpm' }).some(e => e.id === a.id), 'superseded hidden by default');
  memory.setStatus(pd, c.id, { verified: true });
  memory.write(pd, root, { kind: 'constraint', text: 'a.js must stay ES5 compatible', files: ['src/a.js'] });
  H.write(root, { 'src/a.js': 'v2' });
  const hit = memory.search(pd, root, { query: 'ES5 compatible' });
  assert.equal(hit[0].stale, true);
  assert.match(memory.fmt(hit[0]), /STALE/);
});

test('memory: tentative entries expire; caps bound growth', () => {
  const root = H.repo(null);
  const pd = store.projectDir(root);
  memory.write(pd, root, { kind: 'fact', text: 'old tentative fact about caching' });
  const db = memory.load(pd);
  db.entries[0].lastUsed = db.entries[0].updated = Date.now() - 40 * 864e5;
  store.writeJson(memory.file(pd), db);
  memory.write(pd, root, { kind: 'note', text: 'trigger housekeeping now' });
  assert.equal(memory.load(pd).entries[0].status, 'expired');
  for (let i = 0; i < memory.ACTIVE_CAP + 30; i++) memory.write(pd, root, { kind: 'note', text: `unique note number ${i} zq${i}x` });
  const c = memory.counts(pd);
  assert.ok(c.active <= memory.ACTIVE_CAP);
  assert.ok(memory.load(pd).entries.length <= memory.ACTIVE_CAP + 200);
});

test('memory: v1 file migrates; corrupted file recovers from .bak', () => {
  const root = H.repo(null);
  const pd = store.projectDir(root);
  fs.writeFileSync(memory.file(pd), JSON.stringify({ seq: 2, entries: [
    { id: 'm1', kind: 'done', text: 'shipped login', verified: true, source: 'claude', files: [{ path: 'a', mtimeMs: 1 }], status: 'active' },
    { id: 'm2', kind: 'fact', text: 'uses jest', verified: false, source: 'codex:gpt-5.6-sol', files: [], status: 'active' },
  ] }));
  const db = memory.load(pd);
  assert.equal(db.version, 2);
  assert.equal(db.entries[0].kind, 'note');
  assert.equal(db.entries[0].confidence, 'verified');
  assert.deepEqual(db.entries[1].source, { agent: 'codex', model: 'gpt-5.6-sol' });
  memory.write(pd, root, { kind: 'fact', text: 'first durable write' });
  memory.write(pd, root, { kind: 'fact', text: 'second durable write different' });
  fs.writeFileSync(memory.file(pd), '{"version":2,"entr'); // torn write
  assert.ok(memory.load(pd).entries.some(e => e.text === 'first durable write'), 'previous good copy used');
});

test('memory: concurrent writers from 4 processes lose nothing', () => {
  const root = H.repo(null);
  const pd = store.projectDir(root);
  const script = `const m=require(${JSON.stringify(path.join(H.ROOT, 'server', 'memory.js'))});for(let i=0;i<15;i++)m.write(${JSON.stringify(pd)},${JSON.stringify(root)},{kind:'note',text:'proc '+process.argv[1]+' entry '+i+' k'+process.argv[1]+'x'+i});`;
  const procs = [0, 1, 2, 3].map(p => require('child_process').spawn(process.execPath, ['-e', script, String(p)], { env: process.env }));
  return Promise.all(procs.map(c => new Promise(r => c.on('close', r)))).then(codes => {
    assert.deepEqual(codes, [0, 0, 0, 0]);
    const db = memory.load(pd);
    assert.equal(db.entries.length, 60);
    assert.equal(new Set(db.entries.map(e => e.id)).size, 60);
  });
});

// ---------------- verify / store ----------------
test('testFingerprint detects modifications to tracked and untracked tests; additions are allowed', () => {
  const root = H.repo(null, { 'src/a.test.js': 'original', 'main.js': 'original', 'gone.test.js': 'x' });
  H.write(root, { 'extra.test.js': 'untracked original' });
  const a = verify.testFingerprint(root);
  H.write(root, { 'src/a.test.js': 'weakened', 'extra.test.js': 'weakened', 'gone.test.js': null, 'brand-new.test.js': 'new', 'main.js': 'changed' });
  const b = verify.testFingerprint(root);
  assert.deepEqual(verify.testChanges(a, b).sort(), ['extra.test.js', 'gone.test.js', 'src/a.test.js']);
  H.write(root, { 'sub/tests/conftest.py': 'collect_ignore_glob = ["*"]' });
  assert.deepEqual(verify.testChanges(b, verify.testFingerprint(root)), ['sub/tests/conftest.py'], 'new conftest.py is configuration');
  const plain = path.join(H.TMP, `plain-${Date.now()}`);
  H.write(plain, { 'tests/t.py': 'a', 'node_modules/x/y.test.js': 'dep' });
  assert.deepEqual(Object.keys(verify.testFingerprint(plain)), ['tests/t.py'], 'outside git: walked, dependencies skipped');
});

test('verify: detection, fingerprint of scripts only, deleted tests, timeout', async () => {
  const dir = H.repo(null, { 'package.json': JSON.stringify({ scripts: { test: 'node t.js' }, dependencies: { a: '1' } }) });
  assert.equal(verify.detect(dir), 'npm test --silent');
  const before = verify.fingerprint(dir);
  H.write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'node t.js' }, dependencies: { a: '2' } }) });
  assert.deepEqual(verify.definitionChanges(before, verify.fingerprint(dir)), [], 'dependency bump is not a test change');
  H.write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'exit 0' } }), 'pytest.ini': '[pytest]' });
  assert.deepEqual(verify.definitionChanges(before, verify.fingerprint(dir)).sort(), ['package.json', 'pytest.ini']);
  assert.deepEqual(verify.deletedTests([{ status: 'D', path: 'test/a.test.js' }, { status: 'D', path: 'src/a.js' }, { status: 'M', path: 'tests/x.py' }, { status: 'D', path: 'pkg/foo_test.go' }]), ['test/a.test.js', 'pkg/foo_test.go']);
  const t = await verify.run('node -e "setTimeout(()=>{},60000)"', dir, 1000);
  assert.equal(t.ok, false);
  assert.equal(t.timedOut, true);
  const bg = await verify.run(`node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:['ignore','inherit','inherit'],detached:true}).unref()"`, dir, 30000);
  assert.equal(bg.ok, true, 'a leftover background process does not hang verification');
  assert.ok(bg.ms < 6000, `took ${bg.ms} ms`);
});

test('store: stale lock from a dead process is broken; live lock waits', () => {
  const f = path.join(H.TMP, 'locked.json');
  fs.writeFileSync(f + '.lock', `999999 ${Date.now()}`); // pid that does not exist
  assert.equal(store.update(f, { n: 0 }, d => ++d.n), 1);
  assert.ok(!fs.existsSync(f + '.lock'));
});

test('store: an old lock held by a reused (live) PID is broken, not waited on forever', () => {
  const f = path.join(H.TMP, 'reused.json');
  fs.writeFileSync(f + '.lock', `${process.pid} ${Date.now() - 120000} deadbeef`); // live pid, stale age
  const t0 = Date.now();
  assert.equal(store.update(f, { n: 0 }, d => ++d.n), 1);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('store: a holder that lost its lock neither commits nor deletes the new owner\'s lock', () => {
  const f = path.join(H.TMP, 'fenced.json');
  const theirs = `${process.pid} ${Date.now()} 0123456789abcdef`;
  store.withLock(f, held => {
    assert.equal(held(), true);
    fs.writeFileSync(f + '.lock', theirs); // another process broke our lock after a stall and took it
    assert.equal(held(), false);
  });
  assert.equal(fs.readFileSync(f + '.lock', 'utf8'), theirs, 'new owner\'s lock untouched on release');
  fs.unlinkSync(f + '.lock');
  // update(): the transaction that lost its lock is not committed; it is re-run on fresh state.
  store.writeJson(f, { n: 1 });
  let calls = 0;
  store.update(f, { n: 0 }, d => {
    if (++calls === 1) { d.n = 99; fs.writeFileSync(f + '.lock', `999999 ${Date.now()} lost`); } // new owner, since crashed
    else d.n += 1;
  });
  assert.equal(calls, 2);
  assert.equal(store.readJson(f).n, 2, 'the discarded attempt never landed; the retry did, once');
  assert.ok(!fs.existsSync(f + '.lock'));
});

test('store: 8 processes × 100 transactions with crash-left locks planted meanwhile lose no update', async () => {
  const f = path.join(H.TMP, 'stress', 'counter.json');
  const script = `
    const s = require(${JSON.stringify(path.join(H.ROOT, 'server', 'store.js'))});
    const fs = require('fs');
    for (let i = 0; i < 100; i++) {
      s.update(${JSON.stringify(f)}, { n: 0 }, d => { d.n++; });
      // A crashed holder leaves a lock behind (dead pid); others must break it without losing updates.
      if (Math.random() < 0.05) try { fs.writeFileSync(${JSON.stringify(f + '.lock')}, '999999 ' + Date.now() + ' dead', { flag: 'wx' }); } catch {}
    }`;
  const { spawn } = require('child_process');
  const procs = Array.from({ length: 8 }, () => spawn(process.execPath, ['-e', script], { env: process.env, stdio: 'inherit' }));
  assert.deepEqual(await Promise.all(procs.map(c => new Promise(r => c.on('close', r)))), Array(8).fill(0));
  assert.equal(store.readJson(f).n, 800);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(n => n.endsWith('.stale') || n.endsWith('.tmp')), []);
});
