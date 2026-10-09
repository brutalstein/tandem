#!/usr/bin/env node
'use strict';
// Benchmark against the REAL Codex CLI (uses quota). Compares, on identical fresh repos:
//   tandem      - router-selected model/effort, lean prompts
//   tandem-full - router-selected model/effort, full Codex prompt (isolates the lean-prompt effect)
//   fixed-top   - always the strongest eligible model at high effort, full prompt (naive "max power")
// Usage: node bench/bench.js [repeats=1]   -> prints a table and writes bench/results.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-bench-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
delete process.env.TANDEM_CODEX_BIN;
const codex = require('../server/codex');
const router = require('../server/router');
const { JobManager } = require('../server/jobs');
const { config } = require('../server/config');

const TASKS = [
  {
    name: 'ask/trivial', mode: 'ask', difficulty: 'trivial',
    task: 'What does slug.js export and what does it currently do? One sentence.',
    files: { 'slug.js': "module.exports = function slugify(s) { throw new Error('not implemented'); };\n" },
  },
  {
    name: 'implement/normal', mode: 'implement', difficulty: 'normal', paths: ['slug.js'],
    task: 'Implement slugify in slug.js so `npm test` passes: lowercase, strip diacritics (Turkish too), non-alphanumerics become single hyphens, trim hyphens.',
    files: {
      'slug.js': "module.exports = function slugify(s) { throw new Error('not implemented'); };\n",
      'slug.test.js': "const t=require('node:test');const a=require('assert');const s=require('./slug');\nt('slug',()=>{a.equal(s('  Hello, World! '),'hello-world');a.equal(s('Çok Güzel_Şey'),'cok-guzel-sey');a.equal(s('a--b'),'a-b');a.equal(s('İstanbul ığdır'),'istanbul-igdir');});\n",
    },
  },
  {
    name: 'implement/hard', mode: 'implement', difficulty: 'hard', paths: ['lru.js'],
    task: 'Implement class LRU in lru.js (module.exports = LRU) so `npm test` passes: constructor({max, ttlMs, now}) where now() is an injectable clock; get(k) returns undefined for missing or expired keys and refreshes recency; set(k,v) evicts the least-recently-used entry beyond max; size counts only non-expired entries; all operations O(1) amortized.',
    files: {
      'lru.js': "module.exports = class LRU {};\n",
      'lru.test.js': `const t=require('node:test');const a=require('assert');const LRU=require('./lru');
t('evicts lru',()=>{const c=new LRU({max:2,ttlMs:1e9,now:()=>0});c.set('a',1);c.set('b',2);c.get('a');c.set('c',3);a.equal(c.get('b'),undefined);a.equal(c.get('a'),1);a.equal(c.get('c'),3);a.equal(c.size,2);});
t('ttl',()=>{let n=0;const c=new LRU({max:5,ttlMs:10,now:()=>n});c.set('a',1);n=5;c.set('b',2);n=11;a.equal(c.get('a'),undefined);a.equal(c.get('b'),2);a.equal(c.size,1);n=100;a.equal(c.size,0);});
t('overwrite keeps size',()=>{const c=new LRU({max:2,ttlMs:1e9,now:()=>0});c.set('a',1);c.set('a',2);a.equal(c.size,1);a.equal(c.get('a'),2);c.set('b',1);c.set('c',1);a.equal(c.get('a'),undefined);});
t('falsy values',()=>{const c=new LRU({max:2,ttlMs:1e9,now:()=>0});c.set('z',0);a.equal(c.get('z'),0);c.set('n',null);a.equal(c.get('n'),null);});
`,
    },
  },
];

function makeRepo(task, label) {
  const dir = path.join(TMP, `${label}-${task.name.replace('/', '-')}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'b', scripts: { test: 'node --test' } }));
  for (const [p, c] of Object.entries(task.files)) fs.writeFileSync(path.join(dir, p), c);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=b', '-c', 'user.email=b@b', 'commit', '-qm', 'init');
  return dir;
}

(async () => {
  const repeats = Number(process.argv[2] || 1);
  const base = config();
  const env = await codex.discover({ force: true });
  const rungs = router.ladder(env.models, base, codex.unavailable());
  const top = rungs.filter(r => r.effort === 'high').pop() || rungs[rungs.length - 1];
  const arms = [
    { label: 'tandem', cfg: { ...base, leanCodex: true } },
    { label: 'tandem-full', cfg: { ...base, leanCodex: false }, only: ['ask/trivial'] },
    { label: 'fixed-top', cfg: { ...base, leanCodex: false }, model: top.model, effort: top.effort },
  ];
  const rows = [];
  for (let rep = 0; rep < repeats; rep++) {
    for (const task of TASKS) {
      for (const arm of arms) {
        if (arm.only && !arm.only.includes(task.name)) continue;
        const dir = makeRepo(task, arm.label);
        const jm = new JobManager(arm.cfg);
        const t0 = Date.now();
        const j = await jm.submit({ cwd: dir, task: task.task, mode: task.mode, difficulty: task.difficulty, paths: task.paths, model: arm.model, effort: arm.effort, max_attempts: 3 }).promise;
        let independent = '';
        if (task.mode === 'implement') { try { execFileSync('node', ['--test'], { cwd: dir, stdio: 'ignore' }); independent = 'pass'; } catch { independent = 'FAIL'; } }
        const u = (j.result && j.result.usage) || { input: 0, cached: 0, output: 0 };
        const row = { task: task.name, arm: arm.label, status: j.status, independent, rungs: j.attempts.map(a => `${a.model}@${a.effort}`).join(' > '), input: u.input, cached: u.cached, uncached: u.input - u.cached, output: u.output, secs: Math.round((Date.now() - t0) / 1000) };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  const head = '| task | arm | status | tests re-run | model path | input tok | uncached in | output tok | wall s |\n|---|---|---|---|---|---|---|---|---|\n';
  const body = rows.map(r => `| ${r.task} | ${r.arm} | ${r.status} | ${r.independent || '-'} | ${r.rungs} | ${r.input} | ${r.uncached} | ${r.output} | ${r.secs} |`).join('\n');
  const sum = arm => rows.filter(r => r.arm === arm && r.task !== 'ask/trivial');
  const tot = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const cmp = `\n\nImplement tasks, totals: tandem ${tot(sum('tandem'), 'input')} input / ${tot(sum('tandem'), 'secs')} s vs fixed-top ${tot(sum('fixed-top'), 'input')} input / ${tot(sum('fixed-top'), 'secs')} s. ` +
    `Verified: tandem ${sum('tandem').filter(r => r.status === 'verified').length}/${sum('tandem').length}, fixed-top ${sum('fixed-top').filter(r => r.status === 'verified').length}/${sum('fixed-top').length}.\n`;
  const md = `# Tandem benchmark (${new Date().toISOString().slice(0, 10)}, codex ${env.version}, repeats=${repeats})\n\nfixed-top = ${top.model}@${top.effort}, full Codex prompt. Token counts are Codex-reported (input includes cached).\n\n${head}${body}${cmp}`;
  fs.writeFileSync(path.join(__dirname, 'results.md'), md);
  console.log('\n' + md);
})().catch(e => { console.error(e); process.exit(1); });
