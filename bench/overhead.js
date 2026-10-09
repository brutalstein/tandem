#!/usr/bin/env node
'use strict';
// Deterministic overhead micro-benchmarks (no provider access needed).
//   node bench/overhead.js [pluginRoot=.] [--out file.json]
// Measures what an installed-but-idle Tandem costs a Claude Code session: hook latency,
// MCP server start-up, idle CPU/RSS of the server, and memory-search latency vs store size.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const outIdx = process.argv.indexOf('--out');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ovh-'));
const env = { ...process.env, TANDEM_DATA: path.join(TMP, 'data'), CLAUDE_PLUGIN_DATA: path.join(TMP, 'data'), TANDEM_CODEX_BIN: path.join(__dirname, '..', 'test', 'fake-codex.js') };

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const summ = xs => ({ n: xs.length, p50: +q(xs, 0.5).toFixed(2), p95: +q(xs, 0.95).toFixed(2), min: +Math.min(...xs).toFixed(2), max: +Math.max(...xs).toFixed(2) });

const repo = path.join(TMP, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'a.js'), 'x');

function hookLatency(script, input, n) {
  const ms = [];
  for (let i = 0; i < n + 3; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [path.join(root, 'hooks', script)], { input: JSON.stringify(input), env: { ...env, CLAUDE_PROJECT_DIR: repo }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} exited ${r.status}: ${r.stderr}`);
    if (i >= 3) ms.push(Number(process.hrtime.bigint() - t) / 1e6); // first runs warm the FS cache
  }
  return summ(ms);
}

function nodeBaseline(n) {
  const ms = [];
  for (let i = 0; i < n + 3; i++) {
    const t = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', ''], { input: '' });
    if (i >= 3) ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return summ(ms);
}

function procStats(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.TotalProcessorTime.TotalMilliseconds)"`], { encoding: 'utf8' }).trim().split(/\s+/);
    return { rssMB: Number(out[0]) / 2 ** 20, cpuMs: Number(out[1]) };
  }
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const tick = 100;
  return { rssMB: Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096 / 2 ** 20, cpuMs: (Number(stat[11]) + Number(stat[12])) * 1000 / tick };
}

async function mcpStartup(n, idleSeconds) {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const serverPath = path.join(root, 'server', 'mcp.js');
  const times = [];
  let idle = null;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    const p = spawn(process.execPath, [serverPath], { cwd: repo, env: { ...env, TANDEM_PROJECT_DIR: repo } });
    let buf = '';
    await new Promise((resolve, reject) => {
      p.stdout.on('data', d => { buf += d; if (buf.split('\n').filter(Boolean).length >= 2) resolve(); });
      p.on('exit', c => reject(new Error('server exited ' + c)));
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b', version: '1' } } }) + '\n');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (i === n - 1) {
      const toolsBytes = Buffer.byteLength(buf.split('\n')[1] || '');
      await new Promise(r => setTimeout(r, 3000)); // let start-up work (discovery) settle
      const a = procStats(p.pid);
      await new Promise(r => setTimeout(r, idleSeconds * 1000));
      const b = procStats(p.pid);
      idle = { rssMB: +b.rssMB.toFixed(1), idleCpuMsPerMin: +((b.cpuMs - a.cpuMs) * 60 / idleSeconds).toFixed(2), toolsListBytes: toolsBytes };
    }
    p.stdin.end(); p.kill();
  }
  return { initAndToolsList: summ(times), idle, version: plugin.version };
}

function memorySearch(sizes) {
  const memory = require(path.join(root, 'server', 'memory.js'));
  const store = require(path.join(root, 'server', 'store.js'));
  const res = {};
  for (const n of sizes) {
    const pd = store.mkdirp(path.join(TMP, `mem${n}`));
    const words = 'parser cache router ledger worktree memory index token schema verify session hook queue lease commit merge'.split(' ');
    const db = { version: 2, seq: n, entries: [] };
    for (let i = 0; i < n; i++) {
      const text = `entry ${i} ${words[i % words.length]} ${words[(i * 7) % words.length]} module${i % 50} detail${i}`;
      db.entries.push({ id: `m${i + 1}`, kind: i % 5 ? 'fact' : 'decision', text, files: [], verified: i % 3 === 0, confidence: i % 3 === 0 ? 'verified' : 'tentative', source: 'claude', status: 'active', created: Date.now(), updated: Date.now(), hits: 0, uses: 0 });
    }
    fs.writeFileSync(path.join(pd, 'memory.json'), JSON.stringify(db));
    const ms = [];
    for (let i = 0; i < 25; i++) {
      const t = process.hrtime.bigint();
      memory.search(pd, repo, { query: 'router ledger module7', limit: 8 });
      ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    res[n] = summ(ms.slice(5));
  }
  return res;
}

(async () => {
  const result = {
    root: path.relative(process.cwd(), root) || '.', date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version,
    cpu: os.cpus()[0].model, cpus: os.cpus().length,
    nodeSpawnBaseline: nodeBaseline(20),
    guardEditNoJobs: hookLatency('guard.js', { tool_name: 'Edit', cwd: repo, tool_input: { file_path: path.join(repo, 'a.js') } }, 30),
    guardAgent: hookLatency('guard.js', { tool_name: 'Agent', tool_input: { model: 'sonnet' } }, 20),
    sessionStart: hookLatency('session-start.js', { cwd: repo, source: 'startup' }, 20),
    mcp: await mcpStartup(10, 20),
    memorySearchMs: memorySearch([100, 400, 2000]),
  };
  const json = JSON.stringify(result, null, 1);
  if (outIdx > 0) { fs.mkdirSync(path.dirname(path.resolve(process.argv[outIdx + 1])), { recursive: true }); fs.writeFileSync(process.argv[outIdx + 1], json); }
  console.log(json);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
