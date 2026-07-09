---
name: ccg
description: >
  CLI-orchestrated multi-LLM review and synthesis (headless). Decomposes the task,
  runs 2+ external CLIs (codex, gemini, grok, claude, ollama, lmstudio, …) via the
  advisor script, captures artifacts, then synthesizes agreements/disagreements.
  Grok-native equivalent of OMC /ccg.
argument-hint: "[provider1,provider2[,provider3]] <task>"
user-invocable: true
---

# /ccg — Multi-LLM review + synthesis

Grok is the **synthesizer**. External CLIs are the **advisors**.

## Defaults

If the user omits providers, use profile defaults from `.grok/xllm-providers.toml`:

| Role | Preferred | Fallback |
|------|-----------|----------|
| Analysis | `codex` | `claude`, `grok` |
| Design | **`antigravity`** (over gemini) | `gemini` (esp. Windows headless) |
| Mix | local + cloud when both READY | e.g. `ollama:…,codex` |

Resolve advisor path like `/ask`. Run `node <advisor.js> --doctor` for READY set.  
Doctor prints a suggested pair with **antigravity > gemini**.

## Flow (strict)

1. **Parse** optional `p1,p2[,p3]` then the task text.
2. **Decompose** into specialized prompts (do not send the raw user message identical to every advisor):
   - Advisor A (analysis): correctness, architecture, security, tests, risks.
   - Advisor B (design/UX): clarity, alternatives, edge cases, docs/UX.
   - Advisor C (optional): security-only or local cheap second pass.
3. **Run advisors** — preferred one-shot multi index:

   ```bash
   node <advisor.js> --multi codex,gemini "<shared prompt — or prefer specialized calls below>"
   ```

   For **specialized** prompts (recommended), call **once per provider** (parallel if tools allow):

   ```bash
   node <advisor.js> codex "<analysis prompt>"
   node <advisor.js> gemini "<design prompt>"
   node <advisor.js> ollama:qwen3.6:latest "<cheap volume review>"
   ```

4. **Read** every `.grok/artifacts/ask/*.md` path printed by the script (and any `.grok/artifacts/ccg/*` index).
5. **Synthesize** a single response with this structure:

   ```markdown
   ## Agreed
   - ...

   ## Disagreements / trade-offs
   - Topic — A says … / B says … — **decision:** …

   ## Final direction
   ...

   ## Action checklist
   1. ...
   2. ...

   ## Artifacts
   - path1
   - path2
   ```

## Provider syntax

Same as `/ask`: `codex`, `gemini`, `grok`, `claude`, `cursor`, `ollama:MODEL`, `lmstudio:MODEL`, …

```text
/ccg Review payment error handling for security and UX
/ccg ollama:llama3.2,codex Critique the caching design
/ccg codex,claude,gemini Tri-model review of the auth rewrite
```

## Failure policy

- One advisor fails → continue; note failure in synthesis.
- All fail → explain + still give best-effort Grok-only analysis labeled as such.
- Windows + `antigravity` → substitute `gemini` and warn once.

## Relation to other skills

| Skill | Role |
|-------|------|
| `/ask` | Single advisor primitive |
| `/ccg` | Multi advisor + synthesis (this skill) |
| `/ralph` | Uses advisors as critics inside an evidence loop |
| `/verify` | Evidence table against acceptance criteria |
