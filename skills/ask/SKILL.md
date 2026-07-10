---
name: ask
description: >
  Get one authentic external-model opinion from another vendor's CLI (codex,
  claude, gemini, grok, cursor, antigravity) or a local model (ollama,
  lmstudio, lemonade) without leaving your session. Use when the user wants a
  second opinion, cross-vendor review, or a local-LLM answer — e.g. "ask
  codex", "what does gemini think", "get a second opinion on this design".
  Advisors run read-only by default.
---

# ask — Single cross-vendor advisor (xllm)

Your host CLI is the conductor; the external CLI is an **advisor**. Its
opinion arrives as a persisted artifact you read and relay — the advisor
cannot edit files.

## Resolve the advisor script

Pick the first that works, then run it with your shell/Bash tool:

1. **Claude Code**: `"${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js"`
2. **Codex / other hosts**: the plugin root is two directories above this
   SKILL.md — run `<plugin-root>/scripts/grok-ask-advisor.js`
3. **Any host**: the project marker `.xllm/xllm-advisor-path` (legacy
   `.grok/xllm-advisor-path`) contains the absolute script path
4. None of the above → run the `setup` skill first

```bash
node <advisor.js> <spec> "<prompt>"
```

**Never hand-build `codex exec` / `claude -p` / `gemini -p` invocations
yourself — the advisor script owns quoting, stdin, Windows shims, timeouts,
env sanitization, and artifact capture.**

## Spec syntax

```text
provider | provider:model | provider@effort | provider:model@effort
```

Examples: `codex@high`, `claude:opus@medium`, `gemini`, `grok:grok-4@high`,
`ollama:qwen3.6:latest`. Profiles: `.xllm/xllm-providers.toml` (legacy
`.grok/` honored).

## Safety defaults (do not silently override)

- Advisors run **read-only** — no approval bypass, no sandbox escape. Add
  `--allow-write` ONLY when the user explicitly asks the advisor to modify
  files.
- **Your own vendor is refused as advisor** (claude→claude inside Claude
  Code, codex→codex inside Codex, grok→grok inside Grok Build). Suggest a
  different vendor or a local model; `--allow-self` overrides only on
  explicit user request.
- Artifacts persist the prompt and output (secrets redacted) under the
  project state dir. Use `--no-artifacts` if the user asks not to persist.

## Flow

1. Parse the provider spec and build a focused prompt (include only the
   context the advisor needs — it cannot see this conversation).
2. Run via shell. The last stdout line is the artifact path
   (`.xllm/artifacts/ask/…` or legacy `.grok/artifacts/ask/…`).
3. Read the artifact and relay the substance — summary plus notable
   disagreements with your own view, not a raw dump.
4. On failure (missing binary, timeout, refusal): report the error plainly
   and suggest the `setup` skill to diagnose. Never fabricate an advisor
   opinion.

## When NOT to use

- Parallel work-splitting → use your host's native agents/subagents.
- A question you can answer yourself → answer it; advisors add latency/cost.
- The value here is exactly one thing: an **independent, different-vendor
  perspective**.
