#!/usr/bin/env node
'use strict';
// Renders benchmark results as self-contained SVGs (light/dark aware) into docs/charts/.
//   node bench/charts.js [--sim bench/data/router-sim.json] [--overhead bench/data/overhead-v2.json]
//                        [--overhead-v1 bench/data/overhead-v1.json] [--real bench/runs/<name>/summary.json]
// Every input is optional; charts are produced for the inputs that exist. No dependencies.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(ROOT, 'docs', 'charts')));
const load = f => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STYLE = `<style>
  .bg{fill:#ffffff}.t{fill:#1f2328;font:600 15px system-ui,-apple-system,"Segoe UI",sans-serif}
  .s{fill:#59636e;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}.l{fill:#1f2328;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}
  .g{fill:#59636e;font:600 11px system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.04em;text-transform:uppercase}
  .v{fill:#1f2328;font:11px ui-monospace,"Cascadia Mono",Menlo,monospace}.ax{stroke:#d1d9e0}.grid{stroke:#eff2f5}
  .b{fill:#8c959f}.h{fill:#0969da}.w{stroke:#1f2328;stroke-width:1.2}.ref{stroke:#cf222e;stroke-dasharray:3 3}
  @media (prefers-color-scheme:dark){.bg{fill:#0d1117}.t,.l,.v{fill:#e6edf3}.s,.g{fill:#9198a1}.ax{stroke:#3d444d}.grid{stroke:#21262d}
  .b{fill:#656c76}.h{fill:#4493f8}.w{stroke:#e6edf3}.ref{stroke:#f85149}}
</style>`;

