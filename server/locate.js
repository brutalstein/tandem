'use strict';
// Rank a repository's files by how likely a task concerns them, so a worker starts reading in the right place
// instead of exploring. Signals, strongest first: paths the task names, dotted module names it names, files that
// define the identifiers it names, then BM25 over the task's terms (file path tokens weighted up). No index and no
// full read: `git grep` counts only the task's terms, so cost grows with matches, not repository size. Measured on
// real issues in large repositories: bench/locate-eval.js, docs/BENCHMARKS.md.
const { execFileSync } = require('child_process');

const STOP = new Set(('a an and are as at be been but by can could did do does doing for from had has have how if in into is it its '
  + 'may might more most must no not of on or our should so some such than that the their them then there these they this '
  + 'those to too use used using was we were what when where which while who why will with would you your also just only '
  + 'get set new old add like want need make work works working instead same other each any all one two first after before '
  + 'expected actual result results error errors issue bug fix fixed problem example following below above see seems currently '
  + 'self cls none true false null undefined return def class import from print value values type str int list dict '
  + 'http https www com org github html').split(' '));
const SOURCE = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|kts|scala|rb|php|c|cc|cpp|cxx|h|hh|hpp|cs|swift|m|mm|sh|lua|dart|ex|exs|erl|hs|ml|clj|vue|svelte|sql|r|jl)$/i;
const TEST = /(^|\/)(tests?|testing|__tests__|spec|specs)\/|(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+|conftest\.py)$/i;
// Bundled third-party or generated code: large, matches many words, rarely what a task is about.
const VENDOR = /(^|\/)(vendor|vendored|third_party|thirdparty|external|node_modules|dist|build|static\/.*\/(js|lib))\/|\.min\.(js|css)$|[.-]bundle\.js$/i;
const DEF_KW = 'class|def|function|func|fn|struct|interface|type|enum|trait|module|object|record';
// Weights chosen on the tuning half of SWE-bench Lite (bench/locate-eval.js); MRR is flat near this point.
const W = { path: 3, module: 0.5, def: 1, nonSource: 0.5, test: 0.5, vendor: 0.3, pathTf: 1 };
const K1 = 1.2, B = 0.75, MAX_TERMS = 32, MAX_IDS = 40;

// Identifier → lowercase sub-tokens (snake and camel parts) plus the whole identifier when it is compound.
function parts(id) {
  const low = id.toLowerCase();
  const sub = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[_\s]+/).filter(t => t.length > 1);
  return sub.length > 1 ? [low, ...sub] : sub;
}

