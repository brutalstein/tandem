# Architecture

Tandem is a Claude Code plugin. Claude Code is the only user interface. Codex runs in the background as a worker that Claude delegates to, and the user never switches tools. There are no runtime dependencies: about 2,200 lines of Node.js, plus the official `claude` and `codex` CLIs.

```
Claude Code session (lead, the only UI)
 ├─ hooks/session-start.js   brief: Codex readiness, permitted models, memory highlights, kept worktrees
 ├─ hooks/guard.js           PreToolUse: denies Claude edits to paths a running job owns;
 │                           denies subagent models above claude_max_model
 ├─ skills/orchestrate       when to delegate, how to scope a job, how to treat results
 ├─ agents/scout, builder    cheap Claude subagents (read-only exploration, bounded edits)
 └─ server/mcp.js            MCP server over stdio (one per session), argument validation, framing
      └─ server/jobs.js      Orchestrator: admission → routing → execution → verification → integration
           ├─ ledger.js      cross-process job ledger (claims, leases, slots, dependencies)
           ├─ catalog.js     eligibility under the user's ceilings
           ├─ policy.js      expected-cost routing (see ROUTING.md)
           ├─ codex.js       provider adapter: discovery, `codex exec --json`, errors, kill
           ├─ worktree.js    snapshot, isolated worktree, three-way integration
           ├─ verify.js      check detection, run, integrity fingerprints
           ├─ memory.js      shared project memory
           ├─ security.js    sanitise, redact, confine, frame
           └─ store.js       locked JSON transactions with .bak recovery
```

## Job lifecycle

```
queued ──acquire──▶ running ──(worktree)──▶ integrating ──▶ terminal
```

Terminal states:

| State | Meaning |
|---|---|
| `verified` | Tandem's own check passed. The test definition is unchanged and no test was deleted. |
| `unverified` | Done, but there was no check, or the check definition was changed by the job |
| `failed_verification` | The check still failed after the allowed attempts, or failed again after integration into a changed tree |
| `partial`, `failed`, `blocked` | Codex reported it did not finish |
| `answered` | An ask or review job completed |
| `conflict` | A worktree result overlaps your concurrent edits; nothing was written and the worktree is kept |
| `codex_unavailable` | Not installed, not logged in, rate-limited, or no permitted model. Claude does the work. |
| `cancelled`, `interrupted`, `rejected`, `skipped` | Cancelled; owner died; explicit model not allowed or available; an `after` dependency did not succeed |

1. **Admission.**
   - `ledger.tryAcquire` runs in one locked transaction. It checks dependencies, global slots and path claims, and moves the job from `queued` to `running`.
   - Implement jobs choose their isolation here:
     - `inplace` writes to your working tree under a path claim;
     - `worktree` writes to an isolated copy;
     - `auto` edits in place if no writer holds the paths, otherwise isolates. `worktree` is the safer default.
2. **Routing.** `catalog` → eligible rungs; `policy.decide` → escalation plan. The plan is stored with the job.
3. **Execution.**
   - `codex exec --json` runs with `-m`, effort, the sandbox (`workspace-write` or `read-only`), an output schema and, by default, lean flags.
   - Prompts go through stdin.
   - The job holds a lease that is renewed every 15 s; a lease expires after 60 s without renewal.
4. **Verification.**
   - Implement jobs run the check: `verify`, or auto-detected `npm test`, `pytest`, `cargo test` or `go test`.
   - Test definitions and tracked/untracked test-file contents are fingerprinted before and after. Changes downgrade the result.
   - A failed check feeds the failure output into the next attempt. On the same model the thread is resumed; on a new model the prompt is fresh plus a summary.
5. **Integration (worktree jobs).**
   - Planning is three-way per file: base = snapshot, ours = your current file, theirs = job result.
   - All-or-nothing: a conflict anywhere means nothing is written.
   - Each write re-checks that your file still equals the planned "ours". A race rolls back the files already written, but only those still holding what Tandem wrote.
   - If your tree changed since the snapshot, the check runs again after integration. A failure reverts the integration.
6. **Learning and sharing.**
   - The outcome is appended to the routing evidence.
   - Codex findings go to memory as *tentative* entries with provenance (`codex:<model>:<job>`). Claude confirms or retires them.

## Coordination guarantees

`test/ledger.test.js` checks these invariants. It includes a 6-process × 6-job stress test with random paths and crash injection.

