'use strict';
// Capability registry: the skills installed for Codex and Claude Code, found where those tools
// themselves look (no network, no execution). Used to point a Codex worker at the few skills relevant
// to its task: lean mode hides Codex's own skill list to save context, so without this a relevant
// skill would go unused. Installing is explicit (bin/tandem.js skills add), project-local and pinned.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeJson, withLock } = require('./store');

const HOME = process.env.TANDEM_HOME || os.homedir(); // overridable so tests never read the developer's skills
const MAX_SKILL_BYTES = 256 * 1024;

// Top-level scalar keys of a YAML front matter block: plain, quoted, and folded/literal (> |) values.
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      v = block.join(v[0] === '>' ? ' ' : '\n').trim();
    } else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

// Where each tool loads skills from (official locations; plugin skills via Claude Code's own registry).
function locations(root) {
  const L = [
    { dir: path.join(root, '.agents', 'skills'), platform: 'codex', scope: 'project' },
    { dir: path.join(HOME, '.agents', 'skills'), platform: 'codex', scope: 'user' },
    { dir: path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills'), platform: 'codex', scope: 'user' },
    { dir: path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills', '.system'), platform: 'codex', scope: 'system' },
    { dir: path.join(root, '.claude', 'skills'), platform: 'claude', scope: 'project' },
    { dir: path.join(HOME, '.claude', 'skills'), platform: 'claude', scope: 'user' },
  ];
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const enabled = reg.enabledPlugins || {};
    for (const [id, installs] of Object.entries(reg.plugins || {})) {
      if (enabled[id] === false) continue;
      for (const inst of [].concat(installs)) {
        if (inst && inst.installPath) L.push({ dir: path.join(inst.installPath, 'skills'), platform: 'claude', scope: 'plugin', plugin: id, version: inst.version || null, ref: inst.gitCommitSha || null });
      }
    }
  } catch {}
  return L;
}

// A partially written skill lock must never be treated as an empty allow-list:
 // doing so loses ownership records and makes safe rollback impossible. Read the
 // last good backup, but fail closed if both copies exist and are invalid.
function readLock(root) {
  const file = path.join(root, '.agents', 'skills', 'tandem-lock.json');
  if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return {};
  for (const p of [file, file + '.bak']) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (d && d.v === 1 && d.skills && typeof d.skills === 'object' && !Array.isArray(d.skills)) return d.skills;
    } catch {}
  }
  throw new Error('Tandem skill lock is corrupt; refusing changes. Restore tandem-lock.json or its .bak');
}

