---
name: setup
description: >
  Diagnose and configure xllm cross-vendor advisors for THIS project: scan the
  machine for installed advisor CLIs and local models, then run a short Q&A to
  pin which provider+model+effort each role should use here, with recommended
  defaults. Use for "set up xllm", "xllm doctor", "configure advisors for this
  project", or when the ask or multi skills cannot find providers.
---

# setup — Machine inventory + per-project advisor wizard (xllm)

## Resolve the advisor script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-advisor.js"`.
Codex / other hosts: the plugin root is two directories above this SKILL.md —
use `<plugin-root>/scripts/xllm-advisor.js`.

## Step 1 — Machine inventory (what CAN run here)

```bash
node <advisor.js> --inventory            # cached (24h TTL)
node <advisor.js> --inventory --refresh  # force re-probe
```

Reports per provider: installed, healthy, tier (strong/balanced/local),
relative cost, and for ollama the **actually pulled models**. Cloud model
catalogs are not enumerated — for cloud CLIs, installed means the binary
responds; auth is only proven by `node <plugin-root>/scripts/smoke.mjs --live`.

## Step 2 — Project marker + artifact dirs

```bash
node <advisor.js> --remember
```

Writes `.xllm/xllm-advisor-path` (legacy `.grok/` honored) and creates
secret-redacting artifact dirs with a self-ignoring `.gitignore`.

## Step 3 — Per-project advisor wizard (Q&A)

Goal: pin role → `provider[:model][@effort]` for THIS project.

1. **Understand the project locally.** Look at languages, stack, and
   security-sensitivity (auth/payment/crypto code) using your own file access.
   **Never send repository contents to advisors during setup** — your analysis
   stays local; only the resulting config is written.
   If the project is empty, ask the user to describe what they intend to
   build before recommending anything.
2. **Draft recommendations** from the inventory: strong tier for
   analysis/security, balanced for design, cheapest healthy local model for
   critic/docs. Cross-vendor rule: never recommend the host's own vendor.
3. **Ask the user** one focused question per role that matters (usually
   analysis, design, critic). Use the host's native question UI — on Claude
   Code, AskUserQuestion with your recommendation as the first option labeled
   "(Recommended)"; elsewhere, a compact numbered list. Include a "skip
   (use built-in routing)" option.
4. **Persist each answer**:

   ```bash
   node <advisor.js> --set-role analysis codex@high
   node <advisor.js> --set-role critic ollama:qwen3.6:latest@low
   ```

   Verify with `node <advisor.js> --profile-show`. Pinned roles override
   built-in routing exactly (including effort — no intensity bumping).

## Step 4 — Summarize

Report: usable advisors now, what needs installing (`ollama serve`, missing
CLIs), pinned roles, and the standing safety defaults — advisors read-only
(`--allow-write` to opt in), same-vendor nesting refused, artifacts redacted
with `--clean-artifacts [--older-than=DAYS]` retention.
