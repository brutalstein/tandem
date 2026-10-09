# Verification record (v2.0.0)

This page records what was verified, how, and the results. Anything not listed here was not verified. Simulated tests are labelled as such and are never presented as evidence of real provider behaviour.

Primary environment, 2026-10-09:
- Windows 11 Pro 10.0.26200, Node 24.11.0, Git for Windows;
- Claude Code 2.1.281;
- codex-cli 0.154.0 with a ChatGPT account.

Secondary environment: WSL 2, Ubuntu 24.04.4 LTS, Node 22.22.2, Git 2.43.0.

## Safety-hardening branch audit (2026-10-09)

Independent audit of PR #1 (`hardening/safety-and-integrity-v2`) on the local branch `audit/hardening-v2`. The PR's code had passed only syntax parsing before this audit. Every defect below was reproduced with a test that failed on the PR code before it was fixed (details in CHANGELOG.md).

| Check | Result |
|---|---|
| `npm test`, Windows 11, Node 24.11.0 | 81 / 81 pass |
| `npm test`, WSL 2 Ubuntu 24.04, Node 22.22.2 | 80 pass, 0 fail, 1 skipped (Windows-only share-lock test) |
| Filesystem suites with every temp, repo and worktree directory inside OneDrive | 47 / 47 pass (worktree, orchestrator, ledger) |
| `npm run validate` (strict) | pass |
| `node test/install-smoke.js` (real Claude Code 2.1.281) | 12 / 12 pass |
| Real Codex integration, `bench/data/real-integration-audit.json` | 9 / 9 pass, including a new check: an isolated job that adds a test file is verified with linked dependencies and integrated |
| Real Claude Code session vs a running in-place job | Claude's Edit of the claimed file was denied by the guard; the unclaimed file was edited (haiku, $0.037) |
| Lock stress: 8 processes × 100 transactions with crash-left locks planted | no update lost (5 runs); 12 × 150 with a crash lock after half of all transactions: no update lost, no transaction aborted (5 runs) |
| Owner process killed during post-integration re-verification | next start restored the written file, kept the worktree, annotated the job |

Real Codex run, 2026-10-09 13:22 UTC, codex-cli 0.154.0: every job routed to `gpt-6-astra@low` on a cold start; about 292k input tokens (211k cached) and 2.5k output tokens over the implement, ask, resume and MCP checks; about 2.2 minutes of job time.

Not verified in this audit: macOS and Node 20 locally (CI only), CodeQL on the fixed code (no local CodeQL; runs on push), several real Claude sessions delegating to Codex at the same time (covered by the multi-process ledger and lock stress tests), power-loss consistency.

## Continuity branch (feat/continuity-v3, 2026-10-09)

| Check | Result | Kind |
|---|---|---|
| `npm test`, Windows 11, Node 24.11.0 | 97 pass + 1 POSIX-only skip (98 tests) | simulated Codex |
| `npm test`, Ubuntu 24.04 (WSL 2), Node 22.22.2 | 97 pass + 1 Windows-only skip (98 tests); the POSIX Ctrl+C test passes | simulated Codex |
| Strict plugin validation | pass | real `claude plugin validate` |
| `node test/real-resume.js` | 6 / 6 — a real Codex implement turn stopped mid-way (session end) is `suspended` with its thread id and worktree; the resume continued the same thread (`resumed: true`) in the same worktree and finished `verified` and integrated | **real Codex** (codex-cli 0.154.0) |

What the simulated failover tests prove (`continuity.test.js`, `surface.test.js`): suspension on a limit mid-run with partial work kept; no Codex spawn while the recorded limit lasts; resume in the same thread and worktree; in-place resume keeps attribution; drift while stopped forces isolation and preserves the user edit; takeover blocks resume; session end suspends; dependency suspension and ordered resume; a killed owner's job resumes from its worktree; `continue --wait` starts only after the reset; Ctrl+C suspends (POSIX); after the MCP server ends, the CLI alone resumes the job and runs only the delegated checkpoint item.

