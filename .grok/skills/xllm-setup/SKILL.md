---
name: xllm-setup
description: >
  Setup and doctor for grok-xllm. Creates artifact dirs, remembers advisor script
  path for this project, checks cloud/local providers, and prints recommended commands.
user-invocable: true
---

# /xllm-setup — Install health check

Run these steps (do not only describe them).

## 1. Resolve + remember advisor path

Find `grok-ask-advisor.js` via (first hit):

- `.grok/xllm-advisor-path` (legacy: `.grok/xllm-advisor-path`)
- `XLLM_ADVISOR_PATH` / `GROK_PLUGIN_ROOT` / `XLLM_PLUGIN_ROOT`
- `./scripts/grok-ask-advisor.js`
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
.grok/artifacts/ask|ccg|ralph|team|verify/
```

(`--remember` / `--doctor` also create these.)

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

Skills: ask, ccg, ralph, team, verify, xllm-setup  
Agents: critic, executor, verifier, security-reviewer (and friends)

## 6. User summary

Print:

- Advisor path + marker path
- Ready providers
- Recommended:

```text
/ccg <local>,<cloud> "…"
/ralph --critic=<local>,<cloud> "…"
/ask <provider> "…"
```

- Windows: avoid antigravity headless
- Docs: `.grok/docs/install.md`

## Usage

```text
/xllm-setup
```
