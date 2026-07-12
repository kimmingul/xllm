---
name: multi
description: >
  Run 2+ external LLM advisors in parallel (codex, claude, gemini, grok,
  cursor, local ollama/lmstudio) and synthesize their independent opinions
  into one agreements/disagreements verdict. Use for cross-vendor design or
  security review, "get multiple opinions", or comparing cloud vs local model
  takes. Advisors run read-only by default.
---

# multi — Parallel multi-advisor review + synthesis (xllm)

Your host CLI is the **synthesizer**; external CLIs are the **advisors**.
Providers run concurrently (one child process each).

## Run

Resolve the advisor script exactly as in the `ask` skill (Claude Code:
`${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js`; Codex/other hosts:
`<plugin-root>/scripts/grok-ask-advisor.js` two directories above this
SKILL.md; any host: the `.xllm/xllm-advisor-path` marker), then:

```bash
node <advisor.js> --multi p1,p2[,p3] "<shared prompt>"
```

For per-advisor specialized prompts (better than one shared prompt when
roles differ), run single invocations in parallel shell calls instead:

```bash
node <advisor.js> codex@high "<analysis prompt>"
node <advisor.js> gemini "<design prompt>"
```

## Safety defaults

Same as `ask`: read-only advisors (`--allow-write` only on explicit user
request), your own vendor refused as advisor (pick other vendors or local
models), artifacts secret-redacted (`--no-artifacts` to skip persistence).

## Flow (strict)

1. **Decompose** the task into advisor-appropriate prompts. Do not send the
   raw conversation; each advisor sees only its prompt.
2. **Run** advisors (parallel). `--multi` prints a multi-run index (`.md`)
   listing per-advisor artifacts, plus a machine-readable `.json` sidecar.
3. **Read every artifact**, then **synthesize with consensus depth** — label
   every claim, citing supporting advisor specs:

   ```markdown
   ## Claims
   - [unanimous] <claim> (codex@high, gemini)
   - [majority] <claim> (2/3: codex@high, ollama; gemini silent)
   - [split] <claim> — A says… / B says… → needs tiebreaker
   - [single-source] <claim> (gemini only — lead, not finding)

   ## Decision per split claim   (tiebreaker run or explicit judgment + why)
   ## Final direction
   ## Artifacts (paths)
   ```

   Label meanings: **unanimous** = every successful advisor addressed AND
   supported it; **majority** = >half support, no strong counter-evidence;
   **split** = disagreement — don't act without a tiebreaker (prefer a vendor
   not yet consulted); **single-source** = one advisor only — a lead, not a
   finding. Failed advisors count as abstentions, never as support.
   Consensus is confidence metadata, not truth — unanimous can still be wrong.
4. One advisor failing does not cancel the rest — note the failure in the
   synthesis. If all fail, say so and give your own analysis labeled as
   host-only.

## Panel mode (measurement — model-diversity, isolated from prompt-diversity)

When the point is to MEASURE disagreement (not divide roles), use the blind
same-prompt panel instead of role-decomposed multi:

```bash
node <plugin-root>/scripts/xllm-panel.js run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <plugin-root>/scripts/xllm-panel.js stats          # pairwise agreement matrix
```

Every panelist gets the IDENTICAL prompt and returns a structured verdict
(approve/reject/mixed + key claims). The ledger (`<state>/panel-ledger.jsonl`)
is written before any prose — your summary is UX and may not contradict it;
minority reports are findings, not noise; failed panelists are abstentions.
On split, the core now computes the tiebreaker pick itself (an unconsulted
provider with the LOWEST measured agreement from the ledger — never vendor
pedigree) and records it for free; pass `--tiebreak` to spend the one extra
blind call. Don't hand-pick the vendor. Afterwards record what you did:
`panel outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no`.

## Proposal mode (file work, still read-only)

Add `--propose` to get **candidate patches instead of opinions**: each
advisor returns a unified diff, saved under `artifacts/proposals/` with a
`.patch` sidecar. Advisors never apply anything. Judge the N candidates
(correctness, minimality, style fit), pick or merge the best, validate with
`git apply --check <patch>`, and apply only after review. Cost pattern:
cheap/local advisors draft, one strong advisor (or you) judges.

## When NOT to use

Your host's native agents already cover same-model parallelism, planning,
and verification. Reach for this skill only when **cross-vendor
disagreement** (or a local-model perspective) is the point.
