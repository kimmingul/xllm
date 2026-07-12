# xllm debate — adversarial review design (2026-07-11)

> **Amendment (2026-07-12, v0.18.0, user-adjudicated):** author/attacker
> identity is the **model** (canonical spec key, effort stripped), not the
> provider. 'ollama' is a runtime hosting models from different labs, so
> provider-level identity made same-runtime models invisible to each other —
> observed live: a local-only council where 7/8 claims SURVIVED with "no
> valid refutation" because neither ollama model was eligible to attack the
> other's claims. Consequences: same-runtime models now refute each other;
> the N≥3 kill rule counts distinct MODELS ("2 distinct opponents"); defense
> rebuttals are matched per model (this also fixed a latent `[undefined]`
> attacker label in the defend prompt). The decisive-falsifier bar below is
> unchanged and remains the guard against correlated same-lab piling-on.

> Designed via xllm's own adversarial method: codex@high and grok@high each
> proposed a design (Round 1), then rebutted each other (Round 2). They
> converged. This document is the synthesized result; raw rounds are in
> `.grok/artifacts/ask/*fierce-adversarial-design-review*`.

## Purpose

`panel` **measures** diversity (blind, independent — surfaces decorrelated
claims). `debate` **spends** it: models see and try to *refute* each other so
plausible-but-wrong claims die and correct ones survive. Where panel maximizes
diversity measurement, debate maximizes decision **quality**.

Both are read-only, cross-vendor, same-vendor-nesting-refused. Neither
auto-applies anything. **Status is a protocol outcome, not truth.**

## Convergence (what the two designers agreed after rebuttal)

- **Mechanical resolution by default, no judge LLM.** Codex conceded its
  independent-adjudicator layer needs 5 distinct providers per claim (author +
  2 challengers + 2 arbiters) and collapses to all-UNRESOLVED at the realistic
  N=2–3. Arbiters become an optional escalation for UNRESOLVED claims at N≥5.
- **Kill power comes from EVIDENCE TIER, not vendor count.** Grok conceded
  that counting "mechanism" strings is "a vote dressed as logic" — two
  correlated vendors can confabulate matching prose and false-kill a correct
  claim. Fix: only a **DECISIVE** falsifier (a concrete, checkable
  counterexample / failing-test / contradiction) can kill; **SOFT** prose
  mechanisms and `EXTERNAL_UNVERIFIED` evidence can never kill alone.
- **N=2 works.** The old "≥2 distinct-vendor refute" bar is impossible at N=2
  (a claim has one foreign attacker) → nothing could ever be killed. Fixed:
  at any N, one opponent CAN kill a claim if it supplies a decisive falsifier
  the author fails to defeat; mere disagreement never kills.
- **Cap 8 claims** (grok conceded from 12): more claims = shallower claims,
  more fabricated citations, less verification budget each.

## Algorithm

`xllm debate run p1,p2[,p3] "<question>"` — always panel-first (avoids
anchoring); `--from-panel <run-id>` reuses a fresh panel's claims.

0. **R0 blind claims.** Each provider independently answers and emits atomic
   claims (round-robin, cap 8). No provider sees another's answer. Host
   assigns stable IDs `C{provider}-{i}`.
1. **R1 refute (per provider, foreign claims only).** Each provider sees the
   question + others' claims (never full peer answers) and tries to kill each:
   `{claim_id, stance: refute|pass, mechanism, falsifier, tier: decisive|soft}`.
   Default stance is refute; "looks fine" is failure unless justified.
2. **R2 defend (authors only, challenged claims).** The author sees all attacks
   on its claim and responds `concede | amend | holds`, addressing each attacker
   with a counter (evidence/test) or conceding that point.
3. **Mechanical classification (order-immune, no judge).** Pure set-logic on
   the structured fields — see below.
4. **(Optional) N≥5 adjudication.** Only UNRESOLVED claims go identity-blind to
   two eligible arbiters; both must agree or it stays UNRESOLVED.

## Claim lifecycle (the exact rule)

For each claim, with its refute-attacks and the author's defense:

- **KILLED** iff: author `concede`/`amend`; **OR** a `decisive` refute stands
  (the author does not rebut that attacker with `holds` + counter); **OR**
  (N≥3 and ≥2 distinct non-author vendors submit valid refutes and the author
  fails to hold against each).
- **SURVIVED** iff: no valid refute; **OR** every refute is soft/withdrawn/
  schema-invalid and the author holds against any that stand.
- **UNRESOLVED** otherwise: a soft dispute where the author holds (honest
  limbo — no decisive evidence either way), conflicting decisive tests,
  same-vendor-only attacks at N=2, or evidence/schema failure.

`amend` kills the original and adds the narrowed replacement as a new
SURVIVED-amended claim.

## Anti-failure guardrails

- **Sycophancy** → default-to-refute prompt; "you're right"/agreement prose is
  invalid output; each attack must carry a concrete mechanism.
- **Confabulation** → typed evidence; `EXTERNAL_UNVERIFIED` and unvalidated
  provenance can annotate but never drive a KILL.
- **Correlated-wrong consensus** → agreement count is never truth; only a
  decisive falsifier kills, and everything is surfaced for the host; no
  auto-apply.
- **Order effects** → R1 and R2 are independent per-claim; resolution is
  set-logic on fields, never "last/strongest speaker."
- **Cost** → cap 8 claims; ~2N–3N calls (R0 + R1 + authors-only R2).

## Output

Append-only ledger (`<state>/panel-ledger.jsonl`, `type: "debate"`, linked to
the panel run) records claims, attacks, defenses, and status **before** any
prose. The human index lists SURVIVED (with why), KILLED (with the refutation
that killed it), and UNRESOLVED (needs human). Executor-green analogue:
**survived ≠ true — it survived this protocol.**
