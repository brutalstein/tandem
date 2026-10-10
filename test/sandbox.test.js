'use strict';
// Adversarial checks of the REAL verification sandbox (`codex sandbox`; needs the Codex CLI, no login, no quota).
// Every probe runs in disposable directories made here; secrets are canaries, never real credentials.
// Not part of `npm test` (which uses the fake Codex): run `node --test test/sandbox.test.js`; CI runs it with a
// pinned Codex CLI. Without a Codex CLI it skips; where the OS sandbox cannot start it proves the fail-safe instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const REQUIRE = !!process.env.TANDEM_TEST_REQUIRE_SANDBOX; // CI: this platform must provide the sandbox
for (const k of Object.keys(process.env)) if (/^TANDEM_/.test(k)) delete process.env[k];
const verify = require('../server/verify');
const { codexCommand } = require('../server/codex');

const IS_WIN = process.platform === 'win32';
// Not under the temp folder: the sandbox lets checks write there by design, so "outside" must be elsewhere.
// A fixed location: on Windows each new deny path makes Codex refresh sandbox ACLs over the home folder.
const ROOT = path.join(__dirname, '.sbx');
const WS = path.join(ROOT, 'ws'), OUTSIDE = path.join(ROOT, 'outside'), SECRET = path.join(ROOT, 'secret');
const opts = { verifyIsolation: 'sandbox', verifyDenyPaths: [SECRET] };
const q = JSON.stringify;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true }); fs.mkdirSync(OUTSIDE); fs.mkdirSync(SECRET);
fs.writeFileSync(path.join(SECRET, 'token.txt'), 'canary-secret');
fs.writeFileSync(path.join(OUTSIDE, 'unrelated.txt'), 'original');
require('child_process').execFileSync('git', ['init', '-q', WS]);
fs.symlinkSync(OUTSIDE, path.join(WS, 'link-out'), IS_WIN ? 'junction' : 'dir');
fs.writeFileSync(path.join(WS, 'probe.js'), `
const fs = require('fs'), net = require('net'), cp = require('child_process'), r = {};
const can = (k, f) => { try { f(); r[k] = 'ALLOWED'; } catch (e) { r[k] = 'denied'; } };
can('readSecret', () => fs.readFileSync(${q(path.join(SECRET, 'token.txt'))}));
can('writeSecret', () => fs.writeFileSync(${q(path.join(SECRET, 'pwn.txt'))}, 'x'));
can('modifyUnrelated', () => fs.writeFileSync(${q(path.join(OUTSIDE, 'unrelated.txt'))}, 'pwned'));
can('writeViaLink', () => fs.writeFileSync('link-out/via-link.txt', 'x'));
can('writeGitConfig', () => fs.appendFileSync('.git/config', '\\n'));
can('writeInside', () => fs.writeFileSync('inside.txt', 'x'));
r.envSecret = process.env.TANDEM_TEST_SECRET ? 'VISIBLE' : 'absent';
// A process that tries to outlive the check and act after it is over.
cp.spawn(process.execPath, ['-e', 'setTimeout(() => { try { require("fs").writeFileSync(' + ${q(q(path.join(OUTSIDE, 'late.txt')))} + ', "x"); } catch {} require("fs").writeFileSync("survivor.txt", "alive"); }, 3000)'],
  { detached: true, stdio: 'ignore' }).unref();
const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 4000 });
const done = v => { r.network = v; console.log('PROBE ' + JSON.stringify(r)); };
s.on('connect', () => { s.destroy(); done('ALLOWED'); }); s.on('error', () => done('denied')); s.on('timeout', () => { s.destroy(); done('denied'); });
`);

