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

## Hardening branch (hardening-v4, 2026-10-10)

| Check | Result | Kind |
|---|---|---|
| `npm test`, Windows 11, Node 24.11.0 | 123 tests: 122 pass, 1 POSIX-only skip | simulated Codex |
| `npm test`, Ubuntu 24.04 (WSL 2), Node 22.22.2 | 123 tests: 121 pass, 2 Windows-only skips | simulated Codex |
| Windows CI failure "replacing a file another program holds open…" | root cause: the replacement wait (~1 s) was shorter than the handle plus a scan of the new file on the runner. Upstream raised it to a 10 s monotonic deadline with re-validation; the failure path (handle held past the budget) is now tested: originals intact, earlier writes rolled back, no temp files. 25 / 25 local repeats | real file handles (PowerShell) |
| `node --test test/sandbox.test.js` (Windows, Codex CLI 0.154.0, elevated sandbox) | 4 / 4. Default setting refuses: 2 of 7 denied paths readable inside the sandbox. Under `contain`: writes outside, write through a junction, `.git/config`, network and inherited env all blocked; exit codes intact; timeout kill works; a detached child outlives the check but stays confined | **real OS sandbox** |
| Sandbox fail-safes | not started → not run; denied path readable → not run under `sandbox`, run and recorded under `contain`; `off` recorded as `none`. Mutation check: removing the guard fails the test | simulated Codex |
| SIGKILL fault injection on the store | 4 writers killed at random for 5 s: 15 / 15 runs pass after the fix; before it, 3 of 4 runs waited 25–28 s on an empty lock | real processes |
| Lock stress (8 × 100 with planted crash locks) | 1 lost update (799/800) once the flush was added after the commit check; 25 / 25 after moving the check to just before the rename | real processes |
| Integration wait during session end | race found on WSL (a job slipped into integration when the suspend freed its blocking claim); fixed, 5 / 5 repeats on WSL | simulated Codex |

### Windows: stale Codex sandbox permissions ("Stale sandbox ACLs")

A Codex sandbox run that denied the whole home folder (a manual probe, not something Tandem does) was interrupted while Codex applied the deny. Measured afterwards (2026-10-10, read-only, ACL metadata only):

- The home folder's own access list holds two explicit `DENY` entries for `CodexSandboxUsers` (read on the folder, inherit-only read for everything below). Codex's own record (`~/.codex/.sandbox/deny_read_acl_state.json`) does not list the home folder, so Codex will never remove them.
- Every folder below inherits them. Folders where Codex granted an explicit read (`.cargo`, `AppData`, `OneDrive`, …) stay readable to sandboxed commands; the home folder itself and `.config` are not (measured from inside the sandbox: `EPERM`).
- The other entries (system, administrators, the user, one app-container traverse right) and the owner are not involved and are not touched by the repair below.

The earlier advice here (re-enable inheritance on each child folder) does not address this state and must not be used.

Detect (read-only): `node --test --test-name-pattern="untracked Codex" test/sandbox.test.js` fails and names each folder with an untracked read-deny entry.

Repair: remove only those two entries from the home folder's own list. No elevation is needed, nothing else changes, and child folders lose only the inherited copies. Back up first and keep the backup outside the profile:

```powershell
$d = 'C:ProgramData	andem-acl-backup'; New-Item -ItemType Directory -Force $d | Out-Null
icacls $env:USERPROFILE /save "$dhome.icacls"           # DACL of the home folder object only
$csu = (New-Object Security.Principal.NTAccount 'CodexSandboxUsers').Translate([Security.Principal.SecurityIdentifier]).Value
icacls $env:USERPROFILE /remove:d "*$csu"                  # deny entries of that one SID, home folder only (no /T)
```

Rollback (DACL only; owner and auditing untouched):

```powershell
$s = (Get-Content 'C:ProgramData	andem-acl-backuphome.icacls' -Encoding Unicode)[1]
$ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($s, 'Access'); [IO.Directory]::SetAccessControl($env:USERPROFILE, $ds)
```

Both were tested on disposable folders reproducing the exact descriptor: the repair removed the two entries and every inherited copy, kept explicit entries on children (an allow on a folder, a deny on a credential file), and kept owner and protection; the rollback restored the descriptor exactly. (`icacls /restore` failed there without elevation, so the rollback sets the DACL directly.) Afterwards, credential paths whose deny was only inherited (on the development machine `.ssh` and `.docker/config.json`) are no longer denied until Codex re-applies them; Tandem's probe detects that and refuses to run checks under the default setting.

Tandem itself never denies the home folder; its deny list names individual credential files and small folders.

## Continuity branch (feat/continuity-v3, 2026-10-09)

| Check | Result | Kind |
|---|---|---|
| `npm test`, Windows 11, Node 24.11.0 | 107 pass + 1 POSIX-only skip (108 tests) | simulated Codex |
| `npm test`, Ubuntu 24.04 (WSL 2), Node 22.22.2 | 107 pass + 1 Windows-only skip (108 tests); the POSIX Ctrl+C test passes | simulated Codex |
| Independent review (fresh-context agent, same model family) | 5 bugs, 7 risks reported; all 12 fixed with regression tests | same-provider review, not cross-provider |
| Strict plugin validation | pass | real `claude plugin validate` |
| `node test/real-resume.js` | 6 / 6 — a real Codex implement turn stopped mid-way (session end) is `suspended` with its thread id and worktree; the resume continued the same thread (`resumed: true`) in the same worktree and finished `verified` and integrated | **real Codex** (codex-cli 0.154.0) |

