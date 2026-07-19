# Benchmark findings (committed summaries; raw runs are gitignored)

Raw per-run JSON lands in `benchmarks/results/` (gitignored). Notable
findings are transcribed here so the evidence survives.

## 2026-07-11 — first valid diversity-dividend measurement

**Setup:** `xllm-bench run --providers codex,grok` over 4 seeded
code-review tasks (11 known defects: SQLi, XSS, plaintext-pw, TOCTOU,
silent-noop, parse-crash, hardcoded-secret, no-fail-return, no-backoff,
no-expiry, concurrent-fetch). Deterministic regex grading.

**Result:**

| Provider | Detected | Missed |
|----------|----------|--------|
| codex (single) | 10/11 | no-fail-return |
| grok (single) | 10/11 | no-fail-return |
| panel (union) | 10/11 | no-fail-return |

- Pairwise error correlation: **agreement_rate 1.0**, shared_blind_spots 1.
- Diversity dividend: **incremental_defects 0** (`valid_comparison: true`).

**Reading:** Two different vendors (OpenAI codex, xAI grok) had *perfectly
correlated* errors on well-known defect classes — same 10 caught, identical
one missed. Ensemble theory predicts exactly this: no dividend when errors
are correlated. Cross-vendor diversity here was theater. The dividend lives
where models genuinely diverge (harder/ambiguous defects, design judgment,
or a strong model paired with a *measured*-decorrelated one). Conclusion:
spend diversity where `panel stats` shows LOW agreement, not by default.

## 2026-07-11 — hard problems: decorrelation appears, and a real dividend

**Setup:** 5 models calibrated on the harder task set (`hard-tasks.json`,
21 subtle defects): `claude:opus` (Opus 4.8), `codex:gpt-5.5`,
`grok:grok-4.5` (grok-4.3 was unavailable; substituted), `ollama:glm-5.2:cloud`,
`ollama:gemma4:cloud`. Panel = claude / grok / gemma4 (user-specified).

**Calibration — per-task detection rate:**

| task | claude:opus | gpt-5.5 | grok-4.5 | glm-5.2 | gemma4 |
|------|-----|-----|-----|-----|-----|
| h1-median | 100% | 100% | 100% | 67% | 67% |
| h2-retry-jitter | 100% | **25%** | 100% | 75% | 100% |
| h3-cache-lru | 100% | 67% | 67% | 67% | **33%** |
| h4-date-range | 67% | 67% | 100% | 67% | **33%** |
| h5-parse-int | 100% | 100% | 100% | 100% | 75% |
| h6-event-emitter | 75% | 50% | 75% | 50% | **25%** |

- **The strict "all 5 models ≤70%" filter matched 0 problems** — frontier
  models (Opus 4.8, grok-4.5) are simply too strong for even these subtle
  bugs, hitting ~100% on most. So the user's difficulty gate found nothing;
  the set is hard for weaker models, not for the strongest.
- But **errors decorrelate**: gpt-5.5 got 25% on h2 (caught 1/4 seeded
  defects — verified real, not a grader artifact: it found *other* valid
  issues but missed no-jitter / unbounded-delay / non-retriable), while
  claude/grok caught all 4. gemma4 diverges hard on h3/h4/h6.

**Panel (claude / grok / gemma4) on the hard set — the dividend appears:**

| | detected |
|--|--|
| claude:opus alone | 19 / 21 |
| grok:grok-4.5 alone | 19 / 21 |
| gemma4:cloud alone | 12 / 21 |
| **best single** | **19 / 21** |
| **panel union** | **20 / 21** |
| **incremental dividend** | **+1** |

- claude and grok each miss 2 defects — but **different** ones: claude misses
  one in h4 (grok catches it), grok misses one in h3 (claude catches it). The
  panel recovers a defect the best single model missed → **+1 dividend**,
  driven purely by decorrelated errors.
- 1 defect (in h6, the subtle once-emitter double-invoke/leak class) is a
  **shared blind spot** — both strong models miss it, so the panel can't fix
  it. That is exactly the case where you'd escalate to a 4th, more
  decorrelated model.

**Pairwise error correlation (panel, all hard tasks):**

