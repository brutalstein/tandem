# Tandem — Claude Code + OpenAI Codex orchestration

Tandem is a Claude Code plugin that runs OpenAI Codex as a background worker. You keep working in Claude Code as usual. Claude stays the lead engineer. It decides when to hand a well-scoped unit of work to Codex. Tandem then picks the cheapest Codex model and reasoning effort likely to succeed, runs the job, checks the result with your tests, escalates when the check fails, and shares what was learned with every agent through project memory.

No extra windows, no copying prompts between tools, and no third-party dependencies (only Node.js and the two official CLIs).

## Requirements

- Claude Code 2.1.221 or later (developed and tested on 2.1.281, Windows 11)
- Node.js 18 or later on `PATH` (tested with 24.11)
- OpenAI Codex CLI, logged in: `npm i -g @openai/codex`, then `codex login` (tested with 0.154.0 and a ChatGPT login)
- Git, for `implement` jobs. Tandem refuses to let Codex write outside a git repository unless you pass `allow_non_git`, so every change can be reviewed and reverted.

## Install

From any terminal:

```bash
claude plugin marketplace add "C:\Users\cenke\OneDrive\Desktop\empty"
```

```bash
claude plugin install tandem@tandem-local
```

Restart Claude Code. To try it for one session without installing:

```bash
claude --plugin-dir "C:\Users\cenke\OneDrive\Desktop\empty"
```

Check it with `/tandem:status`. It shows the Codex version and login state, the models your account can use, the routing ladder, and any rate-limit state.

## Configure (optional)

The defaults work. To change them, edit Tandem's rows in `/config`.

| Option | Default | Meaning |
|---|---|---|
| `codex_max_model` | `gpt-6.1-sol` | Highest Codex model Tandem may select. Compared by generation first, then family `luna < terra < sol < astra`. With the default, `gpt-6-astra` (older generation) is allowed; `gpt-6.1-astra` and any `gpt-7-*` are not. |
| `codex_max_effort` | `xhigh` | Highest Codex reasoning effort. `max`/`ultra` are never chosen unless you raise this. |
| `claude_max_model` | `opus` | Highest Claude model for subagents. A subagent request above it (for example `fable`) is denied by a hook. |
| `max_parallel` | `0` (auto) | Concurrent Codex jobs; auto = 1–3 from CPU count. |
| `lean_codex` | `true` | Removes Codex's skill and plugin catalogs from delegated runs (measured −35 % input tokens on a trivial prompt, −34 % on a real read-only task). Your `AGENTS.md`, rules, sandbox and hooks still apply. |

Tandem never edits `~/.codex/config.toml`. Every setting is applied per run with `-c` overrides.

## Daily use

Work normally. For multi-step tasks Claude loads the `tandem:orchestrate` skill and decides per unit of work:

- do it itself (small, ambiguous, or architectural work),
- send a cheap Claude subagent (`tandem:scout`, Haiku, read-only exploration; `tandem:builder`, Sonnet, bounded edits),
- or delegate to Codex (`codex_run`), in parallel when units own disjoint files.

Slash commands:

| Command | Purpose |
|---|---|
| `/tandem:status` | Environment, models, ladder, rate limits, learned routing stats, jobs |
| `/tandem:delegate <task>` | Explicitly hand a task to Codex, with verification |
| `/tandem:review [focus]` | Independent Codex review of uncommitted changes; Claude confirms each finding |
| `/tandem:memory [query\|audit]` | Search or curate shared project memory |

MCP tools (Claude calls these): `codex_run`, `codex_wait`, `codex_jobs`, `memory_search`, `memory_write`, `memory_update`, `tandem_status`.

## How it works

```
Claude Code session (lead)
 ├─ SessionStart hook ── injects a short brief: Codex readiness + key decisions/constraints/open issues
 ├─ PreToolUse guard ─── denies edits to files a running Codex job owns; denies over-ceiling subagent models
 ├─ skill tandem:orchestrate, agents tandem:scout / tandem:builder
 └─ MCP server "tandem" (node, stdio, zero deps)
     ├─ discovery   codex --version · codex login status · codex debug models (live catalog, cached 6 h)
     ├─ router      catalog -> ceiling filter -> cost ladder -> start rung by difficulty (+ learned offset)
     ├─ jobs        queue, path ownership, codex exec --json, verify, escalate, resume, cancel, recovery
     └─ memory      typed entries, dedupe, supersede, staleness, bounded size, BM25 search
```

**Routing.** The ladder is built from the live catalog, never from a fixed list. Hidden models and models above the ceiling are skipped, and only the newest version of each family is kept. Each model contributes a few effort rungs, so with today's catalog the ladder is `gpt-5.6-luna@low < … < gpt-5.6-terra@medium < … < gpt-5.6-sol@high < gpt-6-astra@medium < … @xhigh`. Claude states a difficulty (trivial / normal / hard / critical), which maps to a starting rung. Tandem records whether the first attempt succeeded, per mode and difficulty. After 4+ recent failures it starts one rung higher. After a long success streak it tries one rung cheaper. This optimizes the total cost of a verified result, not the cost per call.

