---
name: ask
description: >
  Headless CLI orchestration for multi-LLM advisors (grok-xllm).
  Use when you want authentic responses from external CLIs: claude, codex, gemini,
  antigravity (agy), grok, cursor, or local ollama/lmstudio/lemonade.
  Routes a task through the chosen provider's headless mode and saves a structured artifact.
  Primary building block for /xllm, /ralph, and /team.
argument-hint: "<provider[:model]> <task or question>"
user-invocable: true
---

# /ask — Single-provider headless advisor

Get one authentic external model opinion. Always go through the advisor script.

## Resolve the advisor script (mandatory)

Pick the first that exists:

1. Contents of `.grok/xllm-advisor-path` (legacy: `.grok/xllm-advisor-path`)
2. `$XLLM_ADVISOR_PATH` (legacy `$XLLM_ADVISOR_PATH`)
3. `$GROK_PLUGIN_ROOT/scripts/grok-ask-advisor.js` or `$XLLM_PLUGIN_ROOT/scripts/…`
4. `./scripts/grok-ask-advisor.js` (plugin repo or vendored copy)

If none exist: tell the user to run `/xllm-setup` or  
`node <plugin-checkout>/scripts/xllm.mjs remember` from this project. **Do not invent CLI flags.**

Discovery helpers:

```bash
node <advisor.js> --which
node <advisor.js> --remember
node <advisor.js> --doctor
node <advisor.js> --list-providers
```

## Spec syntax

```text
provider
provider:model
provider@effort
provider:model@effort
```

Examples: `codex@high`, `claude:opus@medium`, `grok:grok-4@high`,  
`antigravity:Gemini 3.5 Flash`, `ollama:qwen3.6:latest`, `ollama:qwen3.6:latest@low`

Profiles / defaults: `.grok/xllm-providers.toml`  
(design side prefers **antigravity** over gemini; Windows auto-falls back to gemini)

## Supported providers

| Kind | Spec | Model / effort |
|------|------|----------------|
| Cloud | `codex` | `-m model`, effort via `-c model_reasoning_effort=` |
| Cloud | `claude` | `--model`, `--effort` |
| Cloud | `grok` | `-m`, `--reasoning-effort` |
| Cloud | `antigravity` (**preferred over gemini**) | `--model` (Windows → gemini fallback) |
| Cloud | `gemini` | `--model` (fallback when antigravity unavailable) |
| Cloud | `cursor` | `--model` when set |
| Local | `ollama[:model]` | model required-ish (default from profile/env) |
| Local | `lmstudio[:model]` | OpenAI body model + optional effort field |
| Local | `lemonade` | `LEMONADE_BIN` |

## Execution

1. Parse: first token = provider (`:model` ok); rest = prompt.
2. Run:

   ```bash
   node <advisor.js> <provider> "<prompt>"
   ```

3. Stdout last path line = artifact under **cwd** `.grok/artifacts/ask/`.
4. Surface path + short excerpt (not full raw dump unless asked).

Optional: `--dry-run`, env `XLLM_ASK_ORIGINAL_TASK`.

## Examples

```text
/ask codex Review auth for race conditions
/ask ollama:qwen3.6:latest Suggest a simpler API surface
/ask grok Propose a thinner plugin scope
```

## Failure rules

- Missing binary / dead local server → report clearly; still mention artifact if written.
- Never claim success without path or explicit spawn error.
- In multi-review, one failure does not cancel others.

## Anti-patterns

- Hand-building `claude -p` / `codex exec` when advisor exists
- `shell: true` quoting hacks for long/Korean prompts
- Skipping artifacts
