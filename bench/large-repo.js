#!/usr/bin/env node
'use strict';
// Tandem's own per-job cost as a repository grows, and whether it picks the right check command in
// multi-project layouts (simulated Codex; no provider access needed).
//   node bench/large-repo.js [reps=3] [--out file.json]
// What Codex and Claude spend exploring a repository is a provider cost and is not measured here.
const fs = require('fs');
const path = require('path');
const H = require('../test/helpers');
const verify = require('../server/verify');
const { contextSize } = require('../server/strategy');
const { Orchestrator } = require('../server/jobs');

const REPS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mod = i => `'use strict';\nexports.f${i} = x => x + ${i};\n`;

// files: generated source files; one in five is a test. scope: the files the job is about; expect: the check
// command a job scoped there should run (null = nothing to run).
const LAYOUTS = {
  'small library': { n: 60, dir: i => 'src', manifest: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, scopeDir: 'src', expect: 'npm test --silent' },
  'medium app': { n: 2000, dir: i => `src/m${i % 40}`, manifest: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, scopeDir: 'src/m7', expect: 'npm test --silent' },
  'large multi-module': { n: 20000, dir: i => `packages/p${i % 200}/src`, manifest: { 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'], scripts: { test: 'npm test --workspaces' } }) }, scopeDir: 'packages/p7/src', expect: 'npm test --silent' },
  'polyglot services': {
    n: 3000, dir: i => ['services/api/src', 'services/billing/billing', 'services/gateway/internal'][i % 3],
    manifest: {
      'services/api/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'services/billing/pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
      'services/gateway/go.mod': 'module gateway\n\ngo 1.22\n',
    },
    scopeDir: 'services/billing/billing', expect: 'cd services/billing && python -m pytest -q',
  },
};

(async () => {
  const out = {};
  const o = new Orchestrator({ ...H.CFG, maxParallel: 1 });
  for (const [name, L] of Object.entries(LAYOUTS)) {
    const files = { ...L.manifest };
    for (let i = 0; i < L.n; i++) files[`${L.dir(i)}/f${i}${i % 5 ? '' : '.test'}.js`] = mod(i);
    const scope = Object.keys(files).filter(f => f.startsWith(L.scopeDir + '/')).slice(0, 20);
    let t = Date.now();
    const dir = H.repo({ default: { action: 'ok' }, writes: [] }, files);
    const createMs = Date.now() - t;
    const detected = verify.detect(dir, scope);
    t = process.hrtime.bigint(); const fp = verify.testFingerprint(dir); const fingerprintMs = Number(process.hrtime.bigint() - t) / 1e6;
    t = process.hrtime.bigint(); contextSize(dir, scope); const contextSizeMs = Number(process.hrtime.bigint() - t) / 1e6;
    const row = { files: L.n, testFiles: Object.keys(fp).length, gitInitMs: createMs, detectedCheck: detected, expectedCheck: L.expect, checkCorrect: (detected || '').replace(/\\/g, '/') === L.expect, fingerprintMs: +fingerprintMs.toFixed(1), contextSizeMs: +contextSizeMs.toFixed(1) };
    for (const isolation of ['inplace', 'worktree']) {
      const wall = [];
      for (let r = 0; r < REPS; r++) {
        H.resetEnv();
        fs.writeFileSync(path.join(dir, '.fake-scenario.json'), JSON.stringify({ default: { action: 'ok' }, byPrompt: { [`edit ${r}`]: { writes: { [scope[0]]: mod(-r - 1) } } } }));
        const started = Date.now();
        const j = await o.submit({ cwd: dir, task: `edit ${r} ${isolation}`, mode: 'implement', difficulty: 'trivial', paths: scope, verify: 'node -e 0', isolation }).promise;
        if (!['verified', 'unverified'].includes(j.status)) throw new Error(`${name} ${isolation}: ${j.status} ${JSON.stringify(j.result && j.result.error)}`);
        wall.push(Date.now() - started);
        H.git(dir, 'checkout', '-q', '--', '.'); // undo the integrated edit so every rep starts equal
      }
      row[`${isolation}JobMs`] = median(wall);
    }
    out[name] = row;
    console.log(name, row);
  }
  const i = process.argv.indexOf('--out');
  if (i > 0) { fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true }); fs.writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 2)); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
