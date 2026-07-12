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

- `.grok/xllm-advisor-path` (legacy: `.grok/xllm-advisor-path`)
- `XLLM_ADVISOR_PATH` / `GROK_PLUGIN_ROOT` / `XLLM_PLUGIN_ROOT`
- `./scripts/xllm-advisor.js`
- plugin checkout path the user has open

Then run:

```bash
node <advisor.js> --remember
node <advisor.js> --which
```

Confirm `.grok/xllm-advisor-path` exists and points at a real file.

## 2. Artifact directories

Ensure:

```text
<state>/artifacts/ask|xllm|proposals|exec/
```

(`--remember` / `--doctor` also create these.)

## 2.5 Project advisor wizard (optional)

Pin per-project roles interactively — recommend from the machine inventory
(`node <advisor.js> --inventory`, 24h cache; `--refresh` to re-probe). Never
send repository contents to advisors during setup; analyze locally, ask the
user per role, then persist:

```bash
node <advisor.js> --set-role analysis codex@high
node <advisor.js> --set-role critic ollama:qwen3.6:latest@low
node <advisor.js> --profile-show
```

Pinned roles override built-in routing exactly (effort included). If the
project is empty, ask the user what they intend to build first.

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

Skills: ask, xllm, xllm-setup  
Agents: critic, executor, verifier, security-reviewer (and friends)

## 6. User summary

Print:

- Advisor path + marker path
- Ready providers
- Recommended:

```text
/xllm <local>,<cloud> "…"
/ask <provider> "…"
```

- Windows: avoid antigravity headless
- Docs: `docs/install.md`

## Usage

```text
/xllm-setup
```
