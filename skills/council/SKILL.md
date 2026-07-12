---
name: council
description: >
  The full two-phase deliberation: an independent blind panel surfaces diverse
  claims and measures their decorrelation, then an adversarial debate
  stress-tests those claims (survived / killed / unresolved) — in one command.
  Use for the most consequential decisions where you want BOTH a measured
  spread of independent views AND hostile refutation. Combines panel and
  debate; advisors stay read-only, nothing is auto-applied.
---

# council — panel → debate pipeline (xllm)

`council` runs both phases of cross-vendor deliberation in order:

1. **Phase 1 — panel (independent divergence).** Every model answers the same
   question blind, without seeing the others. Surfaces diverse claims and
   measures their pairwise agreement (decorrelation).
2. **Phase 2 — debate (adversarial convergence).** Those
   independently-surfaced claims are put through hostile cross-refutation.
   Each ends **SURVIVED / KILLED / UNRESOLVED**.

Panel-first is deliberate: refutation targets claims reached *independently*
(no anchoring), and you keep the diversity measurement. Status is a **protocol
outcome, not truth**; nothing is auto-applied.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-council.js"`.
Other hosts: `<plugin-root>/scripts/xllm-council.js`.

## Run (Bash tool)

```bash
node <xllm-council.js> run codex,grok,gemini "<consequential question or claim>" [--tiebreak] [--ready=a,b,c]
```

Works at N=2 and up. Identity is the MODEL, not the provider: two models on
the same local runtime (e.g. `ollama:llama3.2,ollama:gemma4`) are distinct
members and refute each other in phase 2. Same-vendor HOST nesting is still
refused.

## Tiebreak on a phase-1 split (measured decorrelation)

If phase 1 ends **split**, the core computes the tiebreaker pick for free —
an UNCONSULTED provider chosen by the LOWEST measured pairwise agreement in
the ledger (never by lineage) — and records it. Pass `--tiebreak` to actually
spend that one extra blind call. Its claims then join phase 2 **as an author
only** (leftover claim slots, never displacing an original member's claims,
never a debater), so the decorrelated payload gets stress-tested too. Do not
hand-pick a tiebreaker vendor yourself; `--ready=` only constrains which
providers are considered available.

## Read the result

The combined index (last stdout line) shows the phase-1 consensus label +
pairwise agreement, then the phase-2 SURVIVED / KILLED / UNRESOLVED claims,
linking the detailed panel and debate artifacts. Both phases are recorded to
`<state>/panel-ledger.jsonl` (the panel run is linked to the debate).

- Act on **SURVIVED** claims with more confidence (they passed independent
  scrutiny *and* hostile refutation) — still re-verify anything consequential.
- **KILLED** = surfaced but refuted (read the refutation). **UNRESOLVED** =
  genuinely disputed, human judgment needed.
- Low phase-1 agreement = genuinely decorrelated panel; high agreement =
  correlated views (unanimity is confidence metadata, not proof).

## When to use which

- `panel` — cheap, just measure the spread of independent views.
- `debate` — stress-test a set of claims adversarially.
- `council` — both, for the highest-stakes calls. Costs the most (~3–4× the
  calls of a single ask). Reach for it when being wrong is expensive.

## When NOT to use

Quick opinion → `ask`. Cheap chores → `scribe`. Don't spend a full council on
low-stakes questions.