// Inventory, deduplicated by name (first location wins: project before user before plugin) and by content.
function scan(root, platforms = ['codex', 'claude']) {
  let lock;
  try { lock = readLock(root); } catch { lock = {}; } // discovery remains available; mutations fail closed
  const seen = new Map(), hashes = new Set(), dupes = [];
  for (const loc of locations(root).filter(l => platforms.includes(l.platform))) {
    let names;
    try { names = fs.readdirSync(loc.dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const dir = path.join(loc.dir, d.name), file = path.join(dir, 'SKILL.md');
      let text;
      try { if (fs.statSync(file).size > MAX_SKILL_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fm = frontMatter(text);
      const name = fm.name || d.name;
      const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
      const key = `${loc.platform}:${name}`;
      if (seen.has(key) || hashes.has(loc.platform + hash)) { dupes.push(`${name} (${loc.scope})`); continue; }
      hashes.add(loc.platform + hash);
      let implicit = !/^true$/i.test(fm['disable-model-invocation'] || '');
      try { if (/allow_implicit_invocation:\s*false/.test(fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8'))) implicit = false; } catch {}
      seen.set(key, {
        name, platform: loc.platform, scope: loc.scope, plugin: loc.plugin || null, path: file, hash, bytes: text.length,
        description: String(fm.description || '').replace(/\s+/g, ' ').slice(0, 600), whenToUse: String(fm.when_to_use || '').replace(/\s+/g, ' ').slice(0, 400),
        version: loc.version || fm.version || null, ref: loc.ref || (lock[name] && lock[name].ref) || null,
        trust: loc.scope === 'project' ? (lock[name] ? 'pinned' : 'project') : loc.scope,
        hasScripts: fs.existsSync(path.join(dir, 'scripts')), implicit,
      });
    }
  }
  return { skills: [...seen.values()], dupes };
}

const tokens = s => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) || []).filter(t => !STOP.has(t));
const STOP = new Set('the and for with use when this that you your from are any all not into via can will should must also more use used using user users file files code task tasks skill skills'.split(' '));

// BM25 over name + description. Only skills Codex may load implicitly; at most k, and only clear matches
// (two or more distinct query terms), so an unrelated task gets no skill text at all.
function select(task, skills, k = 3) {
  const docs = skills.filter(s => s.platform === 'codex' && s.implicit).map(s => ({ s, t: tokens(`${s.name.replace(/[-_]/g, ' ')} ${s.description} ${s.whenToUse}`) }));
  if (!docs.length) return [];
  const q = [...new Set(tokens(task))];
  const avg = docs.reduce((a, d) => a + d.t.length, 0) / docs.length;
  const df = t => docs.filter(d => d.t.includes(t)).length;
  const idf = Object.fromEntries(q.map(t => [t, Math.log(1 + (docs.length - df(t) + 0.5) / (df(t) + 0.5))]));
  return docs.map(d => {
    let score = 0, hits = 0;
    for (const t of q) {
      const f = d.t.filter(x => x === t).length;
      if (!f) continue;
      hits++;
      score += idf[t] * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.t.length / avg));
    }
    return { s: d.s, score, hits };
  }).filter(x => x.hits >= 2 && x.score > 2).sort((a, b) => b.score - a.score)
    .filter((x, i, all) => x.score >= all[0].score / 2).slice(0, k).map(x => x.s); // drop the weak tail
}

// Observed effectiveness: outcomes of jobs whose worker was pointed at each skill.
function usage(jobs) {
  const u = {};
  for (const j of jobs) for (const n of j.skills || []) {
    const x = u[n] = u[n] || { jobs: 0, verified: 0, answered: 0 };
    x.jobs++;
    if (j.status === 'verified') x.verified++; // only a genuine passing check counts
    if (j.status === 'answered') x.answered++; // not independent verification
  }
  return u;
}

// ---- explicit, project-local, pinned installs (bin/tandem.js skills ...) ----
// Never global, never automatic: the user runs the command. A skill is copied into
// <root>/.agents/skills/<name> (where Codex looks), its exact content hash and source revision are
// recorded in tandem-lock.json, one previous version is kept for rollback.
const SKILLS = root => path.join(root, '.agents', 'skills');
const LOCK = root => path.join(SKILLS(root), 'tandem-lock.json');
const EXEC = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|exe|dll|so|dylib|py|js|mjs|cjs|ts|rb|pl|php)$/i;

// Regular files only (a link could pull in anything); bounded size.
function listFiles(dir, rel = '', out = []) {
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.name === '.git') continue;
    if (d.isSymbolicLink()) throw new Error(`refusing a skill with a link: ${p}`);
    if (d.isDirectory()) listFiles(dir, p, out);
    else if (d.isFile()) out.push(p);
    if (out.length > 500) throw new Error('skill has more than 500 files');
  }
  return out;
}
function treeHash(dir, files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) h.update(f + '\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
  return h.digest('hex');
}
const writeLock = (root, lock) => {
  fs.mkdirSync(SKILLS(root), { recursive: true });
  writeJson(LOCK(root), { v: 1, skills: lock });
};