What the simulated failover tests prove (`continuity.test.js`, `surface.test.js`): suspension on a limit mid-run with partial work kept; no Codex spawn while the recorded limit lasts; resume in the same thread and worktree; in-place resume keeps attribution; drift while stopped forces isolation and preserves the user edit; takeover blocks resume; session end suspends; dependency suspension and ordered resume; a killed owner's job resumes from its worktree; `continue --wait` starts only after the reset; Ctrl+C suspends (POSIX); after the MCP server ends, the CLI alone resumes the job and runs only the delegated checkpoint item.

What they do **not** prove: real quota exhaustion followed by a real reset (the provider's limit was not reached in this session), the real auth-loss path, and continuity of a real Claude Code session (Claude's own quota is not observable to Tandem). The real resume check covers the session-end path only.

## Independent review of p1-strategy (2026-10-10)

The review was done by a fresh-context agent of the same model family; it is not a cross-provider review. It read `git diff origin/main..HEAD -- server/` and reproduced each finding with small scripts.
- It reported 5 bugs, 10 risks and 1 question.
- 2 bugs were in this branch: a resumed job could pass on a check it wrote itself, and a configuration file between the root and the project could disable the tests.
- 3 bugs were older ways to pass without running the tests: `.pytest.ini`, a local `pytest.py`, and a project `.npmrc`.
- All 5 bugs and all 9 risks the report listed (its summary counted 10) are fixed, each with a regression test that fails on the code before the fix (`unit.test.js` and `orchestrator.test.js`, "(review)"). The POSIX-only test runs in CI.

Left open:
- A new top-level module that shadows one of pytest's own dependencies is not fingerprinted. That class has no fixed file list.
- The question: whether the token objective's failure penalty should count as Codex cost in the strategy comparison. It is left as is and documented.

## Provider continuity, scenarios A–E (p1-strategy, 2026-10-10)

The checkpoint design was not rewritten: no defect was found. Each scenario was checked on its own:

| Scenario | Evidence | Kind |
|---|---|---|
| A. Codex unavailable | `orchestrator.test.js`: rate limit suspends the job (resumable), a provider-wide backoff follows, and later jobs suspend without spawning Codex. An unsupported model is marked unavailable and rerouted; the provider stays available. Auth and transient errors are told apart. `continuity.test.js` A tests: partial work kept, no spawn while the limit lasts. `strategy.test.js`: without Codex the strategy is Claude. | simulated |
| A, repeated | `continuity.test.js` "A, repeated": limited mid-run twice; both partial steps and one Codex thread kept; one provider call per run; the third run finishes and integrates | simulated |
| B. Claude unavailable | `surface.test.js` "Claude gone": session end suspends the job, and the `tandem` CLI continues it and the delegated checkpoint item with no Claude call. `continuity.test.js`: the stored and current ceilings both apply on resume (the stricter wins). `node test/real-resume.js`: a real Codex turn stopped by session end resumed in the same thread and worktree and finished `verified`. | simulated + **real Codex** |
| C. Both unavailable | `continuity.test.js`: provider down at start suspends without spawning; session end suspends live jobs (resumable, not cancelled); a job waiting to integrate keeps its work; dependents suspend with their dependency | simulated |
| D. Availability restored | `continuity.test.js`: files changed while suspended force an isolated resume that never overwrites the user edit; `continue --wait` waits for the recorded reset; a job taken over is never resumed; dependency-suspended jobs run after their dependency | simulated |
| E. Process interruption | `continuity.test.js` "crash" and "crash, repeated" (the owner dies during the submit, then again during the resume; the third run uses the same worktree and both dead runs' work); `orchestrator.test.js` owner killed mid-integration; `unit.test.js` writers killed by SIGKILL never lose an acknowledged update | simulated |

Checkpoint and resume overhead (`node bench/resume-overhead.js 10`, Windows 11, Node 24.11.0, simulated Codex):

| Event | p50 | p95 |
|---|---|---|
| Provider start to durable `suspended` (includes the fake process start and exit) | 128 ms | 152 ms |
| `resume()` to provider start | 150 ms | 157 ms |
| `submit()` to provider start, fresh job (for comparison; includes creating the worktree) | 483 ms | 498 ms |
| Resume state on disk | 93 bytes | |

Resuming is cheaper than starting, because the worktree already exists. The token cost of a real resume is the replayed conversation: 120k input tokens, 101k of them cached (`docs/BENCHMARKS.md`).

Not run in this branch, because each needs real quota and the user's approval:
- a real quota exhaustion followed by a real reset;
- a real auth loss;
- a real exhaustion of Claude's quota. Tandem cannot observe Claude's quota, so B is triggered by the session ending.

Codex exposes no quota query; Tandem reads the reset time from the provider's error message.

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
