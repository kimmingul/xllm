# AGENTS.md — grok-xllm

## Purpose

Thin multi-LLM kit for Grok Build: CLI advisors, evidence loops, local LLMs, role routing.  
Grok orchestrates; external models advise. See `.grok/docs/SCOPE.md`.

## Rules

1. External LLM calls go through `scripts/grok-ask-advisor.js`.
2. `/team` must use `scripts/xllm-routing.js` (`pick-team`) for model/effort.
3. Prefer extending scripts + skills over new runtimes.
4. Keep skills short and artifact-oriented.
5. `npm test` must pass without live LLMs.

## Verify

```bash
npm run ci
grok plugin validate .
```
