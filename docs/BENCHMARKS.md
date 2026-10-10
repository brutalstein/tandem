# Benchmarks

The benchmarks answer three questions:

1. What does an installed Tandem cost a Claude Code session when it is idle?
2. Does the routing policy reach verified results cheaply, including when its assumptions are wrong?
3. With real providers, how does Tandem compare with simple ways of using Codex?

Each kind of evidence is labelled with what it can and cannot show. Simulated results never stand in for real-provider claims.

Environment for the numbers below:
- Windows 11 (10.0.26200), AMD Ryzen 9 8945HX (32 threads), Node 24.11.0;
- codex-cli 0.154.0 with a ChatGPT account;
- Claude Code 2.1.281;
- date: 2026-10-09.

## 1. Local overhead (deterministic, simulated Codex)

`node bench/overhead.js --out bench/data/overhead-v2.json`. The v1 numbers come from the v1.0.0 code on the same machine.

| Event | v1 median (p95) | v2 median (p95) | Notes |
|---|---|---|---|
| Node.js process start (baseline) | 33 (38) ms | 31 (33) ms | lower bound for any hook |
| PreToolUse guard, Edit, no jobs | 42 (52) ms | 39 (40) ms | runs on every Edit/Write |
| PreToolUse guard, Agent | 38 (49) ms | 36 (38) ms | |
| SessionStart hook | 43 (50) ms | 42 (46) ms | once per session |
| MCP server start + `tools/list` | 52 ms | 61 ms | once per session |
| MCP server idle | 53.6 MB RSS, 0 CPU | 49.1 MB RSS, 0 CPU | |
| `tools/list` size | 5.0 KB | 5.9 KB | tool schemas Claude sees |
| Memory search, 100 / 400 / 2,000 entries | 2.2 / 3.0 / 8.8 ms | 0.6 / 1.0 / 3.7 ms | |

The hooks cost 5–11 ms above bare Node start. The v2 MCP server starts about 9 ms slower, because it loads more modules, and its tool schemas are 0.9 KB larger. Neither is noticeable in an interactive session.

![overhead](charts/overhead.svg)

## 1c. Continuity branch vs 2.0.0 (paired, same machine, same run)

`node bench/overhead.js <root>`, both trees measured alternately twice on Windows 11 / Node 24.11.0.

| Event | 2.0.0 (two runs) | continuity branch (two runs) |
|---|---|---|
| MCP server start + `tools/list`, median | 59.6 / 54.4 ms | 57.6 / 55.8 ms |
| MCP server idle RSS | 56.3 / 56.3 MB | 56.9 / 56.8 MB |
| Idle CPU | 0 | 0 |
| PreToolUse guard, Edit, no jobs, median | 37.2 / 36.7 ms | 36.6 / 37.2 ms |
| `tools/list` size | 5.9 KB | 6.8 KB (after trimming; 7.6 KB before) |

Start-up and hook latency are unchanged within noise; idle memory +0.5 MB. The added tool schema (checkpoint, resume, takeover) costs about 0.9 KB of session context.

Per job: skill matching scans Codex skill folders (about 17 ms with 51 skills on the development machine) and adds at most three one-line pointers to the prompt, only when they match. `tandem_status` also scans Claude plugin skills (0.25–0.4 s with 460).

Real resume cost (`bench/results/real-resume-2026-10-09.txt`): the resumed turn replays the conversation: 120 k input tokens, of which 101 k cached, 343 output. The stopped turn's own usage is not reported by Codex when it is killed, so it is missing from the totals.

## 1d. Large repositories: Tandem's own per-job cost (deterministic)

`node bench/large-repo.js 3`. Setup: generated repositories, Windows 11, Node 24.11.0, simulated Codex. Each job edits one file with a trivial check. Values are medians of 3 jobs, measured from submit to done. Raw data: `bench/data/large-repo.json`.

