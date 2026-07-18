---
name: review
description: >
  Cross-vendor deliberation over a question or a code diff, four modes in one
  noun: roles (parallel advisors + host synthesis), blind (measured
  independent panel), debate (adversarial refutation), council (blind→debate
  pipeline). Use for "get multiple opinions", cross-vendor design or security
  review, "review this diff/branch with other vendors", or when a decision is
  consequential and claims need stress-testing. Advisors run read-only by
  default; nothing is auto-applied.
---

# review — cross-vendor deliberation (xllm)

One entry point, four modes. Your host CLI synthesizes; external CLIs advise.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-review.js"`.
Other hosts: `<plugin-root>/scripts/xllm-review.js` (two dirs above this SKILL.md).

## Modes

```bash
node <xllm-review.js> roles   p1,p2[,p3] "<prompt>"      # parallel advisors, host synthesis — NOT measured
node <xllm-review.js> blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <xllm-review.js> debate  p1,p2[,p3] "<claim>"       # SURVIVED / KILLED / UNRESOLVED
node <xllm-review.js> council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <xllm-review.js> stats                              # pairwise agreement (measured decorrelation)
node <xllm-review.js> outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no
```

| mode | epistemology | cost | reach for it when |
|---|---|---|---|
| roles | coverage — synthesis labels, **not measured** | 1× | advisors need different prompts |
| blind | measurement — identical blind prompt, append-only ledger | ~1× | you want the measured spread |
| debate | adversarial — decisive falsifiers kill wrong claims | ~2–3× | being wrong is expensive |
| council | independent divergence → hostile convergence | ~3–4× | the highest-stakes calls |

## Reviewing code

Add exactly one diff source to any mode. The diff is collected
deterministically (plain git), size-capped, sent to advisors — and never
persisted (ledger/index record source/stat/bytes only):

```bash
--staged | --base <ref> | --diff-file <path>
```

## Contract

- Advisors are read-only; your own vendor is refused; nothing is auto-applied.
- blind/council write `<state>/panel-ledger.jsonl` BEFORE prose. The ledger is
  truth; your summary is UX; minority reports are findings; failures abstain.
- roles output is never "measured" — its labels are your synthesis, not
  agreement rates. Only blind/council/stats speak measured decorrelation.
- On a blind split the core suggests the measured tiebreaker for free — spend
  it with `--tiebreak`; never hand-pick by vendor pedigree.
- Afterwards record adoption: `outcome <run-id> …` — it feeds measured routing.
- SURVIVED = withstood refutation, not proven. Re-verify consequential claims.

## When NOT to use

Quick opinion → `ask`. Cheap git prose → `scribe`. Host-native agents already
cover same-model parallelism; reach here only when cross-vendor disagreement
(or a local-model perspective) is the point.
