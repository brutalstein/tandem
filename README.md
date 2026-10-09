# Tandem: Codex as a background worker for Claude Code

Tandem is a Claude Code plugin. Claude Code stays your only interface and the lead engineer. When a unit of work is well-scoped, Claude hands it to OpenAI Codex. Tandem then:

1. picks the Codex model and reasoning effort with the lowest expected cost of a *verified* result;
2. runs Codex in the background, in place or in an isolated git worktree;
3. checks the result with your own tests;
4. escalates when the check fails;
5. merges the result safely and records what was learned in shared project memory.

There are no extra windows and no prompts to copy between tools. Tandem needs only Node.js, Git and the two official CLIs, and has no third-party dependencies.

> Status: 2.0.0, safety-hardening branch under review; run the regression and real-provider checks before release. See [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) for what is verified and what is not.

## Requirements

| | Version | Notes |
|---|---|---|
| Claude Code | 2.1.221 or later | tested with 2.1.281 |
| Node.js | 20 or later | tested with 22 (Linux) and 24 (Windows); CI also runs 20 |
| Git | any recent | `implement` jobs need a git repository, so every change can be reviewed and reverted |
| OpenAI Codex CLI | tested with 0.154.0 | `npm i -g @openai/codex`, then `codex login` |

Tandem works with whatever Codex models your account offers. It reads the live catalog and never assumes a model exists.

## Install

From a clone of this repository:

```bash
claude plugin marketplace add /path/to/tandem
```

```bash
claude plugin install tandem@tandem-local
```

Restart Claude Code and run `/tandem:status`. It shows:
- the Codex version and login state;
- the models Tandem may use, and why it excludes any others;
- routing estimates and recent errors.

To try Tandem for one session without installing it:

```bash
claude --plugin-dir /path/to/tandem
```

Uninstall with `claude plugin uninstall tandem@tandem-local`. Tandem's data directory (memory, routing evidence) is kept. Delete it yourself if you want it gone; `/tandem:status` shows where it is.

## Configure (optional)

The defaults work. To change an option, use the `/plugin` configure flow in Claude Code, or set it at install time with `claude plugin install tandem@tandem-local --config objective=tokens`.

| Option | Default | Meaning |
|---|---|---|
| `codex_max_model` | `gpt-6.1-sol` | Highest Codex model Tandem may select. Ordered by generation, then family (`luna < terra < sol < astra`). A model that cannot be ranked is excluded and reported. |
| `codex_allowed_models` | empty | Exact list of Codex models Tandem may use. When set, replaces the ceiling. |
| `codex_max_effort` | `xhigh` | Highest reasoning effort. `max` and `ultra` are never used unless you raise this. |
| `claude_max_model` | `opus` | Highest Claude model for subagents. A subagent requested above it is denied. |
| `max_parallel` | `0` (auto, 1–3) | Concurrent Codex jobs, counted across all Claude sessions on the project |
| `isolation` | `auto` | `auto`: edit in place, or in an isolated worktree when another job holds the paths. `worktree`: always isolate (safer, with setup cost per job). `inplace`: never isolate. |
| `worktree_links` | `node_modules, .venv, venv` | Dependency folders linked into isolated worktrees so checks can run there. Writes through a link reach your real folder, as an in-place job's would; cleanup never follows links. `none` disables linking. |
| `objective` | `balanced` | What routing minimises: `tokens`, `time`, or both |
| `lean_codex` | `true` | Drops Codex's skill and plugin catalogs from delegated runs. Your `AGENTS.md`, rules, sandbox and hooks still apply. |

Tandem never edits `~/.codex/config.toml` or any other global setting. Every Codex option is passed per run.

## Use

Work normally. For multi-step work Claude loads the `tandem:orchestrate` skill and chooses, per unit of work, one of three routes:
- do it itself;
- send a cheap Claude subagent (`tandem:scout`, read-only; `tandem:builder`, bounded edits);
- delegate to Codex, in parallel when units own different files.

| Command | Purpose |
|---|---|
| `/tandem:status` | Environment, permitted and excluded models, availability, routing evidence, memory, jobs, kept worktrees, recent errors |
| `/tandem:delegate <task>` | Hand a task to Codex explicitly, with verification |
| `/tandem:review [focus]` | Independent Codex review of uncommitted changes; Claude confirms each finding |
| `/tandem:memory [query\|audit]` | Search or curate shared project memory |

