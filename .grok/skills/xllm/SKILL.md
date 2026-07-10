---
name: xllm
description: >
  Multi-LLM review and synthesis for grok-xllm (headless). Decomposes the task,
  runs 2+ external CLIs (codex, antigravity, grok, claude, ollama, lmstudio, …)
  via the advisor script, captures artifacts, then synthesizes agreements and
  disagreements. Primary multi-advisor skill (replaces the former OMC-style /ccg name).
argument-hint: "[provider1,provider2[,provider3]] <task>"
user-invocable: true
---

# /xllm — Multi-LLM review + synthesis

Grok is the **synthesizer**. External CLIs are the **advisors**.

## Defaults

If the user omits providers, use profile defaults from `.xllm/xllm-providers.toml` (legacy `.grok/`):

| Role | Preferred | Fallback |
|------|-----------|----------|
| Analysis | `codex` | `claude`, `grok` |
| Design | **`antigravity`** (over gemini) | `gemini` (esp. Windows headless) |
| Mix | local + cloud when both READY | e.g. `ollama:…,codex` |

Resolve advisor path like `/ask` (`.xllm/xllm-advisor-path` or legacy `.grok/` → env → `./scripts/…`).  
Run `node <advisor.js> --doctor` for READY set.  
Doctor prints a suggested pair with **antigravity > gemini**.

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
3. **Run advisors** — prefer advisor script once per provider (parallel if tools allow):

   ```bash
   node <advisor.js> codex@high "<analysis prompt>"
   node <advisor.js> antigravity "<design prompt>"
   # or --multi when the same prompt is acceptable (providers run in parallel):
   node <advisor.js> --multi codex@high,antigravity "<shared prompt>"
   ```

   Advisors run **read-only by default** (`--allow-write` only on explicit user request).

4. **Read** every artifact path printed on stdout (files live under the state
   dir: `.xllm/artifacts/` or legacy `.grok/artifacts/`, including the
   multi-run index).
5. **Synthesize** one response:

   ```markdown
   ## Agreed
   - ...

   ## Disagreements / trade-offs
   - Topic — A says … / B says … — **decision:** …

   ## Final direction
   ...

   ## Action checklist
   1. ...

   ## Artifacts
   - path1
   - path2
   ```

## Provider syntax

Same as `/ask`: `codex`, `codex@high`, `claude:opus@medium`, `antigravity`, `ollama:qwen3.6:latest`, …

```text
/xllm Review payment error handling for security and UX
/xllm ollama:llama3.2,codex Critique the caching design
/xllm codex@high,antigravity Security + design review of auth rewrite
```

## Failure policy

- One advisor fails → continue; note failure in synthesis.
- All fail → explain + best-effort Grok-only analysis labeled as degraded.
- Windows + `antigravity` → auto-fallback to `gemini` (warn once).

## Relation to other skills

| Skill | Role |
|-------|------|
| `/ask` | Single advisor primitive |
| `/xllm` | Multi advisor + synthesis (this skill) |
| `/ralph` | Uses advisors as critics inside an evidence loop |
| `/team` | Parallel workers with role routing |
| `/verify` | Evidence table against acceptance criteria |

## Implementation note

Prefer:

```bash
node scripts/grok-ask-advisor.js <spec> "<prompt>"
# or
node scripts/xllm.mjs multi p1,p2 "<prompt>"
```

Never hand-roll provider CLI flags when the advisor script exists.
