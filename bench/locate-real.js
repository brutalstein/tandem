#!/usr/bin/env node
'use strict';
// What a model spends finding the code an issue is about in a real large repository, with and without Tandem's
// likely-file hints (server/locate.js). Uses provider quota: Codex arms use Codex, Claude arms use Claude.
//   node bench/locate-real.js <instances.json> <repos-dir> --out <dir> --n 20 --arms codex-plain,codex-hint,claude-plain,claude-hint
//        --max-codex-input <tokens> --max-claude-input <tokens> [--claude-model sonnet] [--plan]
//   node bench/locate-real.js --analyze <dir>
// Instances: the held-out half of bench/locate-eval.js (never used to tune the ranking), in a fixed order.
// Each run gets a checkout of the instance's base commit and the question: which file must change to fix this
// issue. Graded against the files the merged fix changed: `hit` = a gold file is named, `top1` = it is named first.
//   codex-plain / codex-hint   a Tandem ask job (read-only Codex), likely-file hints off / on
//   claude-plain / claude-hint `claude -p` with Read, Grep and Glob only; the hint arm gets the line dry_run shows
// Every run uses fresh Tandem state, so routing is the same prior in both Codex arms. Resumable; ceilings are
// checked before each run against everything already spent in --out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ARMS = ['codex-plain', 'codex-hint', 'claude-plain', 'claude-hint'];
const WORST = { codexIn: 1500000, claudeIn: 1500000 }; // one run's worst case, for the ceiling check
const QUESTION = 'Which source file(s) must be changed to fix the issue below? Investigate the repository as needed, then answer with the repository-relative path(s), most likely first, one per line, and one sentence of reasoning. Do not modify files.\n\nISSUE:\n';
const half = id => (crypto.createHash('sha1').update(id).digest()[0] % 2 ? 'held-out' : 'tuning');
const effective = u => (u ? u.input - u.cached + 0.1 * u.cached + u.output : 0);
const claudeEffective = c => (c ? c.input + c.cacheWrite + 0.1 * c.cacheRead + c.output : 0);