// Horizontal bars with optional 95% CI whiskers, grouped. Bars with `highlight` are drawn in the accent colour.
function bars({ title, subtitle, unit, groups, fmt = v => v.toFixed(0), ref = null, note }) {
  const valueText = b => fmt(b.value) + (Number.isFinite(b.lo) ? ` [${fmt(b.lo)}, ${fmt(b.hi)}]` : '');
  const valueW = 16 + 6.7 * Math.max(...groups.flatMap(g => g.bars.map(b => valueText(b).length))); // monospace 11px
  const W = 760, labelW = 190, plotX = labelW + 12, plotW = W - plotX - valueW, row = 22, gap = 14;
  const vals = groups.flatMap(g => g.bars.flatMap(b => [b.value, b.lo, b.hi].filter(Number.isFinite)));
  const lo = Math.min(0, ...vals, ref ?? 0), hi = Math.max(...vals, ref ?? 0) * 1.05 || 1;
  const x = v => plotX + ((v - lo) / (hi - lo)) * plotW;
  const ticks = niceTicks(lo, hi, 5);
  let y = 64, body = '';
  for (const g of groups) {
    if (g.label) { body += `<text class="g" x="16" y="${y + 4}">${esc(g.label)}</text>`; y += 14; }
    for (const b of g.bars) {
      const x0 = x(Math.max(lo, 0)), x1 = x(b.value);
      body += `<text class="l" x="${labelW}" y="${y + 14}" text-anchor="end">${esc(b.label)}</text>`;
      body += `<rect class="${b.highlight ? 'h' : 'b'}" x="${Math.min(x0, x1)}" y="${y + 4}" width="${Math.max(1, Math.abs(x1 - x0))}" height="${row - 8}" rx="2"/>`;
      if (Number.isFinite(b.lo) && Number.isFinite(b.hi)) {
        const c = y + row / 2;
        body += `<path class="w" d="M${x(b.lo)} ${c}H${x(b.hi)}M${x(b.lo)} ${c - 4}V${c + 4}M${x(b.hi)} ${c - 4}V${c + 4}"/>`;
      }
      body += `<text class="v" x="${plotX + plotW + 8}" y="${y + 14}">${esc(valueText(b))}</text>`;
      y += row;
    }
    y += gap;
  }
  const top = 52, bottom = y - gap + 4;
  let grid = '';
  for (const t of ticks) grid += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${bottom}"/><text class="s" x="${x(t)}" y="${bottom + 16}" text-anchor="middle">${esc(fmt(t))}</text>`;
  if (ref !== null) grid += `<line class="ref" x1="${x(ref)}" x2="${x(ref)}" y1="${top}" y2="${bottom}"/>`;
  const H = bottom + 30 + (note ? 18 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">${STYLE}
<rect class="bg" width="${W}" height="${H}"/>
<text class="t" x="16" y="24">${esc(title)}</text><text class="s" x="16" y="42">${esc(subtitle)}${unit ? ' · ' + esc(unit) : ''}</text>
${grid}<line class="ax" x1="${x(Math.max(lo, 0))}" x2="${x(Math.max(lo, 0))}" y1="${top}" y2="${bottom}"/>
${body}${note ? `<text class="s" x="16" y="${H - 10}">${esc(note)}</text>` : ''}
</svg>
`;
}

function niceTicks(lo, hi, n) {
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}

const written = [];
const save = (name, svg) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), svg); written.push(name); };

// ---- routing simulation: cost relative to the hindsight oracle ----
const sim = load(opt('--sim', path.join(ROOT, 'bench', 'data', 'router-sim.json')));
if (sim) {
  const show = ['fixed-top', 'codex-default', 'cheapest-escalate', 'v1-static', 'v2-mean', 'v2-thompson'];
  const groups = Object.entries(sim.worlds).map(([w, d]) => {
    const o = d.policies.oracle.cost;
    return { label: `${w} world`, bars: show.filter(p => d.policies[p]).map(p => ({ label: p, value: 100 * (d.policies[p].cost / o - 1), lo: 100 * (d.policies[p].costCI[0] / o - 1), hi: 100 * (d.policies[p].costCI[1] / o - 1), highlight: p === 'v2-thompson' })) };
  });
  save('routing-regret.svg', bars({ title: 'Routing simulation: cost above the hindsight oracle', subtitle: `${sim.meta.seeds} seeds per world, 95% t-intervals; lower is better`, unit: '% extra token-equivalent cost', groups, fmt: v => v.toFixed(0) + '%', note: 'Simulated provider (synthetic success curves). Shows adaptation to mis-specified priors; it does not prove real model behaviour.' }));
}

// ---- local overhead v1 vs v2 ----
const ov2 = load(opt('--overhead', path.join(ROOT, 'bench', 'data', 'overhead-v2.json')));
const ov1 = load(opt('--overhead-v1', path.join(ROOT, 'bench', 'data', 'overhead-v1.json')));
if (ov2) {
  const items = [['nodeSpawnBaseline', 'node start (baseline)'], ['guardEditNoJobs', 'PreToolUse guard (Edit)'], ['guardAgent', 'PreToolUse guard (Agent)'], ['sessionStart', 'SessionStart hook']];
  const pick = (d, k) => (k === 'mcp' ? d.mcp.initAndToolsList : d[k]);
  const groups = [...items, ['mcp', 'MCP start + tools/list']].map(([k, label]) => ({ label, bars: [ov1 && { label: 'v1.0.0', value: pick(ov1, k).p50, lo: pick(ov1, k).min, hi: pick(ov1, k).p95 }, { label: 'v2.0.0', value: pick(ov2, k).p50, lo: pick(ov2, k).min, hi: pick(ov2, k).p95, highlight: true }].filter(Boolean) }));
  save('overhead.svg', bars({ title: 'Local overhead per event', subtitle: `median, whisker min–p95 · ${ov2.platform}, ${ov2.node}`, unit: 'milliseconds', groups, fmt: v => v.toFixed(0), note: 'Measured with a simulated Codex; includes Node.js process start (see baseline).' }));
}

// ---- real-provider benchmark ----
const real = load(opt('--real', null));
if (real) {
  const arms = Object.entries(real.arms);
  const hl = a => a === 'tandem';
  save('real-success.svg', bars({ title: 'Real benchmark: task success rate', subtitle: `n runs per arm shown in label; 95% Wilson intervals`, groups: [{ bars: arms.map(([a, s]) => ({ label: `${a} (n=${s.n})`, value: 100 * s.successRate, lo: 100 * s.successCI[0], hi: 100 * s.successCI[1], highlight: hl(a) })) }], fmt: v => v.toFixed(0) + '%' }));
  save('real-tokens.svg', bars({ title: 'Real benchmark: Codex tokens per run', subtitle: 'input + output tokens (cached input included); 95% task-clustered bootstrap', groups: [{ bars: arms.map(([a, s]) => ({ label: a, value: s.codexTokens / 1000, lo: s.codexTokensCI[0] / 1000, hi: s.codexTokensCI[1] / 1000, highlight: hl(a) })) }], unit: 'thousand tokens', fmt: v => v.toFixed(0) + 'k' }));
  save('real-time.svg', bars({ title: 'Real benchmark: time per task', subtitle: 'wall-clock seconds per run; 95% task-clustered bootstrap', groups: [{ bars: arms.map(([a, s]) => ({ label: a, value: s.wallSec, lo: s.wallSecCI[0], hi: s.wallSecCI[1], highlight: hl(a) })) }], unit: 'seconds', fmt: v => v.toFixed(0) + 's' }));
  const pairs = Object.entries(real.paired || {});
  if (pairs.length) save('real-paired.svg', bars({ title: 'Real benchmark: Tandem relative to each baseline (paired)', subtitle: 'ratio of mean Codex tokens, Tandem ÷ baseline, same task and repetition; < 1 means Tandem used fewer', groups: [{ bars: pairs.map(([a, p]) => ({ label: `vs ${a} (${p.pairs} pairs)`, value: p.tandemTokensRatio, lo: p.ratioCI[0], hi: p.ratioCI[1], highlight: true })) }], ref: 1, fmt: v => '×' + v.toFixed(2), note: 'Red dashed line = parity. Intervals: percentile bootstrap resampling tasks, then runs.' }));
}

console.log(written.length ? `wrote ${written.map(w => path.join(path.relative(ROOT, OUT), w)).join(', ')}` : 'no inputs found');
