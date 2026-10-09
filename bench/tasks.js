'use strict';
// Benchmark task fixtures. Each task is a tiny but realistic repository plus an independent grader.
// Implement tasks are graded by running the task's tests in the final tree AND checking that the
// test files are byte-identical to the fixture (editing tests = fail). Ask/review tasks are graded
// by required facts in the answer.

const SLUG = {
  'package.json': JSON.stringify({ name: 'slug', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'slug.js': "'use strict';\nmodule.exports = function slugify(s) {\n  throw new Error('not implemented');\n};\n",
  'slug.test.js': [
    "const test = require('node:test');", "const assert = require('node:assert');", "const slugify = require('./slug');",
    "test('basic', () => { assert.equal(slugify('  Hello, World! '), 'hello-world'); });",
    "test('diacritics incl. Turkish', () => { assert.equal(slugify('Çok Güzel_Şey'), 'cok-guzel-sey'); assert.equal(slugify('İstanbul ılık'), 'istanbul-ilik'); });",
    "test('collapse and trim', () => { assert.equal(slugify('a--b'), 'a-b'); assert.equal(slugify('--x--'), 'x'); assert.equal(slugify(''), ''); });",
    '',
  ].join('\n'),
};

// LRU cache with three planted bugs: get() does not refresh recency, set() on an existing key grows
// the size, and eviction removes the most recent entry. Tests describe the intended behaviour.
const LRU = {
  'package.json': JSON.stringify({ name: 'cache', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/lru.js': [
    "'use strict';",
    '// Least-recently-used cache. Map iteration order = insertion order (oldest first).',
    'class LRU {',
    '  constructor(capacity) {',
    "    if (!(capacity > 0)) throw new RangeError('capacity must be > 0');",
    '    this.capacity = capacity;',
    '    this.map = new Map();',
    '    this.size = 0;',
    '  }',
    '  get(key) {',
    '    if (!this.map.has(key)) return undefined;',
    '    return this.map.get(key);',
    '  }',
    '  set(key, value) {',
    '    this.map.set(key, value);',
    '    this.size++;',
    '    if (this.size > this.capacity) this.evict();',
    '    return this;',
    '  }',
    '  delete(key) {',
    '    const had = this.map.delete(key);',
    '    if (had) this.size--;',
    '    return had;',
    '  }',
    '  evict() {',
    '    const keys = [...this.map.keys()];',
    '    this.map.delete(keys[keys.length - 1]);',
    '    this.size--;',
    '  }',
    '}',
    'module.exports = { LRU };',
    '',
  ].join('\n'),
  'src/memo.js': [
    "'use strict';",
    "const { LRU } = require('./lru');",
    '// Memoise a one-argument function with an LRU of the given capacity.',
    'module.exports = function memo(fn, capacity = 100) {',
    '  const cache = new LRU(capacity);',
    '  return x => {',
    '    const hit = cache.get(x);',
    '    if (hit !== undefined) return hit;',
    '    const v = fn(x);',
    '    cache.set(x, v);',
    '    return v;',
    '  };',
    '};',
    '',
  ].join('\n'),
  'test/lru.test.js': [
    "const test = require('node:test');", "const assert = require('node:assert');", "const { LRU } = require('../src/lru');", "const memo = require('../src/memo');",
    "test('evicts the least recently used entry', () => { const c = new LRU(2); c.set('a', 1).set('b', 2).set('c', 3); assert.equal(c.get('a'), undefined); assert.equal(c.get('b'), 2); assert.equal(c.get('c'), 3); });",
    "test('get refreshes recency', () => { const c = new LRU(2); c.set('a', 1).set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('a'), 1); assert.equal(c.get('b'), undefined); });",
    "test('overwriting a key does not grow the cache', () => { const c = new LRU(2); c.set('a', 1).set('a', 2).set('b', 3); assert.equal(c.size, 2); assert.equal(c.get('a'), 2); assert.equal(c.get('b'), 3); });",
    "test('memo caches and respects capacity', () => { let n = 0; const sq = memo(x => { n++; return x * x; }, 2); sq(2); sq(2); assert.equal(n, 1); sq(3); sq(4); sq(2); assert.equal(n, 4); });",
    "test('capacity validated', () => { assert.throws(() => new LRU(0), RangeError); });",
    '',
  ].join('\n'),
};

// Read-only question with facts that must be found in the code.
const ASK = {
  'src/config.js': "'use strict';\n// Loads settings: environment first, then config.json, then defaults.\nconst DEFAULTS = { port: 8080, retries: 3, timeoutMs: 15000 };\nfunction load(env = process.env, file = {}) {\n  return {\n    port: Number(env.APP_PORT || file.port || DEFAULTS.port),\n    retries: Number(env.APP_RETRIES ?? file.retries ?? DEFAULTS.retries),\n    timeoutMs: Number(env.APP_TIMEOUT_MS || file.timeoutMs || DEFAULTS.timeoutMs),\n  };\n}\nmodule.exports = { load, DEFAULTS };\n",
  'src/server.js': "'use strict';\nconst { load } = require('./config');\nconst cfg = load();\nmodule.exports = function start(listen) { return listen(cfg.port, { retries: cfg.retries, timeout: cfg.timeoutMs }); };\n",
  'README.md': '# svc\nSmall service.\n',
};

// Review: an uncommitted diff introduces an off-by-one in pagination.
const REVIEW_BASE = {
  'src/page.js': "'use strict';\n// Items of 1-based page `page` with `size` items per page.\nmodule.exports = function paginate(items, page, size) {\n  const start = (page - 1) * size;\n  return items.slice(start, start + size);\n};\n",
  'src/total.js': "'use strict';\nmodule.exports = function pageCount(n, size) {\n  return Math.ceil(n / size);\n};\n",
};
const REVIEW_CHANGE = {
  'src/page.js': "'use strict';\n// Items of 1-based page `page` with `size` items per page.\nmodule.exports = function paginate(items, page, size) {\n  if (page < 1 || size < 1) return [];\n  const start = page * size;\n  return items.slice(start, start + size);\n};\n",
};

const TASKS = {
  'ask-config': {
    mode: 'ask', difficulty: 'trivial', files: ASK,
    task: 'In this repository, what is the default port, and which environment variable overrides the request timeout? Answer in one or two sentences.',
    grade: ({ answer }) => /8080/.test(answer) && /APP_TIMEOUT_MS/.test(answer),
  },
  slugify: {
    mode: 'implement', difficulty: 'normal', files: SLUG, paths: ['slug.js'], verify: 'node --test', tests: ['slug.test.js'],
    task: 'Implement slugify in slug.js so `node --test` passes: lowercase, strip diacritics (including Turkish letters such as ı, İ, ş, ç, ğ), turn every run of non-alphanumerics into a single hyphen, and trim leading/trailing hyphens. Do not modify the tests.',
  },
  'lru-bugs': {
    mode: 'implement', difficulty: 'hard', files: LRU, paths: ['src'], verify: 'node --test', tests: ['test/lru.test.js'],
    task: 'The LRU cache in src/lru.js is buggy and `node --test` fails. Find and fix every bug in src/ so all tests pass. Do not modify the tests.',
  },
  'review-page': {
    mode: 'review', difficulty: 'hard', files: REVIEW_BASE, change: REVIEW_CHANGE,
    task: 'Review the uncommitted changes in this repository for correctness bugs. Report each defect with file and line.',
    grade: ({ answer }) => /page\.js/.test(answer) && /(off[- ]by[- ]one|page \* size|\(page - 1\)|skips? the first page|first page)/i.test(answer),
  },
};

module.exports = { TASKS };