| Layout | Files (tests) | Job in place | Job in a worktree | Test fingerprint | Check detected |
|---|---|---|---|---|---|
| Small library | 60 (12) | 1.1 s | 0.9 s | 60 ms | yes |
| Medium app | 2,000 (400) | 1.2 s | 4.3 s | 105 ms | yes |
| Large multi-module | 20,000 (4,000) | 2.5 s | 29–35 s | 510 ms | yes |
| Polyglot services, no root manifest | 3,000 (600) | 1.1 s | 4.7 s | 86 ms | yes, after the fix below; before: none |

In-place jobs stay near 1–2.5 s up to 20,000 files.

Worktree jobs grow with repository size. The breakdown at 20,000 files, profiled:
- `git worktree add`: 8.8 s;
- removing the worktree: 2.6 s;
- the first read of the 4,000 freshly checked-out test files, while they are fingerprinted: about 19 s.

The 19 s is not Tandem's code. A plain `readFileSync` of the same files takes 20 s the first time and 0.2 s the second, with Windows Defender real-time protection on. Any process that reads the new files pays it once, including the test run itself, so moving the fingerprint would only move the cost.

`isolation: auto` already runs in place unless another writer holds the same paths. On large Windows repositories, a worktree is worth it only when that isolation is needed.

**Fixed: check detection in monorepos.** Before, the check was detected at the repository root only:
- A polyglot repository with no root manifest ran every job unverified.
- A root `package.json` could supply an unrelated check for a Python service.

Now the check comes from the deepest project directory that contains all the scoped paths and has its own manifest, for example `cd services/billing && python -m pytest -q`. If no such directory exists, the root check is used.

That project's definition files are fingerprinted with the root's, so a job cannot weaken the service's own check. Tests: `unit.test.js` and `orchestrator.test.js` ("monorepo"); both fail on the previous code.

Not built:
- an index, a symbol graph or embeddings: nothing measured here needed them. Scope sizing (`contextSize`) takes under 1 ms at every size.
- any measure of how much Codex or Claude spend exploring a large repository. That is provider usage and needs real runs; the corpus task `nav-large` (300 modules) is ready for them.

## 1b. Safety overhead per job: main vs the hardening branch (deterministic)

`node bench/safety-overhead.js --server <server dir> --files <n>`. Medians in ms over 5 repetitions, Windows 11, Node 24.11.0, on a generated repository (10 % test files, 2 KB each, one dirty file, an ignored `node_modules`). No provider is called. Data: `bench/data/safety-overhead/`.

| Operation | main, 200 files | branch, 200 | main, 20,000 files | branch, 20,000 |
|---|---:|---:|---:|---:|
| git status | 33.4 | 34.1 | 41.7 | 46.9 |
| working-state snapshot | 149.5 | 162 | 176.3 | 195.2 |
| test-file fingerprint | – | 33.9 | – | 214.8 |
| worktree create + remove | 414.3 | 424.5 | 8702.2 | 8920.6 |
| integration plan, 20 files | 629.1 | 624.4 | 640.9 | 674.2 |
| integration apply, 20 files (journaled on the branch) | 7.7 | 30.4 | 8.2 | 30.4 |
| ledger transaction | 2.2 | 3 | 2.4 | 2.9 |
| concurrent-writes lookup | – | 0.3 | – | 0.3 |

What a job pays on top of main:
- **In place, with a check:** two snapshots and two test fingerprints instead of two `git status` calls: about +0.3 s at 200 files, +0.7 s at 20,000.
- **Isolated, with a check:** two test fingerprints and the journal: about +0.1 s at 200 files, +0.45 s at 20,000.
- **Isolation itself** costs 0.4 s at 200 files and 8.9 s at 20,000 per job, which is why the default stays `auto` (isolate only when another job holds the paths) rather than isolating every job.

A Codex turn takes 10–45 s in the real runs, so the added cost is small next to it.

## 2. Routing simulation (deterministic, synthetic worlds)

`node bench/router-sim.js --seeds 30 --out bench/data/router-sim.json`.
- The unmodified policy runs in five worlds whose true success curves differ from its priors.
- It is compared with fixed strategies, the v1 static table and a hindsight oracle.
- Results come from 30 seeds, with 95 % t-intervals and paired differences.

