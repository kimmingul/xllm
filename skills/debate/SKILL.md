---
name: debate
description: >
  Adversarial multi-LLM review: models see and try to REFUTE each other's
  claims so plausible-but-wrong ones die and correct ones survive. Use when a
  decision is consequential and you want claims stress-tested — security
  reviews, "is this actually safe/correct", high-stakes design calls. The
  quality-maximizing complement to the independent `panel` (which measures
  diversity). Advisors stay read-only; nothing is auto-applied.
---

# debate — Adversarial multi-LLM review (xllm)

`panel` measures diversity (blind, independent). `debate` **spends** it:
cross-vendor models refute each other so wrong claims die. Status is a
**protocol outcome, not truth** — SURVIVED means a claim withstood hostile
refutation, not that it is proven. Nothing is auto-applied; you decide.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-debate.js"`.
Other hosts: `<plugin-root>/scripts/xllm-debate.js` (two dirs above this file).

## Run (Bash tool)

```bash
node <xllm-debate.js> run codex,grok,gemini "<question or claim to stress-test>"
```

Works at N=2 (two debaters) and up. Different MODELS count as different
debaters — identity is the model, not the provider, so two local models on
the same runtime (`ollama:llama3.2,ollama:gemma4` — different labs) attack
each other's claims. Same-vendor HOST nesting is still refused, and diverse
models remain the point.

## What happens

1. **R0 blind claims** — each model independently answers and emits atomic,
   falsifiable claims (no model sees another's answer).
2. **R1 refute** — each model attacks the *others'* claims (foreign only),
   with a concrete mechanism + falsifier, tagged `decisive` or `soft`.
3. **R2 defend** — each claim's author answers the attacks: `holds`, `amend`,
   or `concede`.
4. **Mechanical resolution** (no judge model, order-immune): each claim ends
   **SURVIVED / KILLED / UNRESOLVED**. Only a **decisive falsifier** the author
   can't defeat kills a claim; mere disagreement → UNRESOLVED. A confabulated
   soft attack can never kill.

## Read the result

The index (last stdout line) groups claims by status; the ledger
(`<state>/panel-ledger.jsonl`, `type: "debate"`) records everything before the
prose. Act on **SURVIVED** claims with more confidence, treat **KILLED** as
refuted (read the refutation that killed it), and send **UNRESOLVED** to human
judgment. Re-verify anything consequential yourself — survived ≠ proven.

## When to use panel vs debate

- **panel** — cheap, measures decorrelation, surfaces independent blind spots.
  Use to *see the spread* of views.
- **debate** — costlier (~2–3× the calls), stress-tests claims to *converge on
  quality*. Use when being wrong is expensive.

## When NOT to use

- Quick opinion → `ask`. Diversity measurement → `panel`. Cheap chores →
  `scribe`. Debate is for consequential claims worth adversarial scrutiny.
