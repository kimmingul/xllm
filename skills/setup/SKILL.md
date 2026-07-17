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

## Step 3 — Per-project advisor wizard (posture packs)

Resolve pins deterministically; the skill only renders and confirms.

1. **Preview the recommended pack** (default `balanced`):

   ```bash
   node <advisor.js> --setup balanced --json
   ```

   The resolver returns `{ roles, warnings, evidence, recommended_packs }`.
   `balanced` leaves analysis/design OPEN (measured routing) and pins at most a
   free local critic — a pin FREEZES measured routing, so packs pin only genuine
   constraints. `quality` = max-spend lock, `frugal` = cost lock, `local` =
   offline lock, `skip` = clear pins.

2. **Ask ONE question** using the host's UI, offering the first four of
   `recommended_packs` (always include `skip`). On Claude Code use
   AskUserQuestion with the resolver's top pack labeled "(Recommended)"; show the
   effort legend (Quick=low / Standard=medium / Deep=high) and one-line role
   glosses. Never invent cloud model names — cloud pins omit the model.

3. **Show the resolved preview** (roles + warnings + which stay OPEN and why),
   then on the user's accept:

   ```bash
   node <advisor.js> --setup <pack> --apply
   ```

   Partial tweak: `--role analysis=grok@high` (validated; one bad override writes
   nothing). Reverting: `node <advisor.js> --setup skip --apply` clears the
   posture pins. Verify with `node <advisor.js> --profile-show`.

Never send repository contents to advisors during setup — your analysis stays
local; only the resulting config is written.

## Step 4 — Process-discipline block (optional, explicit opt-in)

xllm can install a ≤25-line process-discipline block (design-before-code,
red→green, evidence-before-done, plus pointers to cross-vendor deliberation)
into the project's CLAUDE.md/AGENTS.md — "discipline in prose, diversity in
product".

1. Preview: `node <advisor.js> --discipline show` — show the user the FULL
   text. Never install silently.
2. Ask consent with the host's question UI (default = skip).
3. On consent: `node <advisor.js> --discipline install` (auto-target: an
   existing CLAUDE.md, else AGENTS.md; override with `--target <path>`).
4. Mention reversibility: re-running replaces the marker block only
   (idempotent, survives version upgrades); `--discipline remove` deletes it.

## Step 5 — Summarize

Report: usable advisors now, what needs installing (`ollama serve`, missing
CLIs), pinned roles, whether the discipline block was installed, and the
standing safety defaults — advisors read-only (`--allow-write` to opt in),
same-vendor nesting refused, artifacts redacted with
`--clean-artifacts [--older-than=DAYS]` retention.
