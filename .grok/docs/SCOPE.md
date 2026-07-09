# Product scope — grok-xllm

## Why this plugin exists

Grok Build already provides subagents, plan mode, skills, hooks, and plugins.

It does **not** natively provide:

- Authentic **cross-vendor** CLI opinions (Codex vs Gemini vs Claude vs local)
- A packaged **evidence gate** that blocks fake completion
- A small **playbook** for mixed native + CLI parallel work

**grok-xllm** fills only those gaps: Grok orchestrates multi-LLM advisors.

## In scope

| Priority | Capability | Mechanism |
|----------|------------|-----------|
| P0 | Single advisor | `/ask` + `scripts/grok-ask-advisor.js` |
| P0 | Multi advisor + synthesis | `/ccg` + artifacts |
| P0 | Local LLMs | ollama / lmstudio / lemonade |
| P0 | Reliable Windows quoting | `shell: false`, stdin, cmd-shim unwrap |
| P1 | Evidence loop | `/ralph` + `/verify` |
| P1 | Parallel playbook | `/team` |
| P1 | Health | `/xllm-setup`, `--doctor` |
| P2 | Thin agents/personas | critic, verifier, security-reviewer, … |

## Out of scope

- Hooks delegation enforcer / stop-gate engine  
- HUD, notifications stack, wiki  
- Autopilot / ultrawork as large state machines  
- Full skill catalog mirrors  
- tmux-based CLI team runtime as default  

## Success metrics

1. `npm test` and `npm run check` pass without live LLMs  
2. `--doctor` reports READY providers accurately  
3. A `/ccg` run produces ≥2 artifacts + synthesis  
4. A `/ralph` run refuses completion without critic + verify evidence  

## Naming / version

Product name: **grok-xllm** (Grok × multi-LLM orchestration).  
Public version line starts at **0.1.0**.  
Legacy env/marker aliases (`OMG_*`, `omg-advisor-path`) still accepted where noted.
