---
description: Search or curate Tandem's shared project memory.
argument-hint: [query | "audit"]
---
Arguments: $ARGUMENTS

- With a query: `memory_search` it and show the results.
- With "audit" (or nothing): `memory_search` with an empty query and `limit: 30`. For each STALE or tentative entry you can check quickly, confirm it against the code and `memory_update` it (`verified: true`, `status: resolved` or `invalidated`, or reworded `text`). Retire contradicted decisions with `supersedes`. Report what changed.
