'use strict';
// Whole-strategy decision (server/strategy.js): rejects unnecessary delegation, prefers tools and the simpler
// strategy on ties, delegates checked work when the measured Codex cost is low against a large Claude-side cost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../server/strategy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-strat-'));
fs.writeFileSync(path.join(dir, 'tiny.js'), 'module.exports = 1;\n');
fs.mkdirSync(path.join(dir, 'big'));
for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'big', `m${i}.js`), 'x'.repeat(12000));
fs.mkdirSync(path.join(dir, 'big', 'node_modules')); fs.writeFileSync(path.join(dir, 'big', 'node_modules', 'huge.js'), 'x'.repeat(1e6));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const cfg = { claudeCostWeight: 1 };

test('locate questions go to a search tool, judgement questions do not', () => {
  for (const q of ['Where is parseConfig defined?', 'which files import lodash', 'find all callers of retry()', 'List every usage of APP_PORT'])
    assert.equal(S.decide({ mode: 'ask', difficulty: 'trivial', prompt: q }, dir, { tokens: 20000, nObs: 0 }, cfg).strategy, 'tool', q);
  for (const q of ['Where is the bug in parseConfig?', 'Explain how retry works', 'which files should own validation', 'What is the default port?'])
    assert.notEqual(S.decide({ mode: 'ask', difficulty: 'trivial', prompt: q }, dir, { tokens: 20000, nObs: 0 }, cfg).strategy, 'tool', q);
  assert.notEqual(S.decide({ mode: 'implement', difficulty: 'trivial', prompt: 'where is x' }, dir, { tokens: 20000, nObs: 0 }, cfg).strategy, 'tool');
});

test('context size is measured from the scoped files, skipping dependency folders', () => {
  assert.deepEqual(S.contextSize(dir, ['big']), { tokens: 36000, files: 12 });
  assert.equal(S.contextSize(dir, []), null);
  assert.equal(S.contextSize(dir, ['missing.js']), null, 'a file that does not exist yet has an unknown size, not size 0');
});

test('a small edit stays with Claude: delegation overhead exceeds the work', () => {
  const r = S.decide({ mode: 'implement', difficulty: 'trivial', prompt: 'rename the export', paths: ['tiny.js'], verify: 'npm test' }, dir, { tokens: 9400, nObs: 5 }, cfg);
  assert.equal(r.strategy, 'claude');
  assert.match(r.why[0], /estimated claude ≈ \d+k vs codex ≈ \d+k/);
});

test('large checked work goes to Codex when Claude tokens are scarcer and Codex cost is measured low', () => {
  const t = { mode: 'implement', difficulty: 'normal', prompt: 'implement the parser per spec', paths: ['big'], verify: 'npm test' };
  const r = S.decide(t, dir, { tokens: 20000, nObs: 6 }, { claudeCostWeight: 4 });
  assert.equal(r.strategy, 'codex', JSON.stringify(r));
  assert.equal(r.review, 'the passing check');
  // Same task, equal weights and an expensive, unmeasured Codex side: not worth delegating.
  assert.equal(S.decide(t, dir, { tokens: 90000, nObs: 0 }, cfg).strategy, 'claude');
});

test('ties go to the simpler strategy and are reported', () => {
  const t = { mode: 'implement', difficulty: 'normal', prompt: 'p', paths: ['big'], verify: 'npm test' };
  // Find a Codex cost whose estimate lands just under Claude's (within 25 %).
  const claude = S.decide(t, dir, { tokens: 1e9, nObs: 6 }, cfg).options.claude, mid = ([a, b]) => Math.sqrt(a * b);
  let tokens = 1000;
  while (mid(S.decide(t, dir, { tokens, nObs: 6 }, cfg).options.codex) < mid(claude) * 0.9) tokens += 500;
  const r = S.decide(t, dir, { tokens, nObs: 6 }, cfg);
  assert.ok(mid(r.options.codex) < mid(r.options.claude) && mid(r.options.codex) * 1.25 >= mid(r.options.claude));
  assert.equal(r.strategy, 'claude');
  assert.match(r.why.join(' '), /simpler strategy wins the tie/);
  assert.equal(r.uncertain, true);
});

test('without a size estimate the scoping rule applies; without Codex, Claude', () => {
  const none = (difficulty, verify) => S.decide({ mode: 'implement', difficulty, prompt: 'p', verify }, dir, { tokens: 20000, nObs: 0 }, cfg);
  assert.equal(none('trivial', 'npm test').strategy, 'claude');
  assert.equal(none('normal', 'npm test').strategy, 'codex');
  assert.equal(none('normal', null).strategy, 'claude');
  assert.ok(none('normal', 'npm test').unknown.some(u => /task size/.test(u)));
  // New-file work used to be measured as 0 tokens and sent to Claude; it now gets the scoping rule.
  const fresh = S.decide({ mode: 'implement', difficulty: 'hard', prompt: 'p', paths: ['src/auth/new-oauth.js'], verify: 'npm test' }, dir, { tokens: 40000, nObs: 5 }, cfg);
  assert.equal(fresh.size, undefined);
  assert.ok(fresh.unknown.some(u => /task size/.test(u)));
  assert.equal(S.decide({ mode: 'implement', difficulty: 'hard', prompt: 'p', paths: ['big'], verify: 'x' }, dir, null, cfg).strategy, 'claude');
});

test('hard and critical implementations require a cross-provider review of the diff', () => {
  for (const difficulty of ['hard', 'critical'])
    assert.match(S.decide({ mode: 'implement', difficulty, prompt: 'p', paths: ['tiny.js'], verify: 'x' }, dir, { tokens: 20000, nObs: 0 }, cfg).review, /read the whole diff/);
});

test('a broad read-only question over many files favours a subagent over the main conversation', () => {
  const r = S.decide({ mode: 'ask', difficulty: 'normal', prompt: 'Summarise how modules in big/ depend on each other', paths: ['big'] }, dir, { tokens: 40000, nObs: 6 }, cfg);
  assert.ok(r.options['claude-subagent'], 'subagent option estimated');
  assert.equal(r.strategy, 'claude-subagent', JSON.stringify(r.options));
});

test('every decision explains itself and lists what was not measured', () => {
  const r = S.decide({ mode: 'implement', difficulty: 'normal', prompt: 'p', paths: ['big'], verify: 'x' }, dir, { tokens: 20000, nObs: 1 }, cfg);
  assert.ok(r.why.length >= 1);
  assert.ok(r.unknown.some(u => /Claude-side/.test(u)));
  assert.ok(r.unknown.some(u => /1 observations/.test(u)));
});
