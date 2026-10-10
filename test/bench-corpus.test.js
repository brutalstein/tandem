'use strict';
// Grader validation for every benchmark task (no provider calls): the untouched fixture fails, the reference
// solution passes, tampering with a protected test file fails, and a read-only task's wrong answer fails.
// Without this, a benchmark could report "success" for a grader that cannot fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TASKS, writeRepo, grade } = require('../bench/tasks');
const { SOLUTIONS } = require('../bench/solutions');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-corpus-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const fresh = (name, i) => { const d = path.join(base, `${name}-${i}`); writeRepo(d, TASKS[name]); return d; };
const put = (dir, files) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); } };

test('corpus covers the required categories with 15–25 tasks, each with a reference', () => {
  const names = Object.keys(TASKS);
  assert.ok(names.length >= 15 && names.length <= 25, `${names.length} tasks`);
  const cats = new Set(names.map(n => TASKS[n].category));
  for (const c of ['trivial', 'debugging', 'multi-file', 'refactoring', 'api-compat', 'security', 'async', 'build', 'review', 'architecture', 'navigation', 'dependency', 'negative'])
    assert.ok(cats.has(c), `category ${c}`);
  for (const n of names) {
    assert.ok(SOLUTIONS[n], `reference for ${n}`);
    if (TASKS[n].mode === 'implement') { assert.ok(TASKS[n].tests.length && TASKS[n].verify, n); assert.ok(TASKS[n].task.includes('Do not modify the tests'), n); }
  }
  assert.ok(names.filter(n => TASKS[n].hidden).length >= 10, 'most implement tasks have hidden tests');
});

for (const [name, t] of Object.entries(TASKS)) {
  test(`grader: ${name} (${t.category}, ${t.mode})`, () => {
    const ref = SOLUTIONS[name];
    if (t.mode !== 'implement') {
      assert.equal(grade(t, null, ref.good).ok, true, 'reference answer passes');
      assert.equal(grade(t, null, ref.bad).ok, false, 'wrong answer fails');
      assert.equal(grade(t, null, '').ok, false, 'empty answer fails');
      return;
    }
    const untouched = grade(t, fresh(name, 0));
    assert.equal(untouched.ok, false, 'the fixture as given must fail');
    const solved = fresh(name, 1); put(solved, ref.files);
    const g = grade(t, solved);
    assert.deepEqual(g, { ok: true, testsPass: true, hiddenPass: t.hidden ? true : null, tampered: [] }, 'reference passes visible and hidden tests');
    // Gaming: replace the visible test with one that always passes, on top of the reference.
    const gamed = fresh(name, 2); put(gamed, ref.files);
    const visible = t.tests.find(f => /\.test\.js$/.test(f));
    fs.writeFileSync(path.join(gamed, visible), "require('node:test')('ok', () => {});\n");
    const gg = grade(t, gamed);
    assert.equal(gg.ok, false); assert.deepEqual(gg.tampered, [visible]);
  });
}

test('hidden tests catch a fix that only satisfies the visible tests', () => {
  // duration: handle decimals but not the "no unit throws" rule from the task text.
  const d = fresh('debug-duration', 3);
  put(d, { 'src/duration.js': "'use strict';\nconst MULT = { h: 3600, m: 60, s: 1 };\nmodule.exports = s => [...String(s).matchAll(/([\\d.]+)([hms])/g)].reduce((t, [, n, u]) => t + Number(n) * MULT[u], 0);\n" });
  assert.deepEqual(grade(TASKS['debug-duration'], d), { ok: false, testsPass: true, hiddenPass: false, tampered: [] });
  // build: expose every file instead of the one subpath.
  const b = fresh('build-exports', 3);
  put(b, { 'package.json': JSON.stringify({ name: 'mathlib', private: true, exports: { '.': './index.js', './*': './src/*.js' } }) });
  assert.equal(grade(TASKS['build-exports'], b).hiddenPass, false);
});
