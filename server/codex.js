'use strict';
// Codex CLI integration: locate the binary, discover installation/models, run `codex exec --json`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { DATA, readJson, update } = require('./store');

const IS_WIN = process.platform === 'win32';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ENV_FILE = path.join(DATA, 'env.json');
const ENV_TTL_MS = 6 * 3600e3;

// Returns [executable, leadingArgs] or null. On Windows the npm shim is a .cmd, which node cannot
// spawn without a shell; running the package's codex.js with our own node avoids cmd.exe quoting.
function codexCommand() {
  const override = process.env.TANDEM_CODEX_BIN;
  if (override) return override.endsWith('.js') ? [process.execPath, [override]] : [override, []];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (IS_WIN) {
      const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(path.join(dir, 'codex.cmd')) && fs.existsSync(js)) return [process.execPath, [js]];
      if (fs.existsSync(path.join(dir, 'codex.exe'))) return [path.join(dir, 'codex.exe'), []];
    } else if (fs.existsSync(path.join(dir, 'codex'))) return [path.join(dir, 'codex'), []];
  }
  return null;
}

function execOut(cmd, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(cmd[0], [...cmd[1], ...args], { timeout, windowsHide: true, maxBuffer: 32 << 20 },
      (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}

function normalizeModels(list) {
  return (list || []).map(m => ({
    slug: m.slug,
    description: m.description || '',
    visibility: m.visibility || 'list',
    efforts: (m.supported_reasoning_levels || []).map(l => l.effort || l).filter(Boolean),
    defaultEffort: m.default_reasoning_level || null,
    contextWindow: m.context_window || null,
    priority: m.priority ?? 99,
  })).filter(m => m.slug);
}

function readConfigModel() {
  try {
    const toml = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    return (/^model\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || null;
  } catch { return null; }
}

async function discover({ force = false } = {}) {
  const cached = readJson(ENV_FILE, null);
  if (!force && cached && cached.installed && Date.now() - cached.at < ENV_TTL_MS) return cached;
  const cmd = codexCommand();
  const env = { at: Date.now(), installed: !!cmd, version: null, loggedIn: false, login: 'codex not found on PATH', models: [], configModel: readConfigModel() };
  if (cmd) {
    const [v, l, m] = await Promise.all([execOut(cmd, ['--version']), execOut(cmd, ['login', 'status']), execOut(cmd, ['debug', 'models'], 60000)]);
    env.version = v.out.trim() || null;
    env.login = (l.out + l.err).trim().split(/\r?\n/)[0] || '';
    env.loggedIn = l.code === 0 && /logged in/i.test(env.login);
    try { env.models = normalizeModels(JSON.parse(m.out).models); } catch {
      env.models = normalizeModels((readJson(path.join(CODEX_HOME, 'models_cache.json'), {}) || {}).models);
    }
  }
  return update(ENV_FILE, {}, v => { Object.assign(v, env); v.unavailable = v.unavailable || {}; return { ...v }; });
}

// Runtime-learned restrictions: a model the account cannot use, or Codex-wide rate limiting (key '*').
function markUnavailable(key, reason, ms) {
  update(ENV_FILE, {}, v => { (v.unavailable = v.unavailable || {})[key] = { until: Date.now() + ms, reason }; });
}

function unavailable() {
  const now = Date.now();
  const u = (readJson(ENV_FILE, {}) || {}).unavailable || {};
  return Object.fromEntries(Object.entries(u).filter(([, x]) => x.until > now));
}

function classifyError(msg) {
  const s = String(msg || '');
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b|insufficient_quota/i.test(s)) return 'rate_limited';
  if (/\b401\b|unauthori[sz]ed|not logged in|login required|authentication/i.test(s)) return 'auth';
  if (/model.*(not supported|not found|does not exist|unavailable|not available)|unknown model|invalid model/i.test(s)) return 'model_unavailable';
  return 'transient';
}

// "try again in 2h 5m" / "in 37 minutes" / "resets in 90 seconds" -> ms; fallback 15 min.
function retryAfterMs(msg) {
  const s = String(msg || '');
  let ms = 0;
  for (const [, n, unit] of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?|s|sec|seconds?)\b/gi)) {
    ms += Number(n) * (/^h/i.test(unit) ? 3600e3 : /^m/i.test(unit) ? 60e3 : 1e3);
  }
  return ms > 0 ? Math.min(ms, 24 * 3600e3) : 15 * 60e3;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

// Spawns one Codex exec turn; prompt goes via stdin so no user text ever touches a command line.
// Returns { child, done } where done resolves to a compact summary of the event stream.
function runCodex({ args, prompt, cwd, timeoutMs, onEvent }) {
  const cmd = codexCommand();
  if (!cmd) return { child: null, done: Promise.resolve({ ok: false, error: 'codex CLI not found on PATH', errorKind: 'missing' }) };
  const started = Date.now();
  const child = spawn(cmd[0], [...cmd[1], ...args], { cwd, windowsHide: true, detached: !IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const r = { threadId: null, finalText: '', commands: [], files: new Set(), warnings: [], usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, error: null, completed: false };
  let buf = '', errTail = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

  const handle = ev => {
    if (ev.type === 'thread.started') r.threadId = ev.thread_id;
    else if (ev.type === 'turn.completed') {
      r.completed = true;
      const u = ev.usage || {};
      r.usage.input += u.input_tokens || 0; r.usage.cached += u.cached_input_tokens || 0;
      r.usage.output += u.output_tokens || 0; r.usage.reasoning += u.reasoning_output_tokens || 0;
    } else if (ev.type === 'turn.failed') r.error = (ev.error && ev.error.message) || 'turn failed';
    else if (ev.type === 'error') r.error = r.error || ev.message;
    else if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item;
      if (it.type === 'agent_message') r.finalText = it.text || '';
      else if (it.type === 'command_execution') r.commands.push({ command: String(it.command || '').slice(0, 200), exit: it.exit_code ?? null });
      else if (it.type === 'file_change') for (const c of it.changes || []) c.path && r.files.add(c.path);
      else if (it.type === 'error' && it.message) r.warnings.push(it.message.slice(0, 200));
    }
    if (onEvent) onEvent(ev);
  };

  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('{')) { try { handle(JSON.parse(line)); } catch {} }
    }
  });
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const done = new Promise(resolve => {
    const finish = code => {
      clearTimeout(timer);
      if (timedOut) r.error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      else if (!r.completed && !r.error) r.error = `codex exited (${code}) without completing: ${errTail.trim().slice(-300)}`;
      resolve({
        ok: r.completed && !r.error, timedOut, exitCode: code, threadId: r.threadId, finalText: r.finalText,
        commands: r.commands, files: [...r.files], warnings: r.warnings, usage: r.usage, error: r.error,
        errorKind: r.error ? (timedOut ? 'timeout' : classifyError(r.error)) : null, durationMs: Date.now() - started,
      });
    };
    child.on('error', e => { r.error = e.message; finish(-1); });
    child.on('close', finish);
  });
  return { child, done };
}

module.exports = { codexCommand, discover, markUnavailable, unavailable, classifyError, retryAfterMs, killTree, runCodex, ENV_FILE };
