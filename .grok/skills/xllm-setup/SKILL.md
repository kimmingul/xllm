---
name: xllm-setup
description: >
  Setup and doctor for xllm. Creates artifact dirs, remembers advisor script
  path for this project, checks cloud/local providers, and prints recommended commands.
user-invocable: true
---

# /xllm-setup — Install health check

> `<state>` = project state dir: `.xllm/` (default) or legacy `.grok/` when the project already uses it.

Run these steps (do not only describe them).

## 1. Resolve + remember advisor path

Find `xllm-advisor.js` via (first hit):

- `.xllm/xllm-advisor-path` (legacy: `.grok/xllm-advisor-path`)
- `XLLM_ADVISOR_PATH` / `GROK_PLUGIN_ROOT` / `XLLM_PLUGIN_ROOT`
- `./scripts/xllm-advisor.js`
- plugin checkout path the user has open

Then run:

```bash
node <advisor.js> --remember
node <advisor.js> --which
```

Confirm `.xllm/xllm-advisor-path` (or legacy `.grok/`) exists and points at a
real file.

## 2. Artifact directories

Ensure:

```text
<state>/artifacts/ask|xllm|proposals|exec/
```

(`--remember` / `--doctor` also create these.)

## 2.5 Project advisor wizard (posture packs — optional)

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

2. **Ask ONE question**, offering the first four of `recommended_packs` (always
   include `skip`). Show the effort legend (Quick=low / Standard=medium /
   Deep=high) and one-line role glosses. Never invent cloud model names — cloud
   pins omit the model.

3. **Show the resolved preview** (roles + warnings + which stay OPEN and why),
   then on the user's accept:

   ```bash
   node <advisor.js> --setup <pack> --apply
   ```

   Partial tweak: `--role analysis=grok@high` (validated; one bad override writes
   nothing). Reverting: `node <advisor.js> --setup skip --apply` clears the
   posture pins. Verify with `node <advisor.js> --profile-show`.

Never send repository contents to advisors during setup; analyze locally, persist
only the resulting config.

## 2.7 Process-discipline block (optional, explicit opt-in)

Preview with `node <advisor.js> --discipline show`, show the user the full
text, ask consent (default = skip), then on consent:

```bash
node <advisor.js> --discipline install   # auto-target: CLAUDE.md, else AGENTS.md
```

Idempotent marker block (≤25 lines); `--discipline remove` deletes it.

## 3. Doctor

```bash
node <advisor.js> --doctor
# or human summary:
node <plugin>/scripts/xllm-doctor.js
```

Report READY / PARTIAL / MISSING.

## 4. Optional smoke

If at least one provider READY:

```bash
node <advisor.js> --dry-run <readyProvider> "setup smoke"
node <advisor.js> ollama:… "Reply with exactly: xllm-setup-ok"
```

## 5. Inventory

Skills: ask, xllm, xllm-setup (agents were removed in v0.20.0 — host-native
agents cover them)

## 6. User summary

Print:

- Advisor path + marker path
- Ready providers
- Recommended:

```text
/xllm <local>,<cloud> "…"
/ask <provider> "…"
```

- antigravity (`agy`) headless works on every platform, Windows included
- Docs: `docs/install.md`

## Usage

```text
/xllm-setup
```
