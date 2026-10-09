'use strict';
// Validated configuration. Sources: plugin userConfig (TANDEM_* in the MCP server env,
// CLAUDE_PLUGIN_OPTION_* in hooks). Invalid values fall back to defaults and are reported.
const os = require('os');

const CONFIG_VERSION = 2;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

function opt(key) {
  const k = key.toUpperCase();
  const v = process.env['TANDEM_' + k] ?? process.env['CLAUDE_PLUGIN_OPTION_' + k];
  return v === undefined || v === '' || String(v).startsWith('${') ? undefined : String(v).trim();
}

function config() {
  const problems = [];
  const pick = (key, allowed, dflt) => {
    const v = opt(key);
    if (v === undefined) return dflt;
    if (allowed.includes(v)) return v;
    problems.push(`${key}=${v} not one of ${allowed.join('/')}; using ${dflt}`);
    return dflt;
  };
  const num = (key, dflt, min, max) => {
    const v = opt(key);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    problems.push(`${key}=${v} outside [${min}, ${max}]; using ${dflt}`);
    return dflt;
  };
  const list = key => (opt(key) || '').split(/[\s,]+/).filter(Boolean);
  const cpus = os.cpus().length;
  const parallel = num('max_parallel', 0, 0, 16);
  return {
    version: CONFIG_VERSION,
    codexMaxModel: opt('codex_max_model') || 'gpt-6.1-sol',
    codexAllowedModels: list('codex_allowed_models'), // explicit allow-list; overrides the ceiling heuristic
    codexMaxEffort: pick('codex_max_effort', EFFORTS, 'xhigh'),
    claudeMaxModel: pick('claude_max_model', CLAUDE_TIERS, 'opus'),
    // Codex jobs are I/O- and provider-bound; the cap protects quota and the machine, not the CPU alone.
    maxParallel: parallel > 0 ? parallel : Math.min(3, Math.max(1, Math.floor(cpus / 4))),
    leanCodex: opt('lean_codex') !== 'false',
    isolation: pick('isolation', ['auto', 'inplace', 'worktree'], 'worktree'),
    objective: pick('objective', ['balanced', 'tokens', 'time'], 'balanced'),
    exploration: opt('exploration') !== 'false',
    // Linked dependencies are writable through a junction/symlink. Opt-in only, never a safe default.
    worktreeLinks: list('worktree_links'),
    jobTimeoutMs: num('job_timeout_min', 30, 1, 240) * 60000,
    verifyTimeoutMs: num('verify_timeout_min', 10, 1, 120) * 60000,
    problems,
  };
}

module.exports = { config, EFFORTS, CLAUDE_TIERS, CONFIG_VERSION };