| pair | agreement | shared blind spots |
|------|-----------|--------------------|
| claude ↔ grok | 0.905 | 1 |
| claude ↔ gemma4 | 0.667 | 2 |
| grok ↔ gemma4 | 0.667 | 2 |
| **mean** | **0.746** | — |

**Reading:** Mean pairwise agreement fell from **1.0 on the easy set to 0.746
on the hard set** — the decorrelation condition for a dividend actually
materialized, and a small (+1/21) dividend appeared with it. The two strong
models stay fairly correlated (0.905); the weaker/different model (gemma4)
decorrelates most (0.667). This is the mission hypothesis confirmed at the
margin: **diversity pays when errors decorrelate, and error correlation is a
function of problem difficulty** — near 1.0 on textbook bugs, well below 1.0
on subtle ones. The dividend is small here only because the panel contains two
near-ceiling models; it grows when no single member dominates.

**Prior confounded run (excluded):** codex vs ollama:qwen3.6 returned
"no dividend" but qwen OOM'd on load (CUDA) and never produced a review;
the bench was fixed to exclude crashed providers (`valid_comparison`
flag) rather than grade them as "found 0 defects".

## 2026-07-12 — hard-set rerun (codex vs grok): the evidence now routes

**Setup:** full hard set (6 tasks, 21 seeded defects), `codex` vs `grok`
(default efforts), modes single+panel, run in 6 task-chunks (Windows argv
limits + codex contention avoidance). Zero provider errors — every cell is a
real judgment. Purpose: repopulate `benchmarks/results/` so the v0.16.0
trait profiles have live evidence (the prior calibration's result files had
been cleaned).

**Single detection:**

| provider | detected | notable misses |
|----------|----------|----------------|
| codex | 15/21 (71%) | h1 window edge cases (×2), h4 tz-comparison, h6 double-fire + late-handler (×2) |
| grok | 20/21 (95%) | h3 no-eviction-on-equal only |
| panel (union) | 20/21 | h3 no-eviction-on-equal |

**Pairwise error correlation: 0.762 over 21 shared cells, 1 shared blind
spot** — consistent with the 2026-07-11 five-model finding (0.746): hard
problems decorrelate this pair too (easy set was 1.0).

**Dividend on THIS pair: 0 over best single** (union 20 = grok 20) — but
**+5 over codex**. When one panelist strictly dominates, the union adds
nothing over the dominant member; the shared blind spot survives the union
(no-eviction-on-equal — both miss, so diversity cannot buy it). The dividend
is not a property of "diversity" in the abstract; it is a property of WHO
your best single is — which is precisely a routing question.

**The loop, closed end-to-end (first live occurrence):** these results flow
into `xllm traits` (bench 21 cells each; grok Wilson-LCB 0.7733, codex
0.5004) and the very next routed pick consumed them:

```text
pick verify / pick security (high intensity, legacy baseline = codex):
  → grok@xhigh · measured bench: grok LCB 0.7733 vs codex 0.5004
    over 21 shared opportunities (6 tasks, via lcb-margin)
```

Measurement → ledger/results → traits → routing decision, with the sample
sizes cited in the reason string. What the benchmark measured is now what
the router does.

## 2026-07-13 — a 4th, decorrelated model recovers a strong-pair blind spot

**Setup:** full hard set (6 tasks, 21 defects), single mode, a 4-model panel
that keeps a strong anchor and adds three cloud models pulled for this run:
`grok` + `ollama:gemma4:cloud` + `ollama:glm-5.2:cloud` +
`ollama:nemotron-3-super:cloud`. Zero provider errors.

**Single detection:**

| model | surface | detected |
|-------|---------|----------|
| grok | cli-agentic | 18/21 |
| nemotron-3-super:cloud | http-completion | 16/21 |
| glm-5.2:cloud | http-completion | 15/21 |
| gemma4:cloud | http-completion | 13/21 |
| **panel union** | mixed | **19/21 (dividend +1 over best single)** |

**The 2막/2026-07-12 prediction, confirmed.** `h3 no-eviction-on-equal` — the
shared blind spot both codex and grok missed on 2026-07-12 — is now caught by
**gemma4:cloud AND nemotron-3-super:cloud**. nemotron scored h3 **3/3**, fully
recovering the LRU off-by-one the strong pair missed. This is exactly the
"escalate to a 4th, measured-decorrelated model" case the earlier finding
named — now with live evidence that the escalation works.