MCP tools Claude uses:
- `codex_run`: `mode` ask, implement or review; `difficulty`; `paths`; `verify`; `isolation`; `after`; `dry_run`.
- `codex_wait`.
- `codex_jobs`: list, show, cancel, discard.
- `memory_search`, `memory_write`, `memory_update`.
- `tandem_status`.

## How it works

- **Routing.**
  - Eligible models come from the live catalog under your ceilings.
  - A success model, learned from your own project's verified outcomes, estimates each `model@effort`'s chance of success. A dynamic program chooses the escalation sequence with the lowest expected total cost.
  - The catalog's ranking is only a weak prior. If a cheaper model keeps succeeding, the evidence wins.
  - Details and the simulation study: [docs/ROUTING.md](docs/ROUTING.md).
- **Verification.**
  - Implement jobs are checked with your tests (`verify`, or auto-detected), never with Codex's own claim.
  - If the job changes a test file, a test definition, or deletes a test, the result is downgraded to `unverified`. An in-place scope violation fails verification and requires manual review.
- **Isolation.**
  - Implement jobs run in an isolated git worktree by default; overlapping `auto` jobs may queue or isolate. Dependency-directory symlinks are disabled by default because they could expose original project files to writes. You can explicitly opt in through `TANDEM_WORKTREE_LINKS` if you accept that risk. Your HEAD, index and branches are never touched.
  - Results are merged three-way per file. If you edited the same lines, nothing is written and you get a `conflict` with the kept worktree.
- **Coordination.**
  - A lock-protected ledger shared by all Claude sessions on the project prevents overlapping writers and enforces the global parallelism limit.
  - It recovers from crashes through leases.
  - Claude's own edits to files a job owns are blocked by a hook.
- **Memory.**
  - Decisions, constraints, facts and issues, with provenance and confidence.
  - An entry is marked stale when a cited file's content changes.
  - Codex's findings enter memory as tentative until Claude confirms them.
- **Failures.**
  - A model your account cannot use is skipped and remembered.
  - A usage limit pauses delegation until the reset time. Tandem never retries in a loop or works around quotas, and Claude continues alone.
  - Timeouts and cancels kill the whole process tree.

Architecture, guarantees and state layout: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Security model: [SECURITY.md](SECURITY.md).

## Measured results

- **Overhead.** An idle Tandem adds 5–11 ms per hook call above Node.js start, and about 61 ms of MCP start-up per session. The idle server uses 49 MB RSS and no CPU.
- **Routing robustness (simulation, 30 seeds × 5 worlds).** Average cost is 15.7 % above a hindsight oracle and the worst case is 24.3 %. For comparison:
  - always using the strongest model at medium effort: 22.5 % average, 48.5 % worst;
  - always using the strongest model at maximum effort: 70 % average, 102 % worst;
  - v1's static table: 49 % average, 60 % worst.

  When the catalog's ranking is right, a fixed strong-model strategy is 3–4 % cheaper. Simulated worlds show adaptation, not real model quality.
- **Real providers (pilot, one run per cell; not yet statistically meaningful).** All arms solved all tasks.
  - On two read-only tasks, Tandem used 44 % and 68 % fewer Codex tokens than plain `codex exec`.
  - With Claude as lead, delegation cut Claude's output tokens by 74 % and its reported cost by 25 %. It added 142k Codex tokens and doubled the wall time: delegation moves work, it does not make it free.

  A repeated run with confidence intervals is in progress.

Methods, raw data and every number: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/tandem:status`: Codex not installed | `npm i -g @openai/codex`; make sure `codex` is on the PATH Claude Code sees |
| "not logged in" | Run `codex login`; Tandem re-checks within a minute |
| No permitted model | No catalog model is within `codex_max_model`. Raise the ceiling or set `codex_allowed_models`; `/tandem:status` lists every exclusion with its reason. |
| Jobs end `codex_unavailable` (rate limit) | Wait for the reset time shown in `/tandem:status`; Claude works alone meanwhile |
| An edit is blocked by Tandem | A running job owns that file: `codex_wait` for it, or cancel it with `codex_jobs` |
| A job ended `conflict` | You changed the same lines while it ran. Nothing was written. Inspect the kept worktree (path in the result), then `codex_jobs` → `discard`. |
| `codex exec` fails outside Tandem with an unsupported model | Your `~/.codex/config.toml` default model is not available to your account. Tandem always passes `-m`, so it is unaffected. |

## Development

```bash
npm test
```

This runs the deterministic suite: a deterministic test suite against a simulated Codex CLI. It needs no account. CI runs it on Linux, macOS and Windows.

Scripts that use real providers consume quota and never run automatically. They are listed in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
