---
name: multi
description: >
  Run 2+ external LLM advisors in parallel (codex, gemini, grok, cursor, local
  ollama/lmstudio) and synthesize their independent opinions into one
  agreements/disagreements verdict. Use for cross-vendor design or security
  review, "get multiple opinions", or comparing cloud vs local model takes.
  Advisors run read-only by default.
---

# /xllm:multi — Parallel multi-advisor review + synthesis

Claude is the **synthesizer**; external CLIs are the **advisors**. Providers
run concurrently (one child process each).

## Run (Bash tool)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js" --multi p1,p2[,p3] "<shared prompt>"
```

For per-advisor specialized prompts (better than one shared prompt when roles
differ), run single `ask` invocations in parallel Bash calls instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js" codex@high "<analysis prompt>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js" gemini "<design prompt>"
```

## Safety defaults

Same as `/xllm:ask`: read-only advisors (`--allow-write` only on explicit user
request), `claude`-as-advisor refused inside Claude Code (pick other vendors),
artifacts secret-redacted (`--no-artifacts` to skip persistence).

## Flow (strict)

1. **Decompose** the task into advisor-appropriate prompts. Do not send the
   raw conversation; each advisor sees only its prompt.
2. **Run** advisors (parallel). Collect artifact paths from stdout — `--multi`
   prints a multi-run index whose Artifacts section lists per-advisor files.
3. **Read every artifact**, then **synthesize**:

   ```markdown
   ## Agreed
   ## Disagreements / trade-offs   (topic — A says… / B says… — decision + why)
   ## Final direction
   ## Artifacts (paths)
   ```

4. One advisor failing does not cancel the rest — note the failure in the
   synthesis. If all fail, say so and give your own analysis labeled as
   Claude-only.

## When NOT to use

Native Claude Code agents already cover same-model parallelism, planning, and
verification. Reach for this skill only when **cross-vendor disagreement**
(or a local-model perspective) is the point.