// Paths an answer names, in order (repository-relative, normalised).
function named(answer, files) {
  const out = [];
  for (const m of String(answer).matchAll(/[\w./-]+\.[A-Za-z]{1,5}\b/g)) {
    const p = m[0].replace(/^\.?\//, '');
    const f = files.find(x => x === p || x.endsWith('/' + p) || p.endsWith('/' + x));
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

async function child(spec) {
  process.env.TANDEM_DATA = spec.data;
  delete process.env.TANDEM_CODEX_BIN;
  const codex = require('../server/codex');
  const { config } = require('../server/config');
  const { Orchestrator } = require('../server/jobs');
  await codex.discover();
  if (codex.unavailable()['*']) return { unavailable: 'rate-limited' };
  const o = new Orchestrator({ ...config(), maxParallel: 1, locateHints: spec.arm === 'codex-hint' });
  const started = Date.now();
  const j = await o.submit({ cwd: spec.dir, task: QUESTION + spec.problem, mode: 'ask', difficulty: 'normal', isolation: 'inplace' }).promise;
  // A usage limit ends the job as codex_unavailable, or suspended (resumable) when it hits mid-run: not a failure.
  const limited = (j.attempts || []).find(a => a.errorKind === 'rate_limited');
  if (j.status === 'codex_unavailable' || (j.status === 'suspended' && limited)) return { unavailable: String((limited && limited.error) || (j.result && j.result.error) || j.status).slice(0, 200) };
  const rep = (j.result && j.result.report) || {};
  return { answer: [rep.summary, ...(rep.findings || [])].join('\n'), usage: j.result && j.result.usage, attempts: j.attempts, located: j.located || null, status: j.status, ms: Date.now() - started };
}

function runClaude(args, opts) {
  const r = spawnSync('claude', args, opts);
  if (!(r.error && r.error.code === 'ENOENT' && process.platform === 'win32')) return r;
  const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return spawnSync(['claude.cmd', ...args.map(q)].join(' '), { ...opts, shell: true });
}
function claudeRun(spec) {
  let hint = '';
  if (spec.arm === 'claude-hint') {
    const hits = require('../server/locate').locate(spec.problem, { cwd: spec.dir }, 5);
    if (hits.length) hint = `\n\nTandem's likely files (ranked from the task text, may be wrong): ${hits.map(h => h.path + (h.why.length ? ` (${h.why[0]})` : '')).join(', ')}`;
  }
  const args = ['-p', '--output-format', 'json', '--model', spec.model, '--setting-sources', 'project', '--strict-mcp-config', '--allowedTools', 'Read', 'Grep', 'Glob'];
  const started = Date.now();
  const r = runClaude(args, { cwd: spec.dir, input: QUESTION + spec.problem + hint, encoding: 'utf8', timeout: 30 * 60e3, maxBuffer: 64 << 20 });
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { return { status: 'error', error: (r.stderr || r.stdout || '').slice(-500), ms: Date.now() - started }; }
  const u = out.usage || {};
  if (out.is_error && /limit|quota/i.test(out.result || '')) return { unavailable: String(out.result).slice(0, 200) };
  return { answer: out.result || '', status: out.is_error ? 'error' : 'done', ms: Date.now() - started, hint: hint.trim() || null,
    claude: { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0, turns: out.num_turns, costUsdReported: out.total_cost_usd } };
}

function analyze(dir) {
  const rows = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.unavailable);
  const mean = xs => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
  const cost = r => effective(r.usage) + claudeEffective(r.claude);
  const arms = [...new Set(rows.map(r => r.arm))];
  const summary = { n: rows.length, arms: {}, paired: {} };
  for (const a of arms) {
    const rs = rows.filter(r => r.arm === a);
    summary.arms[a] = { n: rs.length, hit: +mean(rs.map(r => +r.hit)).toFixed(3), top1: +mean(rs.map(r => +r.top1)).toFixed(3), effectiveTokens: Math.round(mean(rs.map(cost))), wallSec: +mean(rs.map(r => r.ms / 1000)).toFixed(1) };
  }
  // Paired by instance: ratio of mean effective tokens (hint / plain) with a bootstrap 95% interval over instances.
  for (const p of ['codex', 'claude']) {
    const ids = [...new Set(rows.map(r => r.id))].filter(id => rows.some(r => r.id === id && r.arm === p + '-plain') && rows.some(r => r.id === id && r.arm === p + '-hint'));
    if (!ids.length) continue;
    const pair = ids.map(id => [cost(rows.find(r => r.id === id && r.arm === p + '-hint')), cost(rows.find(r => r.id === id && r.arm === p + '-plain'))]);
    const ratio = xs => mean(xs.map(x => x[0])) / mean(xs.map(x => x[1]));
    const rng = require('../server/policy').rngFrom('locate-boot');
    const boots = Array.from({ length: 4000 }, () => ratio(ids.map(() => pair[Math.floor(rng() * pair.length)]))).sort((a, b) => a - b);
    summary.paired[p] = { n: ids.length, tokenRatioHintOverPlain: +ratio(pair).toFixed(3), ci95: [+boots[100].toFixed(3), +boots[3899].toFixed(3)] };
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  if (argv[0] === '--child') { process.stdout.write('\n@@RESULT ' + JSON.stringify(await child(JSON.parse(argv[1]))) + '\n'); return; }
  if (argv[0] === '--analyze') return analyze(argv[1]);
  const [file, reposDir] = argv;
  const VALUED = ['--out', '--n', '--arms', '--max-codex-input', '--max-claude-input', '--claude-model'];
  for (let i = 2; i < argv.length; i++) {
    if (VALUED.includes(argv[i]) && i + 1 < argv.length) i++;
    else if (argv[i] !== '--plan') { console.error(`unknown or incomplete option: ${argv[i]}`); process.exit(2); }
  }
  if (!file || !reposDir || !opt('--out')) { console.error('usage: see the header of bench/locate-real.js'); process.exit(2); }
  const arms = opt('--arms', ARMS.join(',')).split(',');
  if (arms.some(a => !ARMS.includes(a))) { console.error('arms: ' + ARMS.join(', ')); process.exit(2); }
  const n = Number(opt('--n', 20));
  const items = JSON.parse(fs.readFileSync(file, 'utf8')).filter(x => half(x.id) === 'held-out')
    .sort((a, b) => (crypto.createHash('sha1').update('order' + a.id).digest('hex') < crypto.createHash('sha1').update('order' + b.id).digest('hex') ? -1 : 1)).slice(0, n);
  const cells = items.flatMap(it => arms.map(arm => ({ it, arm })));
  if (argv.includes('--plan')) {
    console.log(`${items.length} instances × ${arms.length} arms = ${cells.length} runs; worst case per run: Codex ${WORST.codexIn}, Claude ${WORST.claudeIn} input tokens`);
    console.log('repos: ' + JSON.stringify(items.reduce((a, x) => ({ ...a, [x.repo]: (a[x.repo] || 0) + 1 }), {})));
    return;
  }
  if (!opt('--max-codex-input') || !opt('--max-claude-input')) { console.error('a real run needs --max-codex-input and --max-claude-input (the approved ceilings)'); process.exit(2); }
  const out = path.resolve(opt('--out'));
  const log = path.join(out, 'runs.jsonl');
  fs.mkdirSync(path.join(out, 'work'), { recursive: true });
  const readRows = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const done = new Set(readRows().filter(r => !r.unavailable).map(r => `${r.id}|${r.arm}`));
  const maxCodex = Number(opt('--max-codex-input')), maxClaude = Number(opt('--max-claude-input'));
  for (const { it, arm } of cells) {
    if (done.has(`${it.id}|${arm}`)) continue;
    const rows = readRows();
    const codexIn = rows.reduce((s, r) => s + ((r.usage && r.usage.input) || 0), 0);
    const claudeIn = rows.reduce((s, r) => s + (r.claude ? r.claude.input + r.claude.cacheRead + r.claude.cacheWrite : 0), 0);
    if ((arm.startsWith('codex') && codexIn + WORST.codexIn > maxCodex) || (arm.startsWith('claude') && claudeIn + WORST.claudeIn > maxClaude)) {
      console.log(`budget: skipping ${it.id} ${arm} (Codex input ${codexIn} of ${maxCodex}, Claude input ${claudeIn} of ${maxClaude})`);
      continue;
    }
    const dir = path.join(out, 'work', 'repos', it.id);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', path.join(reposDir, it.repo.replace('/', '_') + '.git'), dir], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'checkout', '-q', it.base], { stdio: 'ignore' });
    }
    const spec = { id: it.id, arm, dir, problem: it.problem, data: path.join(out, 'work', 'data', arm, it.id), model: opt('--claude-model', 'sonnet') };
    let res;
    if (arm.startsWith('claude')) res = claudeRun(spec);
    else {
      const p = spawn(process.execPath, [__filename, '--child', JSON.stringify(spec)], { cwd: ROOT, env: process.env });
      let so = ''; p.stdout.on('data', d => { so += d; }); p.stderr.on('data', () => {});
      await new Promise(r => p.on('close', r));
      const m = /@@RESULT (.*)/.exec(so);
      res = m ? JSON.parse(m[1]) : { status: 'error', error: 'child crashed: ' + so.slice(-300) };
    }
    const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
    const names = named(res.answer, files);
    const row = { id: it.id, repo: it.repo, arm, gold: it.files, named: names.slice(0, 5), hit: names.some(f => it.files.includes(f)), top1: it.files.includes(names[0]), ...res, answer: (res.answer || '').slice(0, 600), at: new Date().toISOString() };
    fs.appendFileSync(log, JSON.stringify(row) + '\n');
    console.log(`${row.at.slice(11, 19)} ${it.id.padEnd(32)} ${arm.padEnd(13)} ${row.unavailable ? 'unavailable' : row.top1 ? 'top1' : row.hit ? 'hit' : 'miss'} ${Math.round((res.ms || 0) / 1000)}s eff ${Math.round(effective(res.usage) + claudeEffective(res.claude))}`);
    if (res.unavailable) { console.log('provider usage limit reached; stopping. Re-run later to resume.'); break; }
  }
  analyze(out);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { named };
