---
name: ask
description: >
  Get one authentic external-model opinion from another vendor's CLI (codex,
  claude, gemini, grok, cursor, antigravity) or a local model (ollama,
  lmstudio, lemonade) without leaving your session; only adapters with a
  verified read-only boundary run by default. Use when the user wants a
  second opinion, cross-vendor review, or a local-LLM answer — e.g. "ask
  codex", "what does claude think", "get a second opinion on this design".
  Advisors run read-only by default.
---

# ask — Single cross-vendor advisor (xllm)

Your host CLI is the conductor; the external CLI is an **advisor**. Its
opinion arrives as a result you read and relay — the advisor cannot edit
files.

**Escalation by need:** host alone first → `ask` one other vendor when an
independent view is worth the cost → blind independent review (`review`
skill) only when you want a measured spread across several models.

## Resolve the advisor script

Pick the first that works, then run it with your shell/Bash tool:

1. **Claude Code**: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-advisor.js"`
2. **Codex / other hosts**: the plugin root is two directories above this
   SKILL.md — run `<plugin-root>/scripts/xllm-advisor.js`
3. **Any host**: the project marker `.xllm/xllm-advisor-path` (legacy
   `.grok/xllm-advisor-path`) contains the absolute script path
4. None of the above → run the `setup` skill first

```bash
node <advisor.js> <spec> "<prompt>"          # human mode: last stdout line = artifact path
node <advisor.js> <spec> "<prompt>" --json   # machine mode: ONE JSON object on stdout
```

**Never hand-build `codex exec` / `claude -p` / `gemini -p` invocations
yourself — the advisor script owns quoting, stdin, Windows shims, timeouts,
env sanitization, and artifact capture.**

## Spec syntax

```text
provider | provider:model | provider@effort | provider:model@effort
```

Examples: `codex@high`, `claude:opus@medium`, `gemini`, `grok:grok-4.5@high`,
`ollama:qwen3.6:latest`. Profiles: `.xllm/xllm-providers.toml` (legacy
`.grok/` honored).

## Safety defaults (do not silently override)

- Advisors run **read-only** — no approval bypass, no sandbox escape — but only
  where xllm can verify the boundary for that adapter. An installed binary is
  not an eligible advisor: adapters with an unverified read-only boundary are
  refused by default (`doctor`/`inventory` show eligibility separately from
  "installed"). Add `--allow-write` ONLY when the user explicitly asks the
  advisor to modify files; that is a separate, unsafe choice.
- **Your own vendor is refused as advisor** (claude→claude inside Claude
  Code, codex→codex inside Codex, grok→grok inside Grok Build). Suggest a
  different vendor or a local model; `--allow-self` overrides only on
  explicit user request.
- **Local-only is strict.** When the project sets `execution_policy =
  "local-only"` (`profile set-default execution_policy local-only`), only
  providers verified as running on this machine pass. Unknown location is
  refused, never assumed local; no flag bypasses it. Tell the user to fix
  the provider/policy rather than relaxing it.
- Human mode persists the prompt and output (secrets redacted) under the
  project state dir. Use `--no-artifacts` if the user asks not to persist.

## Flow

1. Parse the provider spec and build a focused prompt (include only the
   context the advisor needs — it cannot see this conversation).
2. Run via shell. Prefer `--json`: stdout is exactly one object, progress is
   on stderr. Human mode prints the artifact path
   (`.xllm/artifacts/ask/…` or legacy `.grok/artifacts/ask/…`) as the last
   stdout line.
3. Relay the substance — summary plus notable disagreements with your own
   view, not a raw dump.
4. On failure (missing binary, timeout, refusal): report the error plainly
   (`failure.kind`/`hint` in `--json`) and suggest the `setup` skill to
   diagnose. Never fabricate an advisor opinion.

## `--json` result

```text
{ schema_version: 2, raw, exitCode, durationMs, artifactPath, patchPath,
  failure: { kind, retryable, hint? } | null,
  attribution: { requested_provider, requested_model, executed_provider,
                 transmitted_model, substituted_from, model_correction_source,
                 reported_model, identity_status, model_revision,
                 requested_effort, effective_effort, cli_version,
                 surface, execution_location },
  usage, cost_estimate, structured }
```

- `raw` is the advisor's final response text only (no prompt, no stderr).
- Every call — including fatal errors — returns this envelope; check
  `exitCode`/`failure` before using `raw`.
- `attribution` separates what was *requested* from what ran. `reported_model`
  is `null` unless the provider reported it — never infer the model from the
  requested spec or from the answer text.
- `identity_status`: `resolved` = provider reported an immutable identity;
  `mutable` = a full model ID or alias that can change under you
  (`opus`/`sonnet`/`latest`/`default`/`auto` are never resolved);
  `unresolved` = the provider gave no usable metadata. Only `resolved`
  results can count as routing/evidence; `unresolved` is shown, not trusted.
- `execution_location`: `local` | `remote` | `unknown` — `unknown` is not
  `local`.
- `--schema-file <path>` requests structured output. Providers with native
  schema support use it; others fall back to a prompt contract plus a bounded
  retry — that is best-effort JSON, not constrained generation. The parsed
  object lands in `structured` (otherwise `null`).

## Proposal mode (file work, still read-only)

`--propose` asks the advisor for a **unified diff** instead of an opinion:
artifact lands under `artifacts/proposals/` with an extracted `.patch`
sidecar (`patchPath` in `--json`). The advisor never applies anything —
validate with `git apply --check <patch>`, review, then apply yourself.

## When NOT to use

- Parallel work-splitting → use your host's native agents/subagents.
- A question you can answer yourself → answer it; advisors add latency/cost.
- The value here is exactly one thing: an **independent, different-vendor
  perspective**.
