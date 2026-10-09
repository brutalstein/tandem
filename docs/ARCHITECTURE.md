# Architecture

Tandem is a Claude Code plugin. Claude Code is the main user interface; a small CLI (`bin/tandem.js`) can inspect and continue already-authorized work when Claude is unavailable. Codex runs in the background as a worker that Claude delegates to, and the user never switches tools. There are no runtime dependencies: about 2,200 lines of Node.js, plus the official `claude` and `codex` CLIs.

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
           ├─ capabilities.js installed skills (Codex + Claude), task matching, pinned installs
           ├─ checkpoint.js  durable task state (objective, constraints, plan items)
           ├─ security.js    sanitise, redact, confine, frame
           └─ store.js       locked JSON transactions with .bak recovery

bin/tandem.js                standalone CLI on the same state: status, resume, takeover, continue, skills
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
     - `auto` (the default) edits in place if no writer holds the paths, otherwise isolates. `worktree` isolates every job, at a setup cost per job (see BENCHMARKS.md).
2. **Routing.** `catalog` → eligible rungs; `policy.decide` → escalation plan. The plan is stored with the job.
3. **Execution.**
   - `codex exec --json` runs with `-m`, effort, the sandbox (`workspace-write` or `read-only`), an output schema and, by default, lean flags.
   - Prompts go through stdin.
   - The job holds a lease that is renewed every 15 s; a lease expires after 60 s without renewal.
4. **Verification.**
   - Implement jobs run the check: `verify`, or auto-detected `npm test`, `pytest`, `cargo test` or `go test`.
   - Test definitions and tracked/untracked test-file contents are fingerprinted before and after. Modifying or deleting an existing test, or adding a `conftest.py`, downgrades the result; adding new tests does not.
   - In-place jobs are audited against a snapshot of the whole working state taken at start, so a second edit to an already-dirty file is seen. Paths written meanwhile by other Tandem jobs (in-place claims, integrations) are not attributed to the job. Edits made meanwhile by you or by Claude through a shell cannot be told apart from the job's. Files ignored by `.gitignore` are not audited. Out-of-scope changes make the result `unverified` (never `verified`), and Tandem reverts nothing in place.
   - A failed check feeds the failure output into the next attempt. On the same model the thread is resumed; on a new model the prompt is fresh plus a summary.
