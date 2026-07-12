# xllm tiebreak — closing the measurement→routing loop (2026-07-12)

> Designed via xllm's own adversarial method: codex@high and grok@high each
> proposed a design (Round 1), then rebutted each other (Round 2); one residual
> issue went to a focused Round 3. This document is the synthesized result;
> raw rounds are in `.grok/artifacts/ask/*close-the-measurement-routing-loo*`
> and `*cross-rebuttal*`.

## Purpose

The mission thesis is "spend diversity ONLY where decorrelation is MEASURED"
(benchmarks/FINDINGS.md: pairwise error correlation 1.0 on well-known defects,
0.746 with a +1 dividend on hard ones). The measurement instrument exists
(`panel` ledger, pairwise agreement matrix) and the deterministic picker exists
(`suggestTiebreaker` in xllm-routing.js) — but before this change the picker
was called zero times in live flow and routing read the ledger zero times.
This change wires them together: on a **split** panel, the ledger's measured
agreement picks the tiebreaker.

The loop becomes:

```text
blind observations → measured agreement → deterministic selection
→ explicit consent (--tiebreak) → one more blind observation
→ future routing evidence (ledger)
```

## Convergence (what the two designers agreed after rebuttal)

- **Trigger: `split` only.** `single-source`/`no-verdicts` are reliability
  problems (retry/health), not diversity-routing problems; `majority`/
  `unanimous` have no disagreement to break — extra spend there is diversity
  theater. (Unanimous R1.)
- **Opt-in spend, free suggestion.** On split the suggestion is ALWAYS
  computed, printed, and recorded (no LLM call); the extra blind call runs
  only with `--tiebreak`. No `--no-tiebreak` — default is off. Mechanical
  min-agreement selection is *transport* (same class as `consensusLabel`/
  `ledgerStats`); the host keeps the intelligence: whether to spend, what to
  adopt. (Unanimous R1.)
- **Wired inside `runPanel`** — single choke point; council inherits via
  forwarded options. (Unanimous R1.)
- **Original panel record is immutable.** The tiebreak result is a separate
  append-only record linked by `panel_run_id` (the same pattern debate records
  already use). Codex's embedded `panel.tiebreak` field was rejected in R2
  (measurement-record pollution; `status:"scheduled"` crash hole); grok's
  `auto_ran` flag was rejected in R2 (permanently-false value after execution)
  — **the presence of the `type:"tiebreak"` record is authoritative** for
  whether it ran. (Converged R2: codex CONCEDE on record shape.)
- **Tiebreak pairwise rows feed `ledgerStats`** (the tiebreaker is blind and
  prompt-identical → comparable) WITHOUT incrementing `runs`. That is what
  closes the loop for future picks. (Unanimous R1.)
- **Ready set:** `detectAvailableProviders()` default, `--ready=a,b,c`
  override; NO `~/.xllm` inventory cache (stale readiness would turn
  deterministic routing into predictable failures). (Unanimous R1.)
- **Blindness invariant:** the tiebreaker gets the identical
  `buildPanelPrompt(question)` and never sees other answers. (Constraint,
  reaffirmed by both.)

## Behavior

```text
xllm-panel   run p1,p2[,p3] "<q>" [--tiebreak] [--ready=a,b,c]
xllm-council run p1,p2[,p3] "<q>" [--tiebreak] [--ready=a,b,c]
```

On `consensus === 'split'`:

1. `matrix = ledgerStats(readLedger(root)).matrix` (computed after the panel
   record is appended — record-before-narrative; candidate scores are
   unaffected by the current run since candidates are unconsulted).
2. `suggestTiebreaker(onPanelSpecs, readyList, matrix)` → provider or null.
3. Append `type:"tiebreak_suggest"` (always, even suggest-only).
4. If `--tiebreak` and provider non-null: one blind `askStructured` lane with
   the identical panel prompt → append `type:"tiebreak"` → md.

stderr:

```text
[panel] consensus: split
[panel] tiebreak suggest: gemini — lowest measured agreement (0.42) with the panel
[panel] tiebreak run: gemini (blind)…            # only with --tiebreak
[panel] expanded consensus: majority (initial: split)
[panel] tiebreak suggest: (none) — no unconsulted providers available
```

## Ledger records