**Verification and escalation.** For `implement` jobs Tandem runs a check itself: `verify`, or auto-detected `npm test` / `pytest` / `cargo test` / `go test`. It never relies on Codex's own claim. If the check fails, the next attempt moves one rung up. On the same model it resumes the Codex thread (cached context, cheaper); on a new model it starts fresh with the previous summary and the failure output. Final states:

| State | Meaning |
|---|---|
| `verified` | Tandem's check ran and passed, and Codex reported done |
| `unverified` | Codex reported done, but no check was available or requested |
| `failed_verification` | The check still failed after the allowed attempts |
| `partial`, `failed`, `blocked` | Codex reported it did not finish |
| `answered` | ask/review job completed |
| `codex_unavailable` | Not installed, not logged in, no usable model, or rate-limited. Claude does the work itself. |
| `cancelled`, `interrupted`, `rejected` | Cancelled, server died mid-job, or request above a ceiling |

Changed files are measured with `git status` before and after, not taken from Codex's report. Changes outside the job's `paths` are flagged `OUT OF SCOPE`.

**Failure handling.** An unsupported model (for example "model is not supported when using Codex with a ChatGPT account") is marked unavailable for 24 h and the ladder is rebuilt without it, so an older model of the same family can stand in. That attempt does not count against the job. Usage or rate limits pause all delegation until the reset time Codex reports (default 15 min); Tandem never retries in a loop or works around quotas. Transient errors are retried once. Timeouts (default 30 min) kill the whole process tree. When the session ends, its running jobs are cancelled. Jobs orphaned by a crash are marked `interrupted`.

**Conflict prevention.** An implement job owns its `paths` (the whole repo if none are given). A job whose paths overlap a running writer waits in the queue instead of racing it. Claude's own Edit/Write calls on owned files are denied by the guard hook, with a message naming the job. Ownership is shared across Claude sessions on the same project via a lock-protected ledger.

**Memory.** Stored per project under the plugin data directory (`~/.claude/plugins/data/<plugin>/projects/<repo>-<hash>/memory.json`). Kinds: decision, constraint, fact, issue, done, note. Each entry records its source (claude or `codex:<model>`), a verified flag, and modification stamps of the files it cites. Near-duplicates (Jaccard ≥ 0.7, same kind) are merged. `supersedes` retires contradicted entries. An entry is shown as STALE once a cited file changes. The store keeps at most 400 active entries; resolved and superseded entries are pruned first, then old unverified ones. Codex receives the 6 most relevant entries with each task. Its `findings` come back as unverified facts, and Claude confirms or corrects them.

**Safety.**
- Codex runs with its own sandbox: `workspace-write` for implement, `read-only` for ask and review. Tandem never passes `--dangerously-bypass-*` flags.
- Prompts go through stdin, never through a shell command line.
- Your Codex `AGENTS.md`, rules and hooks still apply.
- Claude Code's permission system still gates every Tandem tool call, including the `verify` command, which you see in the call.
- The worker prompt forbids destructive git commands and commits.

## Verification performed

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for what was tested, how, and the benchmark numbers.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/tandem:status` says Codex not installed | `npm i -g @openai/codex`; make sure `codex` is on PATH for Claude Code |
| "not logged in" | Run `codex login` |
| Ladder EMPTY | No catalog model is within `codex_max_model`; raise the ceiling or check `codex debug models` |
| Jobs return `codex_unavailable` "rate limit" | Wait for the reset shown in `/tandem:status`; Claude continues alone meanwhile |
| An edit is blocked by Tandem | A Codex job owns that file: `codex_wait` for it, or `codex_jobs` with `cancel` |
| Codex writes unexpected files | They are reported as OUT OF SCOPE. Check your global `~/.codex/AGENTS.md` for instructions that trigger tooling on every task. |

State lives only in the plugin data directory and is removed on uninstall (`claude plugin uninstall tandem`; add `--keep-data` to keep memory).

## Development

```bash
npm test
```

Runs 18 deterministic tests against a simulated Codex CLI: routing, memory, failures, concurrency, hooks, and the MCP protocol.

```bash
npm run test:real
```

Runs against the real Codex CLI. Uses quota, takes about 1 minute.

```bash
npm run bench
```

Runs the real benchmark. Uses quota, takes about 6 minutes.

## Known limitations

- Parallel writers share one working tree. Overlapping paths are serialized rather than isolated. Verification can observe another job's concurrent changes; the result names those jobs.
- Model family ordering (`luna < terra < sol < astra`) is inferred from the catalog descriptions. A new family name is ignored until it is added to `server/router.js`.
- Routing adaptation uses first-attempt success. For jobs without a verify command, that signal is Codex's self-report, which is weaker.
- The Claude ceiling is enforced for subagent model *overrides* (the `model` parameter). It is not enforced for third-party plugin agents that hard-code a model in their own definition.