function installUnlocked(root, src, { source, ref = null, allowScripts = false, force = false }) {
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`no SKILL.md in ${src}`);
  const fm = frontMatter(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'));
  const name = fm.name || path.basename(src);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error(`unsafe skill name "${name}"`);
  if (!fm.description) throw new Error('SKILL.md has no description');
  const files = listFiles(src);
  const bytes = files.reduce((a, f) => a + fs.statSync(path.join(src, f)).size, 0);
  if (bytes > 5 << 20) throw new Error('skill is larger than 5 MB');
  const exec = files.filter(f => EXEC.test(f) || f.startsWith('scripts/'));
  if (exec.length && !allowScripts) throw new Error(`skill contains executable content (${exec.slice(0, 5).join(', ')}); Codex may run it. Review it, then pass --allow-scripts`);
  const lock = readLock(root), dst = path.join(SKILLS(root), name), prev = path.join(SKILLS(root), `.${name}.prev`);
  if (fs.existsSync(dst) && !lock[name]) throw new Error(`${dst} exists and was not installed by tandem; not touching it`);
  if (fs.existsSync(dst) && !force) throw new Error(`${name} is installed (${lock[name].ref || lock[name].sha256.slice(0, 12)}); pass --force to replace it (the current version is kept for rollback)`);
  const tmp = path.join(SKILLS(root), `.${name}.${process.pid}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.copyFileSync(path.join(src, f), path.join(tmp, f)); }
  const sha256 = treeHash(tmp, files);
  if (fs.existsSync(dst)) { fs.rmSync(prev, { recursive: true, force: true }); fs.renameSync(dst, prev); }
  fs.renameSync(tmp, dst);
  lock[name] = { source: String(source), ref, sha256, files: files.length, executable: exec.length > 0, installed: new Date().toISOString(), prev: lock[name] ? { ...lock[name], prev: undefined } : null };
  writeLock(root, lock);
  return { name, path: dst, files: files.length, sha256, executable: exec };
}

function verifyInstalled(root) {
  return Object.entries(readLock(root)).map(([name, e]) => {
    const dir = path.join(SKILLS(root), name);
    try { const got = treeHash(dir, listFiles(dir)); return { name, ok: got === e.sha256, reason: got === e.sha256 ? null : 'content changed since install' }; }
    catch (err) { return { name, ok: false, reason: err.message }; }
  });
}

function uninstallUnlocked(root, name) {
  const lock = readLock(root);
  if (!lock[name]) throw new Error(`${name} was not installed by tandem`);
  fs.rmSync(path.join(SKILLS(root), name), { recursive: true, force: true });
  fs.rmSync(path.join(SKILLS(root), `.${name}.prev`), { recursive: true, force: true });
  delete lock[name];
  writeLock(root, lock);
}

function rollbackUnlocked(root, name) {
  const lock = readLock(root), e = lock[name];
  const dir = path.join(SKILLS(root), name), prev = path.join(SKILLS(root), `.${name}.prev`);
  if (!e || !e.prev || !fs.existsSync(prev)) throw new Error(`no previous version of ${name} to roll back to`);
  const swap = dir + '.swap';
  fs.renameSync(dir, swap); fs.renameSync(prev, dir); fs.renameSync(swap, prev);
  lock[name] = { ...e.prev, prev: { ...e, prev: undefined } };
  writeLock(root, lock);
  return lock[name];
}

// Skill directory moves and their ownership manifest form one transaction. A
// project-scoped cross-process lock prevents concurrent installs/rollbacks/uninstalls
// from deleting each other's active or previous versions.
function install(root, src, opts) { return withLock(LOCK(root), () => installUnlocked(root, src, opts)); }
function uninstall(root, name) { return withLock(LOCK(root), () => uninstallUnlocked(root, name)); }
function rollback(root, name) { return withLock(LOCK(root), () => rollbackUnlocked(root, name)); }

module.exports = { frontMatter, locations, scan, select, usage, readLock, tokens, install, verifyInstalled, uninstall, rollback };