Full method and discussion: [ROUTING.md](ROUTING.md).

| | fixed-top | codex-default | cheapest-escalate | v1 static | v2 without exploration | **v2 (default)** |
|---|---|---|---|---|---|---|
| mean cost above oracle, 5 worlds | 70.0 % | 22.5 % | 39.1 % | 49.1 % | **14.6 %** | 15.7 % |
| worst world | 101.9 % | 48.5 % | 59.8 % | 59.8 % | 36.4 % | **24.3 %** |
| worlds where it is the best policy | 0 | 0 | 1 | 0 | 2 | 2 |

The world's token costs use the factors measured on real attempts (×1.08 per model tier, ×1.38 per effort step).

**What this shows.** The policy adapts when the catalog's ranking is wrong (the inverted world), when cheap models are better than expected (flat), and when models change (drift). Where its prior is right, it is 3–4 % more expensive than the best fixed strategy; that is the price of exploration.

**What it does not show.** How real models perform. The worlds are synthetic.

![routing simulation](charts/routing-regret.svg)

## 3. Real providers

`node bench/bench.js --reps N --claude-reps M --out DIR`, then `node bench/bench.js --analyze DIR` and `node bench/charts.js --real DIR/summary.json`.

### Tasks

Small but realistic. Each has an independent grader.

| Task | Mode / difficulty | Grader |
|---|---|---|
| `ask-config` | ask / trivial | The answer must name the default port (8080) and the timeout override variable (`APP_TIMEOUT_MS`), which are spread over two files |
| `slugify` | implement / normal | Tests pass in the final tree. Includes Turkish dotted/dotless i, which defeats naive diacritic stripping. Test files must be byte-identical. |
| `lru-bugs` | implement / hard | 3 planted bugs (recency, overwrite size, eviction order); tests pass and test files are unchanged |
| `review-page` | review / hard | Must identify the off-by-one introduced by the uncommitted change in `page.js` |

### Arms

| Arm | What runs |
|---|---|
| `tandem` | Tandem as shipped; routing evidence and memory persist across this arm's runs |
| `tandem-cold` | Tandem with fresh state for every run |
| `codex-default` | Plain `codex exec` as a user would run it: the catalog's first listed model, effort from the user's Codex config, no Tandem prompt or lean flags, one invocation |
| `fixed-top` | Tandem forced to the strongest permitted rung (`gpt-6-astra@xhigh`) |
| `fixed-cheap` | Tandem forced to the cheapest permitted rung (`gpt-5.6-luna@low`) |
| `tandem-nolean` | Ablation: Tandem without the lean Codex flags |
| `claude-only` | `claude -p` (Sonnet) does `lru-bugs` itself |
| `claude-tandem` | `claude -p` (Sonnet) with the Tandem server, told to delegate `lru-bugs` to Codex |

### Design

- **Fresh runs.** Every run gets a fresh copy of the task repository in a separate process.
- **Paired order.** Runs are interleaved in seeded random order within each repetition block (paired design), so provider drift affects all arms alike.
- **Isolated Claude arms.** Both Claude arms run with user and global settings, plugins and MCP servers disabled (`--setting-sources project --strict-mcp-config`), the same model and the same allowed tools apart from the delegation tools.
- **Tokens.** Codex tokens include cached input. Uncached input is reported separately. Claude-side tokens and the cost Claude Code reports are recorded for the Claude arms.
- **Statistics.**
  - Success: 95 % Wilson intervals.
  - Tokens and time: 95 % percentile bootstrap, resampling tasks and then runs.
  - Comparisons: paired by task and repetition.
- **Quota.** A provider usage limit stops the run. The cell is recorded as `unavailable`, never as a failure, and re-running the same command resumes.

### Results so far: pilot only, not statistically meaningful

The first run stopped after 8 cells, when the Codex account reached its usage limit:

> "You've hit your usage limit … try again at 4:18 PM"

