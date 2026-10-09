#!/usr/bin/env node
'use strict';
// Real install lifecycle against the installed `claude` CLI, in a throw-away HOME / CLAUDE_CONFIG_DIR
// so the developer's own Claude Code configuration is never touched. Needs no login.
//   node test/install-smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-proj-'));
spawnSync('git', ['init', '-q'], { cwd: proj });
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
delete env.ANTHROPIC_API_KEY;
// claude is a native executable (no shell needed); an npm install on Windows only has the claude.cmd shim.
function runClaude(args, opts) {
  const r = spawnSync('claude', args, opts);
  if (!(r.error && r.error.code === 'ENOENT' && process.platform === 'win32')) return r;
  const q = a => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return spawnSync(['claude.cmd', ...args.map(q)].join(' '), { ...opts, shell: true });
}
const claude = (args, cwd = proj) => {
  const r = runClaude(args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const steps = [];
const step = (name, args, expect, cwd) => {
  const r = claude(args, cwd);
  const ok = r.code === 0 && expect.test(r.out);
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  exit ${r.code}: ${r.out.trim().slice(-800)}`}`);
  return ok;
};

const v = claude(['--version']);
if (v.code !== 0) { console.log('claude CLI not found; skipping install smoke test'); process.exit(2); }
console.log(`claude ${v.out.trim()} | ${process.platform} | node ${process.version}`);
step('validate marketplace (strict)', ['plugin', 'validate', '--strict', ROOT], /Validation passed/);
step('validate plugin manifest (strict)', ['plugin', 'validate', '--strict', path.join(ROOT, '.claude-plugin', 'plugin.json')], /Validation passed/);
step('marketplace add', ['plugin', 'marketplace', 'add', ROOT], /Successfully added marketplace: tandem-local/);
step('install (user scope)', ['plugin', 'install', 'tandem@tandem-local', '-s', 'user'], /Successfully installed plugin: tandem@tandem-local/);
step('listed and enabled', ['plugin', 'list'], /tandem@tandem-local[\s\S]*Version: 2\.[\s\S]*enabled/);
step('skills, agents and hooks registered', ['plugin', 'details', 'tandem@tandem-local'], /orchestrate[\s\S]*Agents \(2\)[\s\S]*SessionStart, PreToolUse/);
step('MCP server starts and answers the health check', ['mcp', 'list'], /plugin:tandem:tandem: .*Connected/);
step('disable', ['plugin', 'disable', 'tandem@tandem-local'], /disabled/);
step('enable', ['plugin', 'enable', 'tandem@tandem-local'], /enabled/);
step('uninstall', ['plugin', 'uninstall', 'tandem@tandem-local'], /uninstalled/);
step('no plugins left', ['plugin', 'list'], /No plugins installed/);
step('marketplace remove', ['plugin', 'marketplace', 'remove', 'tandem-local'], /removed marketplace/);
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });
const failed = steps.filter(s => !s.ok).length;
console.log(`INSTALL SMOKE: ${failed ? 'FAIL' : 'PASS'} (${steps.length - failed}/${steps.length})`);
process.exit(failed ? 1 : 0);
