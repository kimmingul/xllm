---
name: xllm
description: >
  Multi-LLM review and synthesis for xllm (headless). Decomposes the task,
  runs 2+ external CLIs (codex, claude, ollama, lmstudio, …)
  via the advisor script, captures artifacts, then synthesizes agreements and
  disagreements. Primary multi-advisor skill (replaces the former OMC-style /ccg name).
argument-hint: "[provider1,provider2[,provider3]] <task>"
user-invocable: true
---

# /xllm — Multi-LLM review + synthesis

Grok is the **synthesizer**. External CLIs are the **advisors**.

**Escalate by need:** host alone → `/ask` one other vendor → blind independent
review (below) when a measured spread of several models is worth the calls. Only
advisors whose read-only boundary xllm can verify are eligible by default —
`doctor` shows eligibility separately from "binary installed".

## Defaults

If the user omits providers, use profile defaults from `.xllm/xllm-providers.toml` (legacy `.grok/`):

| Role | Preferred | Fallback |
|------|-----------|----------|
| Analysis | `codex` | `claude` |
| Design | `claude` or a local model | another eligible advisor |
| Mix | local + cloud when both eligible | e.g. `ollama:…,codex` |

Eligible default advisors are those whose read-only boundary xllm verifies:
`codex`, `claude`, `ollama`, `lmstudio`. `antigravity`/`gemini`/`grok`/`cursor`/`lemonade`
are refused by default (installed ≠ eligible) until a boundary can be verified.

Resolve advisor path like `/ask` (`.xllm/xllm-advisor-path` or legacy `.grok/` → env → `./scripts/…`).  
Run `node <advisor.js> --doctor` for the READY set and eligibility (safety is
reported separately from "binary installed").

Or:

```bash
node <plugin>/scripts/xllm-routing.js pick analysis "<task>" --json
node <plugin>/scripts/xllm-routing.js pick design "<task>" --json
```

## Flow (strict)

1. **Parse** optional `p1,p2[,p3]` then the task text. Specs may include `provider[:model][@effort]`.
2. **Decompose** into specialized prompts (do not send the identical raw user message to every advisor):
   - Advisor A (analysis): correctness, architecture, security, tests, risks.
   - Advisor B (design/UX): clarity, alternatives, edge cases, docs/UX.
   - Advisor C (optional): security-only or cheap local pass.
3. **Run advisors** — prefer advisor script once per provider (parallel if tools allow).
   `<xllm.mjs>` below = `scripts/xllm.mjs` next to the `<advisor.js>` you already
   resolved (same directory):

   ```bash
   node <advisor.js> codex@high "<analysis prompt>"
   node <advisor.js> claude "<design prompt>"
   # or review roles when the same prompt is acceptable (providers run in parallel):
   node <xllm.mjs> review roles codex@high,claude "<shared prompt>"
   ```

   Advisors run **read-only by default** (`--allow-write` only on explicit user request).

4. **Read** every artifact path printed on stdout (files live under the state
   dir: `.xllm/artifacts/` or legacy `.grok/artifacts/`, including the
   multi-run index).
5. **Synthesize with consensus depth** — label every claim, citing advisor specs:

   ```markdown
   ## Claims
   - [unanimous] <claim> (codex@high, claude)
   - [majority] <claim> (2/3 support; one silent)
   - [split] <claim> — A says … / B says … → tiebreaker or explicit decision
   - [single-source] <claim> (one advisor — lead, not finding)

   ## Decision per split claim
   ## Final direction
   ## Action checklist
   ## Artifacts
   ```

   unanimous = every successful advisor addressed AND supported it; failed
   advisors are abstentions, never support. Consensus is confidence metadata,
   not truth. For split claims prefer one tiebreaker from an unconsulted
   vendor. `review roles` (built on `--multi`, still the underlying advisor
   flag; the old top-level nouns were removed in v0.28.0) also writes a
   machine-readable `.json` sidecar.

## Deliberation modes

`/xllm` above runs the **roles** mode (parallel advisors, host synthesizes —
coverage, **not measured**). For the default independent review use **blind**;
debate/council are **experimental**. Same `<xllm.mjs>` as step 3:

```bash
node <xllm.mjs> review blind   p1,p2[,p3] "<question>"    # blind independent panel, measured agreement
node <xllm.mjs> review roles   p1,p2[,p3] "<prompt>"      # coverage — NOT measured
node <xllm.mjs> review debate  p1,p2[,p3] "<claim>"       # EXPERIMENTAL
node <xllm.mjs> review council p1,p2[,p3] "<question>"    # EXPERIMENTAL
```

| mode | what it gives | cost | status |
|---|---|---|---|
| blind | identical blind prompt, ledgered, measured agreement | ~1× per model | default recommendation |
| roles | different prompts per advisor, your synthesis | 1× | coverage, not measured |
| debate | adversarial refutation → SURVIVED / KILLED / UNRESOLVED | ~2–3× | experimental |
| council | blind → debate | ~3–4× | experimental |

debate/council benefit is **unproven** (earlier runs showed no quality
discrimination and lower recall than blind; re-evaluation under the strict
identity method is pending). Never base a high-stakes recommendation on them;
a failed round is UNRESOLVED, not survived.

Any mode accepts one diff source: `--staged | --base <ref> | --diff-file <path>`
(`--base` is two-dot `git diff <ref>` — working tree vs ref, uncommitted
included). If the diff is truncated the run reports covered vs omitted hunks —
relay that, never claim a whole-diff review. `review stats` prints the pairwise
agreement matrix (strict-identity evidence only); `review outcome <run-id>
--adopted <spec|majority|minority|none> --helpful yes|no` records what the host
adopted.

Only blind/council/stats speak measured agreement — roles output is your
synthesis, never a rate. On a blind split, spend the measured tiebreaker
(`--tiebreak`) — never hand-pick one by vendor pedigree.

## Provider syntax

Same as `/ask`: `codex`, `codex@high`, `claude:opus@medium`, `ollama:qwen3.6:latest`, …

```text
/xllm Review payment error handling for security and UX
/xllm ollama:llama3.2,codex Critique the caching design
/xllm codex@high,claude Security + design review of auth rewrite
```

## Failure policy

- One advisor fails → continue; note failure in synthesis.
- All fail → explain + best-effort Grok-only analysis labeled as degraded.
- A requested provider is not eligible (unverified read-only boundary, or
  refused by `execution_policy = "local-only"`) → report the refusal; never
  substitute silently or work around the policy.

## Relation to other skills

| Skill | Role |
|-------|------|
| `/ask` | Single advisor primitive |
| `/xllm` | Multi advisor + synthesis (this skill) |

## Implementation note

Prefer:

```bash
node scripts/xllm-advisor.js <spec> "<prompt>"
# or
node <xllm.mjs> review roles p1,p2 "<prompt>"
```

Never hand-roll provider CLI flags when the advisor script exists.
