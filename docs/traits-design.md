# xllm traits — evidence-based provider profiles → routing (2026-07-12)

> Designed via xllm's own adversarial method: codex@high and grok@high each
> proposed a design (Round 1), rebutted each other (Round 2), and resolved
> residual splits in a fact-anchored Round 3. This document is the synthesized
> result; raw rounds are in
> `.grok/artifacts/ask/*evidence-based-provider-trait-pro*` and `*round-*`.

## Purpose

v0.15.0 closed the measurement→routing loop for tiebreakers. This change
extends measured routing to the general pick: cost-aware routing should pick
the RIGHT provider, not just the cheapest healthy one — using accumulated
evidence, never hand-authored lore. The 3-way-unanimous rejection stands:
NO persona lore, NO "lineage astrology". Every trait derives from recorded
measurements and exposes its sample size; below its gate, it is silent.

## Evidence streams consumed

| Stream | Location | Contributes |
|--------|----------|-------------|
| Panel ledger | `<state>/panel-ledger.jsonl` | structured-output adherence (first/retry/failed) per spec; debate claim outcomes per author; outcomes (display-only) |
| Bench results | `benchmarks/results/*.json` | seeded-defect detection cells per spec; duration (display-only) |
| Contracts cache | `~/.xllm/contracts.json` | current per-provider health (failure taxonomy) |
| Static profiles | TOML/BUILTIN | tier / relative_cost / latency_class — cost CONFIG, unchanged (config ≠ behavior lore) |

## Convergence (settled across R1–R2, both designers)

- **New pure module `scripts/xllm-traits.js`** — deterministic derivation
  over evidence inputs; unit-testable with in-memory fixtures, no disk.
- **On-demand derivation only.** No materialized `traits.json`, no refresh
  command, no daemon. Same class as `ledgerStats`: the ledger is truth,
  derived views are cheap.
- **Aggregation key = canonical spec** (effort stripped:
  `codex:gpt-5.5@high → codex:gpt-5.5`). Models within a provider never
  silently share behavioral reputation.
- **Cold start = bit-identical current routing.** Library callers that pass
  no traits/root get exactly today's behavior — the existing test suite stays
  green by construction. Every trait exposes `n`; below its gate it is
  silent, not zero.
- **Never routable** (display/inspect-only, unanimous): human outcome
  records (sparse, post-selection bias), latency (workload-confounded),
  decisive-refutation efficacy (the ledger persists attacks but not WHICH
  attack the classifier selected as decisive — attribution is non-causal
  until the record carries it).
- **v0.15.0 tiebreak selection is preserved**: lowest measured agreement wins
  at any `comparable_runs ≥ 1`. The R2 proposal to gate at ≥3 was withdrawn
  as a regression of the shipped, demonstrated loop closure.
- **Role pins bypass traits entirely** — user intent beats measurement.
- **Unchanged consumers**: `passesCapabilityFloor` (static capacity guard),
  `getProviderCostMeta` (cost config), `pickScribeProvider` (chores stay
  cheapest-healthy; quality traits would mis-spend).
- **Sliding window + per-stream K caps, no decay weights** — bounded,
  explainable, deterministic.
- **CLI**: `xllm traits [--json]` with mandatory per-trait `n`, window and
  provenance; `--no-traits` on pick commands; TOML `[routing]` toggle.
  Routing `reason` strings cite trait, value, and `n` whenever used.
- **Local trust boundary** (no crypto): consistent with ledger-driven
  tiebreaks; malformed evidence is skipped with visible warnings; traits
  never write back into any evidence stream.

## Resolved in Round 3 (fact-anchored final round)

- **General judgment routing consumes ONE trait: `bench_defect_detection`**
  (grok conceded its adherence+survival blend). Adherence measures the
  panel/debate JSON contracts — output free-form role picks never produce;
  the only ROUTED pick whose product is structured output is the tiebreaker,
  and that is where adherence acts. `claim_survival` is inspect-only.
  Eligible roles: `critic | verify | tests | security` — NOT `architecture`
  (the shipped benchmark is defect-listing code review, not architecture
  evaluation; codex's unrebutted R2 point).
- **Health (kind-aware, both amended to the same rule):** an EXPLICIT user
  `--ready=` ignores the contracts cache entirely (user authority). With a
  DETECTED ready set: only FRESH (≤24h) non-retryable `auth`/`contract-drift`
  failures veto (the kinds binary-presence detection cannot see); fresh
  retryable failures demote; a `missing-binary` verdict contradicted by
  current detection is stale and ignored; stale/missing cache ignored.
  All-vetoed → keep legacy first + `health_override:"all-candidates-blocked"`.
  Role pins bypass health too.
- **suggestTiebreaker final order** (grok adopted codex's; quality never
  enters): 1) health veto; 2) adherence veto at `n≥10 && failed/n≥0.25`;
  3) lowest non-null measured agreement at `comparable_runs ≥ 1`;
  4) ties → ready order; 5) no measurements → tier fallback; 6) never a
  bench/near-tie quality override (it can pick the MORE correlated
  candidate); 7) all vetoed → `provider:null` (the `unavailable` path
  v0.15.0 already handles).