Append order: `panel` → `tiebreak_suggest` (split only) → `tiebreak` (only if
run). Original `panel.consensus` is frozen; the expanded label lives ONLY on
the tiebreak record and the `expandedLabel` return field.

```js
{
  type: "tiebreak_suggest",
  run_id: "<own id>",
  panel_run_id: "<panel id>",
  created_at: ISO,
  provider: "gemini" | null,
  measured_agreement: number | null,
  reason: string,
  selection_basis: "lowest-measured-agreement" | "strongest-tier-no-data",
  ready: ["..."], ready_source: "detect" | "override",
  on_panel: ["..."],
  requested: boolean,               // was --tiebreak passed
  status: "suggested" | "unavailable",
}

{
  type: "tiebreak",
  run_id: "<own id>",
  panel_run_id: "<panel id>",
  suggest_run_id: "<tiebreak_suggest id>",
  created_at: ISO,
  selection: { spec, basis, ready_source, measured_agreement },
  blind_prompt: true,
  panelist: { spec, provider, exit_code, verdict, confidence, key_claims, adherence, artifact },
  pairwise: [ /* tiebreaker vs each ORIGINAL panelist; agree:null on abstention */ ],
  consensus_before: "split",
  consensus_after: "majority" | "split" | "single-source" | "no-verdicts",
}
```

`ledgerStats` accumulates pairwise from `panel` AND `tiebreak` records;
`runs` counts only `panel`; a separate `tiebreaks` count is reported.

## API

```js
runPanel({ specs, question, root, tiebreak = false, readyProviders = null })
// → { exitCode, id, label, expandedLabel, mdPath, panelists, pairwise,
//     tiebreakSuggestion, tiebreakResult }

runCouncil({ specs, question, root, tiebreak = false, readyProviders = null })
```

## Council: what the tiebreaker's claims do in phase 2

**RESOLVED IN R3 — codex conceded to grok's amended mechanism.** The
tiebreaker participates as a claim **author only**, never as a debater:

1. Cap original authors' claims first using the existing round-robin
   (`capClaims`); tiebreak claims fill only **unused** `MAX_CLAIMS` capacity —
   they can never displace an original member's claim.
2. `claimsFromPanel` receives the expanded panelists (original + tiebreak
   panelist) so tiebreak key_claims get ids and `authorSpec` attribution.
3. `runDebateOnClaims` receives `parsed` = ORIGINAL council members only.
   The tiebreaker is never in `parsed`.

Why this is cheap and sound (verified against xllm-debate.js on master):
R1 refute is one lane per `parsed` member batch-attacking foreign claims —
tiebreak claims are foreign to everyone, so they are attacked inside the
EXISTING lanes (zero additional R1 calls). R2 defend already routes by
`claim.authorSpec`, so the tiebreaker defends its challenged claims without
being a debater (marginal cost: one defend call per challenged tiebreak
claim, bounded by ≤5 key_claims and the cap). `classifyDebateClaim`'s
N = `parsed.length` stays the original member count — classification
mechanics unchanged.

Rationale (mission thesis): the FINDINGS dividend came from a decorrelated
model *seeing different defects*. Excluding the tiebreaker's claims from
phase 2 would buy the call and throw away the payload; author-only bridging
sends exactly that payload through hostile refutation at near-zero marginal
cost. Codex's fixed-membership/cost objections applied to the R1
full-debater mechanism and were withdrawn against this one.

## NOT building (scope discipline, both designers)

- Default auto-run; multi-round tiebreak cascades; tiebreak on
  majority/unanimous/single-source/no-verdicts.
- Lineage/persona/trait scoring of any kind ("lineage astrology").
- A judge LLM; auto-adoption of any verdict.
- `~/.xllm` inventory cache for readiness.
- Mutating or rewriting existing ledger records.
- Task-conditioned correlation models (future work, measured-only).

## Risks (named, accepted)

- Sparse history overvalues a single low-agreement observation — always
  expose `comparable_runs`; no arbitrary confidence threshold yet.
- The global matrix is not proof of decorrelation on the current question
  (agreement is task-distribution dependent).
- Verdict-level agreement can hide claim-level disagreement.
- `detectAvailableProviders` can report installed-but-unhealthy providers;
  `--ready=` is the operational escape hatch.
- One advisor lane can bill up to two attempts (existing structured-output
  corrective retry) — documented, unchanged.
