#!/usr/bin/env node
'use strict';
// PreToolUse guard:
//  - file edits: deny when the file is owned by a running in-place Codex writer or an integration
//  - Agent: deny a subagent model above the configured Claude ceiling
const path = require('path');

const CLAUDE_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

function main(input) {
  const t = input.tool_input || {};
  if (input.tool_name === 'Agent') {
    const { config } = require('../server/config');
    const ceiling = config().claudeMaxModel;
    const fam = (/(haiku|sonnet|opus|fable)/i.exec(String(t.model || '')) || [])[1];
    if (fam && CLAUDE_RANK[fam.toLowerCase()] > (CLAUDE_RANK[ceiling] || 3)) {
      deny(`Tandem: subagent model "${t.model}" exceeds the configured Claude ceiling (${ceiling}). Use ${ceiling} or a cheaper model.`);
    }
    return;
  }
  const file = t.file_path || t.notebook_path;
  if (!file) return;
  const store = require('../server/store');
  const abs = path.resolve(input.cwd || process.cwd(), file);
  const root = store.projectRoot(path.dirname(abs));
  const target = path.relative(root, abs).split(path.sep).join('/');
  if (target.startsWith('..')) return;
  const ledger = require('../server/ledger');
  const hit = ledger.heldClaims(store.projectDir(root)).find(c => c.paths.some(p => ledger.overlaps(p, target)));
  if (hit) deny(`Tandem: ${target} is owned by ${hit.status} Codex job ${hit.id} (paths: ${hit.paths.join(', ')}). Wait for it (codex_wait) or cancel it (codex_jobs cancel) before editing.`);
}

let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  // Never block the user's work because of a guard bug: fail open, but leave a trace.
  try { main(JSON.parse(raw || '{}')); } catch (e) { try { require('../server/store').logError('guard hook', e); } catch {} }
});
