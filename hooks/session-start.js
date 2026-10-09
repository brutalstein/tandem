#!/usr/bin/env node
'use strict';
// SessionStart: inject a compact orchestration brief (Codex readiness + key shared memory).
// Reads cached state only; never spawns Codex, so session start stays fast.
const path = require('path');

function brief(input) {
  const store = require('../server/store');
  const { config } = require('../server/config');
  const router = require('../server/router');
  const memory = require('../server/memory');
  const { activeClaims } = require('../server/jobs');
  const cfg = config();
  const env = store.readJson(path.join(store.DATA, 'env.json'), null);
  const root = store.projectRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const projDir = store.projectDir(root);

  let codexLine;
  if (!env) codexLine = 'Codex: discovery pending (tandem_status shows it).';
  else if (!env.installed) codexLine = 'Codex: not installed — delegation unavailable; work in Claude only.';
  else if (!env.loggedIn) codexLine = `Codex: not logged in (${env.login}) — delegation unavailable until \`codex login\`.`;
  else {
    const now = Date.now();
    const unav = Object.fromEntries(Object.entries(env.unavailable || {}).filter(([, x]) => x.until > now));
    const ms = router.eligibleModels(env.models, cfg, unav).map(m => m.slug);
    codexLine = unav['*'] ? `Codex: rate-limited until ${new Date(unav['*'].until).toLocaleTimeString()} — do work in Claude.`
      : `Codex ready (${env.version}): ${ms.join(', ') || 'NO model within ceiling'} (ceiling ${cfg.codexMaxModel}).`;
  }
  const L = [`[tandem] ${codexLine} Claude subagent ceiling: ${cfg.claudeMaxModel}. For multi-step engineering work use the tandem:orchestrate skill.`];
  const key = memory.search(projDir, root, { kinds: ['decision', 'constraint'], limit: 5 })
    .concat(memory.search(projDir, root, { kinds: ['issue'], limit: 3 }));
  if (key.length) L.push(`Shared memory (${memory.counts(projDir)} entries; memory_search for more):`, ...key.map(e => '- ' + memory.fmt(e).slice(0, 220)));
  const claims = activeClaims(projDir);
  if (claims.length) L.push(`Active Codex write jobs: ${claims.map(c => `${c.id} owns ${c.paths.join(',')}`).join('; ')}`);
  return L.join('\n');
}

let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief(input) } }));
  } catch {}
});
