---
description: Show Tandem status - Codex install/login, permitted models (and why others are excluded), availability, ceilings, routing estimates, memory, jobs and kept worktrees.
---
Call `tandem_status` (with `refresh: true` if the user passed "refresh": $ARGUMENTS) and `codex_jobs`. Show the output compactly. Point out anything that blocks delegation (not installed, not logged in, rate-limited, no permitted model, config problems) and the fix, any job in `conflict` or with a kept worktree that needs a decision, and any `suspended`/`interrupted` job (offer resume or takeover).
