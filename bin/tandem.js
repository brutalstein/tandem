#!/usr/bin/env node
'use strict';
// Standalone Tandem control: inspect and continue work without a Claude model (Claude quota exhausted,
// Claude Code closed). Uses the same ledger, checkpoint and Codex adapter as the plugin. It only runs
// what was already authorized: suspended/interrupted jobs (under their original scope and ceilings)
// and checkpoint items the lead marked delegable. It never invents new work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../server/config');
const { Orchestrator } = require('../server/jobs');
const codex = require('../server/codex');
const ledger = require('../server/ledger');
const checkpoint = require('../server/checkpoint');
const { formatJob } = require('../server/format');
const capabilities = require('../server/capabilities');

const USAGE = `usage: tandem <command> [--cwd DIR]
  status                 providers, stopped jobs, kept worktrees, checkpoint
  jobs                   recent jobs of this project
  show <id>              one job in full
  resume <id...>|--due|--all [--now]
                         continue stopped jobs where they stopped (--due: only those whose provider
                         wait is over; --now: try even if Codex was recorded as limited)
  takeover <id> [--note TEXT]
                         mark a stopped job as done another way; it will never be resumed
  continue [--now] [--wait]
                         resume due jobs, then start checkpoint items marked delegable; --wait first
                         waits (in this terminal, nothing in the background) until the recorded Codex
                         limit reset, at most 24 h
  skills [list]          installed Codex/Claude skills (source, trust, scripts) and how they did in jobs
  skills add <dir|git-url> [--ref SHA] [--path SUBDIR] [--allow-scripts] [--force]
                         install a skill for this project only (.agents/skills), pinned in tandem-lock.json;
                         a git source needs --ref <full commit sha>
  skills verify | remove <name> | rollback <name>
Ctrl+C suspends running jobs (resumable); it does not discard them.`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--cwd', '--note', '--ref', '--path'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) o[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

// Only jobs that carry their authorization (ceilings recorded at submission) run from here; older
// stopped jobs are resumed from Claude Code, where the plugin's settings apply.
const resumable = j => ledger.RESUMABLE.has(j.status) && !!j.ceiling;
const kind = j => j.result && j.result.suspension && j.result.suspension.kind;
const waitOver = (j, now) => { const sp = j.result && j.result.suspension; return !sp || sp.waitFor !== 'time' || (sp.until || 0) <= now; };
const seq = id => Number(String(id).slice(1));
function dueIds(jobs, now = Date.now()) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const due = new Set(jobs.filter(j => resumable(j) && kind(j) !== 'dependency' && waitOver(j, now)).map(j => j.id));
  // A job stopped for its dependency is due once each dependency is due, running or done (in id order, so chains work).
  const fine = d => due.has(d) || (byId.get(d) && (ledger.ACTIVE.has(byId.get(d).status) || ledger.SUCCESS.has(byId.get(d).status) || byId.get(d).status === 'taken_over'));
  for (const j of jobs.filter(j => resumable(j) && kind(j) === 'dependency').sort((a, b) => seq(a.id) - seq(b.id))) if ((j.after || []).every(fine)) due.add(j.id);
  return [...due];
}

async function status(orch, o) {
  const { root, projDir } = orch.ctx(o.cwd);
  const env = await codex.discover();
  const ps = codex.providerState(env, codex.unavailable());
  const jobs = ledger.list(projDir);
  const L = [`project ${root}`,
    `codex: ${ps.state}${ps.until ? ' until ' + new Date(ps.until).toLocaleString() : ''}${ps.reason ? ' (' + ps.reason + ')' : ''}`,
    'claude: not observable from here (Tandem cannot read Claude quota); use Claude Code when it is available'];
  const stopped = jobs.filter(j => ledger.RESUMABLE.has(j.status)), due = new Set(dueIds(jobs));
  L.push(stopped.length ? 'stopped jobs (resumable):' : 'stopped jobs: none');
  for (const j of stopped) {
    const sp = (j.result && j.result.suspension) || {};
    L.push(`  ${j.id} ${j.status}${sp.kind ? ' ' + sp.kind : ''}${sp.until ? ' until ' + new Date(sp.until).toLocaleString() : ''}${due.has(j.id) ? ' [due]' : j.ceiling ? '' : ' [resume from Claude Code]'} [${j.mode}] ${j.task.slice(0, 80)}`);
  }
  const active = jobs.filter(j => ledger.ACTIVE.has(j.status));
  if (active.length) L.push('active: ' + active.map(j => `${j.id} ${j.status}`).join(', '));
  const kept = jobs.filter(j => j.result && j.result.worktreeKept && fs.existsSync(j.result.worktreeKept));
  if (kept.length) L.push('kept worktrees:\n' + kept.map(j => `  ${j.id}: ${j.result.worktreeKept}`).join('\n'));
  L.push(checkpoint.summary(checkpoint.reconcile(projDir, jobs), jobs));
  return L.join('\n');
}

