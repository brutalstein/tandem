#!/usr/bin/env node
'use strict';
// REAL provider check of suspend -> resume (spends a small amount of Codex quota; never run in CI).
// A job is stopped mid-turn as if the Claude session ended, then resumed: the resumed turn must
// continue the same Codex conversation in the same worktree and finish verified.
// Usage: node test/real-resume.js   (needs a logged-in Codex CLI)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-real-resume-'));
process.env.TANDEM_DATA = path.join(TMP, 'data');
const { Orchestrator } = require('../server/jobs');
const { config } = require('../server/config');

const dir = path.join(TMP, 'repo');
fs.mkdirSync(dir);
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
git('init', '-q');
fs.writeFileSync(path.join(dir, 'README.md'), 'demo\n');
git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

const check = `node -e "const f=require('fs');const ok=['a','b','c'].every(n=>f.existsSync(n+'.txt')&&f.readFileSync(n+'.txt','utf8').trim()===n);process.exit(ok?0:1)"`;
const spec = { cwd: dir, mode: 'implement', difficulty: 'trivial', isolation: 'worktree', paths: ['a.txt', 'b.txt', 'c.txt'], verify: check, max_attempts: 1,
  task: 'Create three files one at a time with separate shell commands, in this order: a.txt containing "a", then b.txt containing "b", then c.txt containing "c". Run `sleep 4` (or `Start-Sleep 4` on Windows) between files.' };

(async () => {
  const results = [];
  const ok = (name, cond, detail = '') => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`); };
  const o = new Orchestrator(config(), { onProgress: (id, m) => console.log(`  ${id} ${m}`) });
  const { job, promise } = o.submit(spec);
  // Stop once Codex has started working (first command), as if the session ended mid-turn.
  const t0 = Date.now();
  while (!(o.live.get(job.id) && o.live.get(job.id).child) && Date.now() - t0 < 120e3) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 15000));
  o.suspendAll('session_ended', 'real-provider resume check');
  const s = await promise;
  ok('stopped job is suspended (not cancelled)', s.status === 'suspended', s.status);
  const rf = (s.result && s.result.resumeFrom) || {};
  ok('Codex thread recorded for continuation', !!rf.threadId, rf.threadId || 'none (stopped before the thread started)');
  const wt = rf.worktree && rf.worktree.path;
  ok('worktree kept', wt && fs.existsSync(wt));
  console.log('  partial files at stop:', wt ? ['a', 'b', 'c'].filter(n => fs.existsSync(path.join(wt, n + '.txt'))).join(',') || 'none' : '-');

  const r = await new Orchestrator(config()).resume(job.id, dir).promise;
  ok('resumed job finishes verified', r.status === 'verified', r.status + (r.result && r.result.error ? ' ' + r.result.error : ''));
  const last = r.attempts.filter(a => !a.before).at(-1) || {};
  ok('resumed attempt continued the Codex conversation', last.resumed === true, JSON.stringify({ model: last.model, effort: last.effort, resumed: last.resumed }));
  ok('result integrated into the project', ['a', 'b', 'c'].every(n => fs.existsSync(path.join(dir, n + '.txt'))));
  const u = (s.result.usage || {}), u2 = (r.result.usage || {});
  console.log(`  tokens: first run in ${u.input || 0} (cached ${u.cached || 0}) out ${u.output || 0}; resumed run in ${u2.input || 0} (cached ${u2.cached || 0}) out ${u2.output || 0}`);
  console.log(`${results.filter(x => x[1]).length}/${results.length} checks passed`);
  process.exitCode = results.every(x => x[1]) ? 0 : 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