// What the task text names: file paths, dotted module paths, code-like identifiers, and weighted plain terms.
function query(task) {
  const text = String(task);
  const paths = [...new Set([...text.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,5}\b|\b[\w-]+\.(?:py|pyi|js|mjs|jsx|ts|tsx|go|rs|java|rb|php|c|h|cpp|hpp|cs|kt|swift|scala|vue|md|rst|txt|json|ya?ml|toml|cfg|ini|html|css)\b/g)].map(m => m[0].replace(/^\.?\//, '')))];
  const dotted = [...new Set([...text.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,}\b/g)].map(m => m[0]).filter(d => !/\.(py|js|ts|md|txt|rst|org|com|io|html)$/i.test(d) && !/^(e\.g|i\.e)/i.test(d)))];
  const code = new Set();
  for (const m of text.matchAll(/`([^`\n]{1,200})`|([A-Za-z_]\w*)\s*\(|\.([A-Za-z_]\w*)|\b([A-Za-z_]*[a-z0-9][A-Z]\w*|[A-Za-z]\w*_\w+|[A-Z][A-Z0-9]*[a-z]\w*[A-Z]\w*)\b/g)) {
    if (m[1]) for (const id of m[1].match(/[A-Za-z_]\w+/g) || []) code.add(id);
    for (const id of [m[2], m[3], m[4]]) if (id && id.length > 2) code.add(id);
  }
  for (const id of [...code]) if (STOP.has(id.toLowerCase())) code.delete(id);
  const terms = new Map(); // term → weight; terms from code-like identifiers count double
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]+/g)) for (const t of parts(m[0])) if (t.length > 2 && !STOP.has(t)) terms.set(t, Math.max(terms.get(t) || 0, code.has(m[0]) ? 2 : 1));
  const top = [...terms].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, MAX_TERMS);
  return { paths, dotted, code: [...code].slice(0, MAX_IDS), terms: new Map(top) };
}

// Repository facts for one query, from git: every file name, and for the files that match, how often each term
// occurs, their size, and which named identifiers they define. src: { cwd } for a working tree (tracked and
// untracked, not ignored), or { gitDir, tree } for a commit. Each git call is cut off after src.timeoutMs (default
// 15 s; 0 = none), and locate() then returns no hints rather than delay the job.
function collect(q, src) {
  const git = (args, max = 256) => {
    try { return execFileSync('git', [...(src.gitDir ? ['--git-dir', src.gitDir] : ['-C', src.cwd]), ...args], { maxBuffer: max * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: src.timeoutMs ?? 15000 }); }
    catch (e) { if (e.status === 1 && e.stdout) return e.stdout; throw e; } // git grep exits 1 when nothing matches
  };
  const strip = src.tree ? s => s.slice(src.tree.length + 1) : s => s;
  const names = args => git(args).toString('utf8').split('\0').filter(Boolean);
  // Tracked names come from the index (no directory walk); untracked ones need one walk.
  const others = src.tree ? [] : names(['ls-files', '-z', '--others', '--exclude-standard']);
  const files = [...(src.tree ? names(['ls-tree', '-r', '-z', '--name-only', src.tree]) : names(['ls-files', '-z'])), ...others];
  const tf = new Map(); // path → Map(term → count)
  const defs = new Map(); // path → Set(names defined there)
  // One pass, one alternation: definitions of the named identifiers, then the terms. Separate -e patterns or a
  // second grep make git scan again (measured: 13 s instead of 0.35 s on django). -i also matches "Class Foo";
  // the defined name itself is compared case-sensitively below.
  const ids = q.code.join('|');
  const alts = [];
  if (ids) alts.push(`(${DEF_KW})[[:space:]]+(${ids})([^A-Za-z0-9_]|$)`, `func[[:space:]]*\\([^)]*\\)[[:space:]]*(${ids})([^A-Za-z0-9_]|$)`, `(const|let|var)[[:space:]]+(${ids})[[:space:]]*=`);
  if (q.terms.size) alts.push(`(${[...q.terms.keys()].join('|')})`);
  if (!alts.length) return { files, tf, defs };
  const grep = where => git(['grep', '-o', '-i', '-I', '-E', '--null', '-e', alts.join('|'), ...where]).toString('utf8');
  // Untracked files are searched by name; a list too long for one command line falls back to a full walk.
  const out = src.tree ? grep([src.tree])
    : grep([]) + (!others.length ? '' : others.join('').length < 20000 ? grep(['--untracked', '--', ...others.map(f => ':(literal)' + f)]) : grep(['--untracked']));
  const count = (p, t) => { let m = tf.get(p); if (!m) tf.set(p, m = new Map()); m.set(t, (m.get(t) || 0) + 1); };
  for (const line of out.split('\n')) {
    const z = line.indexOf('\0'); if (z < 0) continue;
    const p = strip(line.slice(0, z)), hit = line.slice(z + 1);
    if (/[\s(=]/.test(hit)) { // a definition: terms never contain spaces, parentheses or '='
      const name = (hit.match(/[A-Za-z_]\w*(?=\W*$)|[A-Za-z_]\w*(?=\s*=)/) || [])[0];
      if (name && q.code.includes(name)) { if (!defs.has(p)) defs.set(p, new Set()); defs.get(p).add(name); }
      if (name) for (const t of parts(name)) if (q.terms.has(t)) count(p, t); // the match consumed these occurrences
      continue;
    }
    count(p, hit.toLowerCase());
  }
  return { files, tf, defs };
}

// Score files for a query from collected facts. Returns [{ path, score, why }] best first.
function score(q, { files, tf, defs }, limit = 10) {
  const N = files.length || 1;
  const s = new Map();
  const bump = (p, v, why) => { let e = s.get(p); if (!e) s.set(p, e = { score: 0, why: [] }); e.score += v; if (why && !e.why.includes(why)) e.why.push(why); };
  const suffix = ref => files.filter(f => f === ref || f.endsWith('/' + ref));
  // A traceback names the installed copy (…/site-packages/pkg/mod.py): drop leading folders until a file matches.
  for (const ref of q.paths) {
    const seg = ref.split('/');
    for (let i = 0; i < seg.length; i++) {
      const hit = suffix(seg.slice(i).join('/'));
      if (hit.length) { if (hit.length <= 5) for (const f of hit) bump(f, W.path / hit.length, 'named'); break; }
    }
  }
  for (const dot of q.dotted) {
    const p = dot.split('.');
    for (let drop = 0; drop < Math.min(3, p.length - 1); drop++) { // a.b.c may be a module, a.b's attribute c, …
      const base = p.slice(0, p.length - drop).join('/');
      const hit = ['.py', '/__init__.py', '.js', '.ts', '.go', '.rs'].flatMap(x => suffix(base + x));
      if (hit.length) { for (const f of hit) bump(f, W.module / (1 + drop) / hit.length, 'module'); break; }
    }
  }
  const defCount = new Map();
  for (const names of defs.values()) for (const n of names) defCount.set(n, (defCount.get(n) || 0) + 1);
  for (const [p, names] of defs) for (const n of names) if (defCount.get(n) <= 20) bump(p, W.def / defCount.get(n), 'defines ' + n);
  // Path tokens count as W.pathTf extra occurrences, so a file named after a term matches even without content hits.
  const pathTf = new Map();
  for (const f of files) {
    const toks = new Set(f.split(/[/.\-]/).flatMap(parts));
    for (const t of q.terms.keys()) if (toks.has(t)) { let m = pathTf.get(f); if (!m) pathTf.set(f, m = new Map()); m.set(t, W.pathTf); }
  }
  const cand = new Set([...tf.keys(), ...pathTf.keys()]);
  const df = new Map();
  for (const p of cand) for (const t of new Set([...(tf.get(p) || new Map()).keys(), ...(pathTf.get(p) || new Map()).keys()])) df.set(t, (df.get(t) || 0) + 1);
  // Document length: matched-term occurrences stand in for size (no file is read); normalised over candidates.
  const len = p => { let n = 0; for (const v of (tf.get(p) || new Map()).values()) n += v; return n + 1; };
  const avg = [...cand].reduce((a, p) => a + len(p), 0) / (cand.size || 1);
  const bm = new Map();
  let max = 0;
  for (const p of cand) {
    let v = 0;
    for (const [t, w] of q.terms) {
      const f = ((tf.get(p) && tf.get(p).get(t)) || 0) + ((pathTf.get(p) && pathTf.get(p).get(t)) || 0);
      if (!f) continue;
      const d = df.get(t);
      v += w * Math.log(1 + (N - d + 0.5) / (d + 0.5)) * f * (K1 + 1) / (f + K1 * (1 - B + B * len(p) / avg));
    }
    bm.set(p, v); if (v > max) max = v;
  }
  for (const p of cand) if (max && bm.get(p)) bump(p, bm.get(p) / max, null);
  for (const [p, e] of s) {
    if (!SOURCE.test(p)) e.score *= W.nonSource;
    if (TEST.test(p)) e.score *= W.test;
    if (VENDOR.test(p)) e.score *= W.vendor;
  }
  return [...s].map(([p, e]) => ({ path: p, score: +e.score.toFixed(3), why: e.why })).filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).slice(0, limit);
}

// The files most likely relevant to a task. Never throws: an unreadable repository gives [].
function locate(task, src, limit = 10) {
  const q = query(task);
  try { return score(q, collect(q, src), limit); } catch { return []; }
}

module.exports = { locate, query, collect, score, parts, W };
