#!/usr/bin/env node
'use strict';
// Real-provider benchmark (uses Codex quota; Claude arms also use Claude quota). Resumable.
//   node bench/bench.js --reps 3 --out bench/runs/<name> [--tasks a,b] [--arms x,y] [--claude-reps 0] [--claude-arms x,y] [--claude-model sonnet]
//   node bench/bench.js --plan [same options]               (counts cells and estimates quota; no provider calls)
//   node bench/bench.js --analyze bench/runs/<name>          (statistics only, no provider calls)
//
// Design
//  - Every run happens in a fresh copy of the task repository, in a separate child process.
//  - Runs are interleaved in seeded random order within each repetition block (paired design), so
//    provider-side drift affects all arms alike.
//  - Grading is independent of the arm: implement = the task's tests pass in the final tree AND the
//    test files are byte-identical to the fixture; ask/review = required facts present in the answer.
//  - Results are appended to runs.jsonl; re-running skips completed (task, arm, rep) cells. A provider
//    usage limit stops the run cleanly; the cell is recorded as `unavailable`, never as a failure.
//
// Codex arms (Codex tokens only):
//   tandem         Tandem as shipped; routing evidence + memory persist across this arm's runs
//   tandem-cold    Tandem with fresh state for every run (no learning, no memory)
//   tandem-nolean  ablation: Tandem without the lean Codex flags
//   codex-default  plain `codex exec` as a user would run it: the catalog's first listed model (-m, since
//                  a configured default may be unavailable), the effort from the user's Codex config,
//                  no Tandem prompt, no lean flags, one invocation (Codex iterates internally)
//   fixed-top      Tandem machinery forced to the strongest permitted rung (model@xhigh)
//   fixed-cheap    Tandem machinery forced to the cheapest permitted rung (model@low)
// Claude arms (Claude + Codex tokens, end to end through `claude -p`):
//   claude-only    Claude Code does the task itself
//   claude-tandem  Claude Code with the Tandem plugin, instructed to delegate via codex_run (forced delegation)
//   claude-adaptive Claude Code with the Tandem plugin, free to do the work itself or delegate (strategy advice)
//   claude-review  Claude Code does the work, then asks Codex for an independent review of the diff
// Budget: --plan prints the run count and token estimate; --max-codex-input / --max-claude-input stop the run
// before a worst-case run would cross the ceiling.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { TASKS, writeRepo, grade: gradeTree } = require('./tasks');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const CODEX_ARMS = ['tandem', 'tandem-cold', 'codex-default', 'fixed-top', 'fixed-cheap', 'tandem-nolean'];
const CLAUDE_ARMS = ['claude-only', 'claude-tandem', 'claude-adaptive', 'claude-review'];
const home = os.homedir();
const scrub = (k, v) => (typeof v === 'string' ? v.split(home).join('~') : v); // no personal paths in published data

const grade = (task, dir, answer) => gradeTree(TASKS[task], dir, answer);

