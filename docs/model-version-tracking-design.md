# 모델 버전 추종 설계 (model version tracking)

적대 리뷰: **codex@high × grok@high, 3라운드** (2026-08-02).
마지막 라운드는 제안자가 코드를 직접 열어 검증한 사실(F1–F7)로 앵커했다.
**두 리뷰어 모두 최종 잔여 쟁점 "없음"으로 판정** — 사용자 판정 대기 항목 없음.

## 문제

LLM 모델이 1~2개월마다 교체된다. xllm을 계속 업데이트하지 않으면 모델명이 낡아
오류가 난다. 사용자는 provider 수준(`gpt`, `grok`)만 제시해도 각 CLI의 기본
모델이 자동으로 쓰이기를 원한다.

## 재구성 — 문제는 "로스터가 없다"가 아니었다

`--dry-run` 실측: 모델을 지정하지 않으면 xllm은 `--model`/`-m` 플래그를 **아예
붙이지 않는다**. 즉 "provider만 주면 CLI 기본값 사용"은 **이미 동작 중**이다.

```
codex@high → args: [exec, --sandbox, read-only, -c, model_reasoning_effort=high, -]
```

실제로 깨지는 지점은 셋이다:

1. 사용자가 **추측한 이름**(`gpt-5.6`, `grok-4`)을 줄 때 — 하드 실패
2. 모델을 생략하면 **무엇이 답했는지 기록되지 않음** → traits 귀속 불가
3. 코드에 박힌 별칭표 자체가 낡아갈 부채

## 검증된 코드 사실

| ID | 사실 | 위치 |
|----|------|------|
| F1 | `resolveCandidateKey`는 `route.model` → TOML `default_model` → `''` 순으로 키를 정하고, 모델이 없으면 **bare provider**가 키가 된다. 주석: "no sibling rollup" | `xllm-traits.js:363-368` |
| F2 | `TRAIT_WINDOW.horizon_days = 180` | `xllm-traits.js:55-56` |
| F3 | `classifyFailure` kind는 정확히 6종: `missing-binary / timeout / auth / transient / permanent / ok`. **`unknown-model`도 `account-unsupported`도 없다** — 둘 다 `permanent`로 뭉개진다 | `xllm-advisor.js:1746-1779` |
| F4 | `resolvedModel = model \|\| pconf.default_model \|\| …` — 핀이 있으면 "생략" 경로가 성립하지 않는다 | `xllm-advisor.js` resolveSpawnConfig |
| F5 | `MODEL_ALIASES`는 **이미 존재하고 동작한다** (`gpt-5.6→gpt-5.6-sol`, `grok-4→grok-4.5`) | `xllm-advisor.js` |
| F6 | `XLLM_ADVISOR_TIMEOUT_MS`가 **무효**였다 — `defaults.timeout_ms`만 설정하는데 모든 빌트인 프로바이더가 자기 `timeout_ms: 300000`을 갖고 있어 도달 불가 | 수정 완료, 별도 커밋 |
| F7 | artifact 작성기는 `substituted`만 헤더에 쓰고 **요청→전송 모델 교정을 파일에 남기지 않는다** (stderr 고지는 휘발) | `xllm-advisor.js:1334` |

CLI별 표면 (2026-08-02 실측, Windows 11):

| CLI | 기본 모델 비대화형 조회 | 실행 후 실제 모델 보고 |
|---|---|---|
| codex 0.146.0 | `codex doctor` → `model gpt-5.5 · openai` | exec 헤더 `model: gpt-5.5` |
| grok 0.2.118 | `grok models` → `Default model: grok-4.5` | JSON에 model 필드 **없음** |
| agy 1.1.9 | `agy models` 목록만, **default 표시 없음** | JSON에 model 필드 **없음** |
| claude 2.1.220 | 벤더 별칭(`opus`/`sonnet`)이 항상 최신 지시 | 미검증 |
| ollama | `ollama list` | API가 model 에코 |

`codex models`는 TTY 필요 — 스크립트 불가(`Error: stdin is not a terminal`).

## 검토한 3안과 기각 사유

**A안 — 무모델 기본 + 사후 모델 회수.** 유지보수 0이지만 F1 때문에 치명적:
모델을 생략하면 traits 키가 bare provider가 되어 기존 `codex:gpt-5.5` 증거와
**exact-key 미스**가 난다. 즉 A를 권장 경로로 만들면 그 경로에서만 bench 점프와
veto가 영구 비활성된다. "재현성 약화"가 아니라 **lookup 키 분열**이다.

**B안 — 런타임 탐색 + 캐시 + 퍼지 매칭.** 목록 조회는 **계정별 가용성을 알려주지
못한다**. `gpt-5.6`은 이름이 존재하는데도 이 계정에서 400으로 거부된다
(`not supported when using Codex with a ChatGPT account`). 목록은 sol/terra/luna
중 무엇이 이 계정에서 되는지 모른다 — **정보 이론적으로 무력**. 퍼지 매칭 기각.

**C안 — 별칭 제거 + 실패 시 실시간 힌트.** 힌트는 **배치/CI에서 무력**하다.
이미 job이 깨진 뒤다. 단독으로는 부족.

## 최종 합의 계약

### 1. 귀속 (attribution)

- **구체 모델만** model-level traits에 반영한다.
- 미귀속 실행은 traits **라우팅 입력에서 완전 제외**한다. `"(vendor default)"`를
  원장/traits 키로 **쓰지 않는다** — 시간가변 포인터가 되어 서로 다른 시기의 다른
  모델이 한 키에 뭉치고, 표본 수 노출 원칙이 깨진다(`n=80`이 실은
  `grok-4.5 n=60 + grok-5 n=20`).
