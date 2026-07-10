---
name: setup
description: >
  Diagnose and initialize xllm cross-vendor advisors in this project: check
  which advisor CLIs (codex, claude, gemini, grok, cursor, ollama, lmstudio)
  are installed and healthy, write the advisor-path marker, and prepare
  artifact directories. Use for "set up xllm", "xllm doctor", or when the ask
  or multi skills cannot find providers.
---

# setup — Doctor + project marker (xllm)

## Resolve the advisor script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/grok-ask-advisor.js"`.
Codex / other hosts: the plugin root is two directories above this SKILL.md —
use `<plugin-root>/scripts/grok-ask-advisor.js`.

## Steps

1. **Doctor** (shell/Bash tool):

   ```bash
   node <advisor.js> --doctor
   ```

   Report per-provider status. Note honestly: for cloud CLIs, READY means the
   binary responds — auth is only proven by a live call
   (`node <plugin-root>/scripts/smoke.mjs --live`).

2. **Remember the advisor path** in this project (writes
   `.xllm/xllm-advisor-path`, or legacy `.grok/` if the project already uses
   it, and creates secret-redacting artifact dirs with a self-ignoring
   `.gitignore`):

   ```bash
   node <advisor.js> --remember
   ```

3. **Summarize for the user**: which advisors are usable now, which need
   installing (codex/claude/gemini/grok CLIs, or `ollama serve` for local),
   and that your host's own vendor is not usable as an advisor from inside
   itself (same-provider nesting is refused by design — e.g. no claude
   advisor inside Claude Code, no codex advisor inside Codex).

## Safety reminders to surface

- Advisors are read-only by default; `--allow-write` / `XLLM_ALLOW_MUTATION=1`
  is the explicit opt-in.
- Artifacts persist prompts/outputs (redacted); retention via
  `--clean-artifacts [--older-than=DAYS]`, opt-out via `--no-artifacts`.