// ---------------- child: one run ----------------
async function child(spec) {
  const { task, arm, dir, data } = spec;
  process.env.TANDEM_DATA = data;
  delete process.env.TANDEM_CODEX_BIN;
  const codex = require('../server/codex');
  const catalog = require('../server/catalog');
  const { config } = require('../server/config');
  const { Orchestrator } = require('../server/jobs');
  const t = TASKS[task];
  const cfg = { ...config(), maxParallel: 1, leanCodex: arm !== 'tandem-nolean' };
  const env = await codex.discover();
  const started = Date.now(); // after discovery: Tandem caches it, so it is not per-task cost
  if (codex.unavailable()['*']) return { unavailable: 'rate-limited' };
  if (arm === 'codex-default') {
    const listed = env.models.filter(m => m.visibility !== 'hide').sort((a, b) => a.priority - b.priority);
    const m = listed[0];
    const args = ['exec', '--json', '--skip-git-repo-check', '-m', m.slug, '-c', `sandbox_mode="${t.mode === 'implement' ? 'workspace-write' : 'read-only'}"`, ...(t.mode === 'implement' ? [] : ['--ephemeral']), '-'];
    const prompt = t.mode === 'review' ? `${t.task}\n(Use git status / git diff to see the changes.)` : t.task;
    const r = await codex.runTurn({ args, prompt, cwd: dir, timeoutMs: 30 * 60e3 }).done;
    if (r.errorKind === 'rate_limited') { codex.markUnavailable('*', r.error, codex.retryAfterMs(r.error)); return { unavailable: r.error.slice(0, 200) }; }
    return { answer: r.finalText, usage: r.usage, attempts: [{ model: m.slug, effort: 'codex-default', errorKind: r.errorKind }], status: r.ok ? 'done' : 'error', error: r.error, ms: Date.now() - started };
  }
  const o = new Orchestrator(cfg);
  const spec2 = { cwd: dir, task: t.task, mode: t.mode, difficulty: t.difficulty, paths: t.paths, verify: t.verify, isolation: 'inplace' };
  if (arm === 'fixed-top' || arm === 'fixed-cheap') {
    const rungs = catalog.rungs(env.models, cfg, codex.unavailable());
    const r = arm === 'fixed-top' ? rungs.filter(x => x.tier === Math.max(...rungs.map(y => y.tier))).at(-1) : rungs[0];
    Object.assign(spec2, { model: r.model, effort: r.effort });
  }
  const j = await o.submit(spec2).promise;
  if (j.status === 'codex_unavailable') return { unavailable: (j.result && j.result.error || '').slice(0, 200) };
  const rep = (j.result && j.result.report) || {};
  return { answer: [rep.summary, ...(rep.findings || [])].join('\n'), usage: j.result && j.result.usage, attempts: j.attempts, status: j.status, route: j.route && (j.route.plan || j.route.override), ms: Date.now() - started };
}

