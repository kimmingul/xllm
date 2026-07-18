# Local LLM support — xllm

Local models are first-class advisors — same artifact contract as cloud CLIs.

## Providers

| Spec | How it runs | Setup |
|------|-------------|--------|
| `ollama` / `ollama:llama3.2` | HTTP `POST /api/generate` (default `http://localhost:11434`; `OLLAMA_HOST` honored). `ollama list`/`ollama stop` stay CLI. | Install Ollama; pull model |
| `lmstudio` / `lmstudio:phi3` | HTTP `POST /v1/chat/completions` | LM Studio server |
| `lemonade` | `LEMONADE_BIN` or synthetic stub | Set `LEMONADE_BIN` |

## Examples

```bash
node scripts/xllm.mjs ask ollama:qwen3.6:latest "Review this function"
node scripts/xllm.mjs review roles ollama:qwen3.6:latest,codex "Analyze authentication changes"
node scripts/xllm.mjs review debate ollama:llama3.2,ollama:gemma4 "Is this cache design safe under concurrency?"
```

Or via the host skills: `/xllm:ask`, `/xllm:review` (Claude Code / Codex) · `/ask`, `/xllm`
(Grok Build).

Identity is the **model**, not the provider: two models on the same local runtime
(`ollama:llama3.2,ollama:gemma4`) are distinct panel/debate members and refute each other.
Tiny local models are barred from voting on judgment roles (capability floor) — they still
serve fine as cheap critics and `scribe` writers.

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

Profiles: `.xllm/xllm-providers.toml`, legacy `.grok/` honored
(`default_model`, `default_effort`, timeouts).

## Environment

| Variable | Meaning |
|----------|---------|
| `OLLAMA_HOST` | Ollama server (default `http://localhost:11434`; scheme-less accepted) |
| `OLLAMA_DEFAULT_MODEL` | Default bare `ollama` model |
| `LMSTUDIO_MODEL` | Default LM Studio model id |
| `LMSTUDIO_BASE` | Default `http://localhost:1234` |
| `LEMONADE_BIN` | Real lemonade binary |
| `XLLM_ADVISOR_TIMEOUT_MS` | Per-call timeout (default 300000) |
| `XLLM_PROVIDERS_PATH` | Override path to providers TOML |

## Health

```bash
node scripts/xllm.mjs doctor                 # provider + path health
node scripts/xllm.mjs inventory --refresh    # re-probe installed CLIs + pulled ollama models
```

**Wedged ollama server** (diagnosed live): if `ollama ps` shows nothing but calls fail with a
cudaMalloc OOM, the server itself is wedged — restarting it is the fix, not switching models.
