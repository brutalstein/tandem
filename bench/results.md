# Tandem benchmark (2026-10-09, codex codex-cli 0.154.0, repeats=1)

fixed-top = gpt-6-astra@high, full Codex prompt. Token counts are Codex-reported (input includes cached).

| task | arm | status | tests re-run | model path | input tok | uncached in | output tok | wall s |
|---|---|---|---|---|---|---|---|---|
| ask/trivial | tandem | answered | - | gpt-5.6-luna@low | 39340 | 14252 | 475 | 13 |
| ask/trivial | tandem-full | answered | - | gpt-5.6-luna@low | 59831 | 21431 | 397 | 10 |
| ask/trivial | fixed-top | answered | - | gpt-6-astra@high | 81512 | 29928 | 305 | 16 |
| implement/normal | tandem | verified | pass | gpt-5.6-terra@medium | 81626 | 19162 | 893 | 39 |
| implement/normal | fixed-top | verified | pass | gpt-6-astra@high | 104302 | 28014 | 497 | 32 |
| implement/hard | tandem | verified | pass | gpt-5.6-sol@high | 91787 | 21643 | 3533 | 41 |
| implement/hard | fixed-top | verified | pass | gpt-6-astra@high | 165328 | 30928 | 1851 | 57 |

Implement tasks, totals: tandem 173413 input / 80 s vs fixed-top 269630 input / 89 s. Verified: tandem 2/2, fixed-top 2/2.