Earlier work the same day had used most of the window. The pilot cells (one run each) were:

| Task | Arm | Outcome | Rung | Input tokens (cached) | Output | Seconds |
|---|---|---|---|---|---|---|
| ask-config | fixed-cheap | success | luna@low | 53,166 (49,152) | 489 | 17 |
| ask-config | tandem-nolean | success | terra@high | 182,623 (121,856) | 1,197 | 103 |
| slugify | fixed-top | success | astra@xhigh | 125,936 (101,760) | 765 | 40 |
| slugify | codex-default | success | astra, config effort | 195,842 (164,864) | 728 | 51 |
| lru-bugs | tandem | success | terra@high | 165,549 (133,376) | 2,906 | 172 |
| lru-bugs | tandem-cold | success | astra@high | 125,306 (99,968) | 1,668 | 71 |
| review-page | fixed-cheap | success | luna@low | 53,358 (13,056) | 695 | 21 |

Smoke runs from the same day give 1 run per cell, so they are indicative only:

| Task | tandem | codex-default |
|---|---|---|
| ask-config | sol@low: 45,327 in, 408 out, 14 s | astra: 80,122 in, 204 out, 17 s |
| review-page | luna@low: 39,708 in, 549 out, 14 s | astra: 123,266 in, 502 out, 26 s |

| `lru-bugs` with Claude Sonnet as lead | Claude tokens (in incl. cache / out) | Claude cost reported | Codex tokens | Seconds | Result |
|---|---|---|---|---|---|
| claude-only | 248,383 / 3,359 | $0.155 | 0 | 42 | tests pass |
| claude-tandem | 199,542 / 876 | $0.116 | 141,799 (luna@xhigh) | 88 | tests pass |

**What the pilot does and does not support.**
- **All arms solved every task they attempted.** With tasks this small, success rates cannot separate the arms. The differences are in tokens and time.
- **Fewer tokens on read-only tasks.** Tandem used fewer Codex tokens than plain `codex exec` on both read-only tasks (45k vs 80k, 40k vs 123k). It routed them to cheaper rungs, and the lean flags drop Codex's skill and plugin catalog. One run each; not yet a statistical claim.
- **Exploration on a fresh install can be expensive.** A fresh Tandem explored `terra@high` for a trivial question (183k tokens, 103 s, `tandem-nolean`). Tandem with persistent evidence chose `terra@high` for the hard `lru-bugs` task and took 172 s, against 71 s for a cold start that happened to pick `astra@high`.
  - These observations led to a cost prior refitted on the 24 real attempts (effort matters much more than the model tier) and a tighter exploration threshold (1.5 → 1.25). See [ROUTING.md](ROUTING.md#4-calibration-from-real-runs). A fresh install now starts at `astra@low`.
  - They also show the time cost of choosing a slower rung, which the `objective` setting controls.
- **Delegation moves work from Claude to Codex; it does not remove it.** With Claude as lead, delegating cut Claude's output tokens 74 % and its reported cost 25 %, but added 142k Codex tokens and doubled the wall time.
  - Whether that trade is worth it depends on the relative price of your Claude and Codex quotas. Tandem does not convert subscription quotas into money, because no reliable conversion exists.

Raw rows: `bench/data/real-v2-pilot/runs.jsonl` (routing policy before the calibration in ROUTING.md §4). Run metadata: `bench/data/real-v2-pilot/meta.json`.

<!-- REAL-RESULTS -->

## Reproduce

```bash
node bench/overhead.js --out bench/data/overhead-v2.json
```

```bash
node bench/router-sim.js --seeds 30 --out bench/data/router-sim.json
```

```bash
node bench/bench.js --reps 3 --claude-reps 2 --out bench/data/real-v2
```

```bash
node bench/charts.js --real bench/data/real-v2/summary.json
```

`bench/bench.js` consumes Codex quota (and Claude quota with `--claude-reps`). It never runs in automatic CI; the `real-provider` workflow runs it only when triggered manually.