**But diversity is not a universal solvent.** Two defects survive the whole
4-model union: `h4 tz-comparison` and `h6 double-fire`. h6 double-fire has now
been missed by **every model measured across every run** (codex, grok, gemma4,
glm-5.2, nemotron) — a deep blind spot no panel here can buy.

**Pairwise agreement (21 shared cells each):** grok↔gemma4 **0.667** (most
decorrelated), grok↔nemotron 0.810, grok↔glm-5.2 0.857; the three cloud models
agree with each other 0.810–0.857. Two honest confounds: (1) this is a
**cross-surface** panel — grok is a vendor CLI (cli-agentic), the cloud models
are raw HTTP completion — so grok↔cloud decorrelation is model *and* surface;
(2) grok scored **18/21 here vs 20/21 on 2026-07-12** — same model, run-to-run
variance, a reminder that single-run cells carry measurement noise (this is why
traits gate on Wilson lower bounds and sample counts, not raw rates).

## 2026-07-13 — debate, measured for the first time: no quality dividend here

**Setup:** the new `--modes debate` grades the ACTUAL adversarial protocol, not
a detection union. For each hard task, `debate run codex,grok` produces claims
that end SURVIVED/KILLED/UNRESOLVED; each claim's text is mapped to the seeded
defects. A **grounded** claim maps to ≥1 seeded defect; a **surplus** claim maps
to none. The falsifiable question: does refutation preserve grounded claims at a
higher rate than surplus ones (quality discrimination)?

**Result (codex vs grok, both cli-agentic, 0 errors):**

| bucket | survived | rate |
|--------|----------|------|
| grounded (real-defect) claims | 20/23 | 0.87 |
| surplus claims | 22/25 | 0.88 |
| **quality discrimination** | | **−0.01** |

Debate killed **6 of 48 claims (12.5%)**, and those kills split **3 grounded /
3 surplus** — it removed real-defect claims as often as unmapped ones. On a
strong, aligned, same-surface pair over these tasks, the SURVIVED label did
**not** track seeded grounding.

**Reading.** This is the debate analogue of the easy-set panel result
(correlation 1.0 → "diversity was theater"): the deliberation dividend, like
the diversity dividend, is conditional, not free. Adversarial refutation
sharpens quality only when there are confident-but-wrong claims to kill — which
a strong aligned pair on these tasks rarely produced (near-zero kills). The
deliverable is not a positive result; it is that the **instrument now exists**
to detect when debate helps, closing the last "shipped on design + live e2e
only" gap. Honest caveat, enforced in code and the report: *surplus ≠ false* —
frontier models raise real UNSEEDED issues that land in the surplus bucket, so
`quality_discrimination` is a lower bound. With kills this rare, even the lower
bound shows no sharpening here.

**Surface tags (harness-vs-model confound).** Every result now records each
provider's measurement surface: `cli-agentic` (vendor CLI that may run its own
tools/reasoning — codex, claude, grok, gemini, …) vs `http-completion` (raw
model — ollama, lmstudio). This makes explicit that the bench unit is the
advisor surface xllm calls, not the bare model: a strong CLI score can be model
quality OR harness amplification. For the record, xllm never invokes grok in a
team/agent mode — the call is a one-shot `grok -m … --reasoning-effort … -p`
print, read-only, identical to every cloud CLI; but grok's `-p` is still a
vendor CLI, hence `cli-agentic`.

## 2026-07-13 — the cleanest dividend yet: a balanced, same-surface panel

**Motivation.** Every panel measured so far carried a near-ceiling model
(grok 18–20, claude 19), so its high best-single ate the dividend (the
2026-07-12 grok-anchored panel: +1 over best single). Ensemble theory predicts
the dividend GROWS when no member dominates. Test it directly: a panel of three
mid-tier models that are (a) roughly comparable — no dominator, (b) different
labs — decorrelated, and (c) **all `http-completion`** — so the cross-surface
confound of the grok-anchored run is eliminated. `ollama:gemma4:cloud` +
`ollama:glm-5.2:cloud` + `ollama:nemotron-3-super:cloud`, hard set, single mode,
**run 3× to separate signal from run-to-run variance.**

