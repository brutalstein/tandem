'use strict';
// Human-readable job reports, shared by the MCP server (Claude Code) and the standalone CLI.
const { frame } = require('./security');

const k = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
const list = xs => xs.map(x => '- ' + x).join('\n');

function formatJob(j, full = false) {
  const r = j.result || {};
  const rep = r.report || {};
  const L = [`job ${j.id} [${j.mode}/${j.difficulty}${j.isolation && j.isolation !== 'none' ? ', ' + j.isolation : ''}] ${j.status.toUpperCase()}` + (j.finished ? ` in ${Math.round((j.finished - (j.started || j.created)) / 1000)}s` : '')];
  if (j.note) L.push(`note: ${j.note}`);
  if (j.route && (full || j.route.explored)) L.push(`route: ${j.route.override ? 'override ' + j.route.override : `plan ${(j.route.plan || []).map(p => p.r).join(' -> ')}${j.route.explored ? ' (exploring)' : ''}, ${j.route.nObs} obs`}`);
  if (j.attempts && j.attempts.length) L.push('attempts: ' + j.attempts.map(a => `${a.model}@${a.effort}${a.verified === true ? ' ✓' : a.verified === false ? ' ✗' : ''}${a.errorKind ? ' (' + a.errorKind + ')' : ''}`).join(' -> '));
  if (r.usage) L.push(`codex tokens: in ${k(r.usage.input)} (cached ${k(r.usage.cached)}), out ${k(r.usage.output)}`);
  if (rep.summary) L.push(frame(`codex report (${rep.status})`, rep.summary + (full && rep.verification ? `\nclaimed verification: ${rep.verification}` : '')));
  if (r.verification && r.verification.environment) L.push(`verification: could not run \`${r.verification.command}\`: ${r.verification.environment}. The change is UNVERIFIED; fix the environment and run the check yourself.`);
  else if (r.verification) L.push(`verification: \`${r.verification.command}\` ${r.verification.ok ? 'PASSED' : 'FAILED (exit ' + r.verification.code + ')'}` + (r.verification.tail ? '\n' + frame('test output', r.verification.tail) : ''));
  else if (j.mode === 'implement' && rep.status) L.push('verification: none run by Tandem — verify before trusting');
  if (r.integrity) L.push(`INTEGRITY: ${r.integrity.verifyDefinitionChanged ? 'test definition changed (' + r.integrity.verifyDefinitionChanged.join(', ') + ') ' : ''}${r.integrity.deletedTests ? 'tests deleted (' + r.integrity.deletedTests.join(', ') + ') ' : ''}${r.integrity.modifiedTests ? 'test files changed (' + r.integrity.modifiedTests.join(', ') + ')' : ''} — pass not counted as verified; review the diff`);
  if (r.changed) L.push(`changed: ${r.changed.join(', ') || 'none'}`);
  if (r.outOfScope && r.outOfScope.length) L.push(`OUT OF SCOPE changes: ${r.outOfScope.join(', ')}`);
  if (r.integration) {
    const g = r.integration;
    if (g.conflicts) L.push(`integration: NOT applied — conflicts:\n${list(g.conflicts.map(c => `${c.path}: ${c.reason}`))}`);
    else L.push(`integration: ${g.applied.length ? g.applied.map(a => `${a.path} (${a.how})`).join(', ') : 'nothing to apply'}${g.mainTreeDrifted ? '; your tree changed meanwhile' : ''}${g.postVerify ? `; re-verified in your tree: ${g.postVerify.ok ? 'PASSED' : 'FAILED'}` : ''}${g.reverted ? `; reverted ${g.reverted.join(', ')}` : ''}`);
  }
  if (r.suspension) {
    const sp = r.suspension;
    L.push(`SUSPENDED (${sp.kind}): ${sp.reason || ''} — resumable ${sp.waitFor === 'time' && sp.until ? 'after ' + new Date(sp.until).toLocaleString() : 'once the cause is fixed'}; partial work kept. Continue: codex_jobs resume=${j.id} (or \`tandem resume ${j.id}\`), or do it yourself and codex_jobs takeover=${j.id}`);
  }
  if (j.resumed) L.push(`resumed ${j.resumed}x`);
  if (r.worktreeKept) L.push(`worktree kept for inspection: ${r.worktreeKept} (git -C "${r.worktreeKept}" diff HEAD; codex_jobs discard=${j.id} to delete)`);
  if (rep.findings && rep.findings.length) L.push(frame('codex findings (saved as tentative memory)', list(rep.findings)));
  if (rep.open_questions && rep.open_questions.length) L.push(frame('codex open questions', list(rep.open_questions)));
  if (r.error) L.push(`error: ${r.error}`);
  if (r.memoryIds && r.memoryIds.length) L.push(`memory: ${r.memoryIds.join(', ')}`);
  return L.join('\n');
}

module.exports = { formatJob, k, list };
