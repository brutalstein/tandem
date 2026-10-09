#!/usr/bin/env node
'use strict';
// Opt-in integration test against the REAL Codex CLI (uses your Codex quota, ~1-3 min).
//   node test/real-integration.js
// Covers: discovery, ask job, implement job verified by a real test, resume of a real thread.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-real-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
delete process.env.TANDEM_CODEX_BIN;
const codex = require('../server/codex');
const { JobManager } = require('../server/jobs');
const { config } = require('../server/config');
const router = require('../server/router');

const dir = path.join(TMP, 'proj');
fs.mkdirSync(dir);
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
fs.writeFileSync(path.join(dir, 'slug.js'), "'use strict';\nmodule.exports = function slugify(s) {\n  throw new Error('not implemented');\n};\n");
fs.writeFileSync(path.join(dir, 'slug.test.js'), "const t=require('node:test');const a=require('assert');const s=require('./slug');\nt('slug',()=>{a.equal(s('  Hello, World! '),'hello-world');a.equal(s('Çok Güzel_Şey'),'cok-guzel-sey');a.equal(s('a--b'),'a-b');});\n");
git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

const line = (label, j) => console.log(`${label}: ${j.status} | ${j.attempts.map(a => `${a.model}@${a.effort} ${Math.round(a.ms / 1000)}s ${a.tokens}tok${a.verified !== undefined ? (a.verified ? ' ✓' : ' ✗') : ''}${a.errorKind ? ' ' + a.errorKind : ''}`).join(' -> ')}`);

(async () => {
  const cfg = config();
  const env = await codex.discover({ force: true });
  console.log(`codex ${env.version}; logged in: ${env.loggedIn}; ladder: ${router.ladder(env.models, cfg, {}).map(r => r.model + '@' + r.effort).join(' < ')}`);
  assert.ok(env.installed && env.loggedIn, 'codex must be installed and logged in');

  const jm = new JobManager(cfg);
  const ask = await jm.submit({ cwd: dir, task: 'Which function does slug.js export and what does it currently do? One sentence.', mode: 'ask', difficulty: 'trivial' }).promise;
  line('ask', ask);
  assert.equal(ask.status, 'answered', JSON.stringify(ask.result));

  const impl = await jm.submit({ cwd: dir, task: 'Implement slugify in slug.js so `npm test` passes: lowercase, strip diacritics (Turkish chars too), non-alphanumerics become single hyphens, trim hyphens.', mode: 'implement', difficulty: 'normal', paths: ['slug.js'] }).promise;
  line('implement', impl);
  console.log('  changed:', impl.result.changed, 'outOfScope:', impl.result.outOfScope, 'verify:', impl.result.verification && impl.result.verification.command);
  assert.equal(impl.status, 'verified', JSON.stringify(impl.result).slice(0, 1500));
  execFileSync('node', ['--test'], { cwd: dir, stdio: 'ignore' }); // independent re-check

  // Resume a real thread with Tandem's resume argument vector (stdin prompt, -c sandbox, schema).
  const first = impl.attempts[impl.attempts.length - 1];
  const r1 = await codex.runCodex({ args: jm.args({ mode: 'implement' }, first, null, path.join(process.env.TANDEM_DATA, 'output-schema.json')), prompt: 'Reply with status done and summary "one". Do not change files.', cwd: dir, timeoutMs: 300000 }).done;
  assert.ok(r1.ok && r1.threadId, 'fresh run: ' + r1.error);
  const r2 = await codex.runCodex({ args: jm.args({ mode: 'implement' }, first, r1.threadId, path.join(process.env.TANDEM_DATA, 'output-schema.json')), prompt: 'What summary did you give last time? Reply with status done and that word as summary.', cwd: dir, timeoutMs: 300000 }).done;
  console.log(`resume: ok=${r2.ok} thread=${r2.threadId === r1.threadId} cached=${r2.usage.cached}/${r2.usage.input} answer=${r2.finalText}`);
  assert.ok(r2.ok, 'resume failed: ' + r2.error);
  assert.match(r2.finalText, /one/i, 'resumed thread kept context');
  console.log('REAL INTEGRATION: PASS');
})().catch(e => { console.error('REAL INTEGRATION: FAIL\n', e); process.exit(1); });
