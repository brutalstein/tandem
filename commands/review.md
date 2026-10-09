---
description: Get an independent Codex review of the uncommitted changes, then triage the findings.
argument-hint: [focus area]
---
Run `codex_run` with mode `review`, difficulty `hard` (`critical` for security-sensitive code), task: review the uncommitted changes for correctness bugs, regressions and security issues. Focus: $ARGUMENTS

Then check each reported defect against the code yourself. Present only confirmed defects (file:line, impact, fix), and list the rejected ones in one line each with the reason. Do not apply fixes unless the user asks.
