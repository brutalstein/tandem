# Routing

Tandem decides which Codex model and reasoning effort runs a job, and what to do when an attempt fails. The decision logic is in `server/catalog.js` (what may be used) and `server/policy.js` (what should be used).

## 1. What may be used: eligibility

The candidate set comes from the live catalog (`codex debug models`, cached 6 h; negative results cached 60 s). It is never a fixed list.

- Hidden catalog entries are excluded.
- Models above `codex_max_model` are excluded. Ordering is by generation, then family. The family order (`luna < terra < sol < astra`) is only a hint used when the catalog gives no better signal; an unknown family is reported, not silently dropped.
- `codex_allowed_models`, when set, is an explicit allow-list and overrides the heuristic.
- Efforts above `codex_max_effort` are excluded. `max` and `ultra` are never used unless the ceiling allows them.
- Models the provider rejected for this account are excluded until the rejection expires (24 h). An explicit request for such a model is rejected; Tandem never substitutes a different model for an explicit request.

`tandem_status` lists every excluded model with its reason.

The result is a set of **rungs** `model@effort` with a prior capability score `cap ∈ [0,1]` (70 % model rank, 30 % effort).

## 2. What should be used: expected cost of a verified result

Tandem minimises the expected total cost of reaching a successful (verified) result, not the cost of one call.

For an escalation sequence s = (s₁, …, s_k), k ≤ 4:

```
E[cost | s] = Σᵢ Πⱼ<ᵢ (1 − qⱼ) · C(sᵢ)  +  Πⱼ (1 − qⱼ) · F
q₁ = p(s₁),  qᵢ = p(sᵢ)·(1 − ρ) for i > 1
```

| Symbol | Meaning | Estimate |
|---|---|---|
| p(r) | probability that rung r succeeds on a task of this class | success model below |
| ρ | how much a failure lowers the next attempt's chance (failures are correlated: the task is harder than its class suggests) | learned from conditional observations, default 0.25, clamped to [0, 0.8] |
| C(r) | cost of one attempt | observed costs on this rung, shrunk toward a prior (×1.1 per model tier, ×1.45 per effort step, fitted on real attempts, see below) scaled to the observed units; other classes' observations count half |
| F | cost of ending without success (Claude redoes the work) | `failureMult × max C`, `failureMult = 2` |

Cost units follow `objective`:
- `tokens`: uncached input + 0.1 × cached input + output;
- `time`: seconds;
- `balanced`: the mean of both, each normalised to a reference (60k tokens, 60 s).

The minimising sequence is found exactly by dynamic programming over non-decreasing rung indices. A retry may stay on the same rung; that resumes the same Codex thread with cached context. A unit test compares the DP with brute-force enumeration.

### Success model

```
logit p(class, model, effort) = α[class] + γ[model] + ε[effort]
```

| Parameter | Prior (Gaussian) | Meaning |
|---|---|---|
| α[class] | mean `PRIOR_LOGIT[difficulty]` (+0.5 for read-only modes), sd 1.0 | how hard this kind of task is |
| γ[model] | mean `3 · 0.7 · (model rank − 0.5)`, sd 1.0 | catalog rank as a weak hint only |
| ε[effort] | mean `3 · 0.3 · (effort rank − 0.5)`, sd 0.5 | effort as a weak hint |

