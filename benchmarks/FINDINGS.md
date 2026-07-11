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
