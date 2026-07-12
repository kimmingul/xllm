# Product scope — xllm

## Why this plugin exists

Agentic coding hosts (Claude Code, Codex, Grok Build) already provide
subagents, plan mode, skills, hooks, and plugins. They do **not** natively
provide:

- Authentic **cross-vendor** CLI opinions (Codex vs Gemini vs Claude vs local)
- Free **local LLMs** as first-class participants
- **Instruments** that measure whether that diversity actually pays
  (pairwise agreement ledger, seeded-defect benchmark, trait profiles)

**xllm** fills only those gaps: one host-neutral core, thin per-host adapters.

## In scope

| Priority | Capability | Mechanism |
|----------|------------|-----------|
| P0 | Single / parallel advisors | `ask`, `multi` + `scripts/xllm-advisor.js` |
| P0 | Local LLMs | ollama (HTTP API) / lmstudio / lemonade |
| P0 | Reliable Windows delivery | `shell: false`, stdin payloads, `--prompt-file`, cmd-shim unwrap |
| P0 | Review family | `panel` (blind, measured) · `debate` (adversarial, mechanical kill rules) · `council` (pipeline) |
| P0 | Measured routing | ledger tiebreaker, trait profiles (Wilson LCB, sample gates), cost/tier routing |
| P1 | Escalation ladder | `ask` → `propose` (diff) → `exec` (isolated clone, evidence handback) |
| P1 | Cheap-prose lane | `scribe` (commit/PR/release notes on the cheapest healthy model) |
| P1 | Health & contracts | `doctor`, `contracts` (flag drift, failure taxonomy), `smoke` |
| P1 | Self-refuting benchmark | seeded-defect tasks + error-correlation measurement |

## Out of scope (deliberate)

- Hooks delegation enforcers / stop-gate engines, HUD, notification stacks
- Agent-OS runtimes (ralph / ultrawork / autopilot state machines) — host-native features cover them
- Hand-authored model personas / lineage lore — evidence only, sample sizes visible
- Full skill-catalog mirrors; tmux team runtimes
- Anything that mutates the user's checkout (advisors are read-only by default;
  `exec` works in an ephemeral separate-`.git` clone)

## Success metrics

1. `npm run ci` passes without live LLMs
2. `--doctor` reports provider availability accurately (READY = binary/server
   responds; auth is only proven by `smoke --live`)
3. A `multi`/`panel` run produces per-advisor artifacts + a synthesis contract
4. Measured instruments feed real decisions: split → measured tiebreaker;
   bench cells → trait-profile routing (see `benchmarks/FINDINGS.md`)

## Naming / version

Product name: **xllm** (cross-vendor multi-LLM). One repo, three host
adapters (`.claude-plugin/`, `.codex-plugin/` + `.agents/`, `.grok/`).
The advisor core is `scripts/xllm-advisor.js`.
