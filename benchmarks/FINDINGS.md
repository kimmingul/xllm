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