What they do **not** prove: real quota exhaustion followed by a real reset (the provider's limit was not reached in this session), the real auth-loss path, and continuity of a real Claude Code session (Claude's own quota is not observable to Tandem). The real resume check covers the session-end path only.

## Facts established by observation (not assumed)

| Finding | How verified | Consequence |
|---|---|---|
| Account catalog lists `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and hides `gpt-reserve`, `gpt-5.5`, `codex-auto-review` | `codex debug models` | Eligibility is computed from discovery, never a fixed list |
| `gpt-6.1-sol` (the default ceiling) is rejected for this account: "not supported when using Codex with a ChatGPT account" | Real call (integration check 2) | A ceiling is a cap, never a default; an explicit request for it is rejected, never substituted |
| The user's `~/.codex/config.toml` default model `gpt-6-luna` is rejected, so plain `codex exec` fails without `-m` | Real call | Tandem always passes `-m`; the config file is reported, not edited |
| `codex exec --json` events: `thread.started`, `item.completed`, `turn.completed` (usage), `turn.failed`, top-level `error` (also for retried stream hiccups) | Real runs | Event parser; a recovered stream error is not a failure |
| Real usage-limit wording: "You've hit your usage limit … try again at 4:18 PM." | Real run (benchmark, account exhausted) | Classified `rate_limited`; reset parsed as the next local 16:18. Before this fix it fell back to 15 minutes; regression test added. |
| On Windows, `git worktree remove --force` follows a directory junction and deletes the target's contents; Node's `fs.rmSync` does not | Reproduced in isolation | Worktrees are deleted with Node's `rm` after unlinking links; surviving worktrees hold no links |
| A process started by Codex can outlive Codex and keep the stdout pipe open (an orphaned `git rev-parse HEAD` after a cancel); waiting for `close` then hangs forever | Real cancel in integration run 3 | A turn and a verification settle 1.5 s after the main process exits; regression tests with an orphaned grandchild |
| `claude -p --bare` accepts only `ANTHROPIC_API_KEY` or an `apiKeyHelper` | `claude --help` | Benchmarks isolate Claude with `--setting-sources project --strict-mcp-config` instead |

## Automated tests: simulated Codex (`npm test`)

At the 2.0.0 commit on main there were 62 tests (the hardening branch has 81; see the audit section above). They run the real orchestrator, ledger, worktree, policy, MCP server and hooks. Only the Codex CLI is replaced, by `test/fake-codex.js`.

| Platform | Result |
|---|---|
| Windows 11, Node 24.11.0 | 62 / 62 pass |
| Ubuntu 24.04 (WSL 2), Node 22.22.2 | 62 / 62 pass |
| macOS, Node 20 | not run locally; covered by the CI matrix, which has not been executed yet (no push) |

| File | Covers |
|---|---|
| `unit.test.js` | **Security:** sanitise, redact, confine, frame.<br>**Catalog:** ceilings, allow-list, exclusions with reasons.<br>**Policy:** DP equals brute force; Cholesky; success model learns an inverted model order and transfers across classes; Laplace samples centred; routing moves away from failing rungs; seeded exploration with bounded regret; v1 migration.<br>**Codex adapter:** error classification incl. the real usage-limit message; argument building; fuzzed JSONL (garbage, oversized lines, split multibyte); recovered stream errors; timeout; orphaned grandchild.<br>**Other:** report parsing; memory; verification incl. leftover background process; store recovery |
| `ledger.test.js` | Invariants I1–I5; crash of an owner; reaping unlinks a crashed worktree's links; v1 import; 6 processes × 6 jobs stress with random paths |
| `worktree.test.js` | Snapshot leaves HEAD, index and status byte-identical; links never deleted; fast-forward, merge, conflict, binary, all-or-nothing; race and rollback; revert; CRLF filters; autocrlf; drift; a user's `git worktree remove --force` on a surviving worktree cannot reach `node_modules` |
| `orchestrator.test.js` | End to end with the fake CLI: verification, escalation, thread resume, unsupported model skipped, rate limit, cancel, timeout, `after`, isolation `auto`, worktree conflict kept without links, out-of-scope, integrity downgrade, drift + re-verification revert, coordination prompt |
| `surface.test.js` | Guard hook, SessionStart brief, MCP protocol, argument validation, framing, dry run, status, progress notifications, discard |

## Real Codex integration (`node test/real-integration.js`)

Final run (run 4): **8 / 8 PASS**. Output: `bench/data/real-integration-v2.json`.

| Check | Result |
|---|---|
| Discovery | Catalog parsed. 4 eligible models; 3 hidden ones excluded with reasons. |
| Explicit `gpt-6.1-sol` | `rejected` with the provider's message; no other model substituted |
| ask / trivial | Answered on a permitted model, read-only |
| Memory | Codex findings stored as *tentative* with provenance `codex:<model>:<job>` |
| Concurrent implement | Worktree job and wide in-place job ran together; no duplicated work; both verified; worktree result integrated as a fast-forward |
| Thread resume | Same thread kept context; 49 % of input cached on resume |
| Cancel | Real running job cancelled 159 ms after the request; claim released |
| MCP over stdio | `tandem_status`, dry-run plan, and a real ask through the protocol; output framed as untrusted |

History. Each failure led to a fix and a regression test:
- runs 1–2: 7 / 8, conflict caused by line endings (autocrlf) and by duplicated work;
- run 3: hung at cancel, caused by the orphaned grandchild;
- run 4: 8 / 8.

Run 4 used the routing cost prior from before the calibration in [ROUTING.md](ROUTING.md) §4. The checks do not depend on which rung is chosen.

## Plugin install lifecycle (`node test/install-smoke.js`)

This runs against the real `claude` 2.1.281 in a throw-away home directory. Result: **12 / 12 PASS**, run twice on Windows.

The steps:
1. strict validation of the marketplace and the plugin manifest;
2. marketplace add;
3. install (user scope);
4. listed as enabled;
5. skills, agents and hooks registered;
6. MCP server connected (`claude mcp list`);
7. disable, enable;
8. uninstall;
9. no plugins left;
10. marketplace removed.

Not run on Linux or macOS locally; CI runs it on Ubuntu and Windows.

## Real Claude Code with Tandem

`claude -p` (Sonnet) ran the `lru-bugs` task with the Tandem MCP server and hooks (`--plugin-dir`). Claude delegated through `codex_run`; Codex fixed the bugs, verified on `luna@xhigh`. The independent re-test passed and the test files were byte-identical. See [BENCHMARKS.md](BENCHMARKS.md).

## Provider quota behaviour (real)

The Codex account reached its usage limit during the benchmark.
- The job ended `codex_unavailable` with the provider's message.
- Tandem marked the provider unavailable and made no further calls.
- The benchmark recorded the cell as `unavailable`, not as a failure, and stopped.

## Static checks

- `node --check` passes on every source file.
- `tsc --checkJs` was evaluated: about 20 reports, all type-inference limitations, no real defects. It was not adopted.
- CodeQL is configured in CI and has not run yet.

## Not verified

- **macOS.** No machine available. Only the CI matrix covers it, and it has not run.
- **Node 20.** CI only. The local Docker daemon was not running and was not started.
- **GitHub Actions workflows.** Never executed, because nothing was pushed.
- **Real-provider behaviour after the routing calibration.** Pending the scheduled benchmark (see [BENCHMARKS.md](BENCHMARKS.md)).
- **Several real Claude Code sessions on one project at the same time.** Covered by the 6-process ledger stress test, not by real sessions.
- ~~The PreToolUse guard denying a real Claude edit in v2~~: verified on the hardening branch (audit section above).
