# Contributing

Tandem has no runtime dependencies and no build step. You need Node.js 20 or later and Git.

## Tests

```bash
npm test
```

This runs the deterministic suite against a simulated Codex CLI (`test/fake-codex.js`). It needs no account and consumes no quota. CI runs it on Linux, macOS and Windows.

The following scripts use real providers and **consume quota**. Never add them to automatic CI:

| Command | Needs | What it does |
|---|---|---|
| `node test/real-integration.js` | Codex CLI, logged in | 8 end-to-end checks against the real Codex |
| `node bench/bench.js --reps N --out DIR` | Codex CLI, logged in (and Claude Code for `--claude-reps`) | Real benchmark, resumable |
| `node test/install-smoke.js` | Claude Code CLI (no login) | Install lifecycle in a throw-away home directory |

Deterministic benchmarks, safe to run anywhere:

```bash
node bench/router-sim.js --seeds 30
node bench/overhead.js
node bench/charts.js
```

## Rules for changes

- Keep zero runtime dependencies (`dependency-review` fails a pull request that adds one).
- A bug fix comes with a test that fails without the fix.
- Routing changes need evidence: run `bench/router-sim.js` before and after and report the paired differences. Do not hard-code assumptions about which model is better.
- Never write to the user's project outside an explicit job scope, and never delete through links. `test/worktree.test.js` guards this.
- Do not commit personal paths, account details or credentials. CI scans the bundle for them.
