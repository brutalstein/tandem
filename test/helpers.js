'use strict';
// Shared fixtures. Each test file runs in its own process (node --test), so each gets its own
// TANDEM_DATA directory and never touches the real plugin data or the real Codex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
process.env.TANDEM_CODEX_BIN = path.join(__dirname, 'fake-codex.js');
process.env.CODEX_HOME = path.join(TMP, 'codex-home'); // never read the developer's real Codex config
for (const k of Object.keys(process.env)) if (/^(TANDEM_(?!DATA|CODEX_BIN)|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete process.env[k];
process.env.TANDEM_HOME = path.join(TMP, 'home'); // skill discovery sees only test fixtures

const ROOT = path.join(__dirname, '..');
const CFG = {
  codexMaxModel: 'gpt-6.1-sol', codexAllowedModels: [], codexMaxEffort: 'xhigh', claudeMaxModel: 'opus', maxParallel: 2,
  leanCodex: true, isolation: 'auto', objective: 'balanced', exploration: false, worktreeLinks: ['node_modules'],
  jobTimeoutMs: 20000, verifyTimeoutMs: 20000, problems: [],
};
const MODELS = [
  { slug: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], visibility: 'list' },
  { slug: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh'], visibility: 'list' },
  { slug: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'], visibility: 'list' },
  { slug: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high'], visibility: 'list' },
  { slug: 'gpt-5.5-luna', efforts: ['low', 'medium'], visibility: 'list' },
  { slug: 'gpt-7-sol', efforts: ['low'], visibility: 'list' },
  { slug: 'gpt-reserve', efforts: ['low'], visibility: 'hide' },
];

let n = 0;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

function repo(scenario = { default: { action: 'ok' } }, files = {}) {
  const dir = path.join(TMP, `repo${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.fake-scenario.json\n.fake-log.jsonl\n');
  write(dir, { 'README.md': 'x\n', ...files });
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  if (scenario) fs.writeFileSync(path.join(dir, '.fake-scenario.json'), JSON.stringify(scenario));
  return dir;
}
function write(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    if (c === null) { fs.rmSync(path.join(dir, p), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
}
const read = (dir, p) => { try { return fs.readFileSync(path.join(dir, p), 'utf8'); } catch { return null; } };
const calls = dir => (read(dir, '.fake-log.jsonl') || '').split('\n').filter(Boolean).map(JSON.parse);
// A verification command that passes iff <file> contains "good".
const CHECK = file => `node -e "process.exit(require('fs').readFileSync('${file}','utf8').trim()==='good'?0:1)"`;
const resetEnv = () => { try { fs.unlinkSync(path.join(process.env.TANDEM_DATA, 'env.json')); } catch {} };

module.exports = { TMP, ROOT, CFG, MODELS, repo, write, read, calls, git, CHECK, resetEnv };
