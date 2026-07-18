<div align="center">

# xllm

### 하나의 세션에서 모든 모델을. 크로스-벤더 LLM 다양성.

에이전틱 코딩 도구(Claude Code · Codex · Grok Build)는 제조사 단일 LLM에 락인됩니다.
**xllm**은 다른 벤더와 로컬 모델을 그 세션 안으로 불러옵니다 — 기본은 read-only.

**[🌐 소개 페이지](https://kimmingul.github.io/xllm/)** · **v0.24.4** · MIT

`codex` · `claude` · `gemini` · `grok` · `antigravity` · `cursor` · `ollama` · `lmstudio` · `lemonade`

</div>

---

## 왜 xllm인가

인간이 유전적·사회적 다양성으로 발전하듯, AI도 다양한 모델을 섞으면 더 견고한 지식 전략을
가질 수 있습니다 — **단, 그 오류들이 실제로 서로 다를 때만.** xllm은 그 다양성(다양한
provider · model · effort)을 제공하고, 그것이 실제로 도움이 되는지를 **측정하는 계측기**까지
함께 제공합니다.

호스트 CLI는 이미 서브에이전트·plan mode·스킬·훅을 갖고 있습니다. xllm은 **호스트가 구조적으로
할 수 없는 것만** 더합니다: 다른 벤더의 독립적 의견, 무료 로컬 모델, 그리고 다양성 배당의 측정.

---

## 에스컬레이션 사다리: ask → propose → exec

단이 올라갈수록 어드바이저의 자유는 커지지만, **당신의 체크아웃에 대한 권한은 모든 단에서
0**입니다 — 늘어나는 것은 격리 공간 안의 자유뿐입니다.

| 단 | 명령 | 하는 일 |
|----|------|---------|
| **01 · 의견** | `ask` | 다른 벤더(또는 무료 로컬 모델)의 진짜 답을 아티팩트로 받습니다. read-only. |
| **02 · 정적 diff** | `propose` | 어드바이저가 unified diff를 `.patch`로 반환. 아무것도 적용 안 됨 — `git apply --check` 후 직접 병합. |
| **03 · 검증된 브랜치** | `exec` | 어드바이저가 임시 클론에서 편집→빌드→테스트를 반복하고 검증된 브랜치를 반환. 당신 트리는 불가침. |

```bash
node scripts/xllm.mjs ask codex@high "이 설계를 리뷰해줘"
node scripts/xllm.mjs propose codex@high "login()에 입력 검증 추가"
node scripts/xllm.mjs exec codex@high "X를 구현해줘" --test-cmd "npm test"
```

**exec 불변식** — 체크아웃·브랜치·index·config는 절대 불가침(`.git` 분리 클론, fetch 전용
`refs/xllm/exec/<id>` 반환, 변조 트립와이어) · 병합/push/자격증명은 호스트 측 · 샌드박스 가능한
프로바이더만(codex/claude) · OS 샌드박스 고장 시 fail-closed · executor의 green은 증거이지 신뢰가
아님(병합 후 재검증).

---

## 핵심 기능

| 기능 | 설명 |
|------|------|
| **블라인드 패널 (`review blind`)** | 동일 프롬프트를 N개 모델에 블라인드로 보내 **다양성을 측정**. 구조화 판정이 산문보다 먼저 append-only 원장에 기록되고, 누적 쌍별 일치 행렬을 제공. |
| **측정 타이브레이커** | 패널이 **split**이면 원장의 실측 일치율이 가장 낮은 **미참여** 프로바이더를 자동 선정(혈통 아님) — 제안은 항상 무료 기록, 실제 추가 호출은 `--tiebreak` 옵트인. 타이브레이크의 쌍별 행이 다시 원장에 쌓여 **다음 선정의 근거**가 됨(측정→라우팅 루프 폐쇄). |
| **특성 프로파일 (`traits`)** | 원장·벤치마크·계약 캐시에서 **실측 특성만** 파생(손으로 쓴 모델 인상론 금지, 표본 수 상시 노출). 판단 역할 라우팅은 시딩 결함 검출률의 **Wilson 95% 하한**을 공유 결함셋 게이트(과제≥4·기회≥12·+0.10) 하에 소비 — 측정이 tier/비용 경계를 넘을 수 있음. 증거 없으면 기존 라우팅과 비트 동일. `--no-traits`로 비활성. |
| **적대적 검토 (`review debate`)** | 모델들이 서로 **반박**해 틀린 주장을 죽이고 **품질로 수렴**. 정체성은 provider가 아닌 **모델 단위** — 같은 로컬 런타임의 다른 모델(예: ollama의 llama↔gemma)도 서로 공격. decisive falsifier만 KILL, 단순 이견은 UNRESOLVED. judge LLM 없는 기계적 판정. 이 기능 자체가 xllm 적대 방식으로 설계됨. |
| **2단계 파이프라인 (`review council`)** | `review blind`(독립 발산) → `review debate`(적대 수렴)을 한 명령으로. 독립적으로 도출된 주장을 반박 검증 → survived/killed/unresolved. 최고 중요도 결정용. |
| **합의 깊이 종합** | 주장별로 만장일치/다수결/의견분열/단일출처 라벨. 실패 어드바이저는 기권. 합의는 신뢰도 메타데이터이지 진리가 아님. |
| **비용 인지 라우팅** | 가벼운 일은 무료 로컬·low effort, 무거운 판단은 strong tier. 초소형 로컬 모델은 판단 역할 투표권 거부(능력 하한). |
| **scribe** | 커밋 메시지·PR 본문·릴리스 노트를 가장 싼 healthy 모델이 작성, 결정적 검증. 기계적 작업에 SOTA 요금을 쓰지 않음. |
| **구조화 출력 견고성** | `review`(roles/blind/debate/council) 계열의 JSON 계약 파싱을 견고한 단일 추출기로 통합(맨 JSON·트레일링 콤마·줄바꿈 래핑 처리) + 비준수 시 1회 교정 재시도. 프로바이더별 **계약 준수도**(first/retry/failed) 리포트로 약한·로컬 모델도 안정 참여. |
| **계약 플로어** | 설치된 CLI의 플래그를 프로브해 버전 드리프트 감지, 실패 분류, transient만 재시도. |
| **read-only 안전 모델** | 샌드박스 탈출·승인 우회 없음. 동일 벤더 중첩 거부. 세션 env 스트리핑. 아티팩트 시크릿 마스킹. |

---

## scribe — 커밋 메시지에 SOTA 요금 쓰지 않기

기계적 git 산문을 메인 세션의 비싼 모델 대신 가장 싼 healthy 모델(무료 로컬 우선)에게 맡깁니다.
결정적 수집기가 diff/log를 모으고, 모델은 **산문만** 작성하며, git 실행은 항상 사용자가 합니다.
push/tag는 모델 호출 자체가 없습니다.

```bash
MSG=$(node scripts/xllm.mjs scribe commit) && git commit -m "$MSG"
node scripts/xllm.mjs scribe pr --base main
node scripts/xllm.mjs scribe release --from v0.10.0
```

---

## 설치

한 저장소, 세 호스트. Node ≥ 18. 사용할 어드바이저 CLI만 설치하면 됩니다.

**Claude Code**
```text
/plugin marketplace add kimmingul/xllm
/plugin install xllm@xllm
```

**Codex**
```bash
codex plugin marketplace add https://github.com/kimmingul/xllm.git
codex plugin add xllm@xllm
```

**Grok Build**
```bash
grok plugin install kimmingul/xllm --trust
```

### 설치 후 — 호스트 안에서 부르는 법

Claude Code와 Codex는 동일한 호스트 중립 스킬 5종을 `./skills/`에서 공유합니다. Claude Code에서는
`/xllm:<스킬>` 슬래시 커맨드 또는 자연어("codex한테 이 설계 물어봐줘")로 트리거되며, 각 스킬은
아래 명령 레퍼런스의 스크립트를 실행합니다.

| 스킬 | 하는 일 | 실행하는 스크립트 |
|------|---------|-------------------|
| `/xllm:ask` | 외부 어드바이저 1명의 의견 (read-only) | `scripts/xllm-advisor.js` |
| `/xllm:review` | roles(커버리지)·blind(측정 패널)·debate(적대)·council(blind→debate) 4모드 심의 | `scripts/xllm-review.js` |
| `/xllm:exec` | 격리 클론에서 구현 위임 → 검증된 브랜치 | `scripts/xllm-exec.js` |
| `/xllm:scribe` | 커밋/PR/릴리스 산문을 최저가 모델로 | `scripts/xllm-scribe.js` |
| `/xllm:setup` | 머신 인벤토리 + 역할 핀 위저드 + 규율 블록 옵트인 | `scripts/xllm-advisor.js --inventory/--remember/--set-role/--discipline` |
| `setup [pack]` | 인벤토리→역할 핀을 결정적으로 해석(포스처 팩); `--apply` 전엔 미리보기 | `scripts/xllm-advisor.js --setup` |

Grok Build 어댑터는 별도 3종입니다: `/ask` · `/xllm` · `/xllm-setup` (`.grok/skills/`).

팀·루프·플래닝·검증은 **의도적으로 포팅하지 않았습니다** — 호스트 네이티브 기능이 이미
담당합니다.

### 설치는 한 번(전역), setup은 프로젝트마다 한 번

플러그인 설치는 호스트에 **한 번**이면 됩니다. 하지만 xllm의 상태·설정은 **프로젝트별**이므로,
새 프로젝트에서 처음 쓸 때 **`/xllm:setup`(Grok Build는 `/xllm-setup`)을 한 번** 실행하는 것을
권장합니다. 왜 프로젝트마다인가 — 프로젝트마다 알맞은 어드바이저가 다르기 때문입니다(보안 민감
코드는 strong tier 고정, 문서 프로젝트는 무료 로컬 모델 고정). setup은 저장소 내용을 어드바이저에
보내지 않고 **로컬에서만** 분석하며, 결과 설정만 프로젝트의 `.xllm/`에 씁니다.

setup이 하는 일(그리고 남기는 프로젝트-로컬 상태):

| 단계 | 하는 일 | 산출물 (프로젝트 로컬) |
|------|---------|------------------------|
| **1. 머신 인벤토리** | 설치된 어드바이저 CLI·로컬 모델·tier·비용을 프로브(24h 캐시) | `~/.xllm` 캐시(머신 단위) |
| **2. 마커 + 아티팩트** | 호스트가 이 프로젝트에서 advisor 스크립트를 해석하도록 경로 마커 생성 + 시크릿 마스킹 아티팩트 디렉토리 | `.xllm/xllm-advisor-path` · `.xllm/artifacts/{ask,xllm,proposals,exec}/`(자기 무시 `.gitignore`) |
| **3. 역할 핀 위저드** | 역할별(analysis·security·design·critic…) `provider:model@effort`를 프로젝트에 고정 — 내장 라우팅을 정확히 오버라이드 | `.xllm/xllm-providers.toml` |
| **4. 규율 블록(옵트인)** | superpowers류 프로세스 규율 ≤25줄을 CLAUDE.md/AGENTS.md에 설치(전문 미리보기 후 동의; 멱등 마커 블록; `--discipline remove`로 제거) | `CLAUDE.md`/`AGENTS.md`의 `<!-- xllm:discipline -->` 블록 |

setup을 건너뛰어도 내장 라우팅으로 동작하지만, **마커가 없으면** 스킬이 경로 해석 휴리스틱에
의존하고 **역할 핀이 없으면** 프로젝트 맞춤 어드바이저 선택을 못 합니다. 그래서 프로젝트마다 한 번
실행이 권장 기본값입니다. CLI로 직접 하려면:

```bash
node scripts/xllm.mjs doctor       # 프로바이더 + 경로 건강 진단
node scripts/xllm.mjs remember     # 마커 + 아티팩트 디렉토리 생성
```

`.xllm/` 런타임 상태(마커·프로파일·아티팩트·원장)는 기본적으로 gitignore되는 운영 산출물입니다.

---

## 안전 모델

경계는 프롬프트가 아니라 **실행 플래그와 샌드박스로** 강제됩니다.

- **어드바이저는 기본 read-only** — codex `--sandbox read-only`; `--yolo`/`--dangerously-*`/`--always-approve` 미사용. 변경은 `--allow-write`로 명시적 옵트인.
- **당신의 체크아웃은 불가침** — `exec`는 `.git` 분리 클론에서만 작업, fetch 전용 반환.
- **동일 벤더 중첩 거부** — Claude Code 안 claude, Codex 안 codex 어드바이저 거부(`--allow-self`로 해제).
- **시크릿은 디스크에 남지 않음** — 알려진 키/토큰 포맷 마스킹, scribe는 diff 미저장.
- **병합·push·자격증명은 호스트 측** — xllm은 git push/tag 생성/자격증명 전달을 하지 않음.
- **정직한 실패** — 사용 불가 프로바이더는 합성 출력 대신 명확한 실패.

---

## 명령 레퍼런스

모든 명령의 진입점은 하나입니다:

```bash
node scripts/xllm.mjs <command> …          # 저장소에서
node <plugin-root>/scripts/xllm.mjs …      # 플러그인 설치본에서
```

**공통 규약**

- **스펙 문법** — `provider[:model][@effort]`. 예: `codex@high`, `claude:opus@medium`,
  `grok:grok-4@high`, `ollama:qwen3.6:latest`. 프로젝트 프로파일: `.xllm/xllm-providers.toml`.
- **출력 규약** — 실행 결과의 **마지막 stdout 줄이 아티팩트/인덱스 경로**입니다
  (`.xllm/artifacts/…`). `review`의 blind/debate/council(roles 제외) 구조화 판정은 산문보다 먼저
  `.xllm/panel-ledger.jsonl`(append-only)에 기록됩니다.
- **안전 플래그** (ask/review roles) — `--allow-write`(어드바이저 파일 쓰기 옵트인) ·
  `--allow-self`(동일 벤더 중첩 해제) · `--no-artifacts`(아티팩트 미저장).
  셋 모두 사용자의 명시적 요청 없이는 쓰지 않는 것이 규약입니다.
- **긴 프롬프트** — Windows argv ~32KB 한계가 있습니다. `--prompt-file <경로>`를 쓰세요
  (review 계열은 24KB 초과 시 자동으로 파일 경유).
- **diff 입력** — 어느 심의 모드에서든 `--staged | --base <ref> | --diff-file <path>` 중 하나로
  diff를 넣을 수 있습니다. git으로 결정적으로 수집되어 크기 상한 후 어드바이저에 전달되며,
  **절대 저장되지 않습니다**(원장/인덱스는 source/stat/bytes/truncated 메타데이터만 남김).

### 의견 — `ask`

```text
ask   <spec> "<prompt>"  [--propose] [--prompt-file <path>] [--allow-write] [--allow-self] [--no-artifacts]
```

```bash
node scripts/xllm.mjs ask codex@high "이 마이그레이션 설계의 위험을 짚어줘"
```

- `ask`는 어드바이저 1명의 진짜 답을 `.xllm/artifacts/ask/…` 아티팩트로 남깁니다(프롬프트+출력,
  시크릿 마스킹). 어드바이저는 이 대화를 볼 수 없으므로 필요한 컨텍스트만 프롬프트에 담으세요.
- `--propose`를 붙이면 의견 대신 **unified diff**를 받습니다 — `artifacts/proposals/`에 `.patch`
  사이드카로 저장되고, 아무것도 적용되지 않습니다.
- 병렬 다중 어드바이저 + 합의 깊이 종합은 이제 `review roles` — 아래 참고.

### 심의 — `review` (`roles`·`blind`·`debate`·`council`)

```text
review roles   p1,p2[,p3] "<prompt>"   [--propose] [--prompt-file <path>] [--allow-write] [--allow-self] [--no-artifacts]
review blind   p1,p2[,p3] "<질문>"      [--tiebreak] [--ready=a,b,c]
review debate  p1,p2[,p3] "<질문/주장>"
review council p1,p2[,p3] "<질문>"      [--tiebreak] [--ready=a,b,c]
review stats [--json]                  쌍별 일치 행렬 (실측 탈상관 + tiebreak 행 합산)
review outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no

diff 입력(위 모든 모드): --staged | --base <ref> | --diff-file <path>
```

```bash
node scripts/xllm.mjs review roles ollama:qwen3.6:latest,codex "advisor 스크립트 보안 리뷰"
node scripts/xllm.mjs review blind codex,grok,gemini "이 캐시 설계가 동시성에 안전한가?" --tiebreak
node scripts/xllm.mjs review debate ollama:llama3.2,ollama:gemma4 "이 인증 흐름은 토큰 재사용에 취약하다" --staged
node scripts/xllm.mjs review council codex,grok,gemini "결제 웹훅을 재설계해야 하는가?" --tiebreak
```

> 구 명칭 `multi`/`panel`/`debate`/`council`은 CLI alias로 **v0.27.x까지** 그대로 동작합니다
> (v0.28.0에서 제거 예정) — 새 스크립트/문서는 `review <mode>`로 쓰세요.

- **roles** — 커버리지 모드(구 `multi`): 프로바이더별 자식 프로세스로 병렬 실행 후, 어드바이저별
  아티팩트 목록을 담은 인덱스(`.md`)와 기계 판독용 `.json` 사이드카를 생성합니다. 종합은 합의 깊이
  라벨(만장일치/다수결/split/단일출처)로 하며, 실패한 어드바이저는 지지가 아닌 **기권**으로 칩니다.
  **측정이 아니라 커버리지입니다** — 인덱스 JSON에 `measurement: false`가 명시되고, "측정됨"이나
  "consensus-measured" 같은 표현은 쓰지 않습니다. 측정된 일치율이 필요하면 `blind`를 쓰세요.
- **blind** — 모든 패널리스트가 **동일 프롬프트를 블라인드로** 받고 구조화 판정
  (approve/reject/mixed + 핵심 주장)을 반환합니다. 원장이 산문보다 먼저 기록되며, 요약은 원장과
  모순될 수 없습니다. split이면 코어가 **원장의 실측 일치율이 가장 낮은 미참여 프로바이더**를
  무료로 선정·기록하고, `--tiebreak`을 줬을 때만 실제 추가 호출을 지불합니다(벤더를 손으로 고르지
  않는 것이 규약; `--ready=`는 가용 프로바이더 제약일 뿐). 실행 후 `review outcome`으로 무엇을
  채택했는지 기록하면 측정→라우팅 루프가 이어집니다.
- **debate** — R0 블라인드 주장 → R1 상호 반박(구체적 메커니즘+falsifier, decisive/soft 태그) →
  R2 저자 방어 → **기계적 판정**(judge LLM 없음, 순서 불변). 저자가 못 막은 decisive falsifier만
  주장을 KILL하고, 단순 이견은 UNRESOLVED입니다. 정체성은 모델 단위 — 같은 ollama 위의
  llama↔gemma도 서로 공격합니다.
- **council** — blind(독립 발산) → debate(적대 수렴)을 한 명령으로. 1단계가 split이면 타이브레이커
  주장이 2단계에 **저자로만** 참여합니다(원 멤버 주장을 밀어내지 않음, 토론자 아님).
- **비용 감각** — `ask`/`review roles` < `review blind` < `review debate`(~2–3×) <
  `review council`(~3–4×). SURVIVED는 "적대적 검증을 통과했다"는 프로토콜 결과이지 증명이 아니며,
  중요한 것은 직접 재검증하세요.

### 변경 위임 — `propose` · `exec`

```text
propose <spec> "<변경 요청>"
exec <spec> "<과제>" --test-cmd "npm test"  [--sandbox-mode bypass]
exec list | exec cleanup <id>|--all
```

```bash
node scripts/xllm.mjs propose codex@high "login()에 입력 검증 추가"
node scripts/xllm.mjs exec codex@high "slugify 유닛 테스트 추가" --test-cmd "npm test"
```

- `propose`는 read-only 그대로입니다 — 산출물은 `.patch`뿐이고 적용은 항상 사용자 몫
  (`git apply --check` → 리뷰 → 병합).
- `exec`는 **임시 로컬 클론**에서 편집→빌드→테스트를 돌리고 `refs/xllm/exec/<id>`(fetch 전용) +
  `.patch` + 테스트 증거 아티팩트를 돌려줍니다. `--test-cmd`가 없으면 증거는 executor의 주장뿐이니
  가능하면 항상 지정하세요. 샌드박스 가능한 프로바이더만 허용(codex; 호스트가 아닐 때 claude) —
  gemini/grok/cursor(비샌드박스), ollama(순수 텍스트)는 거부됩니다. OS 샌드박스가 없으면
  **fail-closed**; `--sandbox-mode bypass`는 클론 격리만 남는다는 것을 이해하고 명시적으로만.
- **핸드백 절차** — 증거 아티팩트의 `Status`(green/not-green/no-change/timeout) 확인 →
  `git diff <base>..refs/xllm/exec/<id>` 리뷰 → `git merge --no-ff` → **병합 후 직접 재검증**
  (executor-green은 증거이지 신뢰가 아님) → `exec cleanup <id>`.

### 저비용 산문 — `scribe`

```text
scribe commit                     staged diff → 커밋 메시지
scribe pr --base <branch>         커밋+디프스탯 → PR 제목/본문
scribe release --from <tag>       로그 범위 → 릴리스 노트
scribe notes --from <tag>         로그 범위 → CHANGELOG 항목
                                  (모두 --provider <spec>로 라우팅 오버라이드 가능)
```

- 메시지는 **stdout**, 진단은 stderr — `MSG=$(… scribe commit) && git commit -m "$MSG"` 패턴이
  기본입니다. git/gh 실행은 항상 사용자가 합니다.
- 출력은 결정적으로 검증됩니다(Conventional Commits, 제목 ≤72자, 펜스 금지 등) + 1회 교정 재시도.
  **exit 3**은 검증 실패 — 원문을 그대로 쓰지 말고 검토하라는 신호입니다.
- diff는 라우팅된 어드바이저에게만 가고 **절대 디스크에 저장되지 않습니다**. 민감한 저장소는
  scribe를 로컬 모델에 핀하세요: `profile set-role scribe ollama:qwen3.6:latest@low`.

### 계측·진단 — `traits` · `contracts` · `inventory` · `doctor` · `smoke` · `dry-run`

```text
traits [--json]          실측 특성 프로파일 (원장·벤치·계약 파생, 표본 수 상시 노출)
contracts [--live]       CLI 계약 프로브: 플래그 드리프트, 실패 분류; --live는 클라우드별 소형 호출 1회
inventory [--refresh]    머신 역량 캐시 (설치된 CLI, pull된 ollama 모델; 24h TTL)
doctor                   프로바이더 + 경로 건강 진단 (사람용)
smoke [--live]           드라이 스모크 / READY 프로바이더 라이브 확인
dry-run <spec> "<p>"     실제 호출 없이 조립될 커맨드라인 확인
```

- `traits`는 손으로 쓴 모델 인상론을 배제하고 실측만 파생합니다. 판단 역할 라우팅은 시딩 결함
  검출률의 Wilson 95% 하한을 게이트(과제≥4 · 기회≥12 · 마진 +0.10) 하에 소비합니다 — 3막의
  `grok LCB 0.7733 vs codex 0.5004`가 정확히 이 경로입니다.

### 라우팅 — `pick` · `infer` · `roles` · `profile`

```text
pick <role> <task>       역할×과제 → 모델/강도 자동 선정 (+실측 특성; --no-traits로 레거시와 비트 동일)
infer <task>             과제 강도 추정 low|medium|high
roles                    라우팅 역할 목록
profile show             해석된 프로젝트 프로파일 + 상태 디렉토리
profile set-role <role> <spec>      이 프로젝트에서 역할 핀 (라우팅을 정확히 오버라이드, 강도 범핑 없음)
profile set-default <key> <value>   프로파일 [defaults] 키 설정
```

```bash
node scripts/xllm.mjs pick security "auth token refresh"
node scripts/xllm.mjs profile set-role critic ollama:qwen3.6:latest@low
```

### 유지관리 — `which` · `remember` · `list-providers` · `clean`

```text
which                    해석된 advisor 스크립트 경로 출력
remember                 .xllm/xllm-advisor-path 마커 + 아티팩트 디렉토리(자기 무시 .gitignore) 생성
list | list-providers    프로바이더 목록 JSON
clean [--older-than=DAYS]   보존된 어드바이저 아티팩트 삭제
discipline show|install|remove [--target <path>]
                         프로세스 규율 블록(≤25줄)을 CLAUDE.md/AGENTS.md에 설치/제거 —
                         마커 블록으로 멱등, setup 위저드에서 전문 미리보기 후 옵트인
```

---

## 개발

```bash
npm test          # 단위 테스트 163개 (라이브 LLM 불필요)
npm run check     # 문법 + 3개 호스트 매니페스트/스킬 검증
npm run ci        # check + test + smoke + bench selftest
npm run bench:live   # 시딩 결함 다양성 벤치마크 (라이브 프로바이더 필요)
```

**레이아웃**

```text
.claude-plugin/ .codex-plugin/ .agents/   3개 호스트 매니페스트
skills/                                    Claude Code + Codex 공유 스킬 5종
scripts/  xllm-advisor.js  xllm-exec.js  xllm-scribe.js  xllm-review.js  xllm-diff.js
          xllm-panel.js  xllm-debate.js  xllm-council.js  xllm-contracts.js  xllm-bench.js
          xllm-structured.js  xllm-routing.js  xllm-traits.js  xllm.mjs
benchmarks/  tasks/  FINDINGS.md            시딩 결함 벤치마크
docs/  index.html SCOPE.md *-design.md …   소개 페이지 + 스코프/설계/로드맵 문서
.grok/  skills/                             Grok Build 어댑터 (ask/xllm/xllm-setup)
```

---

## 범위 (Scope)

**포함**: 크로스-벤더 어드바이저, 로컬 LLM, diff 제안, 단일 태스크 격리 실행, 저비용 산문 레인,
비용 라우팅, 다양성 계측(패널·원장·벤치마크), 경계가 명확한 심의(적대적 debate, 2단계 council).

**불포함(의도적)**: 에이전트 OS 이식, HUD/훅 엔진, 대형 스킬 카탈로그, xllm 자체 **무한 루프·자율 팀·
오케스트레이션 상태기계**(autopilot류), 자동 병합, push/배포, 자격증명 처리, 다수결 자동 적용
("투표=진리" 엔진) — 실행 오케스트레이션과 다중 태스크 조합은 호스트 네이티브의 몫입니다.
(debate/council은 한 질문에 대한 **유한한** 심의 파이프라인이지 실행 루프가 아닙니다.)

---

## 벤치마크 — "우리는 측정했습니다"

xllm은 **자기 핵심 주장을 반증할 수 있는** 시딩 결함 벤치마크를 내장합니다. 알려진 결함을 심은
코드 리뷰 과제에서 검출률·**쌍별 오류 상관**·심의 결과를 측정합니다. 실측은 시간순으로 누적됐고,
"탈상관이 측정된 곳에만 다양성을 쓰고, 그것이 실제로 도움이 되는지도 잰다"는 제품 동작으로
귀결됩니다. **긍정적 결과를 보장하는 도구가 아니라, 도움이 될 때를 감지하는 계측기입니다.**

### 1막 — 쉬운 결함: 다양성은 연극이었다 (2026-07-11 · codex vs grok)

4개 시딩 과제, 잘 알려진 결함 11개(SQLi · XSS · 평문 비밀번호 · TOCTOU 등), 결정적 regex 채점.

| 리뷰어 | 검출 | 놓침 |
|--------|------|------|
| codex (단독) | 10 / 11 | `no-fail-return` |
| grok (단독) | 10 / 11 | `no-fail-return` |
| 패널 (합집합) | 10 / 11 | `no-fail-return` |

**쌍별 오류 상관 = 1.0, 추가 검출 = 0.** 서로 다른 벤더(OpenAI codex, xAI grok)인데도 잘 알려진
결함 클래스에서는 오류가 완벽히 상관되어, 크로스-벤더 다양성이 여기서는 연극이었습니다 —
앙상블 이론이 "오류가 탈상관일 때만 다양성이 배당을 낸다"고 예측한 그대로입니다.

### 2막 — 어려운 결함: 탈상관이 출현하고, 배당이 실재한다 (2026-07-11 · 5모델)

hard 세트(6과제 h1–h6, 미묘한 결함 21개)에서 5개 모델(`claude:opus`, `codex:gpt-5.5`,
`grok:grok-4.5`, `ollama:glm-5.2:cloud`, `ollama:gemma4:cloud`)을 캘리브레이션한 뒤,
패널(claude / grok / gemma4)을 실측했습니다.

| | 검출 |
|--|--|
| claude:opus 단독 | 19 / 21 |
| grok-4.5 단독 | 19 / 21 |
| gemma4 단독 | 12 / 21 |
| **최고 단일 모델** | **19 / 21** |
| **패널 합집합** | **20 / 21** |
| **다양성 배당** | **+1** |

claude와 grok은 각각 2개를 놓치지만 **서로 다른** 결함을 놓칩니다(claude는 h4에서, grok은
h3에서 — 상대가 잡아줌). 패널이 최고 단일 모델이 놓친 결함 1개를 회수했고, 이 배당은 순수하게
탈상관된 오류가 만든 것입니다. 나머지 1개(h6의 once-emitter 이중 호출/누수 클래스)는 두 강한
모델이 함께 놓친 **공유 맹점** — 패널도 못 잡으며, 바로 이 지점이 4번째의 더 탈상관된 모델로
에스컬레이션할 자리입니다.

| 쌍 | 일치율 | 공유 맹점 |
|----|--------|-----------|
| claude ↔ grok | 0.905 | 1 |
| claude ↔ gemma4 | 0.667 | 2 |
| grok ↔ gemma4 | 0.667 | 2 |
| **평균** | **0.746** | — |

평균 쌍별 일치율이 easy 세트 **1.0 → hard 세트 0.746**으로 떨어지며 배당의 전제 조건(오류
탈상관)이 실제로 실현됐고, 그와 함께 배당(+1/21)이 나타났습니다. **오류 상관은 문제 난이도의
함수입니다** — 교과서 결함에선 1.0, 미묘한 결함에선 뚜렷이 낮아집니다. 여기서 배당이 작은 것은
패널에 천장 근처의 모델이 둘이나 있기 때문이며, 단일 지배자가 없을수록 커집니다.

<details>
<summary>과제별 검출률 캘리브레이션 (5모델 × 6과제)</summary>

| task | claude:opus | gpt-5.5 | grok-4.5 | glm-5.2 | gemma4 |
|------|-----|-----|-----|-----|-----|
| h1-median | 100% | 100% | 100% | 67% | 67% |
| h2-retry-jitter | 100% | **25%** | 100% | 75% | 100% |
| h3-cache-lru | 100% | 67% | 67% | 67% | **33%** |
| h4-date-range | 67% | 67% | 100% | 67% | **33%** |
| h5-parse-int | 100% | 100% | 100% | 100% | 75% |
| h6-event-emitter | 75% | 50% | 75% | 50% | **25%** |

- "5모델 전부 ≤70%" 난이도 필터에 걸린 과제는 **0개** — 프론티어 모델(Opus 4.8, grok-4.5)에겐
  이 세트도 대부분 쉽습니다. 난이도는 약한 모델 기준으로만 성립합니다.
- 하지만 오류는 탈상관합니다: gpt-5.5는 h2에서 25%(채점기 인공물 아님 — 다른 유효 이슈는
  찾았으나 시딩 결함 3개를 실제로 놓침), gemma4는 h3/h4/h6에서 크게 발산.

</details>

### 3막 — 측정이 라우팅을 움직인다 (2026-07-12 · hard 세트 재실행)

full hard 세트(6과제 21결함)에서 codex vs grok 재실행. 프로바이더 오류 0 — 모든 셀이 실제 판정.

| 프로바이더 | 검출 | 놓친 것 |
|-----------|------|---------|
| codex 단독 | 15 / 21 (71%) | h1 윈도 엣지 ×2 · h4 tz 비교 · h6 이중 발화 + late-handler ×2 |
| grok 단독 | 20 / 21 (95%) | h3 `no-eviction-on-equal`만 |
| 패널 (합집합) | 20 / 21 | 공유 맹점 1 |

쌍별 오류 상관 **0.762**(공유 21셀) — 2막의 0.746과 일관되게 재현. 배당은 최고 단일 대비
**0**(grok이 지배), codex 대비 **+5**. 한 패널리스트가 압도하면 합집합은 지배자 위에 아무것도
더하지 못하고, 공유 맹점은 합집합에서도 살아남습니다. **배당은 추상적 "다양성"의 속성이 아니라
"당신의 최고 단일 모델이 누구냐"의 속성 — 즉 라우팅 문제입니다.**

그리고 이 결과가 실제로 라우팅을 움직였습니다(측정→라우팅 루프의 첫 라이브 폐쇄):

```text
pick verify / pick security (high intensity, legacy baseline = codex):
  → grok@xhigh · measured bench: grok LCB 0.7733 vs codex 0.5004
    over 21 shared opportunities (6 tasks, via lcb-margin)
```

측정 → 원장/결과 → `traits`(Wilson 95% 하한) → 라우팅 결정, 근거 문자열에 표본 수 인용.
벤치마크가 잰 것이 곧 라우터가 하는 일이 됐습니다.

### 4막 — 4번째 탈상관 모델이 강 모델 쌍의 맹점을 회수한다 (2026-07-13 · 4모델)

2막이 예측한 "공유 맹점 → 4번째 탈상관 모델로 에스컬레이션"을 실측했습니다. 강 앵커(grok)에
클라우드 로컬 모델 3종을 추가한 4모델 패널(single):

| 모델 | 표면 | 검출 |
|------|------|------|
| grok | cli-agentic | 18 / 21 |
| nemotron-3-super:cloud | http-completion | 16 / 21 |
| glm-5.2:cloud | http-completion | 15 / 21 |
| gemma4:cloud | http-completion | 13 / 21 |
| **패널 합집합** | 혼합 | **19 / 21 (배당 +1)** |

**예측 확인.** `h3 no-eviction-on-equal` — 2026-07-12에 codex와 grok이 **둘 다** 놓친 공유 맹점
— 을 이번엔 **gemma4:cloud와 nemotron-3-super:cloud가 잡았습니다.** nemotron은 h3를 **3/3**으로
완전 검출해 강 모델 쌍이 놓친 LRU off-by-one을 회수했습니다. 더 탈상관된 모델로의 에스컬레이션이
실제로 작동한다는 라이브 증거입니다.

**단, 다양성은 만능 용매가 아닙니다.** 두 결함(`h4 tz-comparison`, `h6 double-fire`)은 4모델
합집합에서도 살아남습니다. 특히 h6 double-fire는 지금까지 측정된 **모든 모델(codex·grok·gemma4·
glm-5.2·nemotron)이 전부 놓친** 깊은 맹점입니다.

쌍별 일치율: grok↔gemma4 **0.667**(최고 탈상관), grok↔nemotron 0.810, grok↔glm-5.2 0.857.
정직한 교락 2가지: (1) 이건 **크로스-표면** 패널 — grok은 벤더 CLI(cli-agentic), 클라우드 3종은
원 모델에 가까운 HTTP 완성 — 이라 grok↔클라우드 탈상관에는 모델 차이와 표면 차이가 섞여 있고,
(2) grok이 여기서 **18/21**(2026-07-12엔 20/21)로 같은 모델이 실행마다 다른 점수를 냅니다 —
단일 실행 셀에 측정 노이즈가 있다는 뜻이며, traits가 원점수가 아닌 Wilson 하한·표본 수로 게이트하는
이유입니다.

### 5막 — debate를 처음으로 측정: 여기서는 품질 배당이 없었다 (2026-07-13 · codex vs grok)

`--modes debate`는 검출 합집합이 아니라 **실제 적대 프로토콜**을 채점합니다. 각 주장의 텍스트를
시딩 결함에 매핑해, 시딩 결함에 대응하면 **grounded(참 검출)**, 대응 없으면 **surplus**로 나누고,
반박이 grounded를 surplus보다 높은 비율로 살려두는지(품질 판별)를 봅니다.

| 버킷 | 생존 | 비율 |
|------|------|------|
| grounded (참 결함) 주장 | 20 / 23 | 0.87 |
| surplus 주장 | 22 / 25 | 0.88 |
| **품질 판별** | | **−0.01** |

debate는 48개 주장 중 **6개(12.5%)만** 죽였고, 그 kill은 **grounded 3 / surplus 3**으로 갈려
참 결함 주장을 surplus만큼 자주 죽였습니다. 강하고 정렬된 동일-표면 쌍에서 SURVIVED 라벨은 시딩
결함 대응 여부를 **추적하지 못했습니다.**

이것은 1막(상관 1.0 → "다양성은 연극")의 debate 판입니다. **심의 배당도 다양성 배당처럼
조건부이지 공짜가 아닙니다** — 적대적 반박은 죽일 만한 확신에 찬 오류가 있을 때만 품질을
날카롭게 하는데, 강하고 정렬된 쌍은 이 과제들에서 그런 오류를 거의 만들지 않았습니다(kill 근접
제로). 성과는 긍정적 결과가 아니라, **debate가 도움이 될 때를 감지하는 계측기가 이제 존재한다는
것** — "설계+라이브 e2e로만 출하됐던" 마지막 공백을 닫았습니다. 코드·리포트에 강제된 정직성
단서: *surplus ≠ 거짓* — 프론티어 모델은 시딩되지 않은 진짜 이슈도 제기해 surplus에 섞이므로
품질 판별은 하한입니다. 다만 kill이 이토록 드물면 하한조차 날카로움 없음을 보입니다.

### 6막 — 가장 깨끗한 배당: 지배자 없는 동일-표면 패널 (2026-07-13 · 3회 반복)

지금까지 모든 패널엔 천장 근처 모델(grok 18–20, claude 19)이 하나씩 있어 그 높은 최고-단일이
배당을 먹었습니다. 앙상블 이론은 **지배자가 없을 때 배당이 커진다**고 예측합니다. 직접
검증했습니다: 서로 대등하고(지배자 없음), 서로 다른 랩이며(탈상관), **전부 `http-completion`**
(cross-surface 교락 제거)인 3모델 — gemma4:cloud · glm-5.2:cloud · nemotron-3-super:cloud — 을
hard-set에서 **3회 반복** 측정.

| 실행 | gemma4 | glm-5.2 | nemotron | 최고 단일 | 합집합 | 배당 |
|------|--------|---------|----------|-----------|--------|------|
| 1 | 16 | 17 | 14 | 17 | 19/21 | **+2** |
| 2 | 14 | 16 | 17 | 17 | 19/21 | **+2** |
| 3 | 16 | 18 | 15 | 18 | 20/21 | **+2** |

**배당 = [+2, +2, +2], 평균 2.0, 분산 0** — 지배자 있던 패널의 +1의 정확히 두 배이고, 실행 간
흔들림이 없습니다. **각 모델 순위는 매 실행 뒤바뀌는데**(glm-5.2가 1·3회 최고, nemotron이 2회
최고; 각자 어느 실행에선 최약체) 개별 점수는 ±3씩 요동쳐도 **앙상블 배당은 미동도 없습니다** —
패널이 그 구성원 누구보다 안정적이라는 뜻입니다. 평균 쌍별 일치율 **0.735**(hard-set 0.746과
같은 탈상관 영역, 이번엔 표면 교락 없이). **영구 맹점 0개** — 3회에 걸쳐 합집합이 21개 결함을
모두 커버했고(grok 앵커 4모델 패널은 2개를 영구히 못 잡았음), 4막에서 "모든 모델이 놓쳤다"던 h6
double-fire조차 대등 패널이 2/3회 잡았습니다.

**미션 가설의 가장 깨끗한 확인입니다.** 동일-표면·무지배자·탈상관 패널이 벤치 역사상 가장 크고
안정적인 배당(+2/21, σ=0)을 냈고, 실행당 합집합 19–20/21로 **프론티어 단일 모델(grok 20,
claude 19)과 대등한 검출을 세 개의 무료 로컬 중형 모델로** 달성했습니다. 프로젝트가 기대는 실용
명제가 마침내 깨끗이 실증됐습니다: *오류가 탈상관이고 단일 지배자가 없을 때 다양성은 배당을
내며, 싼 탈상관 모델 셋이 프론티어 하나를 대신할 수 있다 — 가정이 아니라 측정으로.* 정직한 한계:
+2/21은 여전히 소폭(~10%)이고, 단일 세트·결정적 regex 채점이며, 이득의 본질은 천장이 아니라
비용 구조(무료 로컬 3회 호출 vs 유료 프론티어 1회)입니다.

### 7막 — 혈통은 탈상관을 예측하지 못한다 (2026-07-14 · nemotron 계열 + gpt-oss)

신규 3모델(nemotron-3-ultra·nemotron-3-nano:30b·gpt-oss:120b)을 추가하며 프로젝트의 창립
질문을 직접 겨냥했습니다: **같은 계보가 오류 상관을 예측하는가, 아니면 측정해야 하는가?**
nemotron 3사이즈(ultra/super/nano — **같은 NVIDIA 랩**) + gpt-oss(**다른 랩**), hard-set, 3회.

검출률(3회 평균): ultra **17.0**(그룹 최강) · super 15.0 · gpt-oss:120b 15.0 · nano:30b **12.0**(최약).
천장에 붙은 모델 없음 → 무지배자 영역 유지. **배당 = [+2, +2, +3], 평균 2.33 — 역대 최대.**
평균 일치율이 **0.691**(대등 3-cloud의 0.735보다 낮음)로 떨어지며 배당이 함께 커져(2.33 vs
2.0) 탈상관→회수 메커니즘을 재확인했습니다. 영구 맹점 0개.

**핵심: 혈통은 무정보. 측정해야 합니다.** 쌍별 평균 일치율:

| 쌍 | 랩 관계 | 평균 일치율 |
|----|---------|-------------|
| ultra ↔ super | **같음** (NVIDIA) | 0.778 |
| super ↔ gpt-oss | 다름 | 0.746 |
| nano ↔ gpt-oss | 다름 | 0.698 |
| ultra ↔ nano | **같음** | 0.667 |
| ultra ↔ gpt-oss | 다름 | 0.651 |
| **super ↔ nano** | **같음** (NVIDIA) | **0.603** |

같은 랩 nemotron 쌍이 **0.603–0.778 전 범위**에 걸쳐 다른 랩 쌍(0.651–0.746)과 완전히 겹칩니다.
**패널에서 가장 탈상관된 쌍이 같은 랩**(super↔nano, 0.603)이고, **다른 랩 쌍이 가장 상관된 축**
(super↔gpt-oss, 0.746)입니다. 같은 랩 평균(0.683)이 오히려 다른 랩 평균(0.698)보다 낮습니다.
**공유 혈통은 두 모델의 오류가 탈상관인지에 대해 신뢰할 신호를 주지 않습니다.**

이것은 xllm 핵심 설계의 실증적 정당화입니다: 패널 타이브레이커는 실측 일치율이 가장 낮은
미참여 프로바이더를 고르며 "**혈통이 아니라 측정으로**"입니다. 만약 혈통으로 다양성을 라우팅했다면
("둘 다 nemotron이니 중복 — 다른 벤더 추가")가장 탈상관된 쌍(두 nemotron)을 버리고 더 상관된
크로스-벤더 쌍을 남겼을 것입니다. 측정이 혈통 직관을 뒤집습니다 — 크로스-**벤더**(v0.1의 원래
다양성 휴리스틱)를 벤치마크가 크로스-**탈상관**(쌍별 실측)으로 은퇴시킨 셈입니다.

### 8막 — 최대 크로스-벤더 패널이 배당은 최저였다 (2026-07-14 · 프론티어 3종 @low)

정반대 극단을 측정했습니다: 세 프론티어 벤더 CLI를 랩당 하나씩, 전부 **최저 강도(low)** —
claude:sonnet@low(Anthropic·Sonnet 5) · codex:gpt-5.6-luna@low(OpenAI) ·
grok:grok-composer-2.5-fast@low(xAI). 전부 cli-agentic(동일 표면), 최대한 크로스-**벤더**.
hard-set 3회, 0 에러(claude는 계측 목적이라 `XLLM_ALLOW_SELF=1`로 실행).

검출률(3회 평균): claude:sonnet **19.3** · grok-composer **19.0**(3회 모두 정확히 19) ·
gpt-5.6-luna 15.3. 저강도인데도 Sonnet 5·grok-composer는 하드셋 천장 근처입니다.

**배당 = [0, 0, +1], 평균 0.33 — 하드셋 역대 최저.** 최대한 크로스-벤더인 패널이 회수를 가장
못 했습니다. 이유 둘이 겹칩니다: (1) **천장 지배자** — claude 20·grok 19라 회수 여지 없음(3막
교훈), (2) **높은 상관** — 평균 일치율 **0.841**(중형 클라우드 패널의 0.69–0.74보다 훨씬 높음).
프론티어 모델은 저강도로 묶고 서로 다른 랩이어도 **의견이 일치합니다.**

**혈통/계보 주제의 정점(7막의 심화).** 벤치 역사상 **가장 상관된 쌍이 claude↔grok 평균 0.920**
(두 실행에서 0.952) — 서로 **다른 벤더**(Anthropic vs xAI)입니다. 반대로 **가장 탈상관된 쌍은
super↔nano 0.603** — **같은 랩**(둘 다 NVIDIA nemotron)입니다. 크로스-벤더 쌍이 같은 랩 쌍보다
~0.32 더 상관됩니다. 혈통 다양성은 탈상관을 예측하지 못할 뿐 아니라, 여기서는 오히려
**역상관**입니다. 배당은 프론티어 크로스-벤더가 아니라 중형 탈상관 영역에 살고, 어느 패널을
쥐었는지는 오직 측정만이 알려줍니다.

### 측정 표면 태그 (모델 vs 하네스 교락)

이제 모든 결과가 각 프로바이더의 측정 표면을 기록합니다: `cli-agentic`(자체 도구·추론을 돌릴 수
있는 벤더 CLI — codex·claude·grok·gemini…) vs `http-completion`(원 모델 — ollama·lmstudio).
벤치의 측정 단위는 **원 모델이 아니라 xllm이 호출하는 어드바이저 표면**이라는 것을 명시합니다 —
강한 CLI 점수는 모델 실력일 수도, 하네스 증폭일 수도 있습니다. 기록을 위해: **xllm은 grok을
team/agent 모드로 부른 적이 없습니다** — 호출은 `grok -m … --reasoning-effort … -p` 원샷 print,
read-only이며 모든 클라우드 CLI와 동일합니다. 다만 grok의 `-p`도 벤더 CLI이므로 `cli-agentic`입니다.

### 재현

```bash
npm run bench:live                                                                          # 기본 세트(잘 알려진 결함)
node scripts/xllm-bench.js run --providers codex,grok --tasks-file hard-tasks               # 어려운 세트 (single+panel)
node scripts/xllm-bench.js run --providers codex,grok --tasks-file hard-tasks --modes debate       # 심의 채점
node scripts/xllm-bench.js run --providers grok,ollama:gemma4:cloud,ollama:nemotron-3-super:cloud --tasks-file hard-tasks --modes single   # 4모델 패널
```

원시 실행 JSON은 gitignore, 요약은 커밋 — 전체 기록: [`benchmarks/FINDINGS.md`](benchmarks/FINDINGS.md) ·
로드맵: [`docs/diversity-roadmap.md`](docs/diversity-roadmap.md)

---

## 라이선스

MIT — [LICENSE](LICENSE)
