'use strict';
// Settings come from plugin userConfig: TANDEM_* in the MCP server env, CLAUDE_PLUGIN_OPTION_* in hooks.
const os = require('os');

function opt(key) {
  const k = key.toUpperCase();
  const v = process.env['TANDEM_' + k] ?? process.env['CLAUDE_PLUGIN_OPTION_' + k];
  return v === undefined || v === '' || v.startsWith('${') ? undefined : v;
}

function config() {
  const parallel = Number(opt('max_parallel') || 0);
  return {
    codexMaxModel: opt('codex_max_model') || 'gpt-6.1-sol',
    codexMaxEffort: opt('codex_max_effort') || 'xhigh',
    claudeMaxModel: opt('claude_max_model') || 'opus',
    maxParallel: parallel > 0 ? parallel : Math.min(3, Math.max(1, Math.floor(os.cpus().length / 4))),
    leanCodex: opt('lean_codex') !== 'false',
    jobTimeoutMs: Number(opt('job_timeout_min') || 30) * 60000,
    verifyTimeoutMs: Number(opt('verify_timeout_min') || 10) * 60000,
  };
}

module.exports = { config };
