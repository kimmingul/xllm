# Design — superpowers absorption & surface consolidation

> Status: **converged, not yet implemented.** Adversarial review per project convention
> (codex@high × grok@high, 3 rounds, final round anchored to verified code facts).
> Raw artifacts live under `.xllm/artifacts/` (gitignored); this doc transcribes the evidence.
> Date: 2026-07-13 · Base: v0.21.1

## Problem

The user is removing two global layers from all three hosts — oh-my-claudecode (agent-OS)
and superpowers (14 process-discipline skills) — because hosts natively absorbed most of
their function (plan mode, agent teams/workflows, task tracking, worktrees, code review,
verification, skill creators), leaving duplication, instruction conflicts, and context bloat.
Question 1: what, if anything, of superpowers should xllm absorb, under SCOPE's
"only what hosts structurally cannot" rule? Question 2: what in xllm's current command
surface should consolidate?

## Method

- **R1 (blind, independent):** identical brief to codex@high and grok@high via `multi`.
- **R2 (cross-rebuttal):** each received the other's R1 verbatim plus newly verified facts;
  instructed to hold/amend/concede per split.
- **R3 (fact-anchored final vote):** both voted on the residual splits, anchored to code
  facts F1–F5 below. grok independently re-verified the facts against the public tree.

Verified fact anchors:

- **F1** — panel is NOT a first-class skill today; it is documented only inside
  `skills/multi/SKILL.md` ("Panel mode"). The discoverability gap is real.
- **F2** — `panel-ledger.jsonl` is written only by `xllm-panel.js` (whose `appendLedger`
  is imported by debate/council). The advisor `--multi` path never writes it: the
  measured/non-measured firewall already exists at the script layer.
- **F3** — the only git-diff collectors are scribe's deterministic, never-persisted ones;
  a review-over-diff needs a new collector under either architecture (equal cost).
- **F4** — `xllm.mjs` is a thin case-statement dispatcher; either architecture is a ~30-line
  change there. The real difference is public naming + skill count + doc surface.
- **F5** — pre-1.0, git-installed: alias windows are cheap; skill descriptions (not names)
  drive natural-language triggering.
- Residue confirmed during review: `examples/minimal-xllm.md:24` still shows `/ralph`;
  README still documents `pick-team` as "auto plan for /team roles" (`/team` removed v0.20.0);
  `xllm-routing.js` header comments still reference `/team`, `/ralph`.

## Round history (compressed)

| Round | codex | grok |
|-------|-------|------|
| R1 | selective; 4 designs under one `review` umbrella; merge multi+panel+debate+council → `review roles\|blind\|debate\|council`; `provider`/`route` namespaces; delete pick-team | selective; 4 thin skills (review/challenge-plan/referee/rebut); **refuses** deliberation merge ("different epistemology; merging recreates ensemble theater"); doctor absorbs shims; delete-or-rename pick-team |
| R2 | **concedes broad merge** (grok's epistemology objection correct) → `review` as thin diff adapter, keep 4 commands + skills (8 skills); defers evidence-referee ("fake-CI risk until a real evidence contract exists") | **concedes namespace merge** (codex's variant separates labels correctly) → goes further: collapse skills 7→5; kills own 4-skill plan, PASS/FAIL labels, pick-roles rename, clean-under-doctor |
| R3 | votes **umbrella-5** (F1 decisive; F2 protects measurement regardless of names) | votes **umbrella-5** (same anchors, independently re-verified) |

A genuine crossover: each side abandoned its R1 position under the other's strongest
argument, then both converged on the same final design once anchored to code facts.

## Converged design (unanimous)

### Q1 verdict — SELECTIVE absorption

