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

### Model-name aliases

Vendors retire model ids faster than xllm ships. `[aliases.<provider>]` rewrites
a name before spawning, so you can follow a rename without waiting for a
release. Quote the keys — model ids contain dots.

```toml
[aliases.codex]
"gpt-5.6" = "gpt-5.6-terra"   # retarget xllm's built-in seed (sol)
"gpt-5.5" = ""                # empty value = leave this name alone
```

Your entries win over xllm's built-in seed, which exists only to rescue names
measured as retired (`gpt-5.6`, `grok-4`). Unknown names are never rewritten —
xllm keeps no model roster, so anything it has no measurement for is passed
through to the CLI untouched. If the CLI then rejects it you get an
`unknown-model` or `account-unsupported` diagnosis with the command that lists
what the CLI actually accepts.

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

### 아티팩트에 남는 모델 교정 기록

xllm이 모델 이름을 교정하면 아티팩트 헤더에 세 줄이 추가됩니다. 교정이 없으면
세 줄 모두 나오지 않습니다.

```
- Model: gpt-5.6-sol
- Requested model: gpt-5.6          # 사용자가 요청한 이름
- Transmitted model: gpt-5.6-sol    # CLI에 실제로 전달된 이름
- Model correction source: builtin  # builtin | toml — 누가 결정했는지
```

교정된 이름만 남기면 증거가 사용자가 고른 적 없는 모델에 실행을 귀속시키게
됩니다. `source`는 값이 아니라 **키의 소유자**로 판정합니다 — 사용자가 내장
씨앗과 같은 값을 `[aliases]`에 지정했더라도 결정한 것은 사용자이므로 `toml`로
기록됩니다.
