# Security policy

## Reporting a vulnerability

Do not open a public issue for security problems. Use the repository's private vulnerability reporting ("Security" tab → "Report a vulnerability"). If that is not enabled, contact the maintainers privately. Include the version (`/tandem:status`), the platform, and steps to reproduce. Expect an acknowledgement within 7 days.

## Supported versions

Only the latest release receives fixes.

## Security model

Tandem runs locally inside Claude Code and starts the official Codex CLI. It adds no network service and has no runtime dependencies.

| Boundary | What Tandem does |
|---|---|
| Codex sandbox | `workspace-write` for implement jobs, `read-only` for ask and review. Tandem never passes `--dangerously-bypass-approvals-and-sandbox` or similar flags, and never edits `~/.codex/config.toml`. |
| Claude Code permissions | Claude Code controls permission for the Tandem MCP tool invocation; subsequent verification commands are executed by Tandem with the local user's rights. There may be no separate approval for each verification subprocess. Treat custom `verify` strings and repository test scripts as trusted-code execution. |
| Untrusted model output | Codex summaries and findings are sanitised (control and bidi characters removed), secret-redacted, length-limited, and returned to Claude inside an explicit "untrusted model output" frame. Findings enter memory only as *tentative* entries. |
| Paths | Tool arguments are validated server-side; `paths` must stay inside the repository (`..` and absolute paths elsewhere are rejected). Integration rejects existing symlinks/junctions in changed source and destination paths. These checks are defense-in-depth and do not eliminate all filesystem race conditions. |
| Prompts | Prompts reach Codex on stdin, never on a command line. |
| Secrets | Text that looks like an API key, token or private key is redacted from Codex summaries and findings and from everything written to project memory. Task text you or Claude send is stored in the job ledger as given. |
| Isolated worktrees | Created only under the plugin data directory. Linked dependency folders are unlinked before removal, so cleanup cannot follow a link into your project. |
| Integration | Worktree results are merged three-way per file. A file you changed on the same lines is a conflict and nothing is written; every write is re-checked immediately before it happens and rolled back on a race. |
| Verification integrity | Test definitions and existing test files are fingerprinted; changing or deleting one, or adding a `conftest.py`, downgrades a `verified` result (new tests are allowed). Out-of-scope edits make the result `unverified` and require review. |

## Known limits

- Codex runs with your Codex account and your `~/.codex` configuration, including your `AGENTS.md`, rules and MCP servers. Tandem cannot make Codex safer than its own sandbox.
- **Verification runs outside the Codex sandbox.** The check runs with your user rights and network access, and it executes code the job just wrote (tests, scripts, `package.json` scripts under `verify: auto`). A job steered by hostile input (for example, a prompt injection in a file it read) can therefore plant code that runs outside Codex's sandbox when Tandem verifies it. Changed test definitions are detected, but only after the check ran. For untrusted input use `verify: none` and review the diff before running anything. Claude Code shows the `verify` string in the tool call.
- Multi-file integration is journaled: if Tandem's process is killed part-way, the next start restores the files it wrote (see ARCHITECTURE.md). Power loss or an OS crash is not covered, because writes are not fsync'd.
- Writes Claude makes through shell commands are not intercepted by the Edit/Write guard hook. Codex's own writes during an in-place job are bounded only by its sandbox and audited afterwards, not prevented.
- Dependency folders are linked into isolated worktrees by default (`worktree_links`). Writes through a link reach the real folder, as an in-place job's would. Set `worktree_links` to `none` for untrusted tasks.
- Path checks are `lstat`-based and race with a concurrent process that swaps a parent directory for a link between the check and the write.
- The Claude subagent ceiling applies to model overrides requested through the Agent tool. It does not apply to third-party agents that hard-code a model.
