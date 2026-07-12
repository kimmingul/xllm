# Install & use outside the plugin repo

> `<state>` = project state dir: `.xllm/` (default) or legacy `.grok/` when the project already uses it.

**xllm** skills call a **Node advisor script**. When you work in another project, that script is not under `./scripts/` — resolve it once, then reuse.

## Install the plugin

```bash
# Local checkout
cd /path/to/xllm
grok plugin install . --trust

# Or from GitHub
grok plugin install kimmingul/xllm --trust
```

Confirm in TUI: `/plugins` → **xllm** enabled.  
Source: https://github.com/kimmingul/xllm

## One-time path setup (per consumer project)

```bash
node /path/to/xllm/scripts/xllm.mjs remember
# or
node /path/to/xllm/scripts/xllm-advisor.js --remember
```

Writes:

```text
.grok/xllm-advisor-path          # absolute path to xllm-advisor.js
<state>/artifacts/{ask,xllm,...}/
```

### Environment variables (optional)

| Variable | Purpose |
|----------|---------|
| `XLLM_ADVISOR_PATH` | Absolute path to `xllm-advisor.js` (highest priority) |
| `XLLM_PLUGIN_ROOT` | Plugin root containing `scripts/xllm-advisor.js` |
| `GROK_PLUGIN_ROOT` | Set by Grok for plugin hooks; honored too |
| `OMG_*` | Legacy aliases from the old *oh-my-grok* name |

```powershell
$env:XLLM_PLUGIN_ROOT = "D:\repo\xllm"
# or
$env:XLLM_ADVISOR_PATH = "D:\repo\xllm\scripts\xllm-advisor.js"
```

## Resolution order

1. `XLLM_ADVISOR_PATH` (or legacy `OMG_ADVISOR_PATH`)
2. `GROK_PLUGIN_ROOT` / `XLLM_PLUGIN_ROOT` / …
3. `.grok/xllm-advisor-path` (or legacy `.grok/omg-advisor-path`)
4. `./scripts/xllm-advisor.js`
5. `~/.grok` plugin scan
6. Running script path

```bash
node scripts/xllm.mjs which
```

## Skill invocation pattern

```text
1. If .grok/xllm-advisor-path exists → use that absolute path
2. Else if $env:XLLM_ADVISOR_PATH or GROK_PLUGIN_ROOT → build path
3. Else try ./scripts/xllm-advisor.js
4. Else tell user to run /xllm-setup or node …/xllm.mjs remember
```

Artifacts land in the **current project** `<state>/artifacts/…` (cwd).

## Health

```text
/xllm-setup
```

```bash
node scripts/xllm.mjs doctor
```

## Windows

Prefer `codex`, `grok`, `claude`, `ollama`, `lmstudio`. Skip `antigravity` headless.
