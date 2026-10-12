---
name: review
description: >
  Cross-vendor review of a question or code diff. Default path is blind
  independent review (several models answer the same prompt without seeing each
  other; agreement is measured). Also: roles (parallel advisors, host
  synthesis) and EXPERIMENTAL debate/council. Use for "get multiple opinions",
  cross-vendor design or security review, "review this diff/branch with other
  vendors". Advisors run read-only by default; nothing is auto-applied.
---

# review — cross-vendor review (xllm)

Your host CLI synthesizes; external CLIs advise. Escalate by need: host alone →
`ask` one other vendor → **blind** independent review when a measured spread is
worth the extra calls.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-review.js"`.
Other hosts: `<plugin-root>/scripts/xllm-review.js` (two dirs above this SKILL.md).

## Modes

```bash
node <xllm-review.js> blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <xllm-review.js> roles   p1,p2[,p3] "<prompt>"      # parallel advisors, host synthesis — NOT measured
node <xllm-review.js> debate  p1,p2[,p3] "<claim>"       # EXPERIMENTAL
node <xllm-review.js> council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]   # EXPERIMENTAL
node <xllm-review.js> stats                              # pairwise agreement
node <xllm-review.js> outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no
```

| mode | what it gives | cost | status |
|---|---|---|---|
| blind | identical blind prompt, append-only ledger, measured agreement | ~1× per model | default recommendation |
| roles | different prompts per advisor; synthesis labels are yours | 1× | coverage, **not measured** |
| debate | adversarial refutation → SURVIVED / KILLED / UNRESOLVED | ~2–3× | **experimental** |
| council | blind → debate pipeline | ~3–4× | **experimental** |

**debate/council are experimental.** Their benefit has not been shown: the
earlier measurements found no quality discrimination and lower recall than
blind, and the evaluation under the current strict-identity method is still
pending. Do not use them as the basis for a high-stakes recommendation; use
`blind` and re-verify consequential claims yourself. A failed debate round is
reported UNRESOLVED, never survived.

## Reviewing code

Add exactly one diff source to any mode: `--staged | --base <ref> | --diff-file <path>`.
The diff is collected deterministically (plain git) and cut to a 24KB budget at
file/hunk boundaries. Every omitted file/hunk is listed in a DIFF COVERAGE
manifest (in md, ledger and `--json` result): relay that coverage, never
claim you reviewed the whole diff. `--base <ref>` is two-dot (`git diff <ref>`):
working tree vs ref, uncommitted changes included. The diff text is sent to
every advisor; see the persistence note below.

## Contract

- Advisors are read-only only where xllm verifies the boundary (installed ≠
  eligible); your own vendor is refused; nothing is auto-applied.
- `execution_policy = "local-only"` is strict: providers whose location is
  unknown or remote are excluded, never assumed local.
- blind/council write `<state>/panel-ledger.jsonl` BEFORE prose. Evidence uses
  the full attribution (executed provider, reported model, effort, surface,
  CLI version); results whose model identity is unresolved are shown but do
  not count toward routing evidence. Failures abstain.
- roles output is never "measured". Only blind/council/stats speak agreement.
- On a blind split the core suggests the measured tiebreaker for free — spend
  it with `--tiebreak`; never hand-pick by vendor pedigree.
- Afterwards record adoption: `outcome <run-id> …`.
- Persistence: by default each advisor call writes an artifact holding the
  original task and full prompt (diff text included, secrets redacted); the
  ledger and md index keep metadata + coverage only. `--no-artifacts` (blind/
  debate/council) writes no advisor artifacts or md index and no question/claim
  text in the ledger. Machine output: add `--json` (one object on stdout).
  Sensitive code → `--no-artifacts`, local-only policy, or local models.

## When NOT to use

Quick opinion → `ask`. Cheap git prose → `scribe`. Host-native agents already
cover same-model parallelism; reach here only when a different-model
perspective is the point.