// ---------------- Claude arms ----------------
// claude is a native executable (no shell needed); an npm install on Windows only has the claude.cmd shim.
function runClaude(args, opts) {
  const r = spawnSync('claude', args, opts);
  if (!(r.error && r.error.code === 'ENOENT' && process.platform === 'win32')) return r;
  const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return spawnSync(['claude.cmd', ...args.map(q)].join(' '), { ...opts, shell: true });
}
function claudeRun(spec) {
  const { task, arm, dir, data } = spec;
  const t = TASKS[task];
  const read = ['Read', 'Grep', 'Glob', 'Bash(node --test*)', 'Bash(git diff*)', 'Bash(git status*)'], edit = ['Edit', 'Write'];
  const tandem = ['mcp__tandem__codex_run', 'mcp__tandem__codex_wait', 'mcp__tandem__memory_search'];
  const how = `mode ${t.mode}, difficulty ${t.difficulty}${t.paths ? ', paths ' + JSON.stringify(t.paths) : ''}${t.verify ? `, verify "${t.verify}"` : ''}`;
  const check = t.mode === 'implement' ? ' Run `node --test` to confirm before you finish.' : '';
  // claude-tandem: forced delegation. claude-adaptive: Claude chooses (orchestrate skill, dry_run strategy).
  // claude-review: Claude does the work, Codex independently reviews the diff.
  const tools = { 'claude-only': [...read, ...edit], 'claude-tandem': [...read, ...tandem] }[arm] || [...read, ...edit, ...tandem];
  const prompt = `${t.task}\n\n` + {
    'claude-only': check,
    'claude-tandem': `Delegate the work to Codex with the codex_run tool (${how}), then confirm the result. Do not edit files yourself.`,
    'claude-adaptive': `Do it yourself or delegate to Codex with codex_run (${how}), whichever is cheaper overall; codex_run with dry_run: true estimates that.${check}`,
    'claude-review': `Do it yourself.${t.mode === 'implement' ? ` Run \`node --test\`, then ask Codex for an independent review of your uncommitted diff (codex_run mode review, difficulty ${t.difficulty}) and fix real defects it finds.` : ''}`,
  }[arm];
  // Every arm: no user/global settings, plugins or MCP servers (login still applies), same model.
  const args = ['-p', '--output-format', 'json', '--model', spec.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--allowedTools', ...tools];
  if (arm !== 'claude-only') {
    // --strict-mcp-config also drops plugin servers, so the Tandem server is passed explicitly; hooks come from --plugin-dir.
    const mcp = path.join(data, 'mcp.json');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { tandem: { command: process.execPath, args: [path.join(ROOT, 'server', 'mcp.js')], env: { TANDEM_DATA: data } } } }));
    args.push('--plugin-dir', ROOT, '--mcp-config', mcp);
  }
  const started = Date.now();
  const r = runClaude(args, { cwd: dir, input: prompt, encoding: 'utf8', timeout: 40 * 60e3, env: { ...process.env, TANDEM_DATA: data }, maxBuffer: 64 << 20 });
  let out = {};
  try { out = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { return { status: 'error', error: (r.stderr || r.stdout || '').slice(-500), ms: Date.now() - started }; }
  const u = out.usage || {};
  let codexUsage = null, attempts = [];
  if (arm !== 'claude-only') {
    for (const f of walk(path.join(data, 'projects')).filter(p => p.endsWith('ledger.json'))) {
      for (const j of Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).jobs || {})) {
        if (!j.result || !j.result.usage) continue;
        codexUsage = codexUsage || { input: 0, cached: 0, output: 0 };
        codexUsage.input += j.result.usage.input; codexUsage.cached += j.result.usage.cached; codexUsage.output += j.result.usage.output;
        attempts.push(...(j.attempts || []));
      }
    }
  }
  return {
    answer: out.result || '', status: out.is_error ? 'error' : 'done', ms: Date.now() - started, attempts,
    claude: { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0, turns: out.num_turns, costUsdReported: out.total_cost_usd },
    usage: codexUsage,
  };
}
function walk(d) { if (!fs.existsSync(d)) return []; return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }

// ---------------- parent: schedule ----------------
// Per-run raw input tokens (cached included) from the real pilot (bench/data/real-v2-pilot): Codex runs used
// 53k–196k, median 145k. Claude-side usage has not been measured yet; the Claude figures are assumptions.
const TYPICAL = { codexIn: 145000, claudeIn: 150000 }, WORST = { codexIn: 400000, claudeIn: 600000 };
function plan(cells, maxCodexIn, maxClaudeIn) {
  const claude = cells.filter(c => CLAUDE_ARMS.includes(c.arm)), codexOnly = cells.length - claude.length;
  const delegating = claude.filter(c => c.arm !== 'claude-only').length;
  const codexRuns = codexOnly + delegating; // a delegating Claude run also spends Codex (forced: always; adaptive/review: up to one job)
  const by = {}; for (const c of cells) by[c.arm] = (by[c.arm] || 0) + 1;
  console.log(`${cells.length} runs: ${Object.entries(by).map(([a, n]) => `${a} ${n}`).join(', ')}`);
  console.log(`Codex input tokens (raw, cached included): typical ${(codexRuns * TYPICAL.codexIn / 1e6).toFixed(1)}M, worst ${(codexRuns * WORST.codexIn / 1e6).toFixed(1)}M over ${codexRuns} runs that may call Codex`);
  console.log(`Claude input tokens (raw, assumed): typical ${(claude.length * TYPICAL.claudeIn / 1e6).toFixed(1)}M, worst ${(claude.length * WORST.claudeIn / 1e6).toFixed(1)}M over ${claude.length} runs`);
  console.log(`ceilings: Codex ${maxCodexIn === Infinity ? 'none' : maxCodexIn}, Claude ${maxClaudeIn === Infinity ? 'none' : maxClaudeIn} (checked before every run; set --max-codex-input / --max-claude-input)`);
}

function shuffle(xs, seed) { const rng = require('../server/policy').rngFrom(seed); const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function main() {
  if (argv[0] === '--child') { const res = await child(JSON.parse(argv[1])); process.stdout.write('\n@@RESULT ' + JSON.stringify(res) + '\n'); return; }
  if (argv[0] === '--analyze') return analyze(argv[1]);
  // Real runs spend quota: an unknown flag (even --help) or a missing ceiling stops here instead of starting the
  // default run.
  const VALUED = ['--out', '--reps', '--claude-reps', '--claude-model', '--tasks', '--arms', '--claude-arms', '--ablation', '--max-codex-input', '--max-claude-input'];
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.includes(argv[i]) && i + 1 < argv.length) i++;
    else if (argv[i] !== '--plan') { console.error(`unknown or incomplete option: ${argv[i]}\n` + fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 7).join('\n')); process.exit(2); }
  }
  if (!argv.includes('--plan') && (!argv.includes('--max-codex-input') || !argv.includes('--max-claude-input'))) {
    console.error('a real run needs --max-codex-input and --max-claude-input (the approved ceilings); see --plan for an estimate');
    process.exit(2);
  }
  const out = path.resolve(opt('--out', path.join(ROOT, 'bench', 'runs', new Date().toISOString().slice(0, 10))));
  const reps = Number(opt('--reps', 3));
  const claudeReps = Number(opt('--claude-reps', 0));
  const claudeModel = opt('--claude-model', 'sonnet');
  const tasks = (opt('--tasks', Object.keys(TASKS).join(','))).split(',');
  const arms = (opt('--arms', 'tandem,tandem-cold,codex-default,fixed-top,fixed-cheap')).split(',');
  const claudeArms = (opt('--claude-arms', CLAUDE_ARMS.join(','))).split(',');
  const ablation = (opt('--ablation', 'tandem-nolean:slugify,tandem-nolean:ask-config')).split(',').filter(Boolean).map(x => x.split(':'));
  // Hard ceilings on raw input tokens (cached included), checked before every run against everything already
  // spent in this output directory: a run starts only if a worst-case run still fits under the ceiling.
  const maxCodexIn = Number(opt('--max-codex-input', Infinity)), maxClaudeIn = Number(opt('--max-claude-input', Infinity));
  const cells = [];
  for (let rep = 0; rep < Math.max(reps, claudeReps); rep++) {
    const block = [];
    if (rep < reps) {
      for (const task of tasks) for (const arm of arms) block.push({ task, arm, rep });
      for (const [arm, task] of ablation) if (tasks.includes(task)) block.push({ task, arm, rep });
    }
    if (rep < claudeReps) for (const task of tasks) for (const arm of claudeArms) block.push({ task, arm, rep, model: claudeModel });
    cells.push(...shuffle(block, `block-${rep}`));
  }
  if (argv.includes('--plan')) return plan(cells, maxCodexIn, maxClaudeIn);
  const work = path.join(out, 'work'); // not the shared temp folder: another local user could pre-create it (gitignored)
  fs.mkdirSync(out, { recursive: true });
  const log = path.join(out, 'runs.jsonl');
  const done = new Set(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.outcome !== 'unavailable').map(r => `${r.task}|${r.arm}|${r.rep}`) : []);
  const codexV = spawnSync(process.execPath, ['-e', "require('./server/codex').discover({force:true}).then(e=>console.log(JSON.stringify({v:e.version,login:e.loggedIn,models:e.models.map(m=>m.slug)})))"], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TANDEM_DATA: path.join(work, 'probe') } });
  const claudeV = (runClaude(['--version'], { encoding: 'utf8' }).stdout || '').trim();
  const meta = { started: new Date().toISOString(), platform: `${process.platform} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpu: os.cpus()[0].model, node: process.version, codex: JSON.parse(codexV.stdout || '{}'), claude: claudeV, reps, claudeReps, claudeModel, tasks, arms, ablation, tandemCommit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() + (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() ? '-dirty' : ''); } catch { return 'unknown'; } })() };
  const metaFile = path.join(out, 'meta.json'); // one record per (resumed) session
  const prior = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : [];
  fs.writeFileSync(metaFile, JSON.stringify([...(Array.isArray(prior) ? prior : [prior]), meta], scrub, 2));

  for (const c of cells) {
    const id = `${c.task}|${c.arm}|${c.rep}`;
    if (done.has(id)) continue;
    const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const codexIn = rows.reduce((s, r) => s + ((r.usage && r.usage.input) || 0), 0);
    const claudeIn = rows.reduce((s, r) => s + (r.claude ? r.claude.input + r.claude.cacheRead + r.claude.cacheWrite : 0), 0);
    if (codexIn + WORST.codexIn > maxCodexIn || (CLAUDE_ARMS.includes(c.arm) && claudeIn + WORST.claudeIn > maxClaudeIn)) {
      console.log(`budget: stopped before ${id} (Codex input ${codexIn} of ${maxCodexIn}, Claude input ${claudeIn} of ${maxClaudeIn}); rerun with a higher ceiling to resume`);
      break;
    }
    const dir = path.join(work, c.arm, 'repo'); // stable path per arm: one "project" per arm
    const data = c.arm === 'tandem-cold' ? path.join(work, c.arm, `data-${c.task}-${c.rep}`) : path.join(work, c.arm, 'data');
    const t = TASKS[c.task];
    writeRepo(dir, t);
    const t0 = Date.now();
    let res;
    if (CLAUDE_ARMS.includes(c.arm)) res = claudeRun({ ...c, dir, data });
    else {
      const p = spawn(process.execPath, [__filename, '--child', JSON.stringify({ ...c, dir, data })], { cwd: ROOT, env: process.env });
      let so = '';
      p.stdout.on('data', d => { so += d; });
      p.stderr.on('data', () => {});
      await new Promise(r => p.on('close', r));
      const m = /@@RESULT (.*)/.exec(so);
      res = m ? JSON.parse(m[1]) : { status: 'error', error: 'child crashed: ' + so.slice(-300) };
    }
    const g = res.unavailable ? null : grade(c.task, dir, res.answer);
    const row = { ...c, outcome: res.unavailable ? 'unavailable' : g.ok ? 'success' : 'failure', grade: g, wallMs: Date.now() - t0, ...res, answer: (res.answer || '').slice(0, 600), at: new Date().toISOString() };
    fs.appendFileSync(log, JSON.stringify(row, scrub) + '\n');
    console.log(`${row.at.slice(11, 19)} ${id.padEnd(34)} ${row.outcome.padEnd(11)} ${Math.round(row.wallMs / 1000)}s codex in ${row.usage ? row.usage.input : '-'} out ${row.usage ? row.usage.output : '-'} ${(row.attempts || []).map(a => `${a.model}@${a.effort}`).join('>')}`);
    if (res.unavailable) { console.log('provider usage limit reached; stopping. Re-run the same command later to resume.'); break; }
  }
  analyze(out);
}

