#!/usr/bin/env node
'use strict';
// Deterministic stand-in for the Codex CLI. Behaviour per model comes from .fake-scenario.json in the
// repository (found from a linked worktree too); every exec call is logged to .fake-log.jsonl there.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\n');

if (args[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (args[0] === 'login') { console.log(process.env.FAKE_LOGGED_OUT ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(process.env.FAKE_LOGGED_OUT ? 1 : 0); }
if (args[0] === 'debug' && args[1] === 'models') {
  const m = (slug, efforts, visibility = 'list') => ({ slug, visibility, supported_reasoning_levels: efforts.map(effort => ({ effort })), priority: 1 });
  const all = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  console.log(JSON.stringify({ models: [
    m('gpt-6-astra', all), m('gpt-5.6-sol', all), m('gpt-5.6-terra', all), m('gpt-5.6-luna', all.slice(0, 5)),
    m('gpt-5.5-luna', all.slice(0, 4)), m('gpt-7-sol', all), m('gpt-reserve', all, 'hide'),
  ] }));
  process.exit(0);
}
// `codex sandbox`: no isolation here (the real sandbox has its own test); runs the command so jobs can verify.
// FAKE_SANDBOX_FAIL simulates a machine where the OS sandbox cannot start.
if (args[0] === 'sandbox') {
  if (process.env.FAKE_SANDBOX_FAIL) { console.error('windows sandbox failed: fake sandbox unavailable'); process.exit(1); }
  const env = { ...process.env };
  let i = 1, cwd = process.cwd();
  for (; i < args.length && args[i].startsWith('-'); i += 2) {
    if (args[i] === '-C') cwd = args[i + 1];
    const set = args[i] === '-c' && /^shell_environment_policy\.set\.(\w+)=(.*)$/s.exec(args[i + 1]);
    if (set) env[set[1]] = JSON.parse(set[2]);
  }
  if (process.env.FAKE_SANDBOX_LOG) fs.appendFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify(args) + '\n');
  // Tandem's deny probe: an enforcing sandbox opens none of the denied paths; FAKE_SANDBOX_LEAK simulates one that
  // silently does not enforce them (observed with Codex on Windows).
  const probeArg = (env.TANDEM_VERIFY_CMD || args.at(-1)).match(/TANDEM_PROBE.* (\S+)$/);
  if (probeArg) {
    JSON.parse(Buffer.from(probeArg[1], 'base64').toString()); // the denied paths arrive intact
    console.log('TANDEM_PROBE ' + JSON.stringify(process.env.FAKE_SANDBOX_LEAK ? [process.env.FAKE_SANDBOX_LEAK] : []));
    process.exit(0);
  }
  const r = require('child_process').spawnSync(args[i], args.slice(i + 1), { cwd, env, stdio: 'inherit', windowsVerbatimArguments: args[i] === 'cmd.exe' });
  process.exit(r.status ?? 1);
}
if (args[0] !== 'exec') { console.error('unsupported ' + args.join(' ')); process.exit(2); }

let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  let home = cwd;
  if (!fs.existsSync(path.join(cwd, '.fake-scenario.json'))) {
    // linked worktree: .git is a file 'gitdir: <repo>/.git/worktrees/<name>'
    const gitdir = /gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(cwd, '.git'), 'utf8'))[1].trim();
    home = path.resolve(gitdir, '..', '..', '..');
  }
  const scenario = JSON.parse(fs.readFileSync(path.join(home, '.fake-scenario.json'), 'utf8'));
  const model = args[args.indexOf('-m') + 1];
  const logFile = path.join(home, '.fake-log.jsonl');
  const n = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
  fs.appendFileSync(logFile, JSON.stringify({ args, prompt, model, cwd, t: Date.now() }) + '\n');
  // byPrompt: { '<marker in the task text>': { writes, delayMs, status, action } } — order-independent per-job behaviour.
  const tagged = Object.entries(scenario.byPrompt || {}).find(([k]) => prompt.includes(k));
  const s = { ...scenario.default, ...(scenario[model] || {}), ...(tagged ? tagged[1] : {}) };
  const thread = args[1] === 'resume' ? args[2] : `thread-${n}`;
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });

  const fail = message => { out({ type: 'error', message }); out({ type: 'turn.failed', error: { message } }); process.exit(1); };
  if (s.action === 'unsupported') fail(`{"status":400,"error":{"message":"The '${model}' model is not supported when using Codex with a ChatGPT account."}}`);
  if (s.action === 'ratelimit') fail("You've hit your usage limit. Try again in 2h 5m.");
  if (s.action === 'transient') fail('stream disconnected before completion: 503 Service Unavailable');
  if (s.action === 'auth') fail('401 Unauthorized: please run codex login');
  if (s.action === 'crash') process.exit(3);
  if (s.action === 'flaky') out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  if (s.action === 'garbage') {
    process.stdout.write('not json\n{"broken": \n' + 'x'.repeat(100000) + '\n[1,2]\n');
    process.stdout.write(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ünïcödé ✓ preface' } }) + '\n').subarray(0, 65));
    process.stdout.write(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ünïcödé ✓ preface' } }) + '\n').subarray(65));
  }
  if (s.action === 'hang') { setInterval(() => {}, 1000); return; }
  if (s.action === 'orphan') { // a tool process outlives codex and keeps the stdout pipe open
    require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
    process.exit(1);
  }

  const writes = (tagged && tagged[1].writes) || (scenario.writes || [])[n] || {};
  for (const [p, content] of Object.entries(writes)) {
    if (content === null) fs.rmSync(path.join(cwd, p), { force: true });
    else { fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true }); fs.writeFileSync(path.join(cwd, p), content); }
    out({ type: 'item.completed', item: { id: 'f' + n, type: 'file_change', changes: [{ path: p, kind: 'update' }] } });
  }
  // The provider stops after partial work (usage limit mid-turn).
  if (s.action === 'partial_ratelimit') fail("You've hit your usage limit. Try again in 2h 5m.");
  const delay = s.delayMs || 0;
  setTimeout(() => {
    out({ type: 'item.completed', item: { id: 'c' + n, type: 'command_execution', command: 'echo ok', exit_code: 0 } });
    const report = { status: s.status || 'done', summary: `fake ${model} call ${n}`, files_changed: Object.keys(writes), verification: 'ran nothing', findings: s.findings || [], open_questions: [] };
    out({ type: 'item.completed', item: { id: 'm' + n, type: 'agent_message', text: s.raw || JSON.stringify(report) } });
    out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 0 } });
  }, delay);
});
