---
name: orchestrate
description: Plan and run multi-step engineering work across Claude and OpenAI Codex (Tandem) - decide what to delegate and to whom, parallel vs sequential, keep agents off each other's files, reuse shared memory, and verify results. Use for features, refactors, multi-file fixes, test writing, code review, or any task with independent parts.
---

# Tandem orchestration

You are the lead engineer. Codex jobs and Claude subagents are workers. Goal: the lowest total cost of a **verified** result — not the fewest tokens per call, not the strongest model.

## 1. Before work
- `memory_search` with the task's keywords. Reuse verified entries. Re-check unverified or STALE entries before relying on them.
- Size the task. Small (one file, a few tool calls, clear fix): do it yourself. Delegation has a fixed cost (~10k Codex tokens, ~10 s start-up) plus your review time.

## 2. Split
Break the work into units, each with explicit file ownership (`paths`).
- Parallel only when units touch disjoint paths and none needs another's output. Otherwise run them in sequence.
- One unit, one worker. Never add workers just for concurrency. Never delegate a unit back and forth.

## 3. Assign
| Work | Worker |
|---|---|
| Broad read-only exploration, locating code | `tandem:scout` subagent, or `codex_run` mode=ask difficulty=trivial |
| Well-specified implementation with a test to prove it | `codex_run` mode=implement with `paths` and `verify` |
| Bounded edit that needs this conversation's context | `tandem:builder` subagent with explicit paths |
| Ambiguous requirements, architecture, security, integration, user-facing decisions | you |
| Second opinion on a risky diff | `codex_run` mode=review |

Set `difficulty` honestly (trivial / normal / hard / critical); the router picks model and effort, escalates on failure, and learns from outcomes. Override `model`/`effort` only when evidence shows the router is wrong for this project.

## 4. Write the task
Workers do not see this conversation. Give: goal, acceptance criteria, files and symbols, constraints, how success is checked. Put decisions in `context` (short) or in memory — not whole files.

## 5. Run
- Independent units: `codex_run` with `wait: false` for each, do your own unit meanwhile, then `codex_wait`.
- Do not edit files a running Codex job owns; the guard hook blocks it.
- `codex_unavailable` (rate limit, login, no model) means do the work in Claude. Do not retry in a loop.

## 6. Verify — a claim is not a result
- `verified`: Tandem ran the check and it passed. `unverified`: no check ran. `failed_verification`, `partial`, `failed`, `blocked`: not done.
- Read the diff of `changed` files for anything non-trivial. Investigate any `OUT OF SCOPE` change; revert only with the user's consent.
- After all units land, run the full build/tests yourself.
- Tell the user exactly what was verified, what was not, and what remains uncertain.

## 7. Remember
- After confirming something durable (decision, constraint, gotcha, finished milestone): `memory_write`, `verified: true` only if you checked it, `files` it depends on.
- Codex findings arrive unverified. Confirm or correct them with `memory_update`; mark fixed issues `resolved`; use `supersedes` when a decision changes.
- Do not store task chatter or anything derivable from the code in a few seconds.
