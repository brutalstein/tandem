'use strict';
// Reference solutions for grader validation only (test/bench-corpus.test.js). Never copied into a task
// repository. Implement tasks: files that replace the fixture's. Read-only tasks: one answer that must pass and
// one plausible wrong answer that must fail.
const SOLUTIONS = {
  slugify: { files: { 'slug.js': "'use strict';\nmodule.exports = s => s.replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" } },
  'lru-bugs': { files: { 'src/lru.js': "'use strict';\nclass LRU {\n  constructor(capacity) {\n    if (!(capacity > 0)) throw new RangeError('capacity must be > 0');\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  get size() { return this.map.size; }\n  get(key) {\n    if (!this.map.has(key)) return undefined;\n    const v = this.map.get(key); this.map.delete(key); this.map.set(key, v);\n    return v;\n  }\n  set(key, value) {\n    this.map.delete(key); this.map.set(key, value);\n    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);\n    return this;\n  }\n}\nmodule.exports = { LRU };\n" } },
  'ask-config': { good: 'The default port is 8080; APP_TIMEOUT_MS overrides the request timeout.', bad: 'The default port is 3000; TIMEOUT overrides it.' },
  'review-page': { good: 'src/page.js line 5: off-by-one, `page * size` skips the first page; it should be (page - 1) * size.', bad: 'No problems; the guard clause is a good addition.' },

  'trivial-constant': { files: { 'src/time.js': "'use strict';\nconst SECONDS_PER_DAY = 86400;\nmodule.exports = { SECONDS_PER_DAY, days: s => s / SECONDS_PER_DAY };\n" } },
  'debug-duration': { files: { 'src/duration.js': "'use strict';\nconst MULT = { h: 3600, m: 60, s: 1 };\nmodule.exports = function parseDuration(str) {\n  const parts = [...String(str).matchAll(/(\\d+(?:\\.\\d+)?)([hms])/g)];\n  if (!parts.length) throw new Error(`no duration in ${JSON.stringify(str)}`);\n  return parts.reduce((t, [, n, u]) => t + Number(n) * MULT[u], 0);\n};\n" } },
  'multi-file-invoice': { files: {
    'src/line.js': "'use strict';\nconst { roundCents } = require('./money');\nexports.lineTotal = (qty, unitCents) => roundCents(qty * unitCents);\n",
    'src/invoice.js': "'use strict';\nconst { lineTotal } = require('./line');\nconst { roundCents } = require('./money');\nexports.invoice = (lines, taxRate) => {\n  const subtotal = lines.reduce((s, l) => s + lineTotal(l.qty, l.unitCents), 0);\n  const tax = roundCents(subtotal * taxRate);\n  return { subtotal, tax, total: subtotal + tax };\n};\n",
  } },
  'refactor-validate': { files: {
    'src/validate.js': "'use strict';\nexports.isEmail = s => typeof s === 'string' && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s);\n",
    'src/users.js': "'use strict';\nconst { isEmail } = require('./validate');\nexports.createUser = (name, email) => { if (!isEmail(email)) throw new Error('invalid email'); return { name, email }; };\n",
    'src/orders.js': "'use strict';\nconst { isEmail } = require('./validate');\nexports.notify = (order, email) => (isEmail(email) ? `sent ${order.id} to ${email}` : null);\n",
  } },
  'api-compat-callback': { files: { 'src/store.js': "'use strict';\nconst data = new Map([['a', 1]]);\nfunction get(key, cb) {\n  if (typeof cb !== 'function') return new Promise((resolve, reject) => get(key, (e, v) => (e ? reject(e) : resolve(v))));\n  setImmediate(() => (data.has(key) ? cb(null, data.get(key)) : cb(new Error(`missing key: ${key}`))));\n}\nexports.get = get;\n" } },
  'security-path-traversal': { files: { 'src/files.js': "'use strict';\nconst path = require('path');\nexports.resolveInside = (root, rel) => {\n  const base = path.resolve(root), p = path.resolve(base, rel), r = path.relative(base, p);\n  if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) throw new Error(`outside root: ${rel}`);\n  return p;\n};\n" } },
  'security-sql-param': { files: { 'src/query.js': "'use strict';\nexports.findUser = (db, name) => db.query('SELECT * FROM users WHERE name = ?', [name]);\nexports.findByEmail = (db, email) => db.query('SELECT * FROM users WHERE email = ?', [email]);\n" } },
  'async-lost-update': { files: { 'src/account.js': "'use strict';\nconst tick = () => new Promise(r => setTimeout(r, Math.random() * 3));\nclass Account {\n  constructor() { this.store = { v: 0 }; this.queue = Promise.resolve(); }\n  serial(fn) { const r = this.queue.then(fn); this.queue = r.catch(() => {}); return r; }\n  async read() { await tick(); return this.store.v; }\n  async write(v) { await tick(); this.store.v = v; }\n  deposit(n) { return this.serial(async () => { const b = await this.read(); await this.write(b + n); }); }\n  withdraw(n) { return this.serial(async () => { const b = await this.read(); if (b < n) throw new Error('insufficient funds'); await this.write(b - n); }); }\n  balance() { return this.serial(() => this.read()); }\n}\nmodule.exports = { Account };\n" } },
  'async-map-limit': { files: { 'src/map-limit.js': "'use strict';\nmodule.exports = async function mapLimit(items, limit, fn) {\n  const out = new Array(items.length); let next = 0;\n  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };\n  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));\n  return out;\n};\n" } },
  'build-exports': { files: { 'package.json': JSON.stringify({ name: 'mathlib', private: true, scripts: { test: 'node --test' }, exports: { '.': './index.js', './stats': './src/stats.js' } }, null, 2) + '\n' } },
  'dep-upgrade': { files: {
    'src/report.js': "'use strict';\nconst td = require('tinydate');\nexports.title = iso => `Report ${td.formatDate('YYYY-MM-DD', td.fromISO(iso))}`;\n",
    'src/summary.js': "'use strict';\nconst td = require('tinydate');\nexports.footer = iso => `Generated ${td.formatDate('DD/MM/YYYY', td.fromISO(iso))}`;\n",
  } },
  'review-async': { good: 'VERDICT: DEFECT\nsrc/sync.js line 4: forEach with an async callback is not awaited, so syncAll resolves before uploads finish and a failed upload becomes an unhandled rejection.', bad: 'VERDICT: OK\nThe change is a harmless style refactor.' },
  'review-clean': { good: 'VERDICT: OK\nfilter + reduce is equivalent to the loop, including for an empty array.', bad: 'VERDICT: DEFECT\nsrc/stats.js line 4: reduce without an initial value throws on an empty array.' },
  'arch-writes': { good: 'Writes should go through src/db/writer.js; src/services/billing.js bypasses it by calling db/raw.js directly.', bad: 'All services use src/db/reader.js for writes.' },
  'nav-large': { good: 'src/routes/r173/index.js sets X-Request-Budget to 750.', bad: 'src/routes/r017/index.js sets it to 500.' },
  'ask-nonexistent': { good: 'NONE', bad: 'Set DEBUG=1 to enable debug logging.' },
};

module.exports = { SOLUTIONS };
