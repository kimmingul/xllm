---
name: ask
description: >
  Headless CLI orchestration for multi-LLM advisors (xllm).
  Use when you want authentic responses from external CLIs or local models. Default
  advisors are those whose read-only boundary xllm verifies (codex, claude, ollama,
  lmstudio); other adapters (gemini, antigravity, grok, cursor, lemonade) are refused by default.
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

Examples: `codex@high`, `claude:opus@medium`, `ollama:qwen3.6:latest`,
`ollama:qwen3.6:latest@low`

Profiles / defaults: `.xllm/xllm-providers.toml` (legacy `.grok/` honored)

## Safety defaults

- Advisors run **read-only** only where xllm can verify the boundary for that
  adapter (flags/sandbox). An installed binary is not enough: an adapter whose
  read-only boundary is unverified is refused by default (`doctor`/`inventory`
  show safety separately from binary READY). Opt in to mutating advisors only
  when the user explicitly asks: `--allow-write` (or `XLLM_ALLOW_MUTATION=1`) —
  that is a separate, unsafe choice.
- Same-provider advising inside that provider's own CLI is refused
  (`--allow-self` to override).
- `execution_policy = "local-only"` (profile default) is strict: unknown or
  remote location is refused; no flag bypasses it.
- Artifacts persist prompts/outputs with secret redaction; `--no-artifacts`
  prints instead of writing.

## Supported providers

| Kind | Spec | Model / effort | Default eligibility |
|------|------|----------------|---------------------|
| Cloud | `codex` | `-m model`, effort via `-c model_reasoning_effort=` | eligible (OS read-only sandbox) |
| Cloud | `claude` | `--model`, `--effort` | eligible (restricted tools, `dontAsk`) |
| Cloud | `grok` | `-m`, `--reasoning-effort` | refused by default (boundary unverified) |
| Cloud | `antigravity` | `--model`, `--effort low\|medium\|high` | refused by default (boundary unverified) |
| Cloud | `gemini` | `--model` | refused by default (boundary unverified) |
| Cloud | `cursor` | `--model` when set | refused by default (boundary unverified) |
| Local | `ollama[:model]` | model required-ish (default from profile/env) | eligible (prompt-only HTTP) |
| Local | `lmstudio[:model]` | OpenAI body model + optional effort field | eligible (prompt-only HTTP) |
| Local | `lemonade` | `LEMONADE_BIN` | refused by default (boundary unverified) |

## Execution

1. Parse: first token = provider (`:model` ok); rest = prompt.
2. Run:

   ```bash
   node <advisor.js> <provider> "<prompt>"
   ```

3. Human mode: stdout last path line = artifact under the **cwd** state dir
   (`.xllm/artifacts/ask/`, or legacy `.grok/artifacts/ask/`). Always read the
   printed path rather than guessing the directory.
4. Machine mode: add `--json` → ONE JSON object on stdout (progress on
   stderr): `schema_version:2`, `raw` (final response only), `exitCode`,
   `failure`, `artifactPath`, and `attribution` (requested vs executed
   provider/model, `reported_model` — null unless the provider reported it —
   `identity_status` resolved|mutable|unresolved, `effective_effort`,
   `cli_version`, `surface`, `execution_location` local|remote|unknown).
   Unresolved/unknown values are shown as such, never guessed.
   `--schema-file <path>` asks for structured output (native when supported,
   else prompt contract + bounded retry).
5. Surface path + short excerpt (not full raw dump unless asked).

Optional: `--dry-run`, env `XLLM_ASK_ORIGINAL_TASK`.

## Examples

```text
/ask codex Review auth for race conditions
/ask ollama:qwen3.6:latest Suggest a simpler API surface
/ask claude Propose a thinner plugin scope
```

## Failure rules

- Missing binary / dead local server → report clearly; still mention artifact if written.
- Never claim success without path or explicit spawn error.
- In multi-review, one failure does not cancel others.

## Anti-patterns

- Hand-building `claude -p` / `codex exec` when advisor exists
- `shell: true` quoting hacks for long/Korean prompts
- Skipping artifacts
