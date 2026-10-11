#!/usr/bin/env node
'use strict';
// Downloads the data for bench/locate-eval.js and bench/locate-real.js (network; no provider quota):
// SWE-bench Lite (300 issues, from the Hugging Face datasets server) and bare clones of its 12 repositories (~1.2 GB).
//   node bench/locate-fetch.js <dir>      → <dir>/swebench-lite.json, <dir>/repos/<owner>_<name>.git
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

(async () => {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node bench/locate-fetch.js <dir>'); process.exit(2); }
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  const rows = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test&offset=${offset}&length=100`);
    if (!r.ok) throw new Error(`dataset download failed: HTTP ${r.status}`);
    rows.push(...(await r.json()).rows.map(x => x.row));
  }
  // Gold files: those the merged fix (the dataset's `patch`, tests excluded) changes.
  const items = rows.map(r => ({ id: r.instance_id, repo: r.repo, base: r.base_commit, problem: r.problem_statement, files: [...r.patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map(m => m[1]) }));
  // Downloaded rows name clone URLs and paths: only well-formed repository names, commits and relative paths pass.
  const bad = x => !/^[\w.-]+\/[\w.-]+$/.test(x.repo) || x.repo.includes('..') || !/^[0-9a-f]{40}$/.test(x.base) || typeof x.problem !== 'string' || x.files.some(p => p.startsWith('/') || p.split('/').includes('..'));
  if (items.some(bad)) throw new Error(`malformed dataset rows: ${items.filter(bad).map(x => x.id).join(', ')}`);
  fs.writeFileSync(path.join(dir, 'swebench-lite.json'), JSON.stringify(items));
  console.log(`${items.length} instances`);
  for (const repo of [...new Set(items.map(x => x.repo))]) {
    const to = path.join(dir, 'repos', repo.replace('/', '_') + '.git');
    if (!fs.existsSync(to)) execFileSync('git', ['clone', '-q', '--bare', `https://github.com/${repo}.git`, to], { stdio: 'inherit' });
    console.log('cloned', repo);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
