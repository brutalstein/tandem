<div align="center">

<sub>CLAUDE CODE × OPENAI CODEX</sub>

# tandem ⚡

### Two brains. One terminal. Zero tab gymnastics.

**Claude leads. Codex works in the background. Tandem keeps everyone in sync.**

An intelligent, open-source Claude Code plugin for model routing, parallel coding, test-backed handoffs, and shared project memory. No extra chat windows. No copy-paste relay races.

<p>
  <a href="https://github.com/brutalstein/tandem/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/brutalstein/tandem/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/brutalstein/tandem/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/brutalstein/tandem/actions/workflows/codeql.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-1f883d?style=flat">
</p>

**[Get started](#get-started)** · **[See the evidence](#the-evidence)** · **[How it works](docs/ARCHITECTURE.md)**

</div>

---

## One workflow. A very capable team.

| | |
|:--|:--|
| 🧠 **Smart routing** | Picks an available Codex model and reasoning effort based on task difficulty and observed outcomes. |
| 🌳 **Parallel, without the pile-up** | Coordinates file ownership and isolated Git worktrees when needed. |
| 🧪 **Trust tests, not confidence** | Checks coding results with project tests; flags conflicts and suspicious changes. |
| 🧩 **Memory that sticks** | Shares decisions and findings between agents, with provenance and staleness checks. |

**The idea:** ask Claude normally → delegate when it makes sense → Codex handles a scoped job → Tandem checks the result. Claude stays your only interface.

## The evidence

<div align="center">

| **62 / 62** | **8 / 8** | **12 / 12** | **5–11 ms** |
|:--:|:--:|:--:|:--:|
| Deterministic tests¹ | Real Codex checks² | Install lifecycle² | Hook overhead³ |

<a href="docs/ROUTING.md"><img src="docs/charts/routing-regret.svg" alt="Measured routing policy performance in five simulated worlds; lower cost above hindsight oracle is better" width="48%"></a>
<a href="docs/BENCHMARKS.md"><img src="docs/charts/overhead.svg" alt="Locally measured Tandem process and hook overhead on Windows" width="48%"></a>

<sub>Click a chart for methodology and underlying data. No decorative numbers were harmed.</sub>

</div>

**Routing study:** Tandem averaged **15.7%** extra cost above a hindsight oracle, versus **22.5%** for the fixed strongest-model / medium-effort baseline (**30 seeds × 5 simulated worlds**). This is a *simulation*, not a claim that real AI tasks are universally 30% cheaper.

¹ Simulated-provider tests across Windows/Linux/macOS CI. ² Recorded real-provider and installation checks. ³ Extra time above Node startup, measured locally on Windows. Real-provider comparisons are still a [small pilot](docs/BENCHMARKS.md)—sometimes delegating takes longer. **We publish the awkward numbers too.**

## Get started

**You'll need:** [Claude Code](https://code.claude.com/docs/en/overview), [Codex CLI](https://github.com/openai/codex), **Node.js 20+**, and **Git**.

In your terminal:

```bash
npm install -g @openai/codex
codex login
claude plugin marketplace add brutalstein/tandem
claude plugin install tandem@tandem-local
```

Restart Claude Code. Then type:

```text
/tandem:status
```

**That's it.** Keep asking Claude to build things as usual—or hand off work explicitly:

```text
/tandem:delegate Fix the failing tests and verify the changes
/tandem:review
/tandem:memory audit
```

Want to tune token use, reasoning ceilings, or parallel jobs? Open Claude Code's `/plugin` configuration. The defaults are ready to try.

<details>
<summary><b>For the curious: what's under the hood?</b></summary>

**Claude Code plugin + MCP + Codex CLI + Node.js + Git.** Expected-cost routing, background jobs, file claims, independent verification, and persistent project memory. No third-party runtime dependencies.

[Architecture](docs/ARCHITECTURE.md) · [Routing math](docs/ROUTING.md) · [Benchmark data](docs/BENCHMARKS.md) · [Security](SECURITY.md) · [Release readiness](docs/RELEASE_READINESS.md)

</details>

---

<div align="center">

**Less model juggling. More shipping.**

<sub>MIT licensed · Tandem v2 · Codex usage follows your account limits · No quota sorcery</sub>

</div>
