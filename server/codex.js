'use strict';
// Codex provider adapter. Everything Codex-specific lives here behind a small interface that the
// orchestrator uses (see docs/ARCHITECTURE.md#provider-interface):
//   discover({force}) -> env    availability(env) -> {model: state}    buildArgs(spec) -> argv
//   runTurn({args, prompt, cwd, timeoutMs, onEvent}) -> {child, done}    classifyError(msg) -> kind
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { DATA, readJson, update } = require('./store');

const IS_WIN = process.platform === 'win32';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ENV_FILE = path.join(DATA, 'env.json');
const ENV_TTL_MS = 6 * 3600e3;
const NEGATIVE_TTL_MS = 60e3; // "not installed / not logged in" is re-probed quickly so `codex login` takes effect

function codexCommand() {
  const override = process.env.TANDEM_CODEX_BIN;
  if (override) return override.endsWith('.js') ? [process.execPath, [override]] : [override, []];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (IS_WIN) {
      // npm's codex.cmd shim needs a shell; running the package entry with our node avoids cmd.exe parsing.
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
  return (list || []).filter(m => m && typeof m.slug === 'string').map(m => ({
    slug: m.slug,
    description: String(m.description || '').slice(0, 200),
    visibility: m.visibility || 'list',
    efforts: (m.supported_reasoning_levels || []).map(l => (l && l.effort) || l).filter(e => typeof e === 'string'),
    defaultEffort: m.default_reasoning_level || null,
    contextWindow: m.context_window || null,
    priority: Number.isFinite(m.priority) ? m.priority : 99,
  }));
}

function readConfigModel() {
  try { return (/^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8')) || [])[1] || null; } catch { return null; }
}

function fresh(env) {
  if (!env || !env.at) return false;
  return Date.now() - env.at < (env.installed && env.loggedIn ? ENV_TTL_MS : NEGATIVE_TTL_MS);
}

async function discover({ force = false } = {}) {
  const cached = readJson(ENV_FILE, null);
  if (!force && fresh(cached)) return cached;
  const cmd = codexCommand();
  const env = { at: Date.now(), installed: !!cmd, version: null, loggedIn: false, login: 'codex not found on PATH', models: [], catalogSource: null, configModel: readConfigModel() };
  if (cmd) {
    const [v, l, m] = await Promise.all([execOut(cmd, ['--version']), execOut(cmd, ['login', 'status']), execOut(cmd, ['debug', 'models'], 60000)]);
    env.version = v.out.trim() || null;
    env.login = (l.out + l.err).trim().split(/\r?\n/)[0] || '';
    env.loggedIn = l.code === 0 && /logged in/i.test(env.login) && !/not logged in/i.test(env.login);
    try { env.models = normalizeModels(JSON.parse(m.out).models); env.catalogSource = 'codex debug models'; } catch {
      env.models = normalizeModels((readJson(path.join(CODEX_HOME, 'models_cache.json'), {}) || {}).models);
      env.catalogSource = env.models.length ? 'models_cache.json' : null;
    }
  }
  return update(ENV_FILE, {}, v => {
    Object.assign(v, env);
    v.unavailable = v.unavailable || {};
    v.verified = v.verified || {};
    return structuredClone(v);
  });
}

// Account-level availability is learned, not assumed from the catalog:
//   verified    - a run on this model succeeded for this account
//   unavailable - the provider rejected it (with expiry) ; key '*' = provider-wide rate limit
//   listed      - in the catalog, never tried
function markUnavailable(key, reason, ms, kind) {
  update(ENV_FILE, {}, v => { (v.unavailable = v.unavailable || {})[key] = { until: Date.now() + ms, reason: String(reason).slice(0, 200), kind: kind || null }; });
}
function markVerified(model) {
  update(ENV_FILE, {}, v => {
    (v.verified = v.verified || {})[model] = Date.now();
    if (v.unavailable) { delete v.unavailable[model]; delete v.unavailable['*']; } // a completed turn proves the provider is back
  });
}
// Forget a recorded outage before its estimated end (the user says the provider is back). It only
// re-enables trying: a provider that is still limited answers with its limit again and the job re-suspends.
function clearUnavailable(key) { update(ENV_FILE, {}, v => { if (v.unavailable) delete v.unavailable[key]; }); }
function unavailable() {
  const now = Date.now();
  const u = (readJson(ENV_FILE, {}) || {}).unavailable || {};
  return Object.fromEntries(Object.entries(u).filter(([, x]) => x && x.until > now));
}
function availability(env) {
  const unav = unavailable();
  return Object.fromEntries((env.models || []).map(m => [m.slug, unav[m.slug] ? 'unavailable' : (env.verified || {})[m.slug] ? 'verified' : 'listed']));
}

// The provider as a whole (a single model being unavailable is not the provider being down):
//   available | rate_limited | quota_exhausted (both with until) | auth_required | not_installed | no_models
function providerState(env, unav = unavailable()) {
  if (!env || !env.installed) return { state: 'not_installed', waitFor: 'user', reason: 'Codex CLI not found on PATH (npm i -g @openai/codex)' };
  if (!env.loggedIn) return { state: 'auth_required', waitFor: 'user', reason: `Codex not logged in (${env.login}); run: codex login` };
  if (unav['*']) return { state: unav['*'].kind || 'rate_limited', waitFor: 'time', until: unav['*'].until, reason: unav['*'].reason };
  if (!(env.models || []).length) return { state: 'no_models', waitFor: 'user', reason: 'no Codex model catalog available' };
  return { state: 'available' };
}

// A usage/plan quota resets on the provider's schedule; a rate limit clears in seconds to minutes.
const limitKind = msg => (/usage limit|quota|insufficient_quota|plan limit|credits/i.test(String(msg || '')) ? 'quota_exhausted' : 'rate_limited');

function classifyError(msg) {
  const s = String(msg || '');
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b|insufficient_quota/i.test(s)) return 'rate_limited';
  if (/\b401\b|unauthori[sz]ed|not logged in|login required|authentication|expired token/i.test(s)) return 'auth';
  if (/model.*(not supported|not found|does not exist|unavailable|not available)|unknown model|invalid model/i.test(s)) return 'model_unavailable';
  if (/\b5\d\d\b|overloaded|stream (disconnected|error)|ECONNRESET|ETIMEDOUT|network|temporar/i.test(s)) return 'transient';
  return 'error';
}

// "try again in 2h 5m" / "in 37 minutes" / "resets in 90 seconds" / "try again at 4:18 PM" -> ms;
// fallback 15 min.
function retryAfterMs(msg, now = Date.now()) {
  // An absolute time is local wall-clock time (the CLI runs on this machine); the next occurrence counts.
  const at = /\bat\s+(\d{1,2}):(\d{2})\s*([ap])?\.?m?\b/i.exec(String(msg || ''));
  if (at) {
    const t = new Date(now);
    t.setHours(Number(at[1]) % (at[3] ? 12 : 24) + (/p/i.test(at[3] || '') ? 12 : 0), Number(at[2]), 0, 0);
    let ms = t.getTime() - now;
    if (ms <= 0) ms += 864e5;
    return Math.min(ms + 60e3, 24 * 3600e3); // +1 min: the message is rounded to minutes
  }
  let ms = 0;
  for (const [, n, unit] of String(msg || '').matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?|s|sec|seconds?)\b/gi)) {
    ms += Number(n) * (/^h/i.test(unit) ? 3600e3 : /^m/i.test(unit) ? 60e3 : 1e3);
  }
  return ms > 0 ? Math.min(ms, 24 * 3600e3) : 15 * 60e3;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

// spec: { sandbox: 'read-only'|'workspace-write', model, effort, resumeThread, schemaFile, lean, ephemeral }
function buildArgs(spec) {
  const a = spec.resumeThread ? ['exec', 'resume', spec.resumeThread] : ['exec'];
  a.push('--json', '--skip-git-repo-check', '-m', spec.model,
    '-c', `model_reasoning_effort="${spec.effort}"`,
    '-c', `sandbox_mode="${spec.sandbox}"`);
  if (spec.schemaFile) a.push('--output-schema', spec.schemaFile);
  if (spec.lean) a.push('-c', 'skills.max_context_tokens=100', '--disable', 'plugins');
  if (spec.ephemeral) a.push('--ephemeral');
  a.push('-'); // prompt on stdin: user/model text never reaches a command line
  return a;
}

const MAX_LINE = 4 << 20;

function runTurn({ args, prompt, cwd, timeoutMs, onEvent }) {
  const cmd = codexCommand();
  if (!cmd) return { child: null, done: Promise.resolve({ ok: false, error: 'codex CLI not found on PATH', errorKind: 'missing', usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, files: [], commands: [], warnings: [], durationMs: 0 }) };
  const started = Date.now();
  const child = spawn(cmd[0], [...cmd[1], ...args], { cwd, windowsHide: true, detached: !IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const r = { threadId: null, finalText: '', commands: [], files: new Set(), warnings: [], usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, error: null, completed: false, firstEventMs: null, badLines: 0 };
  let buf = '', errTail = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

  const handle = ev => {
    if (r.firstEventMs === null) r.firstEventMs = Date.now() - started;
    switch (ev.type) {
      case 'thread.started': r.threadId = typeof ev.thread_id === 'string' ? ev.thread_id : r.threadId; break;
      case 'turn.completed': {
        r.completed = true;
        const u = ev.usage || {};
        r.usage.input += +u.input_tokens || 0; r.usage.cached += +u.cached_input_tokens || 0;
        r.usage.output += +u.output_tokens || 0; r.usage.reasoning += +u.reasoning_output_tokens || 0;
        break;
      }
      case 'turn.failed': r.error = String((ev.error && ev.error.message) || 'turn failed'); break;
      // Top-level 'error' events also report retried stream hiccups; they only fail the turn if it never completes.
      case 'error': r.streamError = String(ev.message); if (r.warnings.length < 20) r.warnings.push(r.streamError.slice(0, 200)); break;
      case 'item.completed': {
        const it = ev.item || {};
        if (it.type === 'agent_message') r.finalText = String(it.text || '');
        else if (it.type === 'command_execution' && r.commands.length < 500) r.commands.push({ command: String(it.command || '').slice(0, 200), exit: it.exit_code ?? null });
        else if (it.type === 'file_change') for (const c of it.changes || []) if (c && typeof c.path === 'string') r.files.add(c.path);
        else if (it.type === 'error' && it.message && r.warnings.length < 20) r.warnings.push(String(it.message).slice(0, 200));
        break;
      }
    }
    if (onEvent) { try { onEvent(ev); } catch {} }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) { buf = ''; r.badLines++; } // absurd line: drop, keep streaming
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { r.badLines++; continue; }
      if (ev && typeof ev === 'object') handle(ev);
    }
  });
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const done = new Promise(resolve => {
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) r.error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      else if (!r.completed && !r.error && r.streamError) r.error = r.streamError;
      else if (!r.completed && !r.error) r.error = `codex exited (${code}) without completing: ${errTail.trim().slice(-300)}`;
      resolve({
        ok: r.completed && !r.error, timedOut, exitCode: code, threadId: r.threadId, finalText: r.finalText,
        commands: r.commands, files: [...r.files], warnings: r.warnings, usage: r.usage, error: r.error, badLines: r.badLines,
        errorKind: r.error ? (timedOut ? 'timeout' : classifyError(r.error)) : null, durationMs: Date.now() - started, firstEventMs: r.firstEventMs,
      });
    };
    child.on('error', e => { r.error = e.message; finish(-1); });
    child.on('close', finish);
    // 'close' waits for every holder of the stdout pipe; a tool process that outlives codex (seen with
    // git after a cancel) would hang the job forever. Codex's own output is already in the pipe at exit.
    child.on('exit', code => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 1500).unref());
  });
  return { child, done };
}

module.exports = { providerState, clearUnavailable, limitKind, id: 'codex', codexCommand, discover, markUnavailable, markVerified, unavailable, availability, classifyError, retryAfterMs, killTree, buildArgs, runTurn, ENV_FILE };