- **Fitting.**
  - The model is fit by maximum a posteriori estimation (Newton's method, Cholesky solves) on all observations of the project.
  - Each observation is weighted by age (half-life 30 days) and by order within its class (λ = 0.97, at most 80 per class).
  - A retry observation counts half, because it is conditioned on a failure.
- **Sharing.** Every observation informs every class: a model that succeeds on hard tasks also gains on normal ones.
- **No imposed ordering.** The model imposes no ordering between models. If a cheaper model keeps succeeding, it is preferred on evidence alone, even against the catalog's ranking.
- **Uncertainty.**
  - Predictions use the posterior predictive (Laplace approximation, probit correction), so uncertain estimates move toward ½ instead of being over-confident.
  - Exploration uses Thompson sampling from the same Laplace posterior, seeded per job so a decision is reproducible.
  - An exploratory first rung is vetoed if its expected cost under the posterior exceeds the best plan by more than 1.5 cost units.

### What Tandem learns from

After each job, Tandem records rung, success, whether the attempt was a retry, tokens, cached tokens, output tokens and seconds, per project and task class (`mode|difficulty`). Success means:
- `verified` for implement jobs with a check;
- Codex's own `done` report when no check exists, which is a weaker signal;
- `answered` for ask and review.

Provider errors (rate limits, unsupported models, crashes) are not recorded as model failures.

v1 router statistics are migrated into this store as synthetic observations.

## 3. Evidence: simulation study

`bench/router-sim.js` runs the unmodified policy in synthetic worlds whose true success curves deliberately differ from the policy's priors.

- **World model.**
  - Tasks have latent difficulty, so failures are correlated within a task.
  - Tokens per attempt grow ×1.08 per model tier and ×1.38 per effort step, with log-normal noise. These are the factors measured on real attempts (section 4).
- **Policies.** Every policy gets at most 2 attempts per task.
- **Oracle.** The oracle knows the world and chooses the best static 2-step plan per class.

The study uses 30 seeds per world. The table shows mean cost above the oracle, where lower is better. Success rates and confidence intervals are in `bench/data/router-sim.json`.

| world (what is wrong with the prior) | fixed-top (astra@xhigh) | codex-default (astra@medium) | cheapest-escalate | v1 static table | v2 mean (no exploration) | **v2 Thompson** (default) |
|---|---|---|---|---|---|---|
| monotone (prior correct) | 47.3 % | 8.5 % | 59.8 % | 49.1 % | **5.5 %** | 12.2 % |
| flat (cheap rungs nearly as good) | 80.4 % | 19.5 % | **4.6 %** | 37.7 % | 5.4 % | 10.7 % |
| inverted (middle model is strongest) | 101.9 % | 48.5 % | 33.7 % | 59.8 % | 36.4 % | **24.3 %** |
| drift (cheap models improve mid-run) | 70.3 % | 26.6 % | 38.8 % | 51.8 % | 19.7 % | **19.2 %** |
| sparse (32 tasks only) | 50.2 % | 9.5 % | 58.4 % | 47.0 % | **5.9 %** | 12.0 % |
| **mean** | 70.0 % | 22.5 % | 39.1 % | 49.1 % | **14.6 %** | 15.7 % |
| **worst case** | 101.9 % | 48.5 % | 59.8 % | 59.8 % | 36.4 % | **24.3 %** |

![routing simulation](charts/routing-regret.svg)

### Reading the results honestly

- **Both v2 variants beat every fixed strategy on average.** Thompson sampling (the default) has the best worst case.
  - It is significantly cheaper than codex-default in 3 of 5 worlds (6–20 %).
  - It is not significantly different in the sparse world, and 3.3 % more expensive in the monotone world (paired 95 % CIs).
- **Exploration buys robustness, not average cost.**
  - Without exploration (v2 mean), the policy is 5–6 % cheaper whenever its prior is roughly right: monotone, flat and sparse, all significant.
  - It costs 9.7 % more when the catalog's ranking is wrong (inverted), and its worst case rises from 24 % to 36 %.
  - Tandem keeps exploration on because a wrong ranking is exactly the failure an evidence-driven router must survive. Set `TANDEM_EXPLORATION=false` to disable it.
- **One baseline wins a world outright.** When cheap rungs are nearly as good as expensive ones, always starting cheap wins (4.6 %).
- **Cost, not success rate, is optimised.** With `F = 2 × max C`, v2 accepts a lower Codex success rate than fixed-top: 0.72 vs 0.87 in the monotone world. The unsolved tasks fall back to Claude.
  - If your Claude time is much more expensive than Codex tokens, a higher failure multiplier (`TANDEM_FAILURE_MULT`) moves the policy toward stronger rungs.
- **Simulation only.** These are simulated worlds. They show how the policy adapts when its assumptions are wrong; they do not show how real models behave. Real-provider results are in [BENCHMARKS.md](BENCHMARKS.md).

## 4. Calibration from real runs

**Cost prior.** The first prior (×1.3 per model tier, ×1.2 per effort step) was an assumption. Real data contradicted it: on a fresh install, exploration sent a trivial question to `terra@high`, which cost 183k tokens and 103 s, against about 45k tokens and 14 s for a low-effort rung.

A log-linear fit on the 24 real attempts recorded on 2026-10-09 (codex-cli 0.154.0) gave these factors:

| | per model tier | per effort step | residual sd (log) |
|---|---|---|---|
| tokens (uncached + 0.1 × cached + output) | ×1.08 | ×1.38 | 0.35 |
| seconds | ×1.08 | ×1.51 | 0.53 |

- **Caveat.** Effort is confounded with task difficulty in this data, because hard tasks were routed to higher effort. The effort factor is therefore likely an overestimate.
- **New prior.** The prior is now ×1.1 per tier and ×1.45 per effort step. It is only a prior: observed costs replace it as data accumulates.
- **Effect.** On a fresh install, every class now starts at `gpt-6-astra@low`, and exploration stays at low or medium effort.

Effect in the simulation (mean / worst regret over the five worlds, v2 Thompson):

| prior ↓ / world cost model → | old assumption (×1.25 tier, ×1.15 effort) | measured (×1.08, ×1.38) |
|---|---|---|
| old prior | 10.8 % / 16.5 % | 19.1 % / 23.2 % |
| **measured prior** | 12.0 % / 19.6 % | **15.7 % / 24.3 %** |

In the world that matches the measurements, the measured prior lowers mean regret by 3.4 points; the worst case is about equal. It does worse only in the world built on the old assumption.

**Model quotas.** Token counts treat all models alike. Subscription quotas may weight models differently, but those weights are not published, so Tandem does not model them.

### Exploration threshold

An exploratory first rung is allowed only if its expected cost is at most `EXPLORE_MAX_REGRET` × that of the best plan. Same simulation, v2 Thompson, 30 seeds, mean / worst regret:

| threshold | old world cost model | measured world cost model |
|---|---|---|
| 1.1 | 10.5 % / 18.2 % | 13.6 % / 26.3 % |
| **1.25 (current)** | 10.8 % / 16.5 % | 15.7 % / 24.3 % |
| 1.5 (previous) | 11.8 % / 16.7 % | 17.4 % / 24.2 % |

Lower thresholds lower the mean and raise the worst case. 1.25 is the compromise. Differences of 1–2 points are within seed noise (about ±2–3 points). Override with `TANDEM_EXPLORE_MAX_REGRET`.

### Design history

The first v2 design used independent Beta posteriors per rung with an isotonic (monotone in capability) constraint. In the original simulation (old world cost model, 10 seeds), its regret was:

| world | Beta + isotonic | additive model |
|---|---|---|
| inverted | 48.6 % | 16.3 % |
| flat | 24.4 % | 17.8 % |
| drift | 21.3 % | 12.6 % |
| monotone | 5.3 % | 6.8 % |
| sparse | 1.8 % | 2.5 % |

The monotonicity constraint encoded exactly the kind of assumption about model superiority that the evidence should decide, so it was removed. The additive model gives up about 1.5 points where the assumption holds, and gains 7–32 points where it does not.

### Cost of deciding

`decide()` takes 1.1 ms at the median and 1.4 ms at the 95th percentile. That measurement uses 16 rungs, up to 4 attempts, a full evidence store (8 classes × 80 observations) and Node 24.

## 5. Which strategy: tool, you, a subagent or Codex

`server/strategy.js` sits above the Codex policy and answers the earlier question: should this task be delegated at all? `codex_run` with `dry_run: true` returns its decision record first, then the Codex plan. It is advice to the lead; it never blocks a run.

| Strategy | When |
|---|---|
| `tool` | a read-only question a search answers exactly ("where is X defined", "find all callers of Y"); no model call |
| `claude` | you do it in the conversation |
| `claude-subagent` | read-only work over enough files that a fresh, small context is cheaper than carrying them in yours |
| `codex` | delegate (the policy above then picks model and effort) |

Every option is an interval of **effective tokens** (the policy's `tokens` unit). Claude tokens are multiplied by `claude_cost_weight` (default 1): how much a Claude token costs you relative to a Codex token. Tandem does not convert one provider's quota into the other's; the weight states your exchange rate.

```
codex    = w · (write the task + 2–3 turns + read the diff or answer, carried) + E_codex · band
claude   = w · (read + carried reads + turns · TURN + edits + check output)
subagent = w · (spawn + read + 2–6 small turns + summary, carried)
```

- `E_codex` is the policy's expected cost of the routed plan under the `tokens` objective (including retries and the failure fallback), from this project's observations. `band` is ×0.75–1.33 with at least 3 observations of the class, ×0.5–2 otherwise.
- Size is measured: the bytes of the files in `paths` (dependency folders skipped) / 4.
- Claude-side costs are not observable by Tandem, so they are explicit ranges, listed in the record as "not measured":

| Assumption | Range | Basis |
|---|---|---|
| TURN (one turn of the main conversation) | 1–5k | 10–50k tokens of cached context at 0.1 |
| CARRY (later re-sending of what was read) | ×0.5–3 | 5–30 later turns at 0.1 |
| subagent turn / spawn | 0.3–1k / 3–8k | small fresh context |
| reads, edits | ×0.5–1.5 of the scoped size, edits ×0.05–0.3 | |

Decision: the option with the lowest geometric midpoint wins, unless the simpler option (claude, then subagent, then codex) is within 25 %; `uncertain` marks overlapping intervals. Without `paths` there is no estimate, and the scoping rule applies: trivial or unchecked work stays with you, and checked work may be delegated. Hard and critical implementations always add your review of the whole diff.

Measured anchor for the fixed cost of delegating: in the real pilot (`bench/data/real-v2-pilot`), the cheapest delegated trivial question cost 9.4k effective Codex tokens and 17 s, and the median task 37–48k.

### Sensitivity (synthetic)

`node bench/strategy-sim.js` draws "true" costs independently of the assumptions above, including scenarios where they are wrong, and compares total cost against a per-task oracle (1.00 = always the cheaper option):

| Scenario (Claude weight) | always Claude | always Codex | size > 10k → Codex | Tandem |
|---|---|---|---|---|
| assumptions hold (×1) | 2.10 | 1.27 | **1.11** | 1.16 |
| assumptions hold (×3) | 3.22 | **1.05** | 1.28 | 1.12 |
| Claude cheaper than assumed (×1) | 1.76 | 1.62 | 1.15 | **1.08** |
| Claude cheaper than assumed (×3) | 2.91 | 1.15 | 1.14 | **1.04** |
| Claude dearer than assumed (×1) | 2.83 | **1.07** | 1.23 | 1.41 |
| Claude dearer than assumed (×3) | 3.99 | **1.01** | 1.49 | 1.24 |
| Codex dearer than estimated (×1) | 1.56 | 1.66 | 1.18 | **1.07** |
| Codex dearer than estimated (×3) | 2.53 | 1.14 | 1.15 | **1.05** |

No policy wins every scenario. Tandem has the lowest worst case (1.41 against 1.49, 1.66 and 3.99) and never doing the work yourself is the worst policy throughout. It loses to "always delegate" when Claude work is much dearer than assumed, and to the fixed threshold when the assumptions hold at equal weight (its tie rule favours the simpler strategy). These numbers come from the simulation's own cost model and say nothing about real savings. Calibrating the Claude-side ranges needs the real benchmark with Claude arms, which spends quota and has not been run.

### Decisions on the benchmark corpus

The same script prints what the layer decides for each of the 20 corpus tasks (Codex cost anchored on the real pilot, no project observations, so the widest band). With equal weights it keeps 19 tasks with you and sends the 300-module header lookup to a search tool. With Claude weighted ×3 it additionally delegates the trivial checked edit, where the Codex prior is cheapest. Every Claude-or-Codex choice is marked uncertain: the fixtures are small, and without observations the Codex band is ×0.5–2. Whether these choices are right is what the real benchmark's `claude-adaptive` arm measures; it has not been run.

## 6. Where the tokens go (context)

Measured before changing anything:

| Item | Size | Source |
|---|---|---|
| Tandem's prompt to Codex (task, scope, check, ≤3 skill pointers, ≤1,800 chars of notes, rules) | 184–407 tokens, median 327, over the 20 corpus tasks | `Orchestrator.prompt` |
| One Codex run's raw input (cached included) | 53k–196k, median 145k | real pilot |
| One Codex run, effective tokens | 9.4k–74k | real pilot |
| Tandem's MCP tool definitions in Claude's context | 7.0 KB | `bench/overhead.js` |

Tandem's own prompt is about 0.2 % of what a Codex run reads. Compressing it further cannot change the cost of a job; the rest is Codex's own system prompt, configuration, tool schemas and the files it reads. Lean mode already removes Codex's skill list and plugins. The levers that matter are not delegating when it does not pay (§5), the cheapest sufficient model and effort (§2), and resuming the same thread on a retry (cached context). The only change made here: the worker prompt now names the check Tandem will run (`CHECK: …`), about 20 tokens, so the worker can run the acceptance command instead of guessing one. Its effect on retries has not been measured.
