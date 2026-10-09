#!/usr/bin/env node
'use strict';
// Standalone Tandem control: inspect and continue work without a Claude model (Claude quota exhausted,
// Claude Code closed). Uses the same ledger, checkpoint and Codex adapter as the plugin. It only runs
// what was already authorized: suspended/interrupted jobs (under their original scope and ceilings)
// and checkpoint items the lead marked delegable. It never invents new work.
const fs = require('fs');
const { config } = require('../server/config');
const { Orchestrator } = require('../server/jobs');
const codex = require('../server/codex');
const ledger = require('../server/ledger');
const checkpoint = require('../server/checkpoint');
const { formatJob } = require('../server/format');

const USAGE = `usage: tandem <command> [--cwd DIR]
  status                 providers, stopped jobs, kept worktrees, checkpoint
  jobs                   recent jobs of this project
  show <id>              one job in full
  resume <id...>|--due|--all [--now]
                         continue stopped jobs where they stopped (--due: only those whose provider
                         wait is over; --now: try even if Codex was recorded as limited)
  takeover <id> [--note TEXT]
                         mark a stopped job as done another way; it will never be resumed
  continue [--now]       resume due jobs, then start checkpoint items marked delegable
Ctrl+C suspends running jobs (resumable); it does not discard them.`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd' || a === '--note') o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) o[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

const isDue = (j, now = Date.now()) => ledger.RESUMABLE.has(j.status) && !(j.result && j.result.suspension && j.result.suspension.kind === 'dependency') &&
  (!(j.result && j.result.suspension) || j.result.suspension.waitFor !== 'time' || (j.result.suspension.until || 0) <= now);

async function status(orch, o) {
  const { root, projDir } = orch.ctx(o.cwd);
  const env = await codex.discover();
  const ps = codex.providerState(env, codex.unavailable());
  const jobs = ledger.list(projDir);
  const L = [`project ${root}`,
    `codex: ${ps.state}${ps.until ? ' until ' + new Date(ps.until).toLocaleString() : ''}${ps.reason ? ' (' + ps.reason + ')' : ''}`,
    'claude: not observable from here (Tandem cannot read Claude quota); use Claude Code when it is available'];
  const stopped = jobs.filter(j => ledger.RESUMABLE.has(j.status));
  L.push(stopped.length ? 'stopped jobs (resumable):' : 'stopped jobs: none');
  for (const j of stopped) {
    const sp = (j.result && j.result.suspension) || {};
    L.push(`  ${j.id} ${j.status}${sp.kind ? ' ' + sp.kind : ''}${sp.until ? ' until ' + new Date(sp.until).toLocaleString() : ''}${isDue(j) ? ' [due]' : ''} [${j.mode}] ${j.task.slice(0, 80)}`);
  }
  const active = jobs.filter(j => ledger.ACTIVE.has(j.status));
  if (active.length) L.push('active: ' + active.map(j => `${j.id} ${j.status}`).join(', '));
  const kept = jobs.filter(j => j.result && j.result.worktreeKept && fs.existsSync(j.result.worktreeKept));
  if (kept.length) L.push('kept worktrees:\n' + kept.map(j => `  ${j.id}: ${j.result.worktreeKept}`).join('\n'));
  L.push(checkpoint.summary(checkpoint.reconcile(projDir, jobs), jobs));
  return L.join('\n');
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._.shift();
  if (!cmd || cmd === 'help' || o.help) return console.log(USAGE);
  const orch = new Orchestrator(config(), { onProgress: (id, m) => process.stderr.write(`${id} ${m}\n`) });
  const { root, projDir } = orch.ctx(o.cwd);
  const run = async started => {
    if (!started.length) return console.log('nothing to run');
    let stopping = false;
    process.on('SIGINT', () => {
      if (stopping) process.exit(130);
      stopping = true;
      process.stderr.write('suspending running jobs (Ctrl+C again to force quit)...\n');
      orch.suspendAll('user_interrupt', 'stopped from the tandem CLI');
    });
    const done = await Promise.all(started.map(s => s.promise));
    console.log(done.map(j => formatJob(j)).join('\n\n'));
    checkpoint.reconcile(projDir, ledger.list(projDir));
    process.exitCode = done.every(j => ['verified', 'answered'].includes(j.status)) ? 0 : 1;
  };

  if (cmd === 'status') return console.log(await status(orch, o));
  if (cmd === 'jobs') return console.log(ledger.list(projDir).slice(0, 20).map(j => `${j.id} ${j.status} [${j.mode}/${j.difficulty}] ${j.task.slice(0, 90)}`).join('\n') || 'no jobs');
  if (cmd === 'show') { const j = ledger.get(projDir, o._[0]); return console.log(j ? formatJob(j, true) : `no job ${o._[0]}`); }
  if (cmd === 'takeover') {
    if (!o._[0]) throw new Error('takeover needs a job id');
    const j = orch.takeOver(o._[0], o.cwd, 'user', o.note || '');
    return console.log(`${j.id} marked taken_over${j.result && j.result.worktreeKept ? `; partial work remains in ${j.result.worktreeKept}` : ''}`);
  }
  if (cmd === 'resume' || cmd === 'continue') {
    const jobs = ledger.list(projDir);
    const ids = cmd === 'continue' || o.due ? jobs.filter(j => isDue(j)).map(j => j.id)
      : o.all ? jobs.filter(j => ledger.RESUMABLE.has(j.status)).map(j => j.id) : o._;
    if (cmd === 'resume' && !ids.length && !o.due && !o.all) throw new Error('resume needs job ids, --due or --all');
    // Dependencies first (lower ids), so a dependent queues behind its resumed dependency.
    const started = ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((id, i) => orch.resume(id, o.cwd, { now: !!o.now && i === 0 }));
    if (cmd === 'continue') {
      const cp = checkpoint.load(projDir);
      for (const it of cp.items.filter(x => x.status === 'todo' && x.delegate && !x.job)) {
        const s = orch.submit({ ...it.delegate, cwd: root }); // under the ceilings recorded when it was delegated
        checkpoint.save(projDir, { items: [{ id: it.id, status: 'doing', job: s.job.id }] }, 'tandem-cli');
        started.push(s);
      }
    }
    return run(started);
  }
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch(e => { console.error('tandem: ' + e.message); process.exitCode = 1; });