// ---------------- analysis ----------------
const mean = xs => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
// Percentile bootstrap of a statistic over rows, resampling clusters (tasks) then rows within them.
function bootstrap(rowsByCluster, stat, B = 4000, seed = 'boot') {
  const rng = require('../server/policy').rngFrom(seed);
  const clusters = Object.values(rowsByCluster).filter(r => r.length);
  if (!clusters.length) return [NaN, NaN];
  const vals = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < clusters.length; i++) {
      const cl = clusters[Math.floor(rng() * clusters.length)];
      for (let j = 0; j < cl.length; j++) sample.push(cl[Math.floor(rng() * cl.length)]);
    }
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}
const freshTokens = u => (u ? Math.max(0, u.input - u.cached) + u.output : 0); // uncached input + output
// Effective tokens (the routing unit): uncached input + 0.1 × cached input + output; Claude cache writes count fully.
const effective = r => (r.usage ? Math.max(0, r.usage.input - r.usage.cached) + 0.1 * r.usage.cached + r.usage.output : 0)
  + (r.claude ? r.claude.input + r.claude.cacheWrite + 0.1 * r.claude.cacheRead + r.claude.output : 0);
const allTokens = u => (u ? u.input + u.output : 0);
const secs = r => (r.ms ?? r.wallMs) / 1000; // task time, excluding bench process start-up and discovery

