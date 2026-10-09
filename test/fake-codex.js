#!/usr/bin/env node
'use strict';
// Deterministic stand-in for the Codex CLI. Behaviour per model comes from .fake-scenario.json in the
// working directory; every exec call is logged to .fake-log.jsonl for assertions.
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
if (args[0] !== 'exec') { console.error('unsupported ' + args.join(' ')); process.exit(2); }

let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  const scenario = JSON.parse(fs.readFileSync(path.join(cwd, '.fake-scenario.json'), 'utf8'));
  const model = args[args.indexOf('-m') + 1];
  const logFile = path.join(cwd, '.fake-log.jsonl');
  const n = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
  fs.appendFileSync(logFile, JSON.stringify({ args, prompt, model, t: Date.now() }) + '\n');
  const s = { ...scenario.default, ...(scenario[model] || {}) };
  const thread = args[1] === 'resume' ? args[2] : `thread-${n}`;
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });

  const fail = message => { out({ type: 'error', message }); out({ type: 'turn.failed', error: { message } }); process.exit(1); };
  if (s.action === 'unsupported') fail(`{"status":400,"error":{"message":"The '${model}' model is not supported when using Codex with a ChatGPT account."}}`);
  if (s.action === 'ratelimit') fail("You've hit your usage limit. Try again in 2h 5m.");
  if (s.action === 'hang') { setInterval(() => {}, 1000); return; }

  const writes = (scenario.writes || [])[n] || {};
  for (const [p, content] of Object.entries(writes)) {
    fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
    fs.writeFileSync(path.join(cwd, p), content);
    out({ type: 'item.completed', item: { id: 'f' + n, type: 'file_change', changes: [{ path: p, kind: 'update' }] } });
  }
  const delay = s.delayMs || 0;
  setTimeout(() => {
    out({ type: 'item.completed', item: { id: 'c' + n, type: 'command_execution', command: 'echo ok', exit_code: 0 } });
    const report = { status: s.status || 'done', summary: `fake ${model} call ${n}`, files_changed: Object.keys(writes), verification: 'ran nothing', findings: s.findings || [], open_questions: [] };
    out({ type: 'item.completed', item: { id: 'm' + n, type: 'agent_message', text: s.raw || JSON.stringify(report) } });
    out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 0 } });
  }, delay);
});