- **No provider rollup, ever** (grok conceded): a routed pick SPAWNS its
  resolved model (`route.model || default_model`) — sibling-model evidence
  describes an executable that will not run for this pick. Missing exact-key
  evidence = unmeasured, silent.
- **Statistics machinery = Wilson 95% lower bound** (grok adopted): raw
  rates make 6/6 a perfect 1.0 at the first sparse crossing; LCB ≈ 0.61
  exposes the uncertainty. Horizon 180 days; per-stream K caps (50/50/30/30);
  bench deduplicated to the newest observation per `{canonical_spec,
  task_id}` (whole-file summation lets reruns manufacture n); records
  without `created_at` are excluded from routing (every real record has one).

## Round-3 residual — trait POWER (user-adjudicated: codex)

The one issue code facts could not decide: does measurement get to move
SPEND? grok held that traits must never override tier/relative_cost
(reorder within band only); codex held that measured quality may cross
tier/cost boundaries under conservative gates. The user adjudicated for
**codex's cross-tier override** — the mission thesis cuts both ways: a
measured ≥0.10 Wilson-LCB advantage is the explicit justification for
paying more, and measured parity is the justification for paying less.
grok's within-band alternative was judged nearly decorative (low intensity
sorts exact relative_cost first, so quality would fire only on exact cost
ties).

## Final parameter block (implementation contract)

```text
ROUTABLE
  general judgment routing (roles: critic|verify|tests|security):
      bench_defect_detection only (Wilson 95% LCB)
  suggestTiebreaker: measured agreement primary; structured_output veto only
  inspect-only: structured_output elsewhere, claim_survival,
      decisive_refutation (provider-level), outcomes, latency
  never trait-routed: architecture + all other roles, role pins, scribe

GENERAL MEASURED ROUTING (preconditions, ALL required)
  capability floor passes for candidate
  ≥2 ready, measured, floor-passing candidates; baseline itself measured
  ≥4 exact shared task_id values
  ≥12 exact shared {task_id, defect_id} opportunities
  newest observation per {canonical_spec, task_id}; ≤180d; timestamped
  comparator over the exact shared opportunity set:
      candidate.LCB95 ≥ baseline.LCB95 + 0.10          → may cross tier/cost
      OR candidate.relative_cost < baseline.relative_cost
         AND candidate.LCB95 ≥ baseline.LCB95 − 0.03   → cheaper at parity
  within 0.03 of best LCB → lowest relative_cost, then legacy order
  measured never overrides an unmeasured baseline

WINDOWS
  horizon_days 180; caps: structured_output 50/spec, claims 50/spec,
  outcomes 30/spec, latency 30/spec; bench: newest per {spec, task_id},
  no file-count cap; contracts fresh ≤24h; timestamp-less excluded

HEALTH (kind-aware)
  ready_source=explicit → ignore contracts
  ready_source=detected/absent →
      fresh non-retryable auth|contract-drift → veto
      fresh retryable → demote
      missing-binary contradicted by current detection → ignore
      stale/missing → ignore
  all vetoed → legacy first + health_override="all-candidates-blocked"

TIEBREAKER ORDER
  1 health rule  2 structured_output veto (n≥10 && failed/n≥0.25)
  3 lowest non-null agreement (comparable_runs ≥ 1)  4 ties → ready order
  5 none measured → tier fallback  6 no quality/near-tie overrides
  7 all vetoed → provider:null ("unavailable" path)
  8 reasons cite comparable_runs and any veto trait's n

ROLLUP: forbidden. resolved exact canonical model spec, else exact
  bare-provider key, else unmeasured.
```

## NOT building (both designers)

## NOT building (both designers)

- Hand-authored behavioral lore, personas, lineage/family priors.
- Materialized trait caches, refresh jobs, daemons, ML/Elo/latent skill.
- Outcome- or latency-driven routing.
- Cross-project trait federation; cryptographic evidence integrity.
- Auto-benchmarking during routing.
- Changes to role-pin precedence, capability floor, scribe, or cost config.
