---
description: Delegate a task to Codex through Tandem with verification.
argument-hint: <task description>
---
Delegate this task to Codex: $ARGUMENTS

1. `memory_search` for relevant context.
2. Decide mode (ask / implement / review), honest difficulty, owned `paths`, and a `verify` command (or "auto").
3. Write a self-contained task (goal, acceptance criteria, files, constraints) and call `codex_run`.
4. Inspect the result: status, `changed` files (read the diff for non-trivial changes), out-of-scope changes, verification output.
5. Report what was done and exactly what was verified.
