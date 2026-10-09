# Release readiness: Tandem 2.0.0

Date: 2026-10-09. Scope: everything in this repository at the commit that contains this file.

## Verdict

**Ready as a release candidate for early adopters on Windows and Linux. Not yet ready for a general public release.**

The core is verified in three ways:
- deterministic tests on two operating systems;
- a real Codex integration run of 8 checks;
- a real install lifecycle against Claude Code.

That core covers coordination, isolation, verification, safety and failure handling. Every defect found during this work was fixed with a regression test, including two data-loss and hang bugs that only real runs exposed.

Three things stand between this and a general release:

1. **Statistically meaningful real-provider performance evidence.** The repeated benchmark was cut short by the Codex account's usage limit; only a pilot exists (one run per cell). Until the scheduled run completes, the claims Tandem can make about cost against plain Codex are directional, not statistical.
2. **CI has never executed.** Nothing was pushed (by instruction), so the macOS leg, the Node 20 leg and CodeQL have not run.
3. **The repository has no public home yet.** `SECURITY.md` points to GitHub private vulnerability reporting, which needs a repository with that feature enabled.

## Checklist

| Area | Status | Evidence |
|---|---|---|
| Deterministic tests | ✅ 62 / 62, Windows + Linux | [VERIFICATION.md](VERIFICATION.md) |
| Real Codex integration | ✅ 8 / 8 | `bench/data/real-integration-v2.json` |
| Real install lifecycle | ✅ 12 / 12 (Windows) | `test/install-smoke.js` |
| Real Claude → Tandem → Codex delegation | ✅ 1 task, verified | [BENCHMARKS.md](BENCHMARKS.md) |
| Strict plugin validation | ✅ | marketplace and manifest |
| Data safety (worktrees, links, integration) | ✅ root-caused and tested | [ARCHITECTURE.md](ARCHITECTURE.md#filesystem-safety) |
| Hang safety (orphaned processes) | ✅ root-caused and tested | same |
| Quota behaviour | ✅ observed for real; reset parsing fixed | VERIFICATION.md |
| Coordination invariants | ✅ incl. 6-process stress | `test/ledger.test.js` |
| Security review | ✅ sanitise, redact, confine, frame; claims checked against code | [SECURITY.md](../SECURITY.md) |
| Routing evidence (simulation) | ✅ 30 seeds × 5 worlds, calibrated on real costs | [ROUTING.md](ROUTING.md) |
| Routing evidence (real, repeated) | ⚠️ pilot only; scheduled run pending | BENCHMARKS.md |
| Local overhead | ✅ hooks 5–11 ms over Node start | BENCHMARKS.md |
| macOS | ❌ not run | CI only |
| Node 20 | ❌ not run locally | CI only |
| CI / CodeQL / dependency review | ⚠️ configured, never executed | `.github/workflows` |
| Docs | ✅ README, architecture, routing, benchmarks, verification, security, contributing, changelog | |
| Personal data in bundle | ✅ none (scanned); CI scans too | |

## Known limitations

- **Small benchmark tasks.** The tasks are small. They separate the arms by cost, not by success; larger tasks are needed to measure success-rate differences.
- **Cost, not success rate, is optimised.** The routing objective trades some Codex success rate for cost, and unsolved tasks fall back to Claude. Users who value Claude time highly should raise `TANDEM_FAILURE_MULT`.
- **No model quota weights.** Token counts treat all Codex models alike; per-model quota weights are not published.
- **Weak learning signal without a check.** For implement jobs without a check, success is Codex's own report.
- **Cost prior from one day.** The cost prior is fitted on 24 real attempts from one account and one day, with effort confounded by difficulty. It is a prior; observed costs replace it per project.
- **Subagent ceiling scope.** The Claude subagent ceiling applies to model overrides requested through the Agent tool, not to third-party agents that hard-code a model.
- **Kept worktrees.** They hold no dependency links, so tests cannot run inside one until you link or install dependencies yourself.

## Environment issues found on the development machine

These were reported, not changed, by instruction:
- **Broken Codex default model.** `~/.codex/config.toml` sets `model = "gpt-6-luna"`, which this account rejects. Plain `codex exec` fails; Tandem is unaffected because it always passes `-m`.
- **Broken `apiKeyHelper`.** The Claude Code `apiKeyHelper` points to a missing script, which prevents `claude --bare`.
- **Leftover test data.** `~/.claude/plugins/data/tandem-inline/` is left over from v1 testing and is safe to delete.
- **Orphaned `git` process.** An orphaned `git.exe` started by Codex during the cancel that exposed the hang bug may still be running. It is harmless and can be ended in Task Manager.
