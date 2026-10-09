# Verification record

Environment: Windows 11 Pro 10.0.26200, Claude Code 2.1.281, codex-cli 0.154.0 (ChatGPT login), Node 24.11.0, 2026-10-09.

## Research findings that shaped the design (verified locally, not assumed)

| Finding | How verified | Consequence |
|---|---|---|
| Live Codex catalog for this account: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (+ hidden `gpt-reserve`, `gpt-5.5`, `codex-auto-review`) | `codex debug models`, `~/.codex/models_cache.json` (fetched same day) | Router builds its ladder from discovery, not a static list |
| `gpt-6.1-sol` (the requested ceiling) does not exist for this account | Real call returned "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." | Ceiling is a cap, never a default; unsupported models are detected and skipped |
| `codex exec --json` emits `thread.started`, `item.completed` (agent_message, command_execution, file_change, error), `turn.completed` with usage, `turn.failed` | Real runs | Event parser |
| `--output-schema` works with this login | Real run | Structured worker reports (status, summary, findings…) |
| `codex exec resume` has no `-s`/`-C` flags | `codex exec resume --help` | Sandbox via `-c sandbox_mode=…`; cwd via process cwd |
| Delegated runs paid ~19.4k input tokens for "say PONG"; 32 KB of skills catalog + 12 KB recommended-plugins block | `codex debug prompt-input` | `lean_codex`: `-c skills.max_context_tokens=100 --disable plugins` -> 12.5k (−35 %) |
| User's global `~/.codex/AGENTS.md` makes Codex build a graphify graph for every codebase task | First real implement run wrote `graphify-out/` (caught by out-of-scope detection) | Worker prompt scopes the task explicitly; the next run cut time 62 s -> 33 s, tokens 83.8k -> 65.3k, and wrote no stray files |
| Windows npm shim `codex.cmd` cannot be spawned without a shell | `%APPDATA%\npm\codex.cmd` | Tandem runs `node …/@openai/codex/bin/codex.js` directly; prompts go via stdin |
| Claude Code stdio MCP tool calls: 28 h wall timeout, 30 min idle | Claude Code env-var docs | Foreground waits capped at 9 min; longer jobs continue in background |

## Automated tests — simulated Codex (`npm test`)

18 tests and 18 passes, run 3 times in a row with no flakes. `test/fake-codex.js` is a deterministic stand-in CLI. The job manager, MCP server and hooks under test are the real code.

- Ceiling semantics; ladder construction (newest per family, hidden and above-ceiling excluded, effort cap, fallback to an older family member); start rungs per difficulty; adaptive offset up after 4 failures and down after an 8-success streak
- Memory: dedupe merge, supersede, BM25 ranking, staleness after a cited file changes, 400-entry cap keeps decisions, kind validation
- Verified on the first attempt; failed verification resumes the same thread at higher effort and then passes; verification never passing gives `failed_verification`, not success
- Unsupported model skipped, remembered, and not charged as an attempt; rate limit stops delegation and short-circuits the next job without a Codex call; logged-out state; explicit above-ceiling model rejected
- Overlapping writers serialize; disjoint writers run concurrently; no check gives `unverified`
- Cancel kills the process tree; timeout reported as a failure; orphaned jobs marked `interrupted`; implement mode refuses non-git directories
- Guard hook: denies edits to owned paths, allows others, denies over-ceiling subagent models (including a lowered ceiling), fails open on garbage input
- SessionStart brief content and size; MCP protocol: initialize, tools/list, calls, unknown-tool error

## Real integration — real Codex (`npm run test:real`)

PASS:
- Discovery found codex-cli 0.154.0, logged in, and a 9-rung ladder.
- ask/trivial: `answered` on gpt-5.6-luna@low.
- implement/normal: `verified` on gpt-5.6-terra@medium. Tandem auto-detected and ran `npm test`, then the test re-ran independently. Changed files were exactly `slug.js`; nothing was out of scope.
- Thread resume: the same thread id kept context across turns.

## Real Claude Code end-to-end (headless, `--plugin-dir`, Haiku)

- The plugin loaded. MCP server `plugin:tandem:tandem` was connected with all 7 tools. Agents `tandem:scout` and `tandem:builder` loaded, along with skill `tandem:orchestrate` and commands status/delegate/review/memory.
- The SessionStart brief was injected: `[tandem] Codex ready (codex-cli 0.154.0): gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol, gpt-6-astra (ceiling gpt-6.1-sol)…`
- `tandem_status`, `memory_write` and `memory_search` round-tripped from inside Claude.
- With a live Codex claim on `a.txt`, Claude's Edit was denied by the guard ("locked by running Codex job j77") and the file stayed unchanged.

## Benchmark — real Codex (`npm run bench`, repeats=1)

Each row uses a fresh git repo. "fixed-top" is the naive strategy: the strongest eligible model (gpt-6-astra@high) with the full Codex prompt.

| task | arm | status | tests re-run | model | input tok | uncached in | output tok | wall s |
|---|---|---|---|---|---|---|---|---|
| ask/trivial | tandem | answered | - | gpt-5.6-luna@low | 39,340 | 14,252 | 475 | 13 |
| ask/trivial | tandem-full | answered | - | gpt-5.6-luna@low | 59,831 | 21,431 | 397 | 10 |
| ask/trivial | fixed-top | answered | - | gpt-6-astra@high | 81,512 | 29,928 | 305 | 16 |
| implement/normal | tandem | verified | pass | gpt-5.6-terra@medium | 81,626 | 19,162 | 893 | 39 |
| implement/normal | fixed-top | verified | pass | gpt-6-astra@high | 104,302 | 28,014 | 497 | 32 |
| implement/hard | tandem | verified | pass | gpt-5.6-sol@high | 91,787 | 21,643 | 3,533 | 41 |
| implement/hard | fixed-top | verified | pass | gpt-6-astra@high | 165,328 | 30,928 | 1,851 | 57 |

- Correctness was equal: 2 of 2 implement tasks verified in both arms, and every test suite re-ran green independently.
- Implement input tokens: 173k vs 270k (−36 %). Uncached input: 40.8k vs 58.9k (−31 %). Wall time: 80 s vs 89 s.
- Read-only task: −52 % input tokens versus fixed-top. Lean prompts alone account for −34 % (same model, 59.8k -> 39.3k).
- Tandem also ran these on cheaper model tiers. Per-model quota pricing is not published in the CLI, so the quota savings beyond token counts were not measured.

**Caveats.** n=1 per cell; Codex runs are non-deterministic, so expect noticeable variance. The tasks are small, and no task needed escalation, so the escalation path is verified only against simulated Codex plus the real resume test. Repeat with `node bench/bench.js 3` for tighter numbers.

## Not verified

- macOS/Linux execution (code paths exist: POSIX process-group kill, `codex` binary lookup), never run
- Real rate-limit and quota-exhaustion responses (message classification is tested against the documented and observed wording only)
- Installation through `claude plugin install` from the local marketplace (the manifests pass `claude plugin validate --strict`; loading was tested with `--plugin-dir`)
- Multiple simultaneous Claude sessions on one project (the ledger is lock-protected; only single-process concurrency was tested)