**Result — dividend +2 on every run:**

| run | gemma4 | glm-5.2 | nemotron | best single | union | dividend |
|-----|--------|---------|----------|-------------|-------|----------|
| 1 | 16 | 17 | 14 | 17 | 19/21 | **+2** |
| 2 | 14 | 16 | 17 | 17 | 19/21 | **+2** |
| 3 | 16 | 18 | 15 | 18 | 20/21 | **+2** |

- **Dividend = [+2, +2, +2], mean 2.0, zero spread** — double the +1 of every
  dominated panel, and rock-steady across runs. The hypothesis is confirmed:
  remove the dominator and the dividend grows.
- **No model dominates — the rank rotates.** glm-5.2 was best in runs 1 & 3,
  nemotron in run 2; each model was the weakest in some run (nemotron 14, gemma4
  14, nemotron 15). Individual scores swing ±3 run-to-run, yet **the ensemble
  dividend does not move.** The panel is more stable than any of its members —
  a selling point, not a footnote.
- **Mean pairwise agreement 0.735** — the same decorrelation regime as the hard
  set (0.746), now with no surface confound to explain it away.
- **Zero permanent blind spots.** Across the 3 runs the union covered ALL 21
  defects (17 in every run; 4 flaky — including h6 `double-fire`, the defect the
  grok-anchored run had called "missed by every model", which a balanced
  panelist actually caught in 2/3 runs). Contrast the grok-anchored 4-model run,
  which left 2 defects (h4 tz, h6 double-fire) permanently uncovered.

**Reading — this is the mission hypothesis, cleanly confirmed.** A same-surface,
no-dominator, decorrelated panel produced the largest and most stable dividend
in the benchmark's history (+2/21, σ=0), reaching a per-run union of 19–20/21 —
on par with a single frontier model (grok 20, claude 19) — from three mid-tier
**free local** models. The practical claim the whole project rests on finally
has its clean demonstration: *diversity pays when errors decorrelate and no
single member dominates, and three cheap decorrelated models can stand in for
one frontier model — measured, not assumed.* Honest bounds: +2/21 is still
modest (~10%); these are single-set, deterministic-regex results; and the win is
cost-shape (3× free local calls vs one paid frontier call), not raw ceiling.

## 2026-07-14 — lineage does NOT predict decorrelation (nemotron family + gpt-oss)