- traits에 **별도 진단용 버킷을 만들지 않는다.** 라우팅이 안 쓸 데이터를 원장
  등급으로 승격하면 스키마·게이트·문서만 3배가 된다. 관측은 artifact
  (`attribution: unresolved` + 기존 `Created at`/`Advisor version`)와 contracts
  health로 충분하다.
- **F1의 함의**: 핀이 있으면 핀 모델이 키다. 따라서 `attribution: unresolved`는
  `route.model`도 `default_model`도 **둘 다 없을 때만** 성립한다. 그리고 벤더
  default 변경은 bare 버킷이 아니라 **핀 키 이전**(옛 키 n 동결 → 새 키
  콜드스타트)으로 이미 관측된다.

### 2. 실패 분류 (F3 보완)

- `classifyFailure`에 `unknown-model`과 `account-unsupported`를 **분리 신설**한다.
  계정 거부는 모델 품질 실패가 아니라 **권한 실패**다.
- 계정 거부는 traits에 **절대** 반영하지 않는다.

### 3. capability 캐시

- 머신 단위 캐시. 키 `{provider, model, cli_version}` → `{status, first_seen,
  last_seen, n}`. **원장/traits 집계 키에 넣지 않는다** — spawn precheck와 힌트 전용.
- 기록은 **실제 spawn 실패 시에만**. 성공하면 같은 키를 `ok`로 덮어쓴다.
- 무효화: CLI 버전 변경 / 성공 실행 / 명시 갱신(`doctor --refresh-capabilities`) /
  계정 변경 / 짧은 TTL(7일 전후). **무한 블랙리스트 금지.**
- **자동 순회 스폰 금지** — sol/terra/luna를 자동으로 돌려보지 않는다(비용·오염).
  힌트로만 제시한다.

### 4. TOML `default_model` 핀 (F4)

- 핀은 **권위 있다**. 무시하지 않는다.
- **자동 갱신 기각** — 침묵 치환은 증거 귀속을 왜곡하고 비용·성능·데이터가 달라진다.
- 낡은 핀이 `unknown-model`/`account-unsupported`로 실패하면 **경고와 힌트**를 낸다.
  배치/CI에서는 fail-fast + "pinned default_model is invalid for this account/CLI".
- 갱신은 명시적 opt-in만: `--adopt-default` / `doctor --repair-default`.

### 5. 증거 필드 (F7)

artifact에 요청→전송 모델 교정을 기록한다. 합의 필드명(codex 제안):
`requested_model`, `transmitted_model`, `model_correction_source`
(예: `model_correction_source: alias`).

### 6. 기각 목록 (명시)

per-run inventory 강제 호출 · 느슨한 퍼지 매칭(B 전체) · `provider-default-unknown`
traits 버킷 · TOML 핀 자동 갱신 · 자동 순회 스폰 · `(vendor default)`를 라우팅 키로 사용.

inventory/snapshot은 **doctor·contracts·opt-in refresh에만** 허용.

## 출하 순서

| 순위 | 단위 | 근거 |
|------|------|------|
| **1** | `classifyFailure`에 `unknown-model` / `account-unsupported` 분리 + 낡은 핀 힌트 | F3: 지금 둘 다 `permanent`로 뭉개진다. "계정 거부는 traits 금지"를 구현하려면 분류가 선행. 사용자가 겪는 진단 구멍이 가장 크다 |
| **2** | `MODEL_ALIASES` → TOML `[aliases]` 승격 + 실패 시 힌트 | F5: 이미 하드코드로 동작 중이므로 정돈 단계 |
| **3** | artifact 증거 필드(F7) / capability 캐시 | 1·2의 실패 로그 빈도를 본 뒤 판단 |

**둘을 합치지 않는다** — 별칭표와 실패 taxonomy는 표면이 독립이고, 합치면 최소
출하 단위가 아니게 된다.

**비대칭이 우선순위를 정했다**: 별칭은 이미 있고(F5), 분류는 없다(F3).
"별칭 먼저"는 현재 코드 상태에서 기각됐다.

## 잔여 쟁점

**없음.** 두 리뷰어 모두 "잔여 쟁점 없음"으로 판정했다. 구현 디테일(stderr 정규식,
TOML merge vs replace, artifact 헤더 노출 형식)은 설계 분기점이 아니라 구현 선택이다.

## 리뷰 과정에서 발견된 부수 버그

- **F6** — `XLLM_ADVISOR_TIMEOUT_MS` 무효. 이 리뷰를 돌리다 codex@high가 300초에
  잘려 발견됐다. 이번 설계와 **직교**하므로 분리해 즉시 수정했다(회귀 테스트 포함).
- **codex 탐색 행 (transport 관찰)** — 라운드 3 프롬프트에 `xllm-traits.js:363-368`
  같은 파일:줄 앵커와 코드 블록을 넣자 codex가 리포지토리 루트에서 read-only
  샌드박스로 장시간 탐색에 들어가 900초를 모두 소진했다(정확히 900028ms).
  탐색 금지를 명시하고 앵커를 산문으로 바꾼 압축 프롬프트로는 **12.5초**에 완료.
  → 관례의 "마지막 라운드는 검증된 코드 사실로 앵커"를 codex에 적용할 때는
  **파일:줄 표기 대신 산문 인용**을 쓸 것.