| | Invariant |
|---|---|
| I1 | At most one running or integrating writer owns any path. |
| I2 | Running and integrating jobs never exceed `max_parallel`, counted across all sessions on the project. |
| I3 | A job with `after` starts only when every dependency succeeded; otherwise it is `skipped`. |
| I4 | Overlapping in-place writers start in submission order (no starvation). |
| I5 | A job whose owner died or stopped heart-beating becomes `interrupted`, and its claims are released. Writes carry the owner's session id, so a reaped job cannot be revived by a late write. |

Deadlock freedom: claims are taken all at once (no hold-and-wait), and `after` may only name earlier jobs, so the wait-for graph is acyclic.

Additional coordination:
- Claude's own Edit and Write calls on claimed paths are denied by `hooks/guard.js`.
- An in-place job's prompt lists the paths other running jobs are changing, so it does not duplicate their work.

## Filesystem safety

- **Snapshot.** The snapshot is built in a temporary index file (`GIT_INDEX_FILE`), started from a copy of the real index. HEAD, the index, branches, the stash and your files are never modified. `.gitignore` is respected.
- **Worktree location.** Worktrees live only under the plugin data directory (`worktrees/<project>/<job>`).
- **Dependency links.** Dependency directories are not linked by default: writable junctions/symlinks would expose the original project during execution. Explicit opt-in via `TANDEM_WORKTREE_LINKS` accepts this risk. The links are recorded in the ledger.
  - **Removal never deletes through a link.** On Windows, `git worktree remove --force` follows junctions and deletes the target's contents; this deleted a real `node_modules` during development. Tandem therefore removes links first, then deletes the worktree with Node's `rm` (which does not follow links), then runs `git worktree prune`.
  - **Surviving worktrees hold no links.** A worktree that outlives its job (kept after a conflict, or left by a crashed session and reaped) has its links removed. If you clean it up yourself with `git worktree remove --force`, that cannot reach your project either.
  - Tests cover removal, kept worktrees followed by a user's `git worktree remove --force`, and crash reaping.
- **Line endings.** Integration compares text with line endings normalised and writes results in your file's existing style, so `core.autocrlf` and `eol` attributes do not produce false conflicts.
- **Kept worktrees.** A worktree with changes that did not land (conflict, failure) is kept for inspection. The SessionStart brief lists those from the last 7 days. `codex_jobs` with `discard` removes one, links first.

## Process safety

- **Timeouts and cancel.** A job timeout (default 30 min) or a cancel kills the whole process tree: `taskkill /T /F` on Windows, process-group `SIGKILL` elsewhere.
- **Hang protection.** A Codex turn and a verification command both settle 1.5 s after their main process exits, even if a leftover grandchild still holds the output pipe. Without this, an orphaned `git` started by Codex during a cancel hung a job indefinitely.
- **Session end.** When the MCP server exits, its running jobs are cancelled. A job whose server crashed is reaped as `interrupted` by the next session.

## State

Everything is under the plugin data directory (`$CLAUDE_PLUGIN_DATA`, or `TANDEM_DATA`):

```
env.json                         discovery cache, per-model availability (verified / unavailable until …)
errors.log                       bounded diagnostics (hooks and server never fail silently)
projects/<name>-<hash>/
  ledger.json                    jobs, claims, leases (v2; v1 jobs.json imported)
  router-evidence.json           routing observations (v2; v1 router stats migrated)
  memory.json                    shared memory (v2; v1 migrated)
worktrees/<project>/<job>/       isolated worktrees (transient, or kept on conflict)
```

All JSON writes are locked transactions (lock file with owner PID, stale-lock breaking). A temporary file is renamed into place, and the previous good copy is kept as `.bak`. A corrupted file is recovered from `.bak` and the recovery is logged.

## Memory

- **Entries.** Typed entries: decision, constraint, fact, issue, note.
- **Confidence.** Each entry is `verified` (Claude confirmed) or `tentative` (Codex findings, unconfirmed notes).
- **Staleness and dedupe.** Entries cite files by content hash: when a cited file's content changes, the entry is shown as STALE. Near-duplicates are merged (Jaccard ≥ 0.7).
- **Supersede.** `supersedes` retires contradicted entries.
- **Size and expiry.** The store is bounded. Tentative entries unused for 30 days expire.
- **Search.** Ranked lexical search. Codex receives the most relevant few entries with each task, framed as untrusted context.

## Extending to another provider

`codex.js` is the only provider-specific module. The orchestrator uses it through `discover`, `buildArgs`, `runTurn`, `classifyError`, `markUnavailable` and `markVerified`. A second worker CLI would implement the same functions. Tandem does not add a provider abstraction until a second provider exists.