5. **Integration (worktree jobs).**
   - Planning is three-way per file: base = snapshot, ours = your current file, theirs = job result.
   - All-or-nothing: a conflict anywhere means nothing is written.
   - Each write re-checks that your file still equals the planned "ours". A race rolls back the files already written, but only those still holding what Tandem wrote.
   - If your tree changed since the snapshot, the check runs again after integration. A failure reverts the integration.
   - **Crash consistency.** Before the first write, the planned actions and your prior file contents are journaled under `projects/<project>/integrations/<job>.json`; the journal is removed only when the outcome is final (after any re-check). If the owner dies part-way, the next Tandem start on that project restores every file that still holds exactly what was written, removes stray temporary files, keeps the worktree and records a `recovery` note on the job. Covered by a test that kills a real process during re-verification. Not covered: power loss or an OS crash (writes are not fsync'd).
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
- Claude's own Edit and Write calls on claimed paths are denied by `hooks/guard.js`. Writes Claude makes through a shell command (Bash) are not intercepted.
- An in-place job's prompt lists the paths other running jobs are changing, so it does not duplicate their work.

## Filesystem safety

- **Snapshot.** The snapshot is built in a temporary index file (`GIT_INDEX_FILE`), started from a copy of the real index. HEAD, the index, branches, the stash and your files are never modified. `.gitignore` is respected.
- **Worktree location.** Worktrees live only under the plugin data directory (`worktrees/<project>/<job>-<random>`); an existing directory is never reused or deleted. Removal and discard accept only a direct child of that project's directory that is not itself a link.
- **Integration paths.** Every component of a destination and source path is checked with `lstat`: a symlink or junction anywhere, a path escaping the repository, or a directory target makes it a conflict. Each file is replaced atomically (temporary file + rename, retried while Windows reports the file busy). A race on a parent directory between the check and the rename remains possible; closing it needs OS-level primitives Node does not expose.
- **Dependency links.** Dependency folders (`node_modules`, `.venv`, `venv`; `worktree_links` option, `none` to disable) are linked into the worktree (a junction on Windows, a symlink elsewhere), so checks can run there without reinstalling. Writes through a link reach your real folder, the same exposure an in-place job has. Link names must be plain folder names. The links are recorded in the ledger.
  - **Removal never deletes through a link.** On Windows, `git worktree remove --force` follows junctions and deletes the target's contents; this deleted a real `node_modules` during development. Tandem therefore removes links first, then deletes the worktree with Node's `rm` (which does not follow links), then runs `git worktree prune`.
  - **Surviving worktrees hold no links.** A worktree that outlives its job (kept after a conflict, or left by a crashed session and reaped) has its links removed. If you clean it up yourself with `git worktree remove --force`, that cannot reach your project either.
  - Tests cover removal, kept worktrees followed by a user's `git worktree remove --force`, and crash reaping.
- **Line endings.** Integration compares text with line endings normalised and writes results in your file's existing style, so `core.autocrlf` and `eol` attributes do not produce false conflicts.
- **Kept worktrees.** A worktree with changes that did not land (conflict, failure) is kept for inspection. The SessionStart brief lists those from the last 7 days. `codex_jobs` with `discard` removes one, links first.

## Continuity: suspend and resume

A provider stopping is not the task failing. Jobs that stop for an outside reason end `suspended` (or `interrupted` when the owner process died) and can be resumed. Nothing is discarded.

| Cause | Detected | State | Resumable when |
|---|---|---|---|
| Codex usage/rate limit (before or during a turn) | `classifyError` → `rate_limited`; `limitKind` splits quota vs rate | `suspended`, `waitFor: time`, `until` = parsed reset | the reset passes (`--due`), or the user says it is back (`--now`) |
| Codex not logged in / not installed | discovery, or an auth error mid-turn | `suspended`, `waitFor: user` | after `codex login` / install |
| Claude Code session ended | MCP server stdin closes | `suspended` (`session_ended`) | any time |
| Ctrl+C in the CLI | SIGINT | `suspended` (`user_interrupt`) | any time |
| Owner process killed | lease expires (reap) | `interrupted` | any time |
| Dependency stopped | `tryAcquire` | `suspended` (`dependency`) | once the dependency is resumed |

What a resume reuses (`result.resumeFrom` in the ledger, baselines in `projects/<p>/resume/<job>.json`):
- **Codex thread.** An implement turn continues the same Codex conversation (`codex exec resume`), with a prompt that says it was interrupted and that the tree holds its partial work. Ask/review turns are ephemeral and restart.
- **Workspace.** An isolated job continues in its kept worktree; dependency links are re-created. An in-place job continues in place only if the project tree is byte-identical to when it stopped; otherwise it continues in an isolated worktree, so it cannot overwrite edits made meanwhile.
- **Baselines.** The pre-job snapshot, dirty-file set and test fingerprints are those of the original run, so partial edits stay attributed to the job and test tampering before the stop is still detected. They are written when the run starts, so even a crashed run resumes with them.
- **Authorization.** Each job records the ceilings it was submitted under (`ceiling`); a resume from the CLI or another session runs under those, never wider. A resume never changes the job's scope, mode or check.
- **History.** Attempts from before the stop are kept, marked `before`; `history` records each transition.

`takeover` closes a stopped job that Claude or the user finished another way, so it is never resumed and repeated.

**Checkpoint.** `tandem_checkpoint` stores the objective, acceptance criteria, constraints, decisions and plan items outside any conversation. An item with a `delegate` spec (codex_run arguments, plus the ceilings in force when it was written) is authorized for Codex; `tandem continue` runs only those, and resumes due jobs. Items complete when their job ends verified, answered or taken over.

**Waiting.** There is no background service. `tandem continue --wait` waits in the terminal until the latest recorded reset (at most 24 h), then continues. Scheduling it (cron, Task Scheduler) is left to the user.

**Data directory.** Inside Claude Code the state lives in `$CLAUDE_PLUGIN_DATA`. The MCP server writes that path to `~/.tandem/data-dir`, and the CLI follows it, so both see the same ledger.

## Skills

`capabilities.js` lists skills from the locations the tools themselves load: `<repo>/.agents/skills`, `~/.agents/skills`, `$CODEX_HOME/skills` (and `.system`), `<repo>/.claude/skills`, `~/.claude/skills`, and enabled Claude plugins (from `installed_plugins.json`). Duplicates (same name or same content) are counted once. Skills marked `disable-model-invocation` or `allow_implicit_invocation: false` are never suggested.

Lean mode passes `skills.max_context_tokens=100` to Codex, which hides its own skill list. To keep relevant skills usable, the worker prompt names at most three installed Codex skills that clearly match the task (BM25 over name and description, at least two distinct matching terms, weak tail dropped), with their paths; nothing when none match. The job records which skills it was pointed at, and `tandem_status` reports how those jobs ended. Scanning Codex locations costs about 17 ms with 51 skills; scanning everything including 460 plugin skills about 0.25–0.4 s (status only).

Installing is explicit (`tandem skills add`), project-local (`<repo>/.agents/skills`), and pinned: see SECURITY.md.

## Process safety

- **Timeouts and cancel.** A job timeout (default 30 min) or a cancel kills the whole process tree: `taskkill /T /F` on Windows, process-group `SIGKILL` elsewhere.
- **Hang protection.** A Codex turn and a verification command both settle 1.5 s after their main process exits, even if a leftover grandchild still holds the output pipe. Without this, an orphaned `git` started by Codex during a cancel hung a job indefinitely.
- **Session end.** When the MCP server exits, its running jobs are suspended (process tree killed, work kept, resumable). A job whose server crashed is reaped as `interrupted` by the next session, and can be resumed too.

## State

Everything is under the plugin data directory (`TANDEM_DATA`, else `$CLAUDE_PLUGIN_DATA`, else the path in `~/.tandem/data-dir`, else `~/.tandem`):

```
env.json                         discovery cache, per-model availability (verified / unavailable until …)
errors.log                       bounded diagnostics (hooks and server never fail silently)
projects/<name>-<hash>/
  ledger.json                    jobs, claims, leases (v2; v1 jobs.json imported)
  router-evidence.json           routing observations (v2; v1 router stats migrated)
  memory.json                    shared memory (v2; v1 migrated)
  integrations/<job>.json        journal of an integration in progress (crash recovery)
  resume/<job>.json              pre-job baselines of a running or stopped implement job
  checkpoint.json                durable task state (tandem_checkpoint, tandem continue)
worktrees/<project>/<job>-<rnd>/ isolated worktrees (transient, or kept on conflict)
```

All JSON writes are locked transactions. A temporary file is renamed into place, and the previous good copy is kept as `.bak`. A corrupted file is recovered from `.bak` and the recovery is logged.

Locks: the lock file holds `<pid> <time> <token>`.
- A lock is stale when its owner is dead or it is older than 30 s. The age bound keeps a reused PID from blocking every writer; transactions take milliseconds, so a live owner only crosses it when suspended.
- A stale lock is moved aside and verified before deletion, and put back if it turned out to be a new owner's.
- Before committing, a transaction checks that it still holds its lock; if not, it is discarded and re-run on fresh state (up to 5 times). Release deletes only the caller's own lock.
- Remaining window: a stall of more than 30 s exactly between that check and the rename can still lose one update.
- Tested with 8 processes × 100 transactions with crash-left locks planted meanwhile (no update lost).

## Memory

- **Entries.** Typed entries: decision, constraint, fact, issue, note.
- **Confidence.** Each entry is `verified` (Claude confirmed) or `tentative` (Codex findings, unconfirmed notes).
- **Staleness and dedupe.** Entries cite files by content hash: when a cited file's content changes, the entry is shown as STALE. Near-duplicates are merged (Jaccard ≥ 0.7).
- **Supersede.** `supersedes` retires contradicted entries.
- **Size and expiry.** The store is bounded. Tentative entries unused for 30 days expire.
- **Search.** Ranked lexical search. Codex receives the most relevant few entries with each task, framed as untrusted context.

## Extending to another provider

`codex.js` is the only provider-specific module. The orchestrator uses it through `discover`, `buildArgs`, `runTurn`, `classifyError`, `markUnavailable` and `markVerified`. A second worker CLI would implement the same functions. Tandem does not add a provider abstraction until a second provider exists.