**Setup.** Three new cloud models added: `nemotron-3-ultra:cloud`,
`nemotron-3-nano:30b-cloud`, `gpt-oss:120b-cloud`. (Note: `nemotron-3-ultra:cloud`
fails `ollama pull` on its cloud manifest but is reachable — one `ollama run`
resolves it, then xllm's HTTP `/api/generate` path works.) Panel of the three
nemotron sizes (ultra/super/nano — **same lab, NVIDIA**) + gpt-oss (**different
lab**), hard set, single mode, run 3×. This isolates the project's founding
question: does shared **lineage** predict correlated errors, or must you measure?

**Detection (per-model mean over 3 runs):**

| model | runs | mean |
|-------|------|------|
| nemotron-3-ultra:cloud | 17 · 18 · 16 | 17.0 |
| nemotron-3-super:cloud | 13 · 16 · 16 | 15.0 |
| gpt-oss:120b-cloud | 14 · 14 · 17 | 15.0 |
| nemotron-3-nano:30b-cloud | 12 · 10 · 14 | 12.0 |

ultra is the strongest of the group (~17/21), the 30b nano the weakest (~12) —
none at ceiling, so the no-dominator regime holds.

**Dividend = [+2, +2, +3], mean 2.33 — the largest yet.** Mean pairwise
agreement fell to **0.691** (below the 3-cloud panel's 0.735), and the dividend
rose with it (2.33 vs 2.0): more decorrelation, more recovery, exactly as the
mechanism predicts. Per-run union 19–20/21; **zero permanent blind spots** (only
h6 double-fire / late-handler stayed flaky at 1/3 each).

**The headline: lineage is not informative — you must measure.** Mean pairwise
agreement by pair:

| pair | lab relation | mean agreement |
|------|--------------|----------------|
| ultra ↔ super | **same** (NVIDIA) | 0.778 |
| super ↔ gpt-oss | cross | 0.746 |
| nano ↔ gpt-oss | cross | 0.698 |
| ultra ↔ nano | **same** | 0.667 |
| ultra ↔ gpt-oss | cross | 0.651 |
| **super ↔ nano** | **same** (NVIDIA) | **0.603** |

The same-lab nemotron pairs span **0.603–0.778** — the ENTIRE range — and fully
overlap the cross-lab pairs (0.651–0.746). The **most decorrelated pair in the
whole panel is same-lab** (super↔nano, 0.603), while a **cross-lab pair is among
the most correlated** (super↔gpt-oss, 0.746). Same-lab mean (0.683) is if
anything *lower* than cross-lab mean (0.698). **Shared lineage carries no
reliable signal about whether two models' errors decorrelate.**

This is the empirical vindication of a core xllm design decision: the panel
tiebreaker picks the unconsulted provider with the LOWEST *measured* agreement,
"never by vendor pedigree/lineage." Had we routed diversity by lineage — "these
are both nemotron, so redundant; add a different vendor" — we would have thrown
away the panel's most decorrelated pair (the two nemotrons) and kept a more
correlated cross-vendor one. The measurement inverts the pedigree intuition.
Cross-**vendor** was the original diversity heuristic (v0.1); the benchmark has
now retired it in favor of cross-**decorrelation**, measured per pair.

## 2026-07-14 — the maximally cross-vendor panel had the LOWEST dividend

**Setup.** The opposite end from the mid-tier cloud panels: three frontier vendor
CLIs, one per lab, all pinned to the **lowest** reasoning effort —
`claude:sonnet@low` (Anthropic, Sonnet 5), `codex:gpt-5.6-luna@low` (OpenAI),
`grok:grok-composer-2.5-fast@low` (xAI). All `cli-agentic`, so same-surface;
maximally cross-**vendor**. Hard set, single mode, 3×. (claude ran with
`XLLM_ALLOW_SELF=1` — same-vendor nesting is refused by default inside Claude
Code, but here we are measuring the model, not using it as a cross-vendor
advisor. Zero provider errors on every run.)

**Detection (per-model mean over 3 runs):**

| model | runs | mean |
|-------|------|------|
| claude:sonnet@low | 20 · 20 · 18 | 19.3 |
| grok:composer-2.5-fast@low | 19 · 19 · 19 | 19.0 |
| codex:gpt-5.6-luna@low | 15 · 16 · 15 | 15.3 |

Even at LOW effort, Sonnet 5 and grok-composer sit near the hard-set ceiling
(19–20/21); grok-composer was eerily stable at exactly 19 all three runs.

**Dividend = [0, 0, +1], mean 0.33 — the lowest of any hard-set panel.** The
maximally cross-vendor panel produced the *least* recovery. Two mechanisms, both
already documented, stack here:

- **Near-ceiling dominator.** claude 20 and grok 19 leave almost no room: union
  20 barely clears best-single 20. (The act-three lesson: when one member
  dominates, the union adds nothing over it.)
- **High correlation.** Mean pairwise agreement **0.841** — far above the
  mid-tier cloud panels (0.69–0.74). Frontier models AGREE, even throttled to low
  effort and across three different labs.

**The capstone on lineage/pedigree (act seven, sharpened).** The single most
correlated pair in the *entire* benchmark is **claude ↔ grok at 0.920 mean**
(0.952 in two runs) — two models from *different vendors* (Anthropic vs xAI). The
single most *decorrelated* pair ever measured is **super ↔ nano at 0.603** — two
models from the *same lab* (both NVIDIA nemotron). So the cross-vendor pair is
~0.32 more correlated than the same-lab pair. Pedigree diversity does not merely
fail to predict decorrelation — here it is *anti*-correlated with it. The
dividend lives in the mid-tier decorrelated regime, not the frontier
cross-vendor one, and only measurement can tell you which panel you have.

**Honest bounds.** Low effort was requested and pinned; at higher effort the
frontier trio might diverge (or converge) differently — this is a low-effort
snapshot. codex:gpt-5.6-luna@low was the weakest (15.3) but not decorrelated
enough to lift the union off claude's ceiling. Single set, deterministic-regex.

## 2026-07-18 — light TRULY-local trio: the largest dividend measured yet

**Motivation (user hypothesis).** Every prior dividend came from *cloud* models
— even the "free local" panels ran on ollama-cloud endpoints. The SOTA-heavy
panels showed the least recovery (act eight: frontier trio, dividend 0.33).
Hypothesis: push further down the capability axis to genuinely light models
running **in local VRAM**, and the dividend should grow further. Trio:
`ollama:ornith:latest` (5.6GB, ~9B), `ollama:gemma4:latest` (9.6GB),
`ollama:qwen3-coder:30b` (18GB) — all weight-local, all `http-completion`
(same-surface, no CLI-harness confound), hard set, single mode, run 3×.
Zero provider errors across all 54 calls; a full 18-call run takes ~10 min
on one consumer GPU and costs nothing.

**Detection (per-model over 3 runs):**

| model | runs | mean |
|-------|------|------|
| ornith:latest (5.6GB) | 15 · 15 · 14 | 14.7 |
| qwen3-coder:30b (18GB) | 13 · 15 · 11 | 13.0 |
| gemma4:latest (9.6GB) | 8 · 9 · 7 | 8.0 |

**Dividend = [+4, +4, +2], mean 3.33 (σ=0.94) — the largest mean dividend in
the benchmark's history** (previous best: the lineage panel's 2.33). Per-run
union 19 · 19 · 16; across the 3 runs the union covered **all 21 seeded
defects**, with **zero permanent shared blind spots**.

**The decorrelation-dividend curve, now four points, strictly monotonic:**

| panel | mean pairwise agreement | mean dividend |
|-------|------------------------|---------------|
| frontier trio @low (act 8) | 0.841 | +0.33 |
| balanced cloud trio (act 6) | 0.735 | +2.0 |
| nemotron family + gpt-oss (act 7) | 0.691 | +2.33 |
| **light local trio (this act)** | **0.609** | **+3.33** |

Pairwise means here: ornith↔gemma4 **0.524** (the most decorrelated pair ever
measured, beating super↔nano's 0.603), ornith↔qwen3-coder 0.635,
gemma4↔qwen3-coder 0.667. Less capability overlap → less error correlation →
more union recovery, exactly as ensemble theory predicts.

**The deepest blind spot fell to a 5.6GB model.** `h6 double-fire` — missed by
codex, grok, gemma4:cloud, glm-5.2 and nemotron across earlier acts — was
caught by **ornith:latest in 2 of 3 runs** (and by qwen3-coder:30b once).
Whatever ornith's lineage, its error profile is simply *different* — and the
union harvests that difference.

**A nuance that refines act six.** ornith was best-single in every run (no rank
rotation — a stable "dominator" by rank), yet the dividend still hit +4. The
no-dominator condition is really a *low-ceiling* condition: what matters is not
whether some member ranks first every time, but whether the best member leaves
enough headroom (ornith's 15/21 leaves 6) AND the others decorrelate hard
enough to fill it. Rank stability with a low ceiling still pays.

**Reading — the user's hypothesis is confirmed, and it completes the arc.**
On this hard set, dividend is a monotonically *decreasing* function of panel
capability: the more SOTA the panel, the less diversity buys; three light
models that fit on one consumer GPU produced union 19/21 — within one defect
of a frontier single (claude 19.3, grok 20) — **for zero incremental cost and
~10 minutes wall-clock**. Honest bounds: run 3 dipped to +2 (union 16; h6
went uncaught by everyone that run) so σ is no longer zero — light models are
individually noisier; gemma4:latest is weak alone (8/21) and earns its seat
purely through decorrelation; single set, deterministic-regex grading; ornith
is an untracked community model — treat its identity as "measured error
profile", not pedigree.

## 2026-07-18 — council, measured for the first time: aggressive kills, zero discrimination

**Setup.** The last unmeasured deliberation mode. `--modes council` runs the
full two-phase protocol (blind panel → adversarial debate over the panel's
claims) per hard task and grades the SURVIVING claims, same instrument as the
act-five debate measurement. Same light local trio as the previous act
(ornith 5.6GB · gemma4 9.6GB · qwen3-coder 30b), run as 6 per-task chunks,
~83 min total on one GPU, **zero task errors**. This yields two firsts at
once: council's first measurement, and deliberation's first measurement at the
light-local end (act five measured debate on a frontier pair).

**Result (48 claims over 6 tasks, per-task cap 8):**

| bucket | survived | rate |
|--------|----------|------|
| grounded (real-defect) claims | 9/18 | 0.500 |
| surplus claims | 15/30 | 0.500 |
| **quality discrimination** | | **0.000** |

Per-task discrimination swung wildly (−0.33 · +0.07 · +0.33 · −0.27 · −0.17 ·
+0.67) and netted to exactly zero. Tallies: 24 SURVIVED · 23 KILLED · 1
UNRESOLVED.

**The contrast with act five is the finding.** The frontier pair barely killed
(6/48, 12.5%) and preserved grounded claims at 0.87; the light trio killed
**aggressively** (23/48, 48%) — and killed *blind*: grounded and surplus
claims died at identical rates. Two opposite failure modes, one conclusion:

| regime | kill rate | grounded survival | discrimination |
|--------|-----------|-------------------|----------------|
| frontier debate (act 5) | 12.5% | 0.87 | −0.01 |
| light-local council (this act) | 48% | 0.50 | 0.00 |

Strong aligned models produce few confident-wrong claims to kill (deliberation
has nothing to do); light decorrelated models refute everything indiscriminately
(deliberation does a lot, none of it quality-tracking). On this instrument the
"plausible-but-wrong claims die, correct ones survive" story now has measured
support in NEITHER regime.

**Addendum (2026-07-19) — the mid-tier cloud council lands at the frontier
end, closing the triangle.** Same protocol, same chunking, on the act-six trio
(gemma4:cloud · glm-5.2:cloud · nemotron-3-super:cloud), ~15 min, zero errors:
grounded 22/25 = 0.88, surplus 21/23 = 0.913, discrimination **−0.033**, kill
rate 5/48 = **10.4%**, survived-coverage 11/21 (blind union for this same trio:
19–20/21). The open question — does mid-tier land between the extremes? — is
answered: **no.** Kill behavior tracks capability, not decorrelation: capable
models (frontier CLIs *and* mid-tier cloud) barely refute each other; only the
light-local panel killed aggressively, and it killed blind. All three measured
regimes now sit at discrimination ≈ 0:

| regime | kill rate | grounded survival | discrimination | survived-coverage vs blind union |
|--------|-----------|-------------------|----------------|----------------------------------|
| frontier debate (act 5) | 12.5% | 0.87 | −0.01 | (not measured) |
| mid-tier cloud council | 10.4% | 0.88 | −0.03 | 11/21 vs 19–20/21 |
| light-local council (act 10) | 48% | 0.50 | 0.00 | 8/21 vs 19/21 |

**Deliberation costs recall — use the blind panel for detection.** Council's
surviving claims covered only **8/21** seeded defects, versus **19/21 per run**
for the *same trio* in blind single mode. Half the real detections entered the
debate and died there (grounded survival 0.50), and the 8-claim cap compresses
coverage further. For light local models the practical routing is now
measured, not aesthetic: `review blind` (union, dividend +3.33) for finding
defects; council's adversarial phase subtracts recall without adding measured
precision. h6 was the exception that keeps the mechanism honest: both grounded
h6 claims (double-fire, no-cleanup) survived with +0.67 discrimination — when
light models DO hold a real claim under attack, it can work; it just does not
work on average.

**Honest bounds.** Single run per task (council is ~8× a single call — n=1 per
cell); surplus ≠ false (unseeded real defects land in surplus, so
discrimination is a lower bound); the 8-claim round-robin cap means coverage
loss is partly protocol shape, not only kill behavior; claims are the panel's
distilled verdicts, not full defect lists, so grounded-claim counts (18/48)
undercount what the models actually detected. And this is one trio — a
mid-tier cloud council might land anywhere between the two measured extremes.