function skills(root, projDir, o) {
  const sub = o._.shift() || 'list';
  if (sub === 'list') {
    const inv = capabilities.scan(root), used = capabilities.usage(ledger.list(projDir));
    for (const p of ['codex', 'claude']) {
      const xs = inv.skills.filter(s => s.platform === p);
      console.log(`${p}: ${xs.length} skills`);
      for (const s of p === 'claude' ? xs.filter(s => s.scope !== 'plugin') : xs) {
        const u = used[s.name];
        console.log(`  ${s.name} [${s.trust}${s.ref ? ' ' + String(s.ref).slice(0, 12) : ''}${s.hasScripts ? ', scripts' : ''}${s.implicit ? '' : ', explicit only'}] ${(u ? `(${u.verified}/${u.jobs} verified${u.answered ? ', ' + u.answered + ' answers' : ''}) ` : '')}${s.description.slice(0, 90)}`);
      }
      if (p === 'claude') console.log(`  + ${xs.filter(s => s.scope === 'plugin').length} from enabled plugins`);
    }
    if (inv.dupes.length) console.log(`duplicates ignored: ${inv.dupes.length}`);
    return;
  }
  if (sub === 'verify') {
    const r = capabilities.verifyInstalled(root);
    console.log(r.map(x => `${x.ok ? 'ok  ' : 'FAIL'} ${x.name}${x.reason ? ': ' + x.reason : ''}`).join('\n') || 'no tandem-installed skills');
    process.exitCode = r.every(x => x.ok) ? 0 : 1;
    return;
  }
  if (sub === 'remove') { capabilities.uninstall(root, o._[0]); return console.log(`removed ${o._[0]}`); }
  if (sub === 'rollback') { const e = capabilities.rollback(root, o._[0]); return console.log(`${o._[0]} rolled back to ${e.ref || e.sha256.slice(0, 12)} (${e.source})`); }
  if (sub !== 'add' || !o._[0]) throw new Error('usage: tandem skills add <dir|git-url> [--ref SHA] [--path SUBDIR]');
  const src = o._[0];
  let dir = src, tmp = null, ref = null;
  if (/^(https:\/\/|ssh:\/\/|file:\/\/|git@)/.test(src)) {
    if (!/^[0-9a-f]{40}$/.test(o.ref || '')) throw new Error('a git source must be pinned: --ref <full 40-character commit sha>');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-skill-'));
    const git = (...a) => execFileSync('git', ['-c', 'core.symlinks=false', ...a], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    try {
      git('clone', '--quiet', '--no-checkout', '--', src, tmp);
      git('-C', tmp, 'checkout', '--quiet', '--detach', o.ref);
      if (git('-C', tmp, 'rev-parse', 'HEAD').toString().trim() !== o.ref) throw new Error('checked-out revision does not match --ref');
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('git fetch failed: ' + String(e.stderr || e.message).trim().slice(0, 300)); }
    dir = tmp; ref = o.ref;
  }
  if (o.path) {
    // Compare real paths: an absolute path, another drive, a UNC path or a link/junction must not lead outside the source.
    const base = fs.realpathSync(tmp || path.resolve(src));
    const target = path.resolve(base, o.path);
    let real = null;
    try { if (!fs.lstatSync(target).isSymbolicLink()) real = fs.realpathSync(target); } catch {}
    const rel = real && path.relative(base, real);
    if (path.isAbsolute(o.path) || rel === null || rel.startsWith('..') || path.isAbsolute(rel)) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('--path escapes the source (or is a link, or does not exist)');
    }
    dir = real;
  }
  try {
    const r = capabilities.install(root, path.resolve(dir), { source: src + (o.path ? '#' + o.path : ''), ref, allowScripts: !!o['allow-scripts'], force: !!o.force });
    console.log(`installed ${r.name} -> ${r.path} (${r.files} files, sha256 ${r.sha256.slice(0, 16)})${r.executable.length ? '\nWARNING: contains executable content Codex may run: ' + r.executable.join(', ') : ''}`);
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
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
  if (cmd === 'continue' && o.wait) {
    // Wait for the latest reset among time-limited jobs (so all of them are due), then continue.
    const until = Math.max(0, ...ledger.list(projDir).filter(j => ledger.RESUMABLE.has(j.status) && j.result && j.result.suspension && j.result.suspension.waitFor === 'time').map(j => j.result.suspension.until || 0));
    const ms = Math.min(until - Date.now(), 24 * 3600e3);
    if (ms > 0) {
      process.stderr.write(`waiting until ${new Date(Date.now() + ms).toLocaleString()} (Codex limit reset); Ctrl+C to stop\n`);
      await new Promise(r => setTimeout(r, ms + 1000));
    }
  }
  if (cmd === 'resume' || cmd === 'continue') {
    const jobs = ledger.list(projDir);
    const ids = cmd === 'continue' || o.due ? dueIds(jobs, o.now ? Infinity : Date.now()) : o.all ? jobs.filter(resumable).map(j => j.id) : o._;
    if (cmd === 'resume' && !ids.length && !o.due && !o.all) throw new Error('resume needs job ids, --due or --all');
    // Check every id first: nothing starts unless all of them can.
    for (const id of ids) {
      const j = jobs.find(x => x.id === id);
      if (!j || !ledger.RESUMABLE.has(j.status)) throw new Error(`${id} is ${j ? j.status : 'unknown'}; only suspended or interrupted jobs can be resumed`);
      if (!j.ceiling) throw new Error(`${id} has no recorded authorization ceilings (older Tandem); resume it from Claude Code: codex_jobs resume=${id}`);
    }
    // Dependencies first (lower ids), so a dependent queues behind its resumed dependency.
    const started = ids.sort((a, b) => seq(a) - seq(b)).map((id, i) => orch.resume(id, o.cwd, { now: !!o.now && i === 0 }));
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
  if (cmd === 'skills') return skills(root, projDir, o);
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch(e => { console.error('tandem: ' + e.message); process.exitCode = 1; });
