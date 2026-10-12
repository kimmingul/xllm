# 모델·CLI 호환성 확인 — 2026-09-12

이 문서는 공식 문서와 로컬 CLI의 비생성 명령(`--version`, `--help`,
`models`)으로 확인한 스냅샷이다. 설치 버전은 이 머신의 관측값이며 전체
사용자의 최신 배포 버전이나 계정별 모델 사용 권한을 뜻하지 않는다.
xllm은 클라우드 모델 목록을 라우팅 테이블로 고정하지 않는다.

## 모델 지정

| 경로 | 확인한 모델·선택 방법 | 근거 |
|---|---|---|
| Codex | `gpt-6-astra`; 기존 `gpt-5.6-sol`도 명시적으로 지정 가능 | [공식 모델 문서](https://learn.chatgpt.com/docs/models) |
| Claude Code | `fable` / `claude-fable-5-1`, `opus` / `claude-opus-5`, `sonnet` / `claude-sonnet-5` | [공식 모델 설정](https://code.claude.com/docs/en/model-config) |
| Antigravity | `gemini-3.8-flash-{high,medium,low}` 추가; 3.7·3.6 Flash와 3.1 Pro도 목록에 존재 | 로컬 `agy models`, agy 1.2.1 |
| Grok Build | 기본 `grok-4.6`, `grok-4.5`도 목록에 존재 | 로컬 `grok models`, grok 1.0.29 |
| Gemini CLI | `auto` 또는 해당 계정의 `/model` 목록에서 선택 | [공식 모델 선택](https://geminicli.com/docs/cli/model/) |
| Cursor | `cursor-agent --list-models`로 해당 계정의 목록 확인 | [공식 CLI 옵션](https://cursor.com/docs/cli/reference/parameters) |
| Ollama / LM Studio / Lemonade | 실제 설치·서빙 중인 모델 ID 사용 | [로컬 모델 연동](local-llms.md) |

Claude 별칭의 대상은 접속 공급자와 설정에 따라 다르다. 특히 `fable`은
Claude Code 2.1.257 이상에서 Fable 5.1을 가리키지만 Claude apps gateway에서는
Fable 5를 가리킨다. 최신 모델 접근 권한은 CLI 설치 여부와 별개다.

모델을 생략하면 xllm은 `--model`을 보내지 않는다. 따라서 공급자 기본값을
따르되 **CLI 설정, 환경 변수, xllm의 `default_model` 고정값이 있으면 그 값이
우선**한다. 새 모델 출시가 기존 고정값을 자동 교체하지는 않는다.
정확한 모델이 필요하면 전체 ID를 지정하고, 일반적인 역할 선택은 계속
`scripts/xllm-routing.js pick`의 측정 근거를 따른다.

아래는 전송 형식을 확인하는 예시다. `--dry-run`은 LLM을 호출하지 않는다.

```bash
node scripts/xllm-advisor.js --dry-run codex:gpt-6-astra@high "연동 확인"
node scripts/xllm-advisor.js --dry-run claude:claude-fable-5-1@high "연동 확인"
node scripts/xllm-advisor.js --dry-run antigravity:gemini-3.8-flash-high@high "연동 확인"
node scripts/xllm-advisor.js --dry-run grok:grok-4.6@high "연동 확인"
```

기존 별칭 씨앗(`gpt-5.6` → `gpt-5.6-sol`, `grok-4` → `grok-4.6`)은
유지한다. 새 모델 출시만으로 수용되는 모델명을 다른 모델로 바꾸지 않는다.
과거 벤치마크와 CHANGELOG의 모델명·날짜도 당시 증거로 보존한다.

## CLI 호환성

| CLI | 로컬 확인 버전 | 반영 사항 |
|---|---|---|
| Codex | 0.154.0 | `exec --sandbox read-only`, `--model`, `-c`, `--cd` 확인 |
| Claude Code | 2.1.269 | `--model`, `--effort`, `--permission-mode` 확인; 계약 검사에 `--effort` 추가 |
| Antigravity | 모델 목록 1.2.1 / 최종 계약 검사 1.2.2 | `--effort low\|medium\|high`; xllm의 유효 제한 시간을 `--print-timeout <N>ms`로 전달 |
| Grok Build | 1.0.29 (alpha) | `-p`, `-m`, `--reasoning-effort`, `--prompt-file` 확인 |
| Gemini CLI | 미설치, 공식 문서 대조 | 쓰기 옵트인에서 폐기 예정 `--yolo`를 `--approval-mode yolo`로 교체 |
| Cursor | 미설치, 공식 문서 대조 | 기본 자문에 `--mode ask` 명시; 모델·모드 옵션도 계약 검사 |

Antigravity는 `--help`에서 자체 print 제한 시간 기본값을 5분으로 표시한다.
이제 `XLLM_ADVISOR_TIMEOUT_MS`나 호출 옵션으로 시간을 늘리면 CLI 내부 제한에도
동일하게 적용된다. `@xhigh` 이상은 기존대로 agy의 `high`에 매핑한다.

Claude의 최신 모델은 `low`, `medium`, `high`, `xhigh`, `max`를 지원하며
모델별 범위는 CLI가 결정한다. `ultracode`는 워크플로 실행 설정이므로 xllm의
공통 effort 어휘에 추가하지 않는다. Gemini CLI와 Cursor에 전용 effort 플래그를
임의로 만들지 않는다.

CLI 근거: [Codex 명령](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Gemini CLI](https://geminicli.com/docs/cli/cli-reference/),
[Cursor 옵션](https://cursor.com/docs/cli/reference/parameters),
[Antigravity CLI](https://antigravity.google/docs/cli/reference).
Antigravity의 세부 제한 시간 형식과 Grok의 옵션·모델은 위 로컬 도움말 관측을 근거로 한다.
`agent`라는 이름의 실행 파일은 다른 공급자와 충돌할 수 있어 Cursor용
`cursor-agent`를 자동으로 `agent`에 대체하지 않는다.

## 재확인

```bash
node scripts/xllm-contracts.js --json
node scripts/xllm-advisor.js --inventory --refresh
npm run ci
```

계약 검사는 토큰을 쓰지 않는다. 이제 실패한 `--version` / `--help` 명령을
성공으로 처리하지 않고, `--model-picker` 같은 다른 플래그가 `--model`을
대신 통과시키지 못한다. ANSI 색상은 제거한 뒤 검사한다.

모델 목록 조회·계약 통과는 생성 성공을 보장하지 않는다. 실제 호출 검증은
`node scripts/smoke.mjs --live --provider <provider>`로 별도로 실행한다.
설치 프로그램이나 사용자 전역 설정은 xllm 업데이트가 변경하지 않는다.

이번 확인에서 Codex·Claude·Antigravity·Grok의 설치된 CLI 계약은 모두 통과했고,
Antigravity 실제 smoke 호출도 exit 0 및 결과 아티팩트의 `XLLM_SMOKE_OK`로
확인했다. Gemini CLI와 Cursor는 미설치여서 실제 호출은 확인하지 않았다.
