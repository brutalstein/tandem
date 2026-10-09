# Tandem v1.0 → v2.0 gap analysis

Audit of the v1.0.0 implementation (2026-10-09). Each gap names the evidence, the severity, and the v2 resolution. Severity: **B** blocker, **H** high (correctness/safety), **M** medium (efficiency/maintainability), **L** low.

## Verified claims from the v1 report

| v1 claim | Re-check | Result |
|---|---|---|
| 18 simulated tests pass | re-ran | true; tests exercise real modules against a fake CLI |
| Real Codex integration | re-ran `test/real-integration.js` earlier same day | true for ask/implement/resume on this machine |
| Plugin loads in Claude Code | headless `--plugin-dir` run | true, **but** see G1: the repo itself breaks sessions opened inside it |
| Normal install | never executed | **unverified** (v1 said so) |
| −36 % implement tokens vs fixed-top | 1 run per cell | not statistically meaningful (n=1); retained only as a pilot |
| Codex works on this machine without Tandem | `codex exec` with user config | **fails**: config default `gpt-6-luna` is rejected for the account; Tandem only worked because it always passes `-m` |

## Gaps

| # | Sev | Area | Evidence | v2 resolution |
|---|---|---|---|---|
| G1 | B | Packaging | Repo-root `.mcp.json` is also read as a *project* MCP config when Claude Code runs inside the repo; `${CLAUDE_PLUGIN_ROOT}` is unresolved → `CONNECTION_CLOSED` (observed in a live session) | MCP server declared inline in `plugin.json`; no root `.mcp.json` |
| G2 | H | Coordination | Path-claim check (`schedule`) and claim write (`execute`) happen in different critical sections → two sessions can both start overlapping writers (TOCTOU) | Ledger: eligibility check and `queued→running` transition in one locked transaction |
| G3 | H | Coordination | Parallelism limit counted per process; N sessions run N×limit Codex jobs | Global slot accounting in the ledger |
| G4 | H | Recovery | Liveness = `kill(pid,0)` only; PID reuse after crash/reboot keeps a dead claim alive forever and wedges the queue | Leases with heartbeats (15 s) + PID check; expired lease ⇒ `interrupted`, claims released |
| G5 | H | Integrity | Codex can edit the verification definition (e.g. `scripts.test` → `exit 0`) and still be reported `verified` | Verification-definition fingerprint before/after; any change ⇒ status `unverified` + warning |
| G6 | H | Isolation | All writers share one working tree; out-of-scope writes only reported; verification sees other jobs' half-done edits | Snapshot-based git worktree isolation (temp index, no user-state mutation) + file-level 3-way integration that never overwrites diverged user content |
| G7 | H | Discovery | Negative discovery state (not logged in) cached 6 h ⇒ delegation blocked after `codex login` | Only positive state cached long; negative state re-probed after 60 s |
| G8 | M | Routing | Hand-tuned difficulty→rung map + ±1 offset rule; no cost model; ignores time, verification cost, failure cost, non-stationarity | Expected-cost policy: additive logistic success model with weak catalog priors (no imposed model ordering), recency-weighted MAP fit, Laplace posterior, cost estimates, exact DP over escalation sequences, seeded Thompson exploration; evaluated against alternatives in simulation (docs/ROUTING.md). An earlier Beta + isotonic design was replaced after the simulation showed 49 % regret when the model order was wrong |
| G9 | M | Routing | Hard-coded family table; unknown family ⇒ model silently ignored; ceiling by version-string comparison | Catalog-derived capability scores; family table only a hint; explicit `codex_allowed_models` allow-list overrides heuristics; every exclusion reported with its reason |
| G10 | M | Routing | Catalog listing treated as availability | Per-model availability state: listed → verified (first success) / unavailable (rejected); optional probe |
| G11 | M | Memory | mtime-based staleness (false positives after checkout); no schema version; no corruption recovery; unsanitised Codex findings; secrets could be persisted; every search writes to disk; per-job `done` entries pollute memory | Schema v2 with migration; content-hash staleness; `.bak` recovery; sanitisation + secret redaction; untrusted-data framing; outcomes moved to the ledger; writes only on meaningful use; tentative entries expire |
| G12 | M | Output schema | Schema file written once at a global path; an upgrade never refreshes it | Versioned schema file name |
| G13 | M | Safety | Tool arguments not validated server-side (`paths` outside repo accepted; wrong types throw) | Central argument validation; repo-confined paths |
| G14 | M | Safety | Codex text (summary, findings) returned to Claude unframed — prompt-injection vector | Reports wrapped as untrusted data; findings sanitised and tentative |
| G15 | M | Scheduling | No dependencies between jobs; no fairness (a later job can starve an earlier overlapping one under contention) | `after` dependencies (acyclic by construction), FIFO ticket order per resource |
| G16 | M | Ops | Hooks fail open silently; no diagnostics | Errors logged to a bounded `errors.log`; `tandem_status` surfaces them |
| G17 | M | Perf | Guard hook loads all modules on every Edit | Fast path: exits after one small ledger read when nothing runs |
| G18 | M | Quality | No CI, no lint/type-check, no cross-platform evidence, no install-lifecycle test | GitHub Actions matrix (Linux/macOS/Windows, Node 20/22/24), syntax check, CodeQL, plugin validation, lifecycle script run for real, WSL Linux run. `tsc --checkJs` was evaluated (about 20 inference-only reports, no real defects) and not adopted |
| G19 | M | Evidence | Benchmark n=1, no CIs, Codex-only, no Claude-side cost | Resumable benchmark harness, paired design, cluster bootstrap CIs, Claude-side arms, deterministic micro-benchmarks, simulation study |
| G20 | L | Privacy | Docs contain the local username/path | Generic paths |
| G21 | L | Memory growth | Router stats keyed per rung with unbounded `totals`; jobs history trimmed but seq file grows forever (harmless) | Evidence store with decay and bounded keys |
| G22 | L | Lifecycle | Background jobs die with the session (documented) | Kept: no orphan processes by design; recovery marks them `interrupted` |
