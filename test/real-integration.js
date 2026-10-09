#!/usr/bin/env node
'use strict';
// Opt-in integration test against the REAL Codex CLI. Uses your Codex quota (≈5–10 min, a few
// hundred thousand tokens). Never run in CI.
//   node test/real-integration.js [--out bench/data/real-integration.json]
// Each check is recorded as pass / fail / skip with evidence; the process exits 1 on any failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-real-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
delete process.env.TANDEM_CODEX_BIN;
const codex = require('../server/codex');
const catalog = require('../server/catalog');
const memory = require('../server/memory');
const store = require('../server/store');
const ledger = require('../server/ledger');
const { Orchestrator } = require('../server/jobs');
const { config } = require('../server/config');

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, outcome: evidence && evidence.skip ? 'skip' : 'pass', ms: Date.now() - t, evidence });
    console.log(`${evidence && evidence.skip ? 'SKIP' : 'PASS'} ${name}${evidence ? ' — ' + JSON.stringify(evidence).slice(0, 300) : ''}`);
  } catch (e) {
    results.push({ name, outcome: 'fail', ms: Date.now() - t, error: String(e && e.stack || e).slice(0, 2000) });
    console.log(`FAIL ${name} — ${String(e && e.message || e).slice(0, 500)}`);
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const att = j => (j.attempts || []).map(a => `${a.model}@${a.effort}${a.verified === true ? '+' : a.verified === false ? '-' : ''}${a.errorKind ? '!' + a.errorKind : ''}`);
const tok = j => j.result && j.result.usage;

function project(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'slug.js'), "'use strict';\nmodule.exports = function slugify(s) {\n  throw new Error('not implemented');\n};\n");
  fs.writeFileSync(path.join(dir, 'slug.test.js'), "const t=require('node:test');const a=require('assert');const s=require('./slug');\nt('slug',()=>{a.equal(s('  Hello, World! '),'hello-world');a.equal(s('Çok Güzel_Şey'),'cok-guzel-sey');a.equal(s('a--b'),'a-b');});\n");
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'clamp.js'), "'use strict';\nmodule.exports = function clamp(x, lo, hi) {\n  throw new Error('not implemented');\n};\n");
  fs.writeFileSync(path.join(dir, 'lib', 'clamp.test.js'), "const t=require('node:test');const a=require('assert');const c=require('./clamp');\nt('clamp',()=>{a.equal(c(5,0,3),3);a.equal(c(-1,0,3),0);a.equal(c(2,0,3),2);a.throws(()=>c(1,3,0));});\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'keep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'keep', 'index.js'), 'module.exports = 1;\n');
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

(async () => {
  const cfg = config();
  const env = await codex.discover({ force: true });
  const meta = { date: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, node: process.version, codex: env.version, ceiling: cfg.codexMaxModel, effortCeiling: cfg.codexMaxEffort };
  console.log(JSON.stringify(meta));
  if (!env.installed || !env.loggedIn) { console.log('Codex not installed or not logged in: nothing to test.'); process.exit(2); }
  const o = new Orchestrator(cfg);
  const dir = project('proj');

  await check('discovery: catalog parsed, ceilings applied with reasons', () => {
    const e = catalog.eligible(env.models, cfg, {});
    must(e.models.length > 0, 'no eligible model');
    return { catalog: env.models.map(m => m.slug), eligible: e.models.map(m => m.slug), excluded: e.excluded, rungs: catalog.rungs(env.models, cfg, {}).map(catalog.key) };
  });

  await check('explicit model the account cannot run is rejected, never substituted', async () => {
    const want = 'gpt-6.1-sol';
    const j = await o.submit({ cwd: dir, task: 'Say hi.', mode: 'ask', difficulty: 'trivial', model: want, effort: 'low', max_attempts: 1 }).promise;
    if (j.status === 'answered') return { skip: true, note: `${want} is executable on this account`, attempts: att(j) };
    must(j.status === 'rejected', `status ${j.status}: ${j.result && j.result.error}`);
    must(j.attempts.every(a => a.model === want), 'another model was tried');
    must(codex.unavailable()[want], 'not remembered as unavailable');
    return { status: j.status, error: j.result.error.slice(0, 160) };
  });

  let ask;
  await check('ask: routed to a permitted model, read-only, answered', async () => {
    ask = await o.submit({ cwd: dir, task: 'Which function does slug.js export and what does it currently do? One sentence. Also report as a finding: "slug.js exports slugify".', mode: 'ask', difficulty: 'trivial' }).promise;
    must(ask.status === 'answered', `status ${ask.status}: ${JSON.stringify(ask.result).slice(0, 400)}`);
    must(ask.attempts.every(a => catalog.ceilingCheck(a.model, cfg).allowed), 'model outside permission');
    must(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim() === '', 'read-only job changed files');
    return { attempts: att(ask), route: ask.route.plan, usage: tok(ask), ms: ask.finished - ask.started, summary: ask.result.report.summary.slice(0, 160) };
  });

  await check('memory: Codex findings stored as tentative with provenance', () => {
    const pd = store.projectDir(dir);
    const ids = ask && ask.result.memoryIds || [];
    if (!ids.length) return { skip: true, note: 'model reported no findings' };
    const e = memory.load(pd).entries.find(x => x.id === ids[0]);
    must(e.confidence === 'tentative' && e.source.agent === 'codex' && e.source.job === ask.id, JSON.stringify(e));
    return { entry: memory.fmt(e).slice(0, 200) };
  });

  // Two concurrent writers on overlapping scope: one in place, one isolated in a worktree.
  let inplace, isolated;
  await check('concurrent implement: isolated worktree + wide in-place writer, no duplicated work, both verified and integrated', async () => {
    const b = o.submit({ cwd: dir, task: 'Implement clamp in lib/clamp.js so `node --test lib/clamp.test.js` passes; throw a RangeError when lo > hi.', mode: 'implement', difficulty: 'normal', paths: ['lib/clamp.js'], verify: 'node --test lib/clamp.test.js', isolation: 'worktree' });
    await new Promise(r => setTimeout(r, 1500));
    const a = o.submit({ cwd: dir, task: 'Implement slugify in slug.js so `node --test slug.test.js` passes: lowercase, strip diacritics (Turkish chars too), non-alphanumerics become single hyphens, trim hyphens.', mode: 'implement', difficulty: 'normal', paths: ['.'], verify: 'node --test slug.test.js', isolation: 'inplace' });
    [inplace, isolated] = await Promise.all([a.promise, b.promise]);
    must(inplace.status === 'verified', `slug: ${inplace.status} ${JSON.stringify(inplace.result).slice(0, 600)}`);
    must(isolated.status === 'verified', `clamp: ${isolated.status} ${JSON.stringify(isolated.result).slice(0, 600)}`);
    must(isolated.isolation === 'worktree', `clamp isolation ${isolated.isolation}`);
    must(isolated.finished > inplace.started, 'did not overlap in time');
    must(!(inplace.result.changed || []).includes('lib/clamp.js'), 'in-place writer duplicated the isolated job work');
    execFileSync('node', ['--test'], { cwd: dir, stdio: 'ignore' }); // independent re-check of both in the user's tree
    must(fs.existsSync(path.join(dir, 'node_modules', 'keep', 'index.js')), 'linked node_modules content was lost');
    must(!fs.existsSync(isolated.worktree.path), 'worktree not cleaned up');
    return {
      inplace: { attempts: att(inplace), usage: tok(inplace), changed: inplace.result.changed, ms: inplace.finished - inplace.started },
      isolated: { attempts: att(isolated), usage: tok(isolated), integration: isolated.result.integration, ms: isolated.finished - isolated.started },
    };
  });

  await check('thread resume keeps context (Tandem resume argv: stdin prompt, -c sandbox, schema)', async () => {
    const last = (inplace && inplace.attempts.at(-1)) || { model: catalog.rungs(env.models, cfg, codex.unavailable())[0].model, effort: 'low' };
    const schema = path.join(store.DATA, 'output-schema.v2.json');
    const spec = { sandbox: 'read-only', model: last.model, effort: 'low', schemaFile: schema, lean: cfg.leanCodex };
    const r1 = await codex.runTurn({ args: codex.buildArgs(spec), prompt: 'Reply with status done and summary "one". Do not change files. Empty arrays elsewhere.', cwd: dir, timeoutMs: 300000 }).done;
    must(r1.ok && r1.threadId, 'fresh run: ' + r1.error);
    const r2 = await codex.runTurn({ args: codex.buildArgs({ ...spec, resumeThread: r1.threadId }), prompt: 'What summary did you give last time? Reply with status done and that word as summary.', cwd: dir, timeoutMs: 300000 }).done;
    must(r2.ok, 'resume failed: ' + r2.error);
    must(/one/i.test(r2.finalText), 'resumed thread lost context: ' + r2.finalText);
    return { model: last.model, cachedShareOnResume: +(r2.usage.cached / (r2.usage.input || 1)).toFixed(2), freshIn: r1.usage.input, resumeIn: r2.usage.input };
  });

  await check('cancel stops a real running job and releases its claim', async () => {
    const j = o.submit({ cwd: dir, task: 'Write a detailed design document in docs/design.md describing 20 alternative slugify algorithms with code for each.', mode: 'implement', difficulty: 'hard', paths: ['docs'], verify: 'none', isolation: 'inplace' });
    await new Promise(r => setTimeout(r, 6000));
    must(o.cancel(j.job.id), 'cancel returned false');
    const done = await j.promise;
    must(done.status === 'cancelled', 'status ' + done.status);
    must(!ledger.heldClaims(store.projectDir(dir)).some(c => c.id === done.id), 'claim still held');
    return { status: done.status, msAfterCancel: done.finished - (done.started + 6000) };
  });

  await check('MCP server over stdio with the real provider: status + dry-run + ask', async () => {
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], { cwd: dir, env: { ...process.env, TANDEM_PROJECT_DIR: dir } });
    let buf = ''; const pending = new Map(); let id = 0;
    srv.stdout.setEncoding('utf8');
    srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
    const rpc = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    const text = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
    try {
      await rpc('initialize', {});
      const st = await text('tandem_status', {});
      must(/permitted: /.test(st), st);
      const dry = await text('codex_run', { task: 'x', mode: 'implement', difficulty: 'hard', dry_run: true });
      must(/plan for implement\|hard/.test(dry), dry);
      const out = await text('codex_run', { task: 'In one sentence: what does lib/clamp.js do now?', mode: 'ask', difficulty: 'trivial' });
      must(/ANSWERED/.test(out) && /untrusted model output/.test(out), out.slice(0, 500));
      return { dryRun: dry.slice(0, 200), answer: out.split('\n')[0] };
    } finally { srv.stdin.end(); srv.kill(); }
  });

  const failed = results.filter(r => r.outcome === 'fail').length;
  const summary = { meta, results, totals: { pass: results.filter(r => r.outcome === 'pass').length, fail: failed, skip: results.filter(r => r.outcome === 'skip').length } };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(summary, (k, v) => (typeof v === "string" ? v.split(os.homedir()).join("~") : v), 2)); }
  console.log(`REAL INTEGRATION: ${failed ? 'FAIL' : 'PASS'} ${JSON.stringify(summary.totals)}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('REAL INTEGRATION: CRASH\n', e); process.exit(1); });
