# Local LLM support — grok-xllm

Local models are first-class advisors — same artifact contract as cloud CLIs.

## Providers

| Spec | How it runs | Setup |
|------|-------------|--------|
| `ollama` / `ollama:llama3.2` | `ollama run <model>` | Install Ollama; pull model |
| `lmstudio` / `lmstudio:phi3` | HTTP `POST /v1/chat/completions` | LM Studio server |
| `lemonade` | `LEMONADE_BIN` or synthetic stub | Set `LEMONADE_BIN` |

## Examples

```bash
node scripts/grok-ask-advisor.js ollama:qwen3.6:latest "Review this function"
/ccg ollama:qwen3.6:latest,codex "Analyze authentication changes"
/ralph --critic=ollama:qwen3.6:latest,grok "Build feature X"
```

## Spec (all providers)

```text
provider[:model][@effort]
```

| Example | Meaning |
|---------|---------|
| `ollama:qwen3.6:latest` | local model |
| `codex@high` | cloud default model, high reasoning effort |
| `claude:opus@medium` | model + effort |
| `antigravity:…` | preferred design advisor (over gemini) |
| `grok:…@high` | grok model + reasoning effort |

Profiles: `.grok/xllm-providers.toml` (`default_model`, `default_effort`, timeouts).

## Environment

| Variable | Meaning |
|----------|---------|
| `OLLAMA_DEFAULT_MODEL` | Default bare `ollama` model |
| `LMSTUDIO_MODEL` | Default LM Studio model id |
| `LMSTUDIO_BASE` | Default `http://localhost:1234` |
| `LEMONADE_BIN` | Real lemonade binary |
| `XLLM_ADVISOR_TIMEOUT_MS` | Per-call timeout (default 300000) |
| `XLLM_PROVIDERS_PATH` | Override path to providers TOML |

## Health

```bash
node scripts/xllm.mjs doctor
```
