'use strict';
// Benchmark corpus v2: tasks across the engineering categories Tandem must handle. Each implement task has
// visible tests (in the repository the agent sees) and HIDDEN tests that exist only here and are copied into the
// final tree at grading time, so passing cannot be obtained by fitting the visible tests or by editing them.
// Read-only tasks are graded on required facts; review tasks and negative questions use a VERDICT line.
// Reference solutions live in bench/solutions.js, never in a task repository; test/bench-corpus.test.js proves
// for every task that the fixture fails, the reference passes and tampering with tests fails.
const pkg = (name, extra = {}) => JSON.stringify({ name, private: true, scripts: { test: 'node --test' }, ...extra }, null, 2) + '\n';
const T = (...lines) => ["'use strict';", "const test = require('node:test');", "const assert = require('node:assert/strict');", ...lines, ''].join('\n');
const VERDICT = 'Start your answer with "VERDICT: OK" if you find no correctness defect, or "VERDICT: DEFECT" followed by each defect with file and line.';

const CORPUS = {
  // ---- trivial code change
  'trivial-constant': {
    category: 'trivial', mode: 'implement', difficulty: 'trivial', paths: ['src/time.js'], verify: 'node --test',
    task: 'src/time.js has a wrong constant: a day has 86400 seconds. Fix it so `node --test` passes. Do not modify the tests.',
    files: {
      'package.json': pkg('time'),
      'src/time.js': "'use strict';\nconst SECONDS_PER_DAY = 86000;\nmodule.exports = { SECONDS_PER_DAY, days: s => s / SECONDS_PER_DAY };\n",
      'test/time.test.js': T("const { days } = require('../src/time');", "test('two days', () => assert.equal(days(172800), 2));"),
    },
    tests: ['test/time.test.js'],
    hidden: { 'hidden/time.hidden.test.js': T("const t = require('../src/time');", "test('constant and fractions', () => { assert.equal(t.SECONDS_PER_DAY, 86400); assert.equal(t.days(129600), 1.5); });") },
  },
  // ---- focused debugging
  'debug-duration': {
    category: 'debugging', mode: 'implement', difficulty: 'normal', paths: ['src/duration.js'], verify: 'node --test',
    task: 'parseDuration in src/duration.js converts strings like "1h30m" to seconds. Units are h, m and s; amounts may be integers or decimals, in any combination. A string without any valid unit must throw. Some inputs give wrong results: find and fix the cause so `node --test` passes. Do not modify the tests.',
    files: {
      'package.json': pkg('duration'),
      'src/duration.js': "'use strict';\nconst MULT = { h: 3600, m: 60, s: 1 };\nmodule.exports = function parseDuration(str) {\n  let total = 0;\n  for (const [, n, u] of String(str).matchAll(/(\\d+)([hms])/g)) total += Number(n) * MULT[u];\n  return total;\n};\n",
      'test/duration.test.js': T("const parse = require('../src/duration');", "test('combined', () => assert.equal(parse('1h30m'), 5400));", "test('decimal hours', () => assert.equal(parse('1.5h'), 5400));"),
    },
    tests: ['test/duration.test.js'],
    hidden: { 'hidden/duration.hidden.test.js': T("const parse = require('../src/duration');", "test('more inputs', () => { assert.equal(parse('2h0.5m'), 7230); assert.equal(parse('45s'), 45); });", "test('no unit throws', () => { assert.throws(() => parse('abc')); assert.throws(() => parse('')); });") },
  },
  // ---- multi-file bug
  'multi-file-invoice': {
    category: 'multi-file', mode: 'implement', difficulty: 'hard', paths: ['src'], verify: 'node --test',
    task: 'Invoice totals are wrong. Rule: each line total (quantity × unit price) is rounded to whole cents before summing; tax is computed on the summed subtotal and rounded half-up to whole cents; the total is subtotal + tax. All amounts are returned in cents. Fix src/ so `node --test` passes. Do not modify the tests.',
    files: {
      'package.json': pkg('invoice'),
      'src/money.js': "'use strict';\n// Round a cent amount half-up to a whole number of cents.\nexports.roundCents = c => Math.floor(c + 0.5 + 1e-9);\n",
      'src/line.js': "'use strict';\n// Line total in cents for a quantity and a unit price in cents.\nexports.lineTotal = (qty, unitCents) => qty * unitCents;\n",
      'src/invoice.js': "'use strict';\nconst { lineTotal } = require('./line');\nexports.invoice = (lines, taxRate) => {\n  const subtotal = lines.reduce((s, l) => s + lineTotal(l.qty, l.unitCents), 0);\n  const tax = Math.floor(subtotal * taxRate);\n  return { subtotal, tax, total: subtotal + tax };\n};\n",
      'test/invoice.test.js': T("const { invoice } = require('../src/invoice');", "test('rounds lines then tax', () => assert.deepEqual(invoice([{ qty: 3, unitCents: 33.335 }, { qty: 1, unitCents: 100 }], 0.2), { subtotal: 200, tax: 40, total: 240 }));", "test('tax half-up', () => assert.equal(invoice([{ qty: 1, unitCents: 1025 }], 0.1).tax, 103));"),
    },
    tests: ['test/invoice.test.js'],
    hidden: { 'hidden/invoice.hidden.test.js': T("const { invoice } = require('../src/invoice');", "test('other amounts', () => { assert.deepEqual(invoice([{ qty: 7, unitCents: 14.285 }, { qty: 2, unitCents: 0.5 }], 0.08), { subtotal: 101, tax: 8, total: 109 }); assert.deepEqual(invoice([], 0.2), { subtotal: 0, tax: 0, total: 0 }); });") },
  },
  // ---- refactoring
  'refactor-validate': {
    category: 'refactoring', mode: 'implement', difficulty: 'normal', paths: ['src'], verify: 'node --test',
    task: 'src/users.js and src/orders.js each contain their own copy of the same email check. Refactor: create src/validate.js exporting isEmail(s), make both modules use it, and remove the duplicated copies. Behaviour must not change; `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('shop'),
      'src/users.js': "'use strict';\nfunction validEmail(s) { return typeof s === 'string' && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s); }\nexports.createUser = (name, email) => { if (!validEmail(email)) throw new Error('invalid email'); return { name, email }; };\n",
      'src/orders.js': "'use strict';\nconst EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\nexports.notify = (order, email) => (typeof email === 'string' && EMAIL.test(email) ? `sent ${order.id} to ${email}` : null);\n",
      'test/shop.test.js': T("const { createUser } = require('../src/users');", "const { notify } = require('../src/orders');", "test('users', () => { assert.deepEqual(createUser('a', 'a@b.co'), { name: 'a', email: 'a@b.co' }); assert.throws(() => createUser('a', 'nope')); });", "test('orders', () => { assert.equal(notify({ id: 7 }, 'x@y.io'), 'sent 7 to x@y.io'); assert.equal(notify({ id: 7 }, 'x@y'), null); assert.equal(notify({ id: 7 }, 5), null); });"),
    },
    tests: ['test/shop.test.js'],
    hidden: { 'hidden/refactor.hidden.test.js': T("const fs = require('fs'), path = require('path');", "const { isEmail } = require('../src/validate');", "const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');", "test('shared validator', () => { assert.equal(isEmail('a@b.co'), true); assert.equal(isEmail('a b@c.d'), false); assert.equal(isEmail(null), false); });", "test('no duplicated copies', () => { for (const f of ['users.js', 'orders.js']) { assert.match(src(f), /require\\(['\"]\\.\\/validate['\"]\\)/, f); assert.doesNotMatch(src(f), /\\[\\^\\\\s@\\]/, f); } });") },
  },
  // ---- API compatibility
  'api-compat-callback': {
    category: 'api-compat', mode: 'implement', difficulty: 'normal', paths: ['src/store.js'], verify: 'node --test',
    task: 'store.get(key, callback) in src/store.js is callback-only. Make it also return a Promise when called without a callback (resolving with the value, rejecting with the same Error the callback would get), while the callback form keeps working exactly as before. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('store'),
      'src/store.js': "'use strict';\nconst data = new Map([['a', 1]]);\nexports.get = function get(key, cb) {\n  setImmediate(() => (data.has(key) ? cb(null, data.get(key)) : cb(new Error(`missing key: ${key}`))));\n};\n",
      'test/store.test.js': T("const store = require('../src/store');", "test('callback form', (t, done) => { store.get('a', (e, v) => { assert.equal(e, null); assert.equal(v, 1); done(); }); });", "test('promise form', async () => assert.equal(await store.get('a'), 1));"),
    },
    tests: ['test/store.test.js'],
    hidden: { 'hidden/store.hidden.test.js': T("const store = require('../src/store');", "test('promise rejects like the callback errs', async () => { await assert.rejects(store.get('zz'), /missing key: zz/); });", "test('callback error unchanged', (t, done) => { store.get('zz', e => { assert.match(e.message, /missing key: zz/); done(); }); });", "test('callback form returns nothing', () => { assert.equal(store.get('a', () => {}), undefined); });") },
  },
  // ---- security
  'security-path-traversal': {
    category: 'security', mode: 'implement', difficulty: 'hard', paths: ['src/files.js'], verify: 'node --test',
    task: 'resolveInside(root, rel) in src/files.js must return the absolute path of `rel` inside `root`, and throw for any path that would resolve outside root (parent traversal, absolute paths, or a sibling directory whose name merely starts with root\'s name). Nested paths that stay inside are allowed. It currently allows escapes; fix it so `node --test` passes. Do not modify the tests.',
    files: {
      'package.json': pkg('files'),
      'src/files.js': "'use strict';\nconst path = require('path');\nexports.resolveInside = (root, rel) => path.join(root, rel);\n",
      'test/files.test.js': T("const path = require('path');", "const { resolveInside } = require('../src/files');", "const root = path.resolve('srv', 'app');", "test('nested allowed', () => assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt')));", "test('parent traversal rejected', () => assert.throws(() => resolveInside(root, '../secret')));"),
    },
    tests: ['test/files.test.js'],
    hidden: { 'hidden/files.hidden.test.js': T("const path = require('path');", "const { resolveInside } = require('../src/files');", "const root = path.resolve('srv', 'app');", "test('more escapes rejected', () => { assert.throws(() => resolveInside(root, path.resolve('etc', 'passwd'))); assert.throws(() => resolveInside(root, '../app2/x')); assert.throws(() => resolveInside(root, 'a/../../x')); });", "test('inside after normalisation allowed', () => { assert.equal(resolveInside(root, 'a/../b'), path.join(root, 'b')); assert.equal(resolveInside(root, '.'), root); });") },
  },
  'security-sql-param': {
    category: 'security', mode: 'implement', difficulty: 'hard', paths: ['src/query.js'], verify: 'node --test',
    task: 'Every query in src/query.js builds SQL by string interpolation (SQL injection). Change every query to use placeholders: call db.query(sql, params) with `?` placeholders and the values in params, keeping the same SQL otherwise. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('query'),
      'src/query.js': "'use strict';\nexports.findUser = (db, name) => db.query(`SELECT * FROM users WHERE name = '${name}'`);\nexports.findByEmail = (db, email) => db.query(`SELECT * FROM users WHERE email = '${email}'`);\n",
      'test/query.test.js': T("const q = require('../src/query');", "const fake = () => { const calls = []; return { calls, query: (sql, params) => { calls.push([sql, params]); return []; } }; };", "test('findUser uses a placeholder', () => { const db = fake(); q.findUser(db, 'bob'); assert.deepEqual(db.calls, [['SELECT * FROM users WHERE name = ?', ['bob']]]); });"),
    },
    tests: ['test/query.test.js'],
    hidden: { 'hidden/query.hidden.test.js': T("const q = require('../src/query');", "const fake = () => { const calls = []; return { calls, query: (sql, params) => { calls.push([sql, params]); return []; } }; };", "test('every query parameterised', () => { const db = fake(); q.findByEmail(db, \"x' OR '1'='1\"); q.findUser(db, \"o'brien\"); assert.deepEqual(db.calls, [['SELECT * FROM users WHERE email = ?', [\"x' OR '1'='1\"]], ['SELECT * FROM users WHERE name = ?', [\"o'brien\"]]]); });") },
  },
  // ---- asynchronous / concurrent code
  'async-lost-update': {
    category: 'async', mode: 'implement', difficulty: 'hard', paths: ['src/account.js'], verify: 'node --test',
    task: 'Concurrent deposit()/withdraw() calls on one Account in src/account.js lose updates (read, await, write). Make operations on the same account take effect one at a time in call order, without losing any. withdraw(n) must reject with an Error when the balance at its turn is insufficient and leave the balance unchanged; a failed operation must not block later ones. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('account'),
      'src/account.js': "'use strict';\nconst tick = () => new Promise(r => setTimeout(r, Math.random() * 3));\nclass Account {\n  constructor() { this.store = { v: 0 }; }\n  async read() { await tick(); return this.store.v; }\n  async write(v) { await tick(); this.store.v = v; }\n  async deposit(n) { const b = await this.read(); await this.write(b + n); }\n  async withdraw(n) { const b = await this.read(); if (b < n) throw new Error('insufficient funds'); await this.write(b - n); }\n  async balance() { return this.read(); }\n}\nmodule.exports = { Account };\n",
      'test/account.test.js': T("const { Account } = require('../src/account');", "test('no lost deposits', async () => { const a = new Account(); await Promise.all(Array.from({ length: 20 }, () => a.deposit(1))); assert.equal(await a.balance(), 20); });"),
    },
    tests: ['test/account.test.js'],
    hidden: { 'hidden/account.hidden.test.js': T("const { Account } = require('../src/account');", "test('mixed operations in call order', async () => { const a = new Account(); const ops = [a.deposit(10), a.withdraw(4), a.withdraw(10), a.deposit(5), a.withdraw(11)]; const r = await Promise.allSettled(ops); assert.deepEqual(r.map(x => x.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']); assert.match(r[2].reason.message, /insufficient/); assert.equal(await a.balance(), 0); });", "test('a failure does not block the queue', async () => { const a = new Account(); await assert.rejects(a.withdraw(1)); await a.deposit(3); assert.equal(await a.balance(), 3); });") },
  },
  'async-map-limit': {
    category: 'async', mode: 'implement', difficulty: 'normal', paths: ['src/map-limit.js'], verify: 'node --test',
    task: 'Implement mapLimit(items, limit, fn) in src/map-limit.js: apply the async fn to every item with at most `limit` calls in flight, resolve with the results in input order, and reject with the first error. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('maplimit'),
      'src/map-limit.js': "'use strict';\nmodule.exports = async function mapLimit(items, limit, fn) {\n  throw new Error('not implemented');\n};\n",
      'test/map-limit.test.js': T("const mapLimit = require('../src/map-limit');", "const wait = ms => new Promise(r => setTimeout(r, ms));", "test('order preserved', async () => assert.deepEqual(await mapLimit([30, 10, 20], 2, async x => { await wait(x); return x * 2; }), [60, 20, 40]));", "test('first error rejects', async () => { await assert.rejects(mapLimit([1, 2, 3], 2, async x => { if (x === 2) throw new Error('boom'); return x; }), /boom/); });"),
    },
    tests: ['test/map-limit.test.js'],
    hidden: { 'hidden/map-limit.hidden.test.js': T("const mapLimit = require('../src/map-limit');", "const wait = ms => new Promise(r => setTimeout(r, ms));", "test('never exceeds the limit', async () => { let active = 0, peak = 0; await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => { active++; peak = Math.max(peak, active); await wait(5); active--; }); assert.equal(peak, 3); });", "test('edges', async () => { assert.deepEqual(await mapLimit([], 2, async x => x), []); assert.deepEqual(await mapLimit([1, 2], 10, async x => x + 1), [2, 3]); });") },
  },
  // ---- build system
  'build-exports': {
    category: 'build', mode: 'implement', difficulty: 'normal', paths: ['package.json'], verify: 'node --test',
    task: 'Consumers must be able to `require("mathlib/stats")` (src/stats.js), but package.json\'s exports map only exposes the package root, so it fails. Fix package.json so the subpath works while src/internal.js stays private (not importable by consumers) and the root import keeps working. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('mathlib', { exports: { '.': './index.js' } }),
      'index.js': "'use strict';\nmodule.exports = { add: (a, b) => a + b };\n",
      'src/stats.js': "'use strict';\nconst { scale } = require('./internal');\nexports.mean = xs => scale(xs.reduce((a, b) => a + b, 0), 1 / xs.length);\n",
      'src/internal.js': "'use strict';\nexports.scale = (x, k) => x * k;\n",
      'test/exports.test.js': T("test('subpath import', () => assert.equal(require('mathlib/stats').mean([1, 2, 3]), 2));", "test('root import', () => assert.equal(require('mathlib').add(2, 3), 5));"),
    },
    tests: ['test/exports.test.js'],
    hidden: { 'hidden/exports.hidden.test.js': T("test('internal stays private', () => assert.throws(() => require('mathlib/internal'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }));", "test('no raw file paths exposed', () => assert.throws(() => require('mathlib/src/internal.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }));") },
  },
  // ---- dependency-sensitive modification
  'dep-upgrade': {
    category: 'dependency', mode: 'implement', difficulty: 'normal', paths: ['src'], verify: 'node --test',
    task: 'The vendored dependency tinydate was upgraded to v3 (node_modules/tinydate) and the app no longer works. Update the app code in src/ to the v3 API (see the dependency\'s CHANGELOG.md); do not change the dependency. `node --test` must pass. Do not modify the tests.',
    files: {
      'package.json': pkg('reports', { dependencies: { tinydate: '^3.0.0' } }),
      'node_modules/tinydate/package.json': JSON.stringify({ name: 'tinydate', version: '3.0.0', main: 'index.js' }) + '\n',
      'node_modules/tinydate/CHANGELOG.md': '# 3.0.0\n- BREAKING: `format(date, pattern)` was renamed to `formatDate(pattern, date)` (arguments swapped).\n- BREAKING: `parse` was removed; use `fromISO(string)`.\n',
      'node_modules/tinydate/index.js': "'use strict';\nconst p = n => String(n).padStart(2, '0');\nexports.formatDate = (pattern, d) => pattern.replace('YYYY', d.getUTCFullYear()).replace('MM', p(d.getUTCMonth() + 1)).replace('DD', p(d.getUTCDate()));\nexports.fromISO = s => new Date(s);\n",
      'src/report.js': "'use strict';\nconst td = require('tinydate');\nexports.title = iso => `Report ${td.format(td.parse(iso), 'YYYY-MM-DD')}`;\n",
      'src/summary.js': "'use strict';\nconst td = require('tinydate');\nexports.footer = iso => `Generated ${td.format(td.parse(iso), 'DD/MM/YYYY')}`;\n",
      'test/report.test.js': T("const { title } = require('../src/report');", "test('title', () => assert.equal(title('2026-03-04T10:00:00Z'), 'Report 2026-03-04'));"),
    },
    tests: ['test/report.test.js', 'node_modules/tinydate/index.js', 'node_modules/tinydate/package.json'],
    hidden: { 'hidden/summary.hidden.test.js': T("const { footer } = require('../src/summary');", "test('every call site migrated', () => assert.equal(footer('2026-12-31T23:00:00Z'), 'Generated 31/12/2026'));") },
  },
  // ---- code review (one defect, one clean negative)
  'review-async': {
    category: 'review', mode: 'review', difficulty: 'hard',
    task: `Review the uncommitted changes in this repository for correctness bugs. ${VERDICT}`,
    files: {
      'src/sync.js': "'use strict';\n// Upload every file; resolves once all uploads finished, rejects if any failed.\nmodule.exports = async function syncAll(files, upload) {\n  for (const f of files) await upload(f);\n  return files.length;\n};\n",
    },
    change: {
      'src/sync.js': "'use strict';\n// Upload every file; resolves once all uploads finished, rejects if any failed.\nmodule.exports = async function syncAll(files, upload) {\n  files.forEach(async f => { await upload(f); });\n  return files.length;\n};\n",
    },
    grade: ({ answer }) => /VERDICT:\s*DEFECT/.test(answer) && /sync\.js/.test(answer) && /(forEach|not awaited|without await|does not wait|doesn't wait|unhandled|before .*finish|fire[- ]and[- ]forget)/i.test(answer),
  },
  'review-clean': {
    category: 'review', mode: 'review', difficulty: 'normal', negative: true,
    task: `Review the uncommitted changes in this repository for correctness bugs. ${VERDICT}`,
    files: {
      'src/stats.js': "'use strict';\n// Sum of the positive numbers in xs.\nmodule.exports = function sumPositive(xs) {\n  let s = 0;\n  for (const x of xs) if (x > 0) s += x;\n  return s;\n};\n",
    },
    change: {
      'src/stats.js': "'use strict';\n// Sum of the positive numbers in xs.\nmodule.exports = function sumPositive(xs) {\n  return xs.filter(x => x > 0).reduce((s, x) => s + x, 0);\n};\n",
    },
    grade: ({ answer }) => /VERDICT:\s*OK/.test(answer) && !/VERDICT:\s*DEFECT/.test(answer),
  },
  // ---- architecture analysis
  'arch-writes': {
    category: 'architecture', mode: 'ask', difficulty: 'normal',
    task: 'In this repository, which module are database writes supposed to go through, and which service module bypasses it? Name the files.',
    files: {
      'README.md': '# shop\nServices persist data through the database layer.\n',
      'src/db/raw.js': "'use strict';\nexports.exec = (sql, params) => ({ sql, params });\n",
      'src/db/writer.js': "'use strict';\n// The only sanctioned write path: validates, audits, then executes.\nconst raw = require('./raw');\nconst audit = [];\nexports.write = (table, row) => { if (!row || typeof row !== 'object') throw new Error('bad row'); audit.push(table); return raw.exec(`INSERT INTO ${table} VALUES (?)`, [JSON.stringify(row)]); };\n",
      'src/db/reader.js': "'use strict';\nconst raw = require('./raw');\nexports.read = table => raw.exec(`SELECT * FROM ${table}`, []);\n",
      'src/services/orders.js': "'use strict';\nconst { write } = require('../db/writer');\nexports.place = o => write('orders', o);\n",
      'src/services/users.js': "'use strict';\nconst { write } = require('../db/writer');\nconst { read } = require('../db/reader');\nexports.add = u => write('users', u);\nexports.all = () => read('users');\n",
      'src/services/billing.js': "'use strict';\nconst raw = require('../db/raw');\nexports.charge = (id, cents) => raw.exec('INSERT INTO charges VALUES (?, ?)', [id, cents]);\n",
      'src/services/reports.js': "'use strict';\nconst { read } = require('../db/reader');\nexports.daily = () => read('orders');\n",
    },
    grade: ({ answer }) => /writer\.js/.test(answer) && /billing\.js/.test(answer),
  },
  // ---- large repository navigation (generated: 300 modules)
  'nav-large': {
    category: 'navigation', mode: 'ask', difficulty: 'normal',
    task: 'Which file sets the X-Request-Budget response header, and to what value?',
    files: (() => {
      const f = { 'package.json': pkg('gateway'), 'README.md': '# gateway\n300 route modules under src/routes.\n' };
      for (let i = 0; i < 300; i++) {
        const id = String(i).padStart(3, '0');
        const header = i === 173 ? "  res.setHeader('X-Request-Budget', '750');\n" : `  res.setHeader('X-Route', 'r${id}');\n`;
        f[`src/routes/r${id}/index.js`] = `'use strict';\n// Route r${id}.\nmodule.exports = (req, res) => {\n${header}  res.end('r${id}');\n};\n`;
      }
      return f;
    })(),
    grade: ({ answer }) => /r173/.test(answer) && /\b750\b/.test(answer),
  },
  // ---- negative question: the feature does not exist
  'ask-nonexistent': {
    category: 'negative', mode: 'ask', difficulty: 'trivial', negative: true,
    task: 'Which environment variable enables debug logging in this service? If there is none, answer exactly NONE.',
    files: {
      'src/config.js': "'use strict';\nmodule.exports = env => ({ port: Number(env.APP_PORT || 8080), retries: Number(env.APP_RETRIES || 3) });\n",
      'src/log.js': "'use strict';\nmodule.exports = (...a) => console.log(new Date().toISOString(), ...a);\n",
      'README.md': '# svc\nConfigure with APP_PORT and APP_RETRIES.\n',
    },
    grade: ({ answer }) => /\bNONE\b/.test(answer),
  },
};

module.exports = { CORPUS };
