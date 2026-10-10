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
| Claude Code permissions | Claude Code controls permission for the Tandem MCP tool invocation. The `verify` string is visible in that call; Tandem runs it without a further prompt, inside the verification sandbox below. |
| Verification sandbox | Checks run under `codex sandbox` (the Codex CLI's OS sandbox: Seatbelt on macOS, bubblewrap/Landlock on Linux, dedicated sandbox users and ACLs on Windows) with a Tandem profile: writes only in the workspace and the temp folder (`.git` stays read-only), no network, environment reduced to the core variables, and known credential stores (and `verify_deny_paths`) neither readable nor writable. Before checks run, a probe inside the sandbox opens each denied path (reporting only which ones opened, never content). If the sandbox cannot start, or any denied path opens, the check is **not run** and the job stays `unverified`. `verify_isolation=contain` accepts readable credential stores (the other limits still apply); `verify_isolation=off` runs checks unsandboxed. See the threat model below for what this does and does not cover. |
| Untrusted model output | Codex summaries and findings are sanitised (control and bidi characters removed), secret-redacted, length-limited, and returned to Claude inside an explicit "untrusted model output" frame. Findings enter memory only as *tentative* entries. |
| Paths | Tool arguments are validated server-side; `paths` must stay inside the repository (`..` and absolute paths elsewhere are rejected). Integration rejects existing symlinks/junctions in changed source and destination paths. These checks are defense-in-depth and do not eliminate all filesystem race conditions. |
| Prompts | Prompts reach Codex on stdin, never on a command line. |
| Secrets | Text that looks like an API key, token or private key is redacted from Codex summaries and findings and from everything written to project memory. Task text you or Claude send is stored in the job ledger as given. |
| Isolated worktrees | Created only under the plugin data directory. Linked dependency folders are unlinked before removal, so cleanup cannot follow a link into your project. |
| Integration | Worktree results are merged three-way per file. A file you changed on the same lines is a conflict and nothing is written; every write is re-checked immediately before it happens and rolled back on a race. |
| Resume and takeover | A resumed job keeps its original scope, mode, check and model/effort ceilings (recorded at submission); the CLI cannot widen them. Checkpoint items run without Claude only if they carry a `delegate` spec, which is validated when written and records the ceilings in force then. |
| Skills | Discovery only reads skill files; nothing is executed or fetched. Worker prompts name at most three matching skills, never their content. `tandem skills add` is explicit and project-local (`<repo>/.agents/skills`, never global); a git source must be pinned to a full commit sha and is checked out with symlinks disabled; links are refused; executable content (`scripts/`, script or binary extensions) requires `--allow-scripts`; the content hash is recorded in `tandem-lock.json` and `tandem skills verify` detects later changes; a directory Tandem did not install is never overwritten or removed. |
| Verification integrity | Test definitions and existing test files are fingerprinted before verification is run. If a check definition or existing test changed, the check is blocked *before* executing that changed test, and the result cannot be `verified` (new tests are allowed). Out-of-scope edits also prevent verification. |

## Known limits

- Codex runs with your Codex account and your `~/.codex` configuration, including your `AGENTS.md`, rules and MCP servers. Tandem cannot make Codex safer than its own sandbox.
- **Verification reads are not confined to the workspace.** The sandbox denies the listed credential stores, not every file: a check can read other files your account can read (except where the platform sandbox narrows reads further). Without network access it cannot send them anywhere, but it can copy them into the workspace, where they could end up in an integrated change. Add other secret locations to `verify_deny_paths`.
- **A process a check starts can outlive it.** On Linux and macOS Tandem kills the check's process group afterwards; a process that left the group, and on Windows any detached process, keeps running, still inside the same sandbox (measured: it could not write outside the workspace).
- **Windows needs Codex's elevated sandbox** (`[windows] sandbox = "elevated"` in your Codex configuration, set up once by Codex). Without it the deny rules cannot be enforced, the sandbox refuses to start, and checks are not run.
- **On Windows, Codex's deny rules depend on the state of your file permissions.** Codex implements them as file permissions (ACLs) for its sandbox users. On fresh Windows machines (CI, Codex 0.154.0 and 0.162.1) every denied path was unreadable. On the development machine some stayed readable, for two measured reasons: Codex had granted its sandbox users an explicit read permission on a credential file (`.npmrc`) or on its parent folder, and an explicit or nearer permission overrides an inherited deny; and a deny set on a file disappears when the file is replaced (a token refresh writes a new file), while Codex's own record still lists it as applied. Tandem therefore measures the deny rules before each check instead of trusting them; on that machine the default setting refuses to run checks.
- **Codex's Windows permission refresh is slow and fragile.** A change to the deny set makes Codex re-apply sandbox permissions across the home folder (measured: about 23 minutes on the development machine, with five refreshes running at once). A refresh that is interrupted leaves stale deny entries for the Codex sandbox users on part of the home folder. That makes those folders unreadable to all later Codex sandboxed commands; see VERIFICATION.md for detection and repair.
- **The integrity check covers known check-defining files, not every way to change what a check runs.** Tandem fingerprints test files and a fixed list of definition files (configuration, `.npmrc`, a local `pytest`) from the root down to the scoped project. A job can still add a new top-level module that shadows one of a test runner's own dependencies, for example a `pluggy.py` that `python -m pytest` would import first. Review a verified change that adds top-level modules a test runner might import.
- `verify_isolation=off` restores the old behaviour: checks run with your user rights and network access and execute code the job wrote. Preflight then still blocks altered test definitions and existing tests, but that is not isolation.
- Multi-file integration is journaled: if Tandem's process is killed part-way, the next start restores the files it wrote (see ARCHITECTURE.md). Tandem's own state files are flushed to disk before they replace the old copy, but power loss or an OS crash during an integration is not covered (integrated project files are not flushed), and no durability claim has been tested by cutting power (ARCHITECTURE.md, Durability).
- Writes Claude makes through shell commands are not intercepted by the Edit/Write guard hook. Codex's own writes during an in-place job are bounded only by its sandbox and audited afterwards, not prevented.
- Dependency folder links are **off by default**. You may explicitly configure `worktree_links` for trusted tasks to avoid reinstalling dependencies, but writes through those links reach the original project.
- Path checks are `lstat`-based and race with a concurrent process that swaps a parent directory for a link between the check and the write.
- An installed skill is instructions Codex may follow (and scripts it may run) inside its sandbox. Review a skill before `--allow-scripts`; pinning proves which content you reviewed, not that it is safe.
- `~/.tandem/data-dir` tells the CLI where the plugin keeps its state. Anyone who can write your home directory can redirect it; that is the same trust boundary as the state itself.
- The Claude subagent ceiling applies to model overrides requested through the Agent tool. It does not apply to third-party agents that hard-code a model.

## Verification threat model

Verification executes code. This section states who is trusted, what is enforced and how it was tested.

| Input | Trust | Control |
|---|---|---|
| Your existing tests and check definitions (`package.json` scripts, `pytest.ini`, …) | trusted as written | fingerprinted before the job; any change blocks the check *before* it runs and prevents `verified` |
| Tests or definitions the job modified or deleted | untrusted | never executed: preflight blocks the check |
| New tests and application code the job wrote | untrusted | executed **inside the verification sandbox** |
| `verify` command given by you or Claude | trusted command, untrusted code it reaches | runs inside the sandbox; shown in the tool call |
| Commands the model runs while working | Codex's responsibility | Codex's own `workspace-write` / `read-only` sandbox |
| Dependency folder links (`worktree_links`) | off by default | when enabled, writes through a link reach your real project |

Evidence (`test/sandbox.test.js`, real Codex CLI 0.154.0, disposable directories and canary secrets only), Windows 11 with Codex's elevated sandbox:

| Probe | Result |
|---|---|
| write a file outside the workspace (not temp) | denied |
| write through a junction pointing outside | denied |
| write a denied canary folder | denied |
| modify `.git/config` in the workspace | denied |
| open a network connection | denied |
| see a secret environment variable of the parent | absent |
| write inside the workspace | allowed |
| exit codes and `&&` chains | passed through unchanged |
| hung check | killed at its timeout |
| detached child | outlived the check, could still not write outside |
| read a denied canary folder | denied in the first run; readable in later runs of the same configuration (see Known limits). The default setting then refuses to run checks |

The fake-Codex suite proves the fail-safes: when the sandbox cannot start, or a denied path is readable, the check never runs and the job is `unverified` without escalation. `contain` and `off` run and record their isolation level in the result.

Full enforcement, every probe in the table above denied (including the read of the denied canary), exit codes passed through, hung check killed. CI's `verification sandbox` job requires this on every platform, for Codex CLI 0.154.0 and 0.162.1, on disposable GitHub-hosted VMs where the platform prerequisites are enabled by the workflow:

| Platform | Environment | Prerequisite | Detached child |
|---|---|---|---|
| macOS | CI | none | outlived the check, confined |
| Linux (Ubuntu) | CI | unprivileged user namespaces allowed (`kernel.apparmor_restrict_unprivileged_userns=0`); without it bubblewrap fails (`bwrap: loopback: Failed RTM_NEWADDR`), the sandbox does not start, and checks are not run | killed with the process group |
| Linux (WSL2, Ubuntu) | development machine | none | killed with the process group |
| Windows | CI | Codex's elevated sandbox (`[windows] sandbox = "elevated"`); without it the sandbox does not start and checks are not run | outlived the check, confined |
| Windows | development machine | as above | before the ACL repair: a denied canary was readable (Known limits), so the default setting refused. After the targeted repair (VERIFICATION.md), the full sandbox runs: all adversarial checks pass, and `.ssh`, `.docker/config.json`, `.codex/auth.json`, `.claude/.credentials.json` and `.npmrc` are unreadable (`EPERM`) |

A defect found by the Linux runs: Node gives a child process socket pairs as pipes, Codex's Linux sandbox filters socket calls, and Node inside it then wrote nothing to its output. Tandem's own probe is a Node script, so on Linux every check was refused even where the sandbox worked. Sandboxed output now goes through a file on Linux and macOS.
