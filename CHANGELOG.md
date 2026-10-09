# Changelog

## 2.0.0 — unreleased

Production hardening of v1. See [docs/GAP_ANALYSIS.md](docs/GAP_ANALYSIS.md) for the audit that motivated each change.

### Breaking

- Node.js 20 or later is required.
- The MCP server is declared inline in `plugin.json`; the repository-root `.mcp.json` is gone. In v1 it broke Claude Code sessions opened inside the plugin's own repository.
- `server/router.js` is replaced by `server/catalog.js` (eligibility, ceilings) and `server/policy.js` (routing).
- On-disk state moved to versioned stores. v1 jobs, router statistics and memory are migrated automatically on first use.

### Added

- **Cross-process job ledger** (`server/ledger.js`). Eligibility check and claim happen in one locked transaction. It adds leases with heartbeats, owner fencing (a reaped job cannot be revived by a late write), FIFO fairness, global parallelism slots and `after` dependencies. Crashed jobs are reaped as `interrupted`.
- **Isolated worktrees** (`server/worktree.js`).
  - A job can run in a git worktree created from a snapshot of your current working state. The snapshot uses a temporary index; HEAD, the index, branches and files are untouched.
  - Results are integrated three-way per file and all-or-nothing, with race re-checks and rollback.
  - Line-ending aware (autocrlf and `eol` attributes).
- **Expected-cost routing policy** (`server/policy.js`).
  - Success model: additive logistic model (task class + model + effort) with Gaussian priors from catalog rank, MAP fit with recency weighting, Laplace posterior and Thompson sampling.
  - Dynamic programming over escalation sequences minimises the expected total cost of a verified result.
  - Retries may stay on the same rung and resume the thread.
  - The cost prior was fitted on real attempts: effort ×1.45 per step, model tier ×1.1. The exploration threshold is 1.25× the best plan, chosen in simulation. See docs/ROUTING.md §4.
- **Verification integrity** (`server/verify.js`). A change to the test definition or a deleted test downgrades `verified` to `unverified`.
- **Memory v2**: confidence (verified / tentative), content-hash staleness, `.bak` recovery, sanitisation and secret redaction, expiry of unused tentative entries.
- **Security layer** (`server/security.js`): sanitisation, secret redaction, repository confinement of paths, untrusted-output framing.
- MCP tools:
  - `codex_run` gains `dry_run`, `after` and `isolation`;
  - `codex_jobs` gains `cancel`, `show` and `discard`;
  - `tandem_status` reports permitted and excluded models with reasons, availability, routing evidence, configuration problems and recent errors.
- Configuration: `codex_allowed_models`, `isolation`, `objective`.
- Prompt coordination: an in-place job is told which paths other running jobs are changing.
- Tooling:
  - tests: real install-lifecycle test, real-provider integration test (8 checks);
  - benchmarks: resumable real benchmark with statistics, routing simulation study, overhead micro-benchmarks, SVG charts;
  - GitHub Actions CI (Linux, macOS, Windows), CodeQL, dependency review, and a manual real-provider workflow.

### Fixed

- **Data loss**: removing an isolated worktree deleted the contents of the user's `node_modules`. Root cause: on Windows, `git worktree remove --force` follows the dependency junction.
  - Links are now unlinked before removal, and the worktree is deleted with Node's `rm`, which does not follow links.
  - Worktrees that outlive their job (kept on conflict, or reaped after a crash) are unlinked too, so a user's own `git worktree remove --force` is safe.
  - The ledger records which links exist.
- Jobs could hang forever when a process started by Codex (observed: `git` during a cancel) outlived Codex and kept its output pipe open. The same applied to verification commands that leave a server running. Both now settle shortly after the main process exits.
- A usage-limit message with an absolute reset time ("try again at 4:18 PM", the real Codex wording) was not understood. Delegation was retried every 15 minutes instead of pausing until the reset.
- Two sessions could start overlapping writers (check and claim were in different critical sections).
- Parallelism limit was per process instead of global.
- A dead process's claim could survive forever through PID reuse.
- Negative discovery state ("not logged in") was cached for 6 hours.
- Snapshots failed when a dependency folder was already git-ignored.
- A recovered Codex stream error was reported as a failure, and multibyte characters split across reads were garbled.
- An integration claim did not block an overlapping in-place writer.

### Removed

- Fixed difficulty→rung table and ±1 offset heuristic (superseded by the policy).
