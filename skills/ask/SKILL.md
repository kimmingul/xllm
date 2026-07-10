---
name: ask
description: >
  Get one authentic external-model opinion from another vendor's CLI (codex,
  gemini, grok, cursor, antigravity) or a local model (ollama, lmstudio,
  lemonade) without leaving Claude Code. Use when the user wants a second
  opinion, cross-vendor review, or a local-LLM answer — e.g. "ask codex",
  "what does gemini think", "get a second opinion on this design".
  Advisors run read-only by default.
---

# /xllm:ask — Single cross-vendor advisor

Claude is the host; the external CLI is an **advisor**. Its opinion arrives as
a persisted artifact you read and relay — the advisor cannot edit files.

## Run the advisor (Bash tool)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js" <spec> "<prompt>"
```

If `CLAUDE_PLUGIN_ROOT` is unset (rare), resolve the script via the project
marker `.xllm/xllm-advisor-path` (legacy `.grok/xllm-advisor-path`) or ask the
user to run `/xllm:setup`. **Never hand-build `codex exec` / `gemini -p`
invocations yourself — the advisor script owns quoting, stdin, Windows shims,
timeouts, and artifact capture.**

## Spec syntax

```text
provider | provider:model | provider@effort | provider:model@effort
```

Examples: `codex@high`, `gemini`, `grok:grok-4@high`, `ollama:qwen3.6:latest`,
`cursor`. Profiles: `.xllm/xllm-providers.toml` (legacy `.grok/` honored).

## Safety defaults (do not silently override)

- Advisors run **read-only** — no approval bypass, no sandbox escape. Add
  `--allow-write` ONLY when the user explicitly asks the advisor to modify
  files.
- **`claude` as advisor is refused inside Claude Code** (same-provider
  nesting). Suggest `codex`, `gemini`, `grok`, or a local model instead;
  `--allow-self` overrides only on explicit user request.
- Artifacts persist the prompt and output (secrets redacted) under the
  project state dir. Use `--no-artifacts` if the user asks not to persist.

## Flow

1. Parse provider spec and build a focused prompt (include only the context
   the advisor needs — it cannot see this conversation).
2. Run via Bash. The last stdout line is the artifact path
   (`.xllm/artifacts/ask/…` or legacy `.grok/artifacts/ask/…`).
3. Read the artifact and relay the substance — summary plus notable
   disagreements with your own view, not a raw dump.
4. On failure (missing binary, timeout, refusal): report the error plainly and
   suggest `/xllm:setup` to diagnose. Never fabricate an advisor opinion.

## When NOT to use

- Parallel work-splitting → use native Claude Code agents/teams.
- A question Claude can answer itself → answer it; advisors add latency/cost.
- The value here is exactly one thing: an **independent, different-vendor
  perspective**.