function analyze(dir) {
  const rows = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const valid = rows.filter(r => r.outcome !== 'unavailable');
  const arms = [...new Set(valid.map(r => r.arm))];
  const tasks = [...new Set(valid.map(r => r.task))];
  const summary = { generated: new Date().toISOString(), n: valid.length, unavailable: rows.length - valid.length, arms: {}, perTask: {}, paired: {} };
  for (const arm of arms) {
    const rs = valid.filter(r => r.arm === arm);
    const k = rs.filter(r => r.outcome === 'success').length;
    const byTask = Object.fromEntries(tasks.map(t => [t, rs.filter(r => r.task === t)]));
    summary.arms[arm] = {
      n: rs.length, success: k, successRate: +(k / rs.length).toFixed(3), successCI: wilson(k, rs.length).map(x => +x.toFixed(3)),
      codexTokens: Math.round(mean(rs.map(r => allTokens(r.usage)))), codexTokensCI: bootstrap(byTask, s => mean(s.map(r => allTokens(r.usage)))).map(Math.round),
      codexFreshTokens: Math.round(mean(rs.map(r => freshTokens(r.usage)))), codexFreshTokensCI: bootstrap(byTask, s => mean(s.map(r => freshTokens(r.usage)))).map(Math.round),
      wallSec: +mean(rs.map(secs)).toFixed(1), wallSecCI: bootstrap(byTask, s => mean(s.map(secs))).map(x => +x.toFixed(1)),
      attempts: +mean(rs.map(r => (r.attempts || []).length || 1)).toFixed(2),
      tokensPerSuccess: k ? Math.round(rs.reduce((a, r) => a + allTokens(r.usage), 0) / k) : null,
      // The headline metric: everything spent (Codex and Claude, failed runs included) per independently graded success.
      effectivePerSuccess: k ? Math.round(rs.reduce((a, r) => a + effective(r), 0) / k) : null,
      models: rs.flatMap(r => (r.attempts || []).map(a => `${a.model}@${a.effort}`)).reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {}),
    };
    if (rs.some(r => r.claude)) {
      const cl = rs.filter(r => r.claude);
      summary.arms[arm].claude = { input: Math.round(mean(cl.map(r => r.claude.input + r.claude.cacheRead + r.claude.cacheWrite))), output: Math.round(mean(cl.map(r => r.claude.output))), costUsdReported: +mean(cl.map(r => r.claude.costUsdReported || 0)).toFixed(3) };
    }
  }
  for (const t of tasks) {
    summary.perTask[t] = Object.fromEntries(arms.map(a => { const rs = valid.filter(r => r.task === t && r.arm === a); if (!rs.length) return [a, null]; const k = rs.filter(r => r.outcome === 'success').length; return [a, { n: rs.length, success: k, codexTokens: Math.round(mean(rs.map(r => allTokens(r.usage)))), wallSec: +mean(rs.map(secs)).toFixed(1) }]; }));
  }
  // Paired comparison vs tandem on (task, rep) blocks both arms completed: ratio of mean tokens, Δ success.
  for (const arm of arms.filter(a => a !== 'tandem')) {
    const pairs = [];
    for (const r of valid.filter(x => x.arm === arm)) { const tr = valid.find(x => x.arm === 'tandem' && x.task === r.task && x.rep === r.rep); if (tr) pairs.push({ task: r.task, a: r, t: tr }); }
    if (!pairs.length) continue;
    const byTask = {}; for (const p of pairs) (byTask[p.task] = byTask[p.task] || []).push(p);
    const ratio = s => mean(s.map(p => allTokens(p.t.usage))) / mean(s.map(p => allTokens(p.a.usage)));
    const timeRatio = s => mean(s.map(p => secs(p.t))) / mean(s.map(p => secs(p.a)));
    const dSucc = s => mean(s.map(p => (p.t.outcome === 'success') - (p.a.outcome === 'success')));
    summary.paired[arm] = { pairs: pairs.length, tandemTokensRatio: +ratio(pairs).toFixed(3), ratioCI: bootstrap(byTask, ratio).map(x => +x.toFixed(3)), tandemTimeRatio: +timeRatio(pairs).toFixed(3), timeRatioCI: bootstrap(byTask, timeRatio).map(x => +x.toFixed(3)), successDiff: +dSucc(pairs).toFixed(3), successDiffCI: bootstrap(byTask, dSucc).map(x => +x.toFixed(3)) };
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\narm            n  success (95% Wilson)     codex tokens/run (95% CI)       wall s');
  for (const [a, s] of Object.entries(summary.arms)) console.log(`${a.padEnd(14)} ${String(s.n).padStart(2)}  ${s.success}/${s.n} [${s.successCI.join('–')}]`.padEnd(42) + `${String(s.codexTokens).padStart(8)} [${s.codexTokensCI.join('–')}]`.padEnd(32) + `${s.wallSec}`);
  console.log('\npaired vs tandem (ratio < 1 = Tandem uses less):');
  for (const [a, p] of Object.entries(summary.paired)) console.log(`${a.padEnd(14)} pairs ${p.pairs}  tokens ×${p.tandemTokensRatio} [${p.ratioCI.join('–')}]  time ×${p.tandemTimeRatio} [${p.timeRatioCI.join('–')}]  Δsuccess ${p.successDiff} [${p.successDiffCI.join('–')}]`);
  return summary;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { analyze, wilson, bootstrap, grade, writeRepo };
