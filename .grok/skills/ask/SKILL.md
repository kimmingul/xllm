---
name: ask
description: >
  Headless CLI orchestration for multi-LLM advisors (xllm).
  Use when you want authentic responses from external CLIs: claude, codex, gemini,
  antigravity (agy), grok, cursor, or local ollama/lmstudio/lemonade.
  Routes a task through the chosen provider's headless mode and saves a structured artifact.
  Primary building block for /xllm.
argument-hint: "<provider[:model]> <task or question>"
user-invocable: true
---

# /ask — Single-provider headless advisor

Get one authentic external model opinion. Always go through the advisor script.

## Resolve the advisor script (mandatory)

Pick the first that exists:

1. Contents of `.xllm/xllm-advisor-path` (legacy: `.grok/xllm-advisor-path`)
2. `$XLLM_ADVISOR_PATH` (legacy `$XLLM_ADVISOR_PATH`)
3. `$GROK_PLUGIN_ROOT/scripts/xllm-advisor.js` or `$XLLM_PLUGIN_ROOT/scripts/…`
4. `./scripts/xllm-advisor.js` (plugin repo or vendored copy)

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

Examples: `codex@high`, `claude:opus@medium`, `grok:grok-4.5@high`,  
`antigravity:gemini-3.6-flash-high`, `ollama:qwen3.6:latest`, `ollama:qwen3.6:latest@low`

Profiles / defaults: `.xllm/xllm-providers.toml` (legacy `.grok/` honored)  
(design side prefers **antigravity** on every platform; the standalone `gemini`
CLI is substituted in only when `agy` is not on PATH — and vice versa)

## Safety defaults

- Advisors run **read-only**: no approval bypass, no sandbox escape. Opt in to
  mutating advisors only when the user explicitly asks: `--allow-write`
  (or `XLLM_ALLOW_MUTATION=1`).
- Same-provider advising inside that provider's own CLI is refused
  (`--allow-self` to override).
- Artifacts persist prompts/outputs with secret redaction; `--no-artifacts`
  prints instead of writing.

## Supported providers

| Kind | Spec | Model / effort |
|------|------|----------------|
| Cloud | `codex` | `-m model`, effort via `-c model_reasoning_effort=` |
| Cloud | `claude` | `--model`, `--effort` |
| Cloud | `grok` | `-m`, `--reasoning-effort` |
| Cloud | `antigravity` (**preferred over gemini**) | `--model`, `--effort low\|medium\|high` |
| Cloud | `gemini` | `--model` (used only when `agy` is not installed) |
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

3. Stdout last path line = artifact under the **cwd** state dir
   (`.xllm/artifacts/ask/`, or legacy `.grok/artifacts/ask/`). Always read the
   printed path rather than guessing the directory.
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
