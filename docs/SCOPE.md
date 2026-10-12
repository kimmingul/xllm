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
| P0 | Single / parallel advisors | `ask` (`--json` result envelope), `review roles` + `scripts/xllm-advisor.js` |
| P0 | Local LLMs | ollama (HTTP API) / lmstudio / lemonade |
| P0 | Reliable Windows delivery | `shell: false`, stdin payloads, `--prompt-file`, cmd-shim unwrap |
| P0 | Review family | `review blind` (independent, measured — default) · `review roles` (coverage) · `review debate` / `review council` (**experimental**: benefit unproven, re-evaluation pending) |
| P0 | Evidence-based routing | strict-identity ledger + trait profiles (Wilson LCB, sample gates); unresolved/legacy records never route; cost/tier routing |
| P0 | Execution boundaries | verified read-only adapters only, `execution_policy` local-only (fail-closed), auth unknown until observed |
| P1 | Escalation ladder | `ask` → `propose` (diff) → `exec` (isolated clone, verified OS sandbox, evidence handback) |
| P1 | Cheap-prose lane (optional) | `scribe` (commit/PR/release notes on the cheapest healthy model; the diff goes to the routed provider) |
| P1 | Health & contracts | `doctor`, `contracts` (flag drift, failure taxonomy), `smoke` |
| P1 | Self-refuting benchmark | `xllm bench`: seeded-defect tasks, repeats, held-out set, human adjudication, opt-in budgeted live runs |

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
3. A `review roles` run produces per-advisor artifacts + a synthesis contract; `--json` runs emit one
   result object with full attribution
4. Measured instruments feed real decisions only through resolved-identity evidence: split → measured
   tiebreaker; bench cells → trait-profile routing (`benchmarks/FINDINGS.md` is historical, non-routing)

## Naming / version

Product name: **xllm** (cross-vendor multi-LLM). One repo, three host
adapters (`.claude-plugin/`, `.codex-plugin/` + `.agents/`, `.grok/`).
The advisor core is `scripts/xllm-advisor.js`.