Absorb from superpowers **only the cross-vendor review value**; everything else is host
territory or prose. Explicitly rejected: full port (re-imports the failure mode being
escaped, ×3 host maintenance) and zero absorption (leaves the measured-diversity
affordance undiscoverable — "users will not invent 'panel this diff with an unconsulted
vendor' from SCOPE.md alone").

**Do-not-port list (unanimous, with reasons):**

| superpowers skill | disposition |
|---|---|
| using-superpowers | never — coercive meta-layer fights host instruction hierarchy |
| brainstorming / writing-plans / executing-plans | host plan mode; prose if desired |
| subagent-driven-development / dispatching-parallel-agents | host-native teams; SCOPE-excluded |
| using-git-worktrees | host/OS concern; xllm isolates via exec clone |
| test-driven-development / systematic-debugging | discipline prose (CLAUDE.md/AGENTS.md), not transport |
| verification-before-completion | gate ritual = host prose; only the *external evidence-audit* survives, as P2 below |
| requesting-code-review / finishing-a-development-branch | host PR UX; scribe already covers prose |
| receiving-code-review | docs recipe over ask/debate; skill only if recipes demonstrably fail |
| writing-skills | host skill creators |

**Prose distillation (the "discipline in prose, diversity in product" residue —
suggested CLAUDE.md/AGENTS.md lines, zero xllm code):**

```text
- 모호한 요구는 코드 전에 설계 문답; 로직에는 red→green; "done" 주장 전에 실행 증거.
- 병렬 작업은 호스트 네이티브(팀/워크트리); xllm은 오케스트레이션하지 않는다.
- 틀리면 비싼 결정만 review blind/debate/council로 — panel stats가 낮은 일치율을
  보이는 곳이 다양성이 배당을 내는 곳이다.
- 리뷰 코멘트가 미심쩍으면 다른 벤더에게 반박 검증(ask/debate) 후 수용.
```

### The one new product noun: `review` (umbrella-5)

- CLI: `review roles|blind|debate|council` becomes the public home of the deliberation
  family. `roles` = today's multi (coverage, host synthesis, **explicitly non-measured**);
  `blind` = today's panel (identical prompt, ledger, agreement matrix); `debate`, `council`
  unchanged. `panel stats|outcome` → `review stats|outcome`. Old nouns remain CLI aliases
  for two minor releases.
- New diff input for review-over-code: `--base <ref>` / `--staged` / `--diff-file`
  (collector modeled on scribe's deterministic, never-persisted collectors).
- **Epistemology firewall (hard requirement):** ledger writes + pairwise-agreement fields
  appear ONLY on `blind` and council phase-1. `roles` output and index JSON must carry
  `measurement: false` (or omit measurement fields). Docs ban the word "consensus-measured"
  on roles output. Never merge multi INTO panel semantics.
- Skills collapse **7 → 5**: `ask`, `review` (absorbs multi/debate/council skill bodies as
  modes; ≤80 lines; shells to existing scripts), `exec`, `scribe`, `setup`.
- Grok Build adapter: keep 3 skills ("map, don't mirror") — `/xllm` gains mode recipes;
  no 4th skill until weekly usage proves need.

### Q2 — consolidation package (phased, unanimous)

**P0 (first release):**
1. Delete `pick-team` (no replacement); purge `/team`/`/ralph` references from README,
   `xllm-routing.js` comments, and `examples/minimal-xllm.md`.
2. Introduce `review` dispatcher + collapse skills to 5; measured/non-measured labels.
3. Grok `/xllm` recipe sections.

**P1 (next):**
1. `route pick|infer|roles|profile` namespace (flat aliases one minor). `traits` stays
   top-level — it is an instrument routing consumes, not routing (S-C unanimous).
2. `doctor smoke|contracts|inventory` subcommands (old top-levels forward).
3. `clean` → `artifacts clean`; top-level `dry-run` → global `--dry-run` flag.
4. Optional `provider list|path`; `remember` stays top-level or moves under setup.
   **No sticky `provider use`** — xllm has no session-active-provider state and must not
   fake one (S-B unanimous).
5. `propose` stays top-level — it is the ask→propose→exec safety-ladder rung, not a shim.

**P2 (evidence-gated):**
1. `review evidence` — labels `CORROBORATED | CONTRADICTED | INSUFFICIENT-EVIDENCE`
   (deliberately not PASS/FAIL: must never sound like CI). Ships ONLY after a real
   evidence-ingestion contract exists (test logs, changed-file lists, transcripts);
   structurally refuses a verdict without evidence (S-D unanimous).
2. Named prompt templates (plan-stress, feedback-rebut) only if recurring usage appears.
3. Drop aliases after two minors.

## Risks & mitigations (carried from both reviewers)

1. **Preset creep → superpowers with better branding.** Every new mode/template must
   demonstrate a specifically cross-vendor or measurement-dependent benefit; skills ≤80
   lines; must shell to an existing script; no state machines; reject loop-shaped PRs.
2. **Evidence-audit becomes fake CI.** Verdict is an external opinion on provided
   evidence, never merge authority; INSUFFICIENT-EVIDENCE on missing inputs; no auto-merge.
3. **Three-host doc skew.** README command matrix is the single source of truth;
   `check-plugin` should assert skill↔script mapping and forbid `/team`/`/ralph` strings
   in shipped docs.

## Residual disputes

None — all four round-3 votes were unanimous. The remaining call is the user's:
whether to accept the 7→5 skill collapse (a product-identity change), since both
advisors recommend it but it alters the plugin's public shape.

## Addendum — revised priority (2026-07-13, user-ratified)

After the review converged, the user supplied a piece that was not on the table during
rounds 1–3: deliver the prose distillation **through `setup`** — an opt-in wizard step
that writes the ≤25-line process block into the project's CLAUDE.md/AGENTS.md. Because
the injected prose is loaded every session and can point directly at panel/debate/council,
it partially closes the discoverability gap that was umbrella-5's decisive argument (F1).
The execution order is therefore re-sequenced; where this conflicts with the P0/P1/P2
phasing above, this addendum supersedes it (the umbrella items move from P0 to step 3).

1. **Step 1 — hygiene (unconditional, ships first).** Delete `pick-team` and its dead
   helpers (`pickTeamAdvisors`, `defaultRolesForTask`); purge `/team`/`/ralph` residue
   from README, `xllm-routing.js`, the `xllm-doctor.js` skills list, and
   `examples/minimal-xllm.md`; add a check-plugin guard so the residue cannot return.
2. **Step 2 — setup-distillation (the user's proposal).** `setup` gains an opt-in step
   writing the process-discipline block. Hard requirements: explicit consent with
   full-text preview; idempotent marker block
   (`<!-- xllm:discipline v1 -->` … `<!-- /xllm:discipline -->`) so re-runs replace the
   block only; a removal path; a ≤25-line cap enforced in code; a version tag so later
   command renames can be propagated.
3. **Step 3 — umbrella-5 (deferred, reduced).** Re-evaluate after step 2 ships. If the
   prose channel closes the discoverability gap in practice, ship only the diff input
   (`--base`/`--staged`) + a `review` entry point; the 7→5 skill collapse goes last,
   if at all.

Rationale: step 2 directly replaces what uninstalling superpowers removes, at the lowest
cost and full reversibility; step 3 changes the plugin's public identity and is the least
reversible, so it is gated on observed need.
