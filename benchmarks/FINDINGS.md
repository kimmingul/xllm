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

**Prior confounded run (excluded):** codex vs ollama:qwen3.6 returned
"no dividend" but qwen OOM'd on load (CUDA) and never produced a review;
the bench was fixed to exclude crashed providers (`valid_comparison`
flag) rather than grade them as "found 0 defects".
