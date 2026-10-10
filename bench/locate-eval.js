#!/usr/bin/env node
'use strict';
// File localization on real issues in real repositories, no provider access needed.
//   node bench/locate-eval.js <instances.json> <repos-dir> [--out file.json] [--repo owner/name] [--cache dir] [--half tuning|held-out]
// instances.json: [{ id, repo, base, problem, files }] — e.g. SWE-bench Lite: the issue text, the commit it was
// filed against, and the files the merged fix changed (the gold set). <repos-dir>/<owner>_<name>.git: bare clones.
// Each instance is ranked on the tree at its base commit (git objects, nothing checked out) with the issue text as
// the task. Reports recall@k (a gold file in the top k), MRR and time, per variant: BM25 alone, then each signal
// of server/locate.js added. A hash of the instance id splits a tuning half from a held-out half; weights were
// chosen on the tuning half only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('../server/locate');

const [file, reposDir] = process.argv.slice(2);
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (!file || !reposDir) { console.error('usage: node bench/locate-eval.js <instances.json> <repos-dir> [--out f] [--repo owner/name]'); process.exit(2); }
const BASE = { ...L.W };
const VARIANTS = {
  'bm25': { path: 0, module: 0, def: 0, nonSource: 1, test: 1, vendor: 1, pathTf: 0 },
  '+path tokens': { path: 0, module: 0, def: 0, nonSource: 1, test: 1, vendor: 1 },
  '+source/test/vendor prior': { path: 0, module: 0, def: 0 },
  '+named paths': { module: 0, def: 0 },
  '+module names': { def: 0 },
  'full (+definitions)': {},
};
const FULL = 'full (+definitions)';
const KS = [1, 3, 5, 10];
const ms = t => Number(process.hrtime.bigint() - t) / 1e6;

let items = JSON.parse(fs.readFileSync(file, 'utf8'));
if (arg('--repo')) items = items.filter(x => x.repo === arg('--repo'));
const half = id => (crypto.createHash('sha1').update(id).digest()[0] % 2 ? 'held-out' : 'tuning');
if (arg('--half')) items = items.filter(x => half(x.id) === arg('--half'));
// --cache: git facts per (instance, query), so weight changes re-score without re-reading the repository.
const cached = (it, q, make) => {
  if (!arg('--cache')) return make();
  const f = path.join(arg('--cache'), crypto.createHash('sha1').update(it.id + JSON.stringify([q.paths, q.dotted, q.code, [...q.terms]])).digest('hex') + '.json');
  if (fs.existsSync(f)) { const x = JSON.parse(fs.readFileSync(f, 'utf8')); return { files: x.files, tf: new Map(x.tf.map(([p, m]) => [p, new Map(m)])), defs: new Map(x.defs.map(([p, n]) => [p, new Set(n)])) }; }
  const x = make();
  fs.mkdirSync(arg('--cache'), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ files: x.files, tf: [...x.tf].map(([p, m]) => [p, [...m]]), defs: [...x.defs].map(([p, n]) => [p, [...n]]) }));
  return x;
};
const rows = [];
for (const it of items) {
  const gitDir = path.join(reposDir, it.repo.replace('/', '_') + '.git');
  if (!fs.existsSync(gitDir)) { console.error('missing clone', gitDir); continue; }
  const t0 = process.hrtime.bigint();
  const q = L.query(it.problem);
  const facts = cached(it, q, () => L.collect(q, { gitDir, tree: it.base, timeoutMs: 0 }));
  const collectMs = ms(t0);
  const gold = new Set(it.files);
  const row = { id: it.id, repo: it.repo, files: facts.files.length, half: half(it.id), collectMs, ranks: {}, top: null };
  for (const [name, v] of Object.entries(VARIANTS)) {
    Object.assign(L.W, BASE, v);
    const t1 = process.hrtime.bigint();
    const r = L.score(q, facts, 50);
    if (name === FULL) { row.scoreMs = ms(t1); row.top = r.slice(0, 5).map(x => x.path); }
    const i = r.findIndex(x => gold.has(x.path));
    row.ranks[name] = i < 0 ? null : i + 1;
  }
  Object.assign(L.W, BASE);
  rows.push(row);
  process.stderr.write('.');
}
process.stderr.write('\n');
const summarize = rs => Object.fromEntries(Object.keys(VARIANTS).map(name => {
  const r = rs.map(x => x.ranks[name]);
  return [name, { n: r.length, ...Object.fromEntries(KS.map(k => ['recall@' + k, +(r.filter(x => x && x <= k).length / r.length).toFixed(3)])), mrr: +(r.reduce((a, x) => a + (x ? 1 / x : 0), 0) / r.length).toFixed(3) }];
}));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(1); };
const out = {
  instances: rows.length,
  all: summarize(rows),
  tuning: summarize(rows.filter(r => r.half === 'tuning')),
  heldOut: summarize(rows.filter(r => r.half === 'held-out')),
  perRepo: Object.fromEntries([...new Set(rows.map(r => r.repo))].map(repo => [repo, summarize(rows.filter(r => r.repo === repo))[FULL]])),
  files: { p50: q(rows.map(r => r.files), 0.5), max: Math.max(...rows.map(r => r.files)) },
  collectMs: { p50: q(rows.map(r => r.collectMs), 0.5), p95: q(rows.map(r => r.collectMs), 0.95) },
  scoreMs: { p50: q(rows.map(r => r.scoreMs), 0.5), p95: q(rows.map(r => r.scoreMs), 0.95) },
  platform: `${process.platform} node ${process.version}`,
};
console.log(JSON.stringify(out, null, 1));
if (arg('--out')) { fs.mkdirSync(path.dirname(arg('--out')), { recursive: true }); fs.writeFileSync(arg('--out'), JSON.stringify({ ...out, rows }, null, 1)); }