const bin = codexCommand();
// sandbox: every denied path is unreadable inside. contain: the sandbox runs but some denied path is readable
// (measured on Windows); the remaining guarantees are still tested. null: the sandbox does not start.
let mode = null, why = '';
test.before(async () => {
  if (!bin) return;
  const r = await verify.run('node -e "process.exit(0)"', WS, 900000, opts); // first use may set the sandbox up
  if (r.isolation === 'sandbox' && r.ok) mode = 'sandbox';
  else {
    why = r.tail;
    const c = await verify.run('node -e "process.exit(0)"', WS, 900000, { ...opts, verifyIsolation: 'contain' });
    if (c.isolation === 'contain' && c.ok) mode = 'contain';
  }
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const using = () => ({ ...opts, verifyIsolation: mode });

test('fail-safe: unless every guarantee holds, a check is not run under the default setting', { skip: !bin && 'Codex CLI not installed' }, async t => {
  if (mode === 'sandbox') return t.skip('full sandbox available here; the fail-safe is covered with simulated failures in the orchestrator tests');
  assert.ok(!REQUIRE, 'the full sandbox is required on this platform but not usable: ' + why);
  const marker = path.join(WS, 'ran.txt');
  const r = await verify.run(`node -e "require('fs').writeFileSync(${q(marker).replace(/"/g, "'")}, 'x')"`, WS, 60000, opts);
  assert.equal(r.isolation, 'unavailable');
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(marker), 'the check never ran');
  assert.match(verify.environmentFailure(r), /not run because the verification sandbox is not usable/);
  t.diagnostic('default setting refuses: ' + r.tail);
});

test('exit status and shell syntax pass through the sandbox unchanged', { skip: !bin && 'Codex CLI not installed' }, async t => {
  if (!mode) return t.skip('sandbox does not start: ' + why);
  const fail = await verify.run('node -e "process.exit(7)"', WS, 60000, using());
  assert.equal(fail.code, 7); assert.equal(fail.ok, false); assert.equal(fail.isolation, mode);
  const chain = await verify.run('node -e "console.log(\'a b\')" && node -e "process.exit(3)" && node -e "process.exit(0)"', WS, 60000, using());
  assert.equal(chain.code, 3, '&& short-circuits on failure');
  assert.match(chain.tail, /a b/);
});

test('adversarial check: no secret reads, no writes outside the workspace, no network, no inherited secrets, no escape through links', { skip: !bin && 'Codex CLI not installed' }, async t => {
  if (!mode) return t.skip('sandbox does not start: ' + why);
  process.env.TANDEM_TEST_SECRET = 'canary-env';
  let r;
  try { r = await verify.run('node probe.js', WS, 120000, using()); } finally { delete process.env.TANDEM_TEST_SECRET; }
  const line = /PROBE (.*)/.exec(r.tail);
  assert.ok(line, 'probe output: ' + r.tail);
  const got = JSON.parse(line[1]);
  t.diagnostic(`isolation ${mode}: ${JSON.stringify(got)}`);
  // Under `contain` Tandem itself measured that some denied path is readable, so a readable canary is expected.
  assert.deepEqual({ ...got, readSecret: mode === 'contain' ? 'n/a' : got.readSecret }, {
    readSecret: mode === 'contain' ? 'n/a' : 'denied', writeSecret: 'denied', modifyUnrelated: 'denied', writeViaLink: 'denied', writeGitConfig: 'denied',
    writeInside: 'ALLOWED', envSecret: 'absent', network: 'denied',
  });
  assert.equal(fs.readFileSync(path.join(OUTSIDE, 'unrelated.txt'), 'utf8'), 'original');
  // A process that outlives the check stays inside the same sandbox: it cannot write outside either.
  await new Promise(res => setTimeout(res, 5000));
  assert.ok(!fs.existsSync(path.join(OUTSIDE, 'late.txt')), 'a surviving process could not write outside the workspace');
  t.diagnostic('process outliving the check: ' + (fs.existsSync(path.join(WS, 'survivor.txt')) ? 'survived (confined)' : 'killed'));
});

test('a hung check is killed at its timeout', { skip: !bin && 'Codex CLI not installed' }, async t => {
  if (!mode) return t.skip('sandbox does not start: ' + why);
  const started = Date.now();
  const r = await verify.run('node -e "setInterval(() => {}, 1000)"', WS, 3000, using());
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
});

// Regression guard for a damaged development machine: an interrupted Codex permission refresh once left
// "deny read" entries for the Codex sandbox users on the home folder that Codex no longer tracked, making most of
// the home folder unreadable to every later sandboxed command. Reads ACL metadata only.
test('Windows: no untracked Codex sandbox read-deny entries on the home folder or its direct children', { skip: !IS_WIN && 'Windows only' }, t => {
  const os = require('os');
  const ps = "$ErrorActionPreference='SilentlyContinue'; $s=(New-Object Security.Principal.NTAccount 'CodexSandboxUsers').Translate([Security.Principal.SecurityIdentifier]).Value;"
    + " if(!$s){'{}';exit}; $h=$env:USERPROFILE; $l=@($h)+@(Get-ChildItem -LiteralPath $h -Force -Directory | % FullName);"
    + " @{sid=$s; acl=@($l | % { @{p=$_; d=(Get-Acl -LiteralPath $_).Sddl} })} | ConvertTo-Json -Depth 4 -Compress";
  const out = JSON.parse(require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }) || '{}');
  if (!out.sid) return t.skip('Codex Windows sandbox not set up on this machine');
  let tracked = [];
  try { tracked = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', '.sandbox', 'deny_read_acl_state.json'), 'utf8')).principals[out.sid] || []; } catch {}
  const norm = p => path.resolve(p).toLowerCase();
  const known = new Set(tracked.map(norm));
  // Explicit (non-inherited) deny ACEs for the sandbox group that include read access.
  const readDeny = new RegExp(`\(D;(?![^;]*ID)[^;]*;(FR|FA|GR|GA|0x[0-9A-Fa-f]+);;;${out.sid}\)`, 'g');
  const isRead = r => !/^0x/.test(r) || (parseInt(r, 16) & 0x80000001) !== 0;
  const stale = [].concat(out.acl || []).filter(a => [...String(a.d).matchAll(readDeny)].some(m => isRead(m[1])) && !known.has(norm(a.p))).map(a => a.p);
  assert.deepEqual(stale, [], 'untracked read-deny entries for CodexSandboxUsers (see docs/VERIFICATION.md, "Stale sandbox ACLs"): ' + stale.join(', '));
});
