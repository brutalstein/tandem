# Release readiness: Tandem 2.0.0

Date: 2026-10-09. Scope: everything in this repository at the commit that contains this file.

## Verdict

**Ready as a release candidate for early adopters on Windows and Linux, including the safety hardening of PR #1 with the audit fixes. Not yet ready for a general public release.**

The core is verified in four ways (details: [VERIFICATION.md](VERIFICATION.md)):
- deterministic tests on Windows, Linux (WSL) and an OneDrive-hosted directory;
- a real Codex integration run of 9 checks on this branch;
- a real install lifecycle against Claude Code;
- a real Claude Code session blocked by the guard from editing a file a running job owns.

That core covers coordination, isolation, verification, safety and failure handling. Every defect found during this work was fixed with a regression test, including two data-loss and hang bugs that only real runs exposed.

Three things stand between this and a general release:

1. **Statistically meaningful real-provider performance evidence.** The repeated benchmark was cut short by the Codex account's usage limit; only a pilot exists (one run per cell). Until the scheduled run completes, the claims Tandem can make about cost against plain Codex are directional, not statistical.
2. **CI on the audited branch.** CI on PR #1 passed on Windows, Linux and macOS (Node 20, 22, 24), but CodeQL reported two file-system-race alerts (fixed on the audit branch, not yet re-scanned) and dependency review fails because the repository's dependency graph is disabled (a repository setting).
3. **Security reporting.** The repository is public. Verify that GitHub private vulnerability reporting is enabled before advertising it as the preferred disclosure channel.
4. **Verification runs outside the Codex sandbox** and executes code the job wrote. This is documented in SECURITY.md; users with untrusted input should use `verify: none` and review.

## Addendum: continuity branch (feat/continuity-v3)

Not merged, not released. Adds suspend/resume, takeover, checkpoint, the standalone CLI and the skill registry (CHANGELOG "Unreleased"). Verified by 97 deterministic tests on Windows and Linux and one real-provider suspend/resume check (6/6). Open before merging:
- real quota exhaustion and reset have not been observed end to end on this branch (the simulated path is tested);
- macOS and Node 20 are CI-only and CI has not run on this branch (nothing pushed);
- the per-job skill pointers have a labelled-set check (5/5, no false positives) but no measured effect on task success yet.

## Checklist

| Area | Status | Evidence |
|---|---|---|
| Deterministic tests | ✅ 81 / 81 Windows; 80 + 1 Windows-only skip on Linux | [VERIFICATION.md](VERIFICATION.md) |
| Real Codex integration | ✅ 9 / 9 on this branch | `bench/data/real-integration-audit.json` |
| Real install lifecycle | ✅ 12 / 12 (Windows) | `test/install-smoke.js` |
| Real Claude → Tandem → Codex delegation | ✅ 1 task, verified | [BENCHMARKS.md](BENCHMARKS.md) |
| Strict plugin validation | ✅ | marketplace and manifest |
| Data safety (worktrees, links, integration) | ✅ root-caused and tested | [ARCHITECTURE.md](ARCHITECTURE.md#filesystem-safety) |
| Hang safety (orphaned processes) | ✅ root-caused and tested | same |
| Quota behaviour | ✅ observed for real; reset parsing fixed | VERIFICATION.md |
| Coordination invariants | ✅ incl. 6-process ledger stress, 8-process lock stress with crash-left locks | `test/ledger.test.js`, `test/unit.test.js` |
| Crash consistency of integration | ✅ journal + recovery, tested by killing a real process | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Guard hook in a real Claude Code session | ✅ edit of a claimed file denied | VERIFICATION.md |
| Security review | ✅ sanitise, redact, confine, frame; claims checked against code | [SECURITY.md](../SECURITY.md) |
| Routing evidence (simulation) | ✅ 30 seeds × 5 worlds, calibrated on real costs | [ROUTING.md](ROUTING.md) |
| Routing evidence (real, repeated) | ⚠️ pilot only; scheduled run pending | BENCHMARKS.md |
| Local overhead | ✅ hooks 5–11 ms over Node start; safety work +0.1–0.7 s per job | BENCHMARKS.md |
| macOS | ⚠️ CI only (passed on PR #1) | GitHub Actions |
| Node 20 | ⚠️ CI only (passed on PR #1) | GitHub Actions |
| CI / CodeQL / dependency review | ⚠️ tests pass on PR #1; CodeQL alerts fixed but not re-scanned; dependency review needs the dependency graph enabled | `.github/workflows` |
| Docs | ✅ README, architecture, routing, benchmarks, verification, security, contributing, changelog | |
| Personal data in bundle | ✅ none (scanned); CI scans too | |

## Known limitations

- **Small benchmark tasks.** The tasks are small. They separate the arms by cost, not by success; larger tasks are needed to measure success-rate differences.
- **Cost, not success rate, is optimised.** The routing objective trades some Codex success rate for cost, and unsolved tasks fall back to Claude. Users who value Claude time highly should raise `TANDEM_FAILURE_MULT`.
- **No model quota weights.** Token counts treat all Codex models alike; per-model quota weights are not published.
- **Weak learning signal without a check.** For implement jobs without a check, success and failure are Codex's own report; both count with reduced weight.
- **Scope audit attribution.** In place, edits made by you or by Claude through a shell while a job runs cannot be told apart from the job's; files ignored by `.gitignore` are not audited.
- **Cost prior from one day.** The cost prior is fitted on 24 real attempts from one account and one day, with effort confounded by difficulty. It is a prior; observed costs replace it per project.
- **Subagent ceiling scope.** The Claude subagent ceiling applies to model overrides requested through the Agent tool, not to third-party agents that hard-code a model.
- **Kept worktrees.** They hold no dependency links, so tests cannot run inside one until you link or install dependencies yourself.

## Environment issues found on the development machine

These were reported, not changed, by instruction:
- **Broken Codex default model.** `~/.codex/config.toml` sets `model = "gpt-6-luna"`, which this account rejects. Plain `codex exec` fails; Tandem is unaffected because it always passes `-m`.
- **Broken `apiKeyHelper`.** The Claude Code `apiKeyHelper` points to a missing script, which prevents `claude --bare`.
- **Leftover test data.** `~/.claude/plugins/data/tandem-inline/` is left over from v1 testing and is safe to delete.
- **Orphaned `git` process.** An orphaned `git.exe` started by Codex during the cancel that exposed the hang bug may still be running. It is harmless and can be ended in Task Manager.
