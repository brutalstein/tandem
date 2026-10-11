'use strict';
// File localization (server/locate.js): each signal ranks the right file first in a small repository, for a
// working tree and for a commit. Accuracy on real issues is measured by bench/locate-eval.js, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../server/locate');

const files = {
  'src/http/client.py': 'class HttpClient:\n    def send_request(self, url):\n        return retry_policy(url)\n',
  'src/http/retry.py': 'def retry_policy(url):\n    """Back off and retry a failed request."""\n    return url\n',
  'src/db/query.py': 'class QuerySet:\n    def filter(self, **kw):\n        return self\n    def order_by(self, *f):\n        return self\n',
  'src/db/models/fields.py': 'class CharField:\n    max_length = 255\n',
  'tests/test_query.py': 'from src.db.query import QuerySet\ndef test_order_by():\n    QuerySet().order_by("x")\n    QuerySet().order_by("y")\n',
  'docs/query.rst': 'QuerySet order_by filter order_by order_by\n',
  'web/parse.ts': 'export function parseConfig(s: string) { return JSON.parse(s); }\n',
  'web/app.ts': 'import { parseConfig } from "./parse";\nparseConfig("{}");\nparseConfig("[]");\n',
  '.gitignore': 'build/\n',
  'build/out.py': 'def retry_policy(): pass\n',
  'logo.bin': Buffer.from([0, 1, 2, 0, 3]),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-locate-'));
for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
fs.writeFileSync(path.join(dir, 'src', 'http', 'untracked_cache.py'), 'def cache_lookup(key):\n    return key\n');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const top = (task, k = 1) => L.locate(task, { cwd: dir }, k).map(r => r.path);

test('a path named in the task ranks first', () => {
  assert.deepEqual(top('Crash in http/retry.py when the url is empty'), ['src/http/retry.py']);
});

test('a dotted module name resolves to its file', () => {
  assert.deepEqual(top('Importing src.db.models.fields.CharField fails on Python 3.12'), ['src/db/models/fields.py']);
});

test('the file that defines a named identifier outranks files that only use it, in any language', () => {
  assert.deepEqual(top('`retry_policy` ignores the timeout'), ['src/http/retry.py']);
  assert.deepEqual(top('QuerySet.order_by() drops the previous ordering'), ['src/db/query.py']);
  assert.deepEqual(top('parseConfig() throws on an empty string'), ['web/parse.ts']);
});

test('source outranks tests and docs that mention the same words more often', () => {
  assert.equal(top('order_by on a QuerySet loses ordering')[0], 'src/db/query.py');
});

test('plain-language tasks rank by content; stop words alone match nothing', () => {
  assert.equal(top('requests are not retried with back off')[0], 'src/http/retry.py');
  assert.deepEqual(L.locate('it should work the same as before', { cwd: dir }), []);
});

test('untracked files count, ignored and binary files do not', () => {
  assert.equal(top('cache_lookup returns stale keys')[0], 'src/http/untracked_cache.py');
  assert.ok(!L.locate('retry_policy', { cwd: dir }, 20).some(r => r.path.startsWith('build/') || r.path === 'logo.bin'));
});

test('a commit can be ranked without a checkout; a missing repository gives an empty list', () => {
  const head = git('rev-parse', 'HEAD').trim();
  assert.equal(L.locate('`retry_policy` ignores the timeout', { gitDir: path.join(dir, '.git'), tree: head }, 1)[0].path, 'src/http/retry.py');
  assert.ok(!L.locate('cache_lookup', { gitDir: path.join(dir, '.git'), tree: head }, 20).some(r => r.path.includes('untracked')));
  assert.deepEqual(L.locate('retry_policy', { cwd: path.join(dir, 'missing') }), []);
});

test('identifier splitting covers camel and snake case', () => {
  assert.deepEqual(L.parts('HttpClient'), ['httpclient', 'http', 'client']);
  assert.deepEqual(L.parts('send_request'), ['send_request', 'send', 'request']);
  assert.deepEqual(L.parts('URLParser'), ['urlparser', 'url', 'parser']);
});

test('worker prompts name the likely files inside the job scope, and the job records them; off when disabled', async () => {
  const H = require('./helpers');
  const { Orchestrator } = require('../server/jobs');
  H.resetEnv();
  const repo = H.repo({ default: { action: 'ok' } }, { 'src/parser.js': 'function parseConfig(s) { return s; }\n', 'lib/use.js': 'parseConfig("a");\nparseConfig("b");\n' });
  const o = new Orchestrator({ ...H.CFG, locateHints: true });
  const j = await o.submit({ cwd: repo, task: 'parseConfig() throws on empty input', mode: 'ask', difficulty: 'trivial' }).promise;
  assert.match(H.calls(repo)[0].prompt, /LIKELY RELEVANT FILES[^\n]*\n- src\/parser\.js \(defines parseConfig\)\n- lib\/use\.js/);
  assert.deepEqual(j.located, ['src/parser.js', 'lib/use.js']);
  await o.submit({ cwd: repo, task: 'parseConfig() throws on empty input', mode: 'implement', difficulty: 'trivial', paths: ['lib'], verify: 'none' }).promise;
  assert.match(H.calls(repo)[1].prompt, /LIKELY RELEVANT FILES[^\n]*\n- lib\/use\.js\n(?!- )/, 'only files inside the scope');
  await new Orchestrator({ ...H.CFG, locateHints: false }).submit({ cwd: repo, task: 'parseConfig() throws on empty input', mode: 'ask', difficulty: 'trivial' }).promise;
  assert.doesNotMatch(H.calls(repo)[2].prompt, /LIKELY RELEVANT FILES/);
});
