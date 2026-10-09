'use strict';
// Skill discovery, selection, and explicit pinned installs. Discovery reads only the fixture home
// (TANDEM_HOME, set by helpers), never the developer's real skills.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cap = require('../server/capabilities');
const { Orchestrator } = require('../server/jobs');

const HOME = process.env.TANDEM_HOME;
const skill = (dir, fm, extra = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n\nBody.\n`);
  for (const [p, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
};
const SK = path.join(HOME, '.agents', 'skills');
skill(path.join(SK, 'pytest-fixer'), 'name: pytest-fixer\ndescription: >\n  Diagnose and fix failing pytest tests, flaky fixtures\n  and assertion errors in Python projects.');
skill(path.join(process.env.CODEX_HOME, 'skills', 'pytest-fixer'), 'name: pytest-fixer\ndescription: >\n  Diagnose and fix failing pytest tests, flaky fixtures\n  and assertion errors in Python projects.');
skill(path.join(SK, 'pdf-reports'), 'name: pdf-reports\ndescription: "Generate PDF reports with charts and tables from data"');
skill(path.join(SK, 'sql-migrations'), 'name: sql-migrations\ndescription: Write safe SQL schema migrations with rollback for PostgreSQL databases');
skill(path.join(SK, 'release-notes'), 'name: release-notes\ndescription: Draft release notes and changelog entries from git history');
skill(path.join(SK, 'react-components'), 'name: react-components\ndescription: |\n  Build accessible React components\n  with TypeScript props and tests');
skill(path.join(SK, 'deploy-prod'), 'name: deploy-prod\ndescription: Deploy the service to production Kubernetes clusters', { 'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n' });
skill(path.join(HOME, '.claude', 'skills', 'claude-only'), 'name: claude-only\ndescription: Fix failing pytest tests the Claude way\ndisable-model-invocation: true');

test('skill effectiveness never counts an unverified answer as a verified change', () => {
  const u = cap.usage([
    { skills: ['pytest-fixer'], status: 'answered' },
    { skills: ['pytest-fixer'], status: 'verified' },
    { skills: ['pytest-fixer'], status: 'unverified' },
  ]);
  assert.deepEqual(u['pytest-fixer'], { jobs: 3, verified: 1, answered: 1 });
});

test('front matter: plain, quoted, folded and literal values', () => {
  assert.deepEqual(cap.frontMatter('---\na: x\nb: "q: v"\nc: >\n  one\n  two\nd: |\n  l1\n  l2\n---\n'), { a: 'x', b: 'q: v', c: 'one two', d: 'l1\nl2' });
  assert.deepEqual(cap.frontMatter('no front matter'), {});
});

test('scan: official locations, deduplicated, invocation policy respected', () => {
  const { skills, dupes } = cap.scan(H.repo());
  const codex = skills.filter(s => s.platform === 'codex').map(s => s.name).sort();
  assert.deepEqual(codex, ['deploy-prod', 'pdf-reports', 'pytest-fixer', 'react-components', 'release-notes', 'sql-migrations']);
  assert.deepEqual(dupes, ['pytest-fixer (user)'], 'same skill under ~/.agents and ~/.codex counted once');
  assert.equal(skills.find(s => s.name === 'deploy-prod').implicit, false);
  assert.equal(skills.find(s => s.name === 'claude-only').implicit, false);
});

test('select: only clear matches, at most 3, never explicit-only or Claude-only skills (labelled set)', () => {
  const { skills } = cap.scan(H.repo());
  const cases = [
    ['Fix the failing pytest tests in tests/test_parser.py', ['pytest-fixer']],
    ['Generate a monthly PDF report with charts of signups', ['pdf-reports']],
    ['Add a SQL migration adding an index to the orders table in PostgreSQL', ['sql-migrations']],
    ['Draft the release notes for v2 from the git history', ['release-notes']],
    ['Build an accessible React date picker component', ['react-components']],
    ['Deploy the service to production', []], // explicit-only skill is never suggested
    ['Rename variable x to y in utils.js', []],
    ['Fix the off-by-one error in the tokenizer', []],
  ];
  let tp = 0, fp = 0, fn = 0;
  for (const [q, want] of cases) {
    const got = cap.select(q, skills).map(s => s.name);
    tp += got.filter(g => want.includes(g)).length; fp += got.filter(g => !want.includes(g)).length; fn += want.filter(w => !got.includes(w)).length;
    assert.deepEqual(got, want, q);
  }
  assert.deepEqual({ tp, fp, fn }, { tp: 5, fp: 0, fn: 0 });
});

test('worker prompt points at matching skills only (lean mode), and the job records which', async () => {
  H.resetEnv();
  const dir = H.repo({ default: { action: 'ok' } });
  const o = new Orchestrator({ ...H.CFG });
  const j = await o.submit({ cwd: dir, task: 'Fix the failing pytest tests in tests/test_parser.py', mode: 'ask', difficulty: 'trivial' }).promise;
  assert.match(H.calls(dir)[0].prompt, /INSTALLED SKILLS[\s\S]*pytest-fixer/);
  assert.deepEqual(j.skills, ['pytest-fixer']);
  await o.submit({ cwd: dir, task: 'What does main.js do?', mode: 'ask', difficulty: 'trivial' }).promise;
  assert.doesNotMatch(H.calls(dir)[1].prompt, /INSTALLED SKILLS/);
});

test('install: project-local, pinned, scripts need consent, tamper detected, rollback and removal', () => {
  const root = H.repo();
  const src = path.join(H.TMP, 'src-skill');
  skill(src, 'name: lint-fixer\ndescription: Fix lint errors', { 'scripts/run.sh': 'echo hi' });
  assert.throws(() => cap.install(root, src, { source: src }), /executable content/);
  const r1 = cap.install(root, src, { source: src, allowScripts: true });
  assert.equal(r1.path, path.join(root, '.agents', 'skills', 'lint-fixer'));
  assert.ok(cap.scan(root).skills.find(s => s.name === 'lint-fixer' && s.trust === 'pinned'));
  assert.throws(() => cap.install(root, src, { source: src, allowScripts: true }), /--force/);
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: lint-fixer\ndescription: Fix lint errors v2\n---\n');
  const r2 = cap.install(root, src, { source: src, allowScripts: true, force: true });
  assert.notEqual(r2.sha256, r1.sha256);
  assert.deepEqual(cap.verifyInstalled(root), [{ name: 'lint-fixer', ok: true, reason: null }]);
  fs.appendFileSync(path.join(r2.path, 'SKILL.md'), 'tampered');
  assert.equal(cap.verifyInstalled(root)[0].ok, false);
  assert.equal(cap.rollback(root, 'lint-fixer').sha256, r1.sha256);
  assert.match(fs.readFileSync(path.join(r2.path, 'SKILL.md'), 'utf8'), /description: Fix lint errors\n/);
  assert.equal(cap.verifyInstalled(root)[0].ok, true);
  // A directory tandem did not install is never overwritten or removed.
  skill(path.join(root, '.agents', 'skills', 'mine'), 'name: mine\ndescription: user skill');
  const other = path.join(H.TMP, 'other'); skill(other, 'name: mine\ndescription: imposter');
  assert.throws(() => cap.install(root, other, { source: other, force: true }), /not installed by tandem/);
  assert.throws(() => cap.uninstall(root, 'mine'), /not installed by tandem/);
  cap.uninstall(root, 'lint-fixer');
  assert.ok(!fs.existsSync(r2.path));
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'mine')));
});

test('skill lock survives corruption through the last good backup; double corruption fails closed', () => {
  const root = H.repo();
  const src = path.join(H.TMP, 'lock-recovery-skill');
  skill(src, 'name: checkpoint-skill\ndescription: Safely checkpoint changes');
  const first = cap.install(root, src, { source: src });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: checkpoint-skill\ndescription: Safely checkpoint changes v2\n---\n');
  cap.install(root, src, { source: src, force: true });
  const lockPath = path.join(root, '.agents', 'skills', 'tandem-lock.json');
  assert.ok(fs.existsSync(lockPath + '.bak'), 'atomic updates retain a last good registry');
  fs.writeFileSync(lockPath, '{broken');
  assert.equal(cap.readLock(root)['checkpoint-skill'].sha256, first.sha256, 'backup can be recovered');
  fs.writeFileSync(lockPath + '.bak', '{broken too');
  assert.throws(() => cap.readLock(root), /corrupt/);
  assert.throws(() => cap.uninstall(root, 'checkpoint-skill'), /corrupt/);
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'checkpoint-skill')), 'corrupt metadata never deletes user files');
});

test('concurrent skill installs cannot corrupt the registry or overwrite a different process', async () => {
  const root = H.repo();
  const src = path.join(H.TMP, 'concurrent-skill');
  skill(src, 'name: one-owner\ndescription: Single-owner skill installation');
  const js = [
    'const c=require(' + JSON.stringify(path.join(H.ROOT, 'server', 'capabilities.js')) + ');',
    'try { c.install(' + JSON.stringify(root) + ',' + JSON.stringify(src) + ',{source:"fixture"}); process.exit(0); }',
    'catch (e) { if (/--force/.test(e.message)) process.exit(2); console.error(e); process.exit(3); }',
  ].join('\n');
  const spawn = require('child_process').spawn;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', js], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }));
  const codes = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  })));
  assert.deepEqual(codes.map(x => x.code).sort(), [0, 2, 2, 2], JSON.stringify(codes));
  assert.deepEqual(cap.verifyInstalled(root), [{ name: 'one-owner', ok: true, reason: null }]);
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'tandem-lock.json.lock')), false);
});

test('CLI: a git source must be pinned to a commit and is fetched at exactly that commit', () => {
  const root = H.repo();
  const srcRepo = H.repo(null, { 'skills/hello/SKILL.md': '---\nname: hello\ndescription: Say hello politely\n---\n' });
  const sha = H.git(srcRepo, 'rev-parse', 'HEAD');
  const url = 'file://' + srcRepo.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');
  const cli = (...a) => spawnSync(process.execPath, [path.join(H.ROOT, 'bin', 'tandem.js'), 'skills', ...a, '--cwd', root], { encoding: 'utf8' });
  assert.match(cli('add', url).stderr, /must be pinned/);
  const ok = cli('add', url, '--ref', sha, '--path', 'skills/hello');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(cap.readLock(root).hello.ref, sha);
  assert.match(cli('add', url, '--ref', sha, '--path', '../..').stderr, /escapes/);
  assert.match(cli('verify').stdout, /ok\s+hello/);
});

test('review: lock entries from the repository cannot name paths, and inherited names do not count as installed', () => {
  const root = H.repo();
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'constructor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'tandem-lock.json'), JSON.stringify({ v: 1, skills: { '../../src': { sha256: 'x' }, 'constructor': undefined } }));
  H.write(root, { 'src/keep.txt': 'precious' });
  assert.deepEqual(Object.keys(cap.readLock(root)), []);
  assert.throws(() => cap.uninstall(root, '../../src'), /unsafe skill name/);
  assert.throws(() => cap.rollback(root, '../../src'), /unsafe skill name/);
  assert.equal(H.read(root, 'src/keep.txt'), 'precious');
  const imp = path.join(H.TMP, 'ctor'); skill(imp, 'name: constructor\ndescription: imposter');
  assert.throws(() => cap.install(root, imp, { source: imp, force: true }), /not installed by tandem/);
});

test('review CLI: --path cannot leave the source (absolute, other drive, ..)', () => {
  const root = H.repo();
  const src = path.join(H.TMP, 'pathsrc'); skill(path.join(src, 'inner'), 'name: inner\ndescription: inner skill');
  const outside = path.join(H.TMP, 'outside'); skill(outside, 'name: outside\ndescription: outside skill');
  const cli = (...a) => spawnSync(process.execPath, [path.join(H.ROOT, 'bin', 'tandem.js'), 'skills', ...a, '--cwd', root], { encoding: 'utf8' });
  const srcRepo = H.repo(null, { 'x/SKILL.md': '---\nname: x\ndescription: x skill\n---\n' });
  const url = 'file://' + srcRepo.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');
  const sha = H.git(srcRepo, 'rev-parse', 'HEAD');
  for (const p of [outside, '../outside', '..']) assert.match(cli('add', url, '--ref', sha, '--path', p).stderr, /escapes/, p);
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'skills', 'outside')));
});
