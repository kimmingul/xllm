# AGENTS.md — xllm

## Purpose

Thin cross-vendor LLM kit: CLI advisors, local LLMs, measured routing,
review pipelines. The host orchestrates; external models advise.
See `docs/SCOPE.md`.

## Rules

1. External LLM calls go through `scripts/xllm-advisor.js`.
2. Role/model/effort picks go through `scripts/xllm-routing.js` (`pick`,
   `pick-team`) — measured traits included; never hand-pick by vendor lore.
3. Prefer extending scripts + skills over new runtimes.
4. Keep skills short and artifact-oriented.
5. `npm run ci` must pass without live LLMs.

## Verify

```bash
npm run ci
```
