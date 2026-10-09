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
| Claude Code permissions | Every Tandem tool call, including the `verify` command, goes through Claude Code's permission system. |
| Untrusted model output | Codex summaries and findings are sanitised (control and bidi characters removed), secret-redacted, length-limited, and returned to Claude inside an explicit "untrusted model output" frame. Findings enter memory only as *tentative* entries. |
| Paths | Tool arguments are validated server-side; `paths` must stay inside the repository (`..` and absolute paths elsewhere are rejected). The check is lexical; it does not resolve symlinks inside your repository. |
| Prompts | Prompts reach Codex on stdin, never on a command line. |
| Secrets | Text that looks like an API key, token or private key is redacted from Codex summaries and findings and from everything written to project memory. Task text you or Claude send is stored in the job ledger as given. |
| Isolated worktrees | Created only under the plugin data directory. Linked dependency folders are unlinked before removal, so cleanup cannot follow a link into your project. |
| Integration | Worktree results are merged three-way per file. A file you changed on the same lines is a conflict and nothing is written; every write is re-checked immediately before it happens and rolled back on a race. |
| Verification integrity | If a job changes the verification definition (test scripts or test config) or deletes tests, the result is downgraded from `verified` to `unverified` with a warning. |

## Known limits

- Codex runs with your Codex account and your `~/.codex` configuration, including your `AGENTS.md`, rules and MCP servers. Tandem cannot make Codex safer than its own sandbox.
- The `verify` command runs with your user rights, like any test command you would run yourself. Claude Code shows it to you in the tool call.
- The Claude subagent ceiling applies to model overrides requested through the Agent tool. It does not apply to third-party agents that hard-code a model.
