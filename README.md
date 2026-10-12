<div align="center">

# xllm

### 하나의 세션에서 모든 모델을. 크로스-벤더 LLM 다양성.

에이전틱 코딩 도구(Claude Code · Codex · Grok Build)는 제조사 단일 LLM에 락인됩니다.
**xllm**은 다른 벤더와 로컬 모델을 그 세션 안으로 불러옵니다 — 기본은 read-only.

**[🌐 소개 페이지](https://kimmingul.github.io/xllm/)** · **v0.36.1** · MIT

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

## 워크플로: 호스트 단독 → ask → 블라인드 독립 리뷰

필요한 만큼만 올라갑니다. **호스트 단독**으로 충분하면 xllm을 부르지 않습니다. 독립적인 다른
모델의 의견이 비용만큼 값어치가 있을 때 `ask`로 **한 명**에게 묻고, 여러 모델의 *측정된* 의견
분포가 필요할 때만 `review blind`(서로 못 보는 독립 리뷰)로 올립니다. `review debate`/`council`은
**실험 기능**이며 고위험 결정의 근거로 쓰지 않습니다(아래 심의 레퍼런스 참고).

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
`refs/xllm/exec/<id>` 반환, 변조 트립와이어) · 병합/push/자격증명은 호스트 측 · **검증된 OS 샌드박스가
있는 provider(현재 codex)만**, 우회 옵션 없음(호스트 셸에서 테스트를 돌리지 않음; 샌드박스 검증 실패 시
fail-closed) · `--test-cmd` 검증 없이는 green이라 부르지 않음(`unverified`) · executor의 green은 증거이지
신뢰가 아님(병합 후 재검증).

---

## 핵심 기능

| 기능 | 설명 |
|------|------|
| **블라인드 독립 리뷰 (`review blind`)** | 동일 프롬프트를 N개 모델에 블라인드로 보내 **다양성을 측정**. 구조화 판정이 산문보다 먼저 append-only 원장에 기록되고, 누적 쌍별 일치 행렬을 제공. 권장 기본 심의 모드. |
| **측정 타이브레이커** | 패널이 **split**이면 원장의 실측 일치율이 가장 낮은 **미참여** 프로바이더를 자동 선정(혈통 아님) — 제안은 항상 무료 기록, 실제 추가 호출은 `--tiebreak` 옵트인. 일치율은 **strict 정체성 증거**(아래)만 사용. |
| **strict 증거 기반 특성 (`traits`)** | 원장·벤치마크에서 **실측 특성만** 파생(손으로 쓴 모델 인상론 금지, 표본 수 상시 노출). 증거는 실행된 provider·보고된 모델/리비전·유효 effort·표면·CLI 버전으로 키잉되며, 모델 정체성이 *resolved*가 아닌 기록(레거시·bare 모델명·별칭)은 **라우팅에 쓰지 않습니다**. 증거가 없으면 내장 라우팅. `pick --no-traits`는 실측 품질 라우팅만 끕니다. |
| **적대적 검토 (`review debate`) — 실험** | 모델들이 서로 **반박**해 주장을 SURVIVED/KILLED/UNRESOLVED로 판정(judge LLM 없는 기계적 판정, 실패한 라운드는 UNRESOLVED). 이전 측정에서 품질 판별력이 확인되지 않았고 strict 방식의 재평가는 **보류 중**입니다. 고위험 권고의 근거로 쓰지 마세요. |
| **2단계 파이프라인 (`review council`) — 실험** | `review blind` → `review debate`을 한 명령으로. debate와 같은 이유로 실험 기능이며, 이전 측정에서 재현율이 블라인드 패널보다 낮았습니다. |
| **합의 깊이 종합** | 주장별로 만장일치/다수결/의견분열/단일출처 라벨. 실패 어드바이저는 기권. 합의는 신뢰도 메타데이터이지 진리가 아님. |
| **비용 인지 라우팅** | 가벼운 일은 무료 로컬·low effort, 무거운 판단은 strong tier. 초소형 로컬 모델은 판단 역할 투표권 거부(능력 하한). |
| **scribe (선택)** | 커밋 메시지·PR 본문·릴리스 노트를 가장 싼 healthy 모델이 작성, 결정적 검증. diff/log가 라우팅된 provider로 전송되므로 비용·프라이버시를 따져 고르는 선택 기능입니다. |
| **구조화 출력 견고성** | `--schema-file`로 스키마를 주면 네이티브 지원 provider는 그 경로를, 아니면 프롬프트 계약 + 견고한 추출기 + 1회 교정 재시도로 폴백합니다(제약된 생성이 아니라 best-effort JSON). 프로바이더별 **계약 준수도**(first/retry/failed) 리포트. |
| **계약 플로어** | 설치된 CLI의 플래그를 프로브해 버전 드리프트 감지, 실패 분류, transient만 재시도. 인증은 **관측 전까지 unknown**이며 관측된 실패만 거부권을 가집니다. |
| **local-only 실행 정책** | `execution_policy = "local-only"`면 위치가 *검증된* 로컬 provider만 통과(fail-closed). unknown은 통과하지 못하고 우회 플래그도 없습니다. |
| **read-only 안전 모델** | 샌드박스 탈출·승인 우회 없음. 읽기 전용 경계를 xllm이 **검증할 수 있는** 어댑터만 기본 허용(설치 ≠ 적격 — `doctor`가 구분 표시). 동일 벤더 중첩 거부. 세션 env 스트리핑. 아티팩트 시크릿 마스킹. |

---

## scribe (선택) — 기계적 git 산문을 싼 모델에게

선택 기능입니다. 기계적 git 산문을 메인 세션의 비싼 모델 대신 가장 싼 healthy 모델(로컬 우선)에게
맡길 수 있고, 직접 쓰는 것이 언제나 대안입니다. 결정적 수집기가 diff/log를 모으고, 모델은
**산문만** 작성하며, git 실행은 항상 사용자가 합니다. **diff/log는 라우팅된 provider로
전송됩니다** — 클라우드 provider면 원격 전송이므로 비공개 코드는 로컬 모델에 핀하고
`execution_policy = "local-only"`를 쓰세요. push/tag는 모델 호출 자체가 없습니다.

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
| `/xllm:review` | blind(독립 측정 패널, 기본)·roles(커버리지) + 실험 기능 debate·council 심의 | `scripts/xllm-review.js` |
| `/xllm:exec` | 검증된 OS 샌드박스의 격리 클론에서 구현 위임 → 검증된 브랜치 | `scripts/xllm-exec.js` |
| `/xllm:scribe` | (선택) 커밋/PR/릴리스 산문을 저가 모델로 | `scripts/xllm-scribe.js` |
| `/xllm:setup` | 머신 인벤토리 + 역할 핀 위저드 + 실행 정책 | `scripts/xllm-advisor.js --inventory/--remember/--set-role/--setup` |
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
| **4. 실행 정책** | `execution_policy`(`any` 기본 · `local-only`)를 프로젝트 프로파일에 기록 — `local` 팩은 `local-only`를 영속, 다른 팩은 기존 정책을 조용히 완화하지 않음 | `.xllm/xllm-providers.toml`의 `[defaults]` |

xllm은 CLAUDE.md/AGENTS.md에 규율 블록을 설치하지 않으며 사용자의 지침 파일을 자동으로 바꾸지
않습니다. 이전 버전이 설치한 마커 블록이 있다면 사용자 요청 시에만 `xllm discipline remove`로
제거합니다.

setup을 건너뛰어도 내장 라우팅으로 동작하지만, **마커가 없으면** 스킬이 경로 해석 휴리스틱에
의존하고 **역할 핀이 없으면** 프로젝트 맞춤 어드바이저 선택을 못 합니다. 그래서 프로젝트마다 한 번
실행이 권장 기본값입니다. CLI로 직접 하려면:

```bash
node scripts/xllm.mjs doctor       # 프로바이더 + 경로 건강 진단
node scripts/xllm.mjs remember     # 마커 + 아티팩트 디렉토리 생성
```

`.xllm/` 런타임 상태(마커·프로파일·아티팩트·원장)는 기본적으로 gitignore되는 운영 산출물입니다.

---

## 사용법

### 기본 사용법 — 5분 온보딩

설치 후 처음 쓰는 프로젝트라면 이 순서 그대로면 됩니다. 스펙 문법은 어디서나
`provider[:model][@effort]` 하나입니다(예: `codex@high`, `ollama:qwen3.6:latest`).
사람용 출력은 **마지막 stdout 줄이 결과 아티팩트 경로**이고, 기계용으로는 `ask --json`이
stdout에 **JSON 객체 하나**(진행 로그는 stderr)를 냅니다.

```bash
# 0. 이 머신에서 뭘 쓸 수 있는지 확인 (READY 프로바이더 + 추천 페어)
node scripts/xllm.mjs doctor

# 1. 프로젝트 1회 초기화 (경로 마커 + 역할 핀 미리보기; --apply 전엔 아무것도 안 바꿈)
node scripts/xllm.mjs setup

# 2. 다른 벤더의 의견 하나 받기 — 가장 기본 동작 (read-only)
node scripts/xllm.mjs ask codex@high "이 마이그레이션 설계의 위험을 짚어줘"

# 3. 여러 모델의 서로 못 보는 독립 의견 — 블라인드 리뷰(측정된 일치율)
node scripts/xllm.mjs review blind codex,grok "auth 모듈 보안 리뷰"

# 4. (선택) 커밋 메시지를 싼 모델에게 — diff가 라우팅된 provider로 전송됨, 비공개 코드는 로컬 모델
MSG=$(node scripts/xllm.mjs scribe commit) && git commit -m "$MSG"
```

호스트 안에서는 스킬로 부릅니다 — Claude Code/Codex: `/xllm:ask`, `/xllm:review`,
`/xllm:scribe`, `/xllm:setup` 또는 자연어("codex한테 이 설계 물어봐줘"). Grok Build:
`/ask`, `/xllm`, `/xllm-setup`. 어드바이저는 **기본 read-only**(읽기 전용 경계를 검증할 수 있는
어댑터만 — 설치된 CLI라고 자동으로 적격이 되지 않습니다)라 트리를 건드리지 못하고,
API 키 없이 **각 CLI의 기존 로그인**을 그대로 씁니다. 로컬 모델(ollama 등)이 있다면 비용 0으로
같은 문법으로 참여합니다: `ask ollama:qwen3.6:latest "..."`.

### 고급 사용법 — 측정 기반 워크플로

**① 코드를 놓고 리뷰받기 (diff 입력).** 어느 심의 모드든 diff 소스를 하나 붙이면
결정적으로 수집·상한 적용 후 어드바이저에게 전달됩니다. 상한에 걸리면 **어느 hunk를 봤고 어느
hunk가 빠졌는지** 결과가 그대로 보고합니다(전체를 리뷰했다고 말하지 마세요). 저장 정책은 아래
[명령 레퍼런스의 diff 입력](#명령-레퍼런스) 참고:

```bash
node scripts/xllm.mjs review blind codex,grok "이 변경 리뷰" --staged           # git add 된 것
node scripts/xllm.mjs review blind codex,grok,gemini "머지 안전?" --base main   # 워킹트리 vs ref(two-dot)
node scripts/xllm.mjs review roles a,b "리스크 나열" --diff-file x.patch       # 커버리지(측정 아님)
```

**② 블라인드 패널 루프 — 의견이 갈릴 때 쓰는 길.** `blind`는 동일 프롬프트를 블라인드로
보내 **일치율을 측정**하고 append-only 원장에 기록합니다. split이 나면 실측 일치율이 가장
낮은 미참여 모델을 타이브레이커로 제안하고(`--tiebreak`으로 실행), 채택 결과(`review outcome`)는
기록됩니다. 일치율·증거는 모델 정체성이 resolved인 기록만 집계합니다(unresolved는 표시만):

```bash
node scripts/xllm.mjs review blind codex,grok,gemini "이 캐시 설계 안전?" --tiebreak
node scripts/xllm.mjs review stats                # 누적 쌍별 일치 행렬 (실측 탈상관)
node scripts/xllm.mjs review outcome <run-id> --adopted majority --helpful yes
```

**③ 적대 검증 — 실험 기능.** `debate`(상호 반박)와 `council`(blind→debate)은 주장을
SURVIVED/KILLED/UNRESOLVED로 판정하지만 **실험 기능**입니다. 이전 벤치마크(10막)에서 품질
판별력이 확인되지 않았고 결함 검출은 blind가 우월했으며, 현행 strict 방식의 재평가는 **보류
중**이라 개선이 측정된 것으로 주장하지 않습니다. 고위험 권고의 근거로 쓰지 말고, 쓰더라도 이미
세운 특정 주장의 스트레스 테스트에 한정하세요. SURVIVED는 증명이 아니라 프로토콜 결과입니다.

**④ 에스컬레이션 — 의견에서 구현까지.** `ask`(의견) → `propose`(정적 `.patch`, 아무것도 적용
안 됨) → `exec`(검증된 OS 샌드박스의 격리 클론에서 편집·빌드·테스트 → 검증된 브랜치 반환, 당신 트리 불가침):

```bash
node scripts/xllm.mjs propose codex@high "login()에 입력 검증 추가"
node scripts/xllm.mjs exec codex@high "X 구현" --test-cmd "npm test"
```

**⑤ 라우팅을 프로젝트에 맞추기.** `setup [pack]`(balanced/quality/frugal/local/skip)으로
포스처를 고르거나 역할 단위로 핀 — 이후 스킬·라우팅이 자동으로 따릅니다. `traits`는 strict 정체성
증거에서만 실측 특성을 파생(표본 수 노출)해 판단 역할 라우팅에 반영하며, 레거시/unresolved 기록은
라우팅에 쓰지 않습니다. 코드를 밖으로 내보내고 싶지 않다면 `local-only`를 쓰세요:

```bash
node scripts/xllm.mjs setup frugal --apply
node scripts/xllm.mjs profile set-role security codex@high
node scripts/xllm.mjs profile set-default execution_policy local-only   # unknown 위치는 거부(fail-closed)
node scripts/xllm.mjs traits
```

**⑥ 무료 로컬 트리오 (검출용 후보).** VRAM에 올라가는 경량 모델 3개를 블라인드로 묶는 구성은
과거 측정(9막)에서 검출 합집합이 프론티어 단일과 비슷했고 비용이 0이었습니다. 단, 그 측정은
모델 정체성 증거(strict) 도입 **이전**의 단일 세트 결과라 현행 증거 체계로는 재검증 대상입니다 —
`xllm bench`로 직접 재측정하세요(아래 [벤치마크](#벤치마크--우리는-측정했습니다)):

```bash
node scripts/xllm.mjs review blind ollama:ornith:latest,ollama:gemma4:latest,ollama:qwen3-coder:30b "이 diff의 결함 전부 나열" --staged
```

ollama 모델은 `@high`를 붙이면 thinking이 켜집니다(미지원 모델은 자동 폴백). 보고된 모델·digest가
없으면 정체성은 unresolved로 남고 라우팅 증거가 되지 못합니다.

**⑦ 알아두면 좋은 함정.** Windows argv ~32KB — 긴 프롬프트는 `--prompt-file <경로>`(review
계열은 24KB 초과 시 자동 파일 경유); grok/gemini는 argv 전달이라 회피 불가, codex/claude는
stdin. 안전 플래그(`--allow-write`/`--allow-self`/`--no-artifacts`)는 명시적 요청 없이 쓰지
않는 것이 규약. 상세 플래그는 아래 [명령 레퍼런스](#명령-레퍼런스) 참고.

---


### 모델 이름이 바뀔 때

벤더는 xllm 릴리스보다 빠르게 모델을 은퇴시킵니다. 그래서 xllm은 클라우드
모델 목록을 하드코딩하지 않습니다 — 모르는 이름은 그대로 CLI에 넘깁니다.

- **모델을 생략하면** 각 CLI의 설정·기본 모델이 쓰입니다. CLI 설정이나 xllm의
  `default_model`이 고정되어 있으면 새 모델 출시 후에도 그 고정값이 유지됩니다.
- **은퇴한 이름은 교정됩니다.** 실측된 소수(`gpt-5.6` → `gpt-5.6-sol`,
  `grok-4` → `grok-4.6`)는 내장 씨앗으로, 그 외에는 프로젝트 설정에서
  직접 지정합니다. 교정되면 stderr로 알리고 아티팩트에 요청/전송 모델을
  모두 남깁니다.
- **CLI가 이름을 거부하면** 왜 거부했는지 구분해 알려 줍니다 —
  `unknown-model`(그런 모델 없음)인지 `account-unsupported`(이름은 있으나
  이 계정/플랜이 못 씀)인지, 그리고 그 CLI에 목록을 묻는 명령까지.

```toml
# .xllm/xllm-providers.toml
[aliases.codex]
"gpt-5.6" = "gpt-5.6-terra"   # 내장 씨앗(sol)을 재지정

[aliases.grok]
"grok-4" = ""                 # 빈 값 = 교정하지 않음 (그대로 CLI에 넘김)
```

**2026-09-12 확인:** GPT-6 Astra, Claude Fable 5.1·Opus 5·Sonnet 5,
Antigravity의 Gemini 3.8 Flash와 CLI 옵션 변경 사항은
[`모델·CLI 호환성 문서`](docs/current-models-and-clis.md)에 정리했습니다.
로컬 모델은 [`docs/local-llms.md`](docs/local-llms.md)를 참고하세요.

### 어댑터 적격성 — 설치 ≠ 적격

기본 read-only 어드바이저로 허용되는 어댑터는 읽기 전용 경계를 xllm이 *검증할 수 있는* 것뿐입니다:
`codex` · `claude` · `ollama` · `lmstudio`(inventory의 `advisor_eligible: true`). `gemini` ·
`antigravity`(`agy`) · `grok` · `cursor` · `lemonade`는 설치되어 있어도 경계를 검증할 수 없어
기본값에서 거부됩니다 — 예컨대 설치된 `agy`의 샌드박스는 워크스페이스 쓰기를 허용하고 신뢰할 도구
허용목록이 없습니다. `doctor`/`inventory`가 "설치됨/READY"와 "적격(안전)"을 따로 표시합니다. 검증된
네이티브 안전 모드가 생기면 그때 적격으로 바뀝니다. 설계 배경은
[`docs/model-version-tracking-design.md`](docs/model-version-tracking-design.md).

## 안전 모델

경계는 프롬프트가 아니라 **실행 플래그와 샌드박스로** 강제되며, **검증되지 않은 경계는 광고하지
않습니다**(fail-closed).

- **어드바이저는 기본 read-only — 검증 가능한 어댑터만.** codex는 `--sandbox read-only`(+ 사용자 설정/규칙 무시·ephemeral), claude는 제한된 도구 허용목록·`dontAsk` 권한 모드; ollama/lmstudio HTTP는 클라이언트 도구가 없는 프롬프트 전용입니다. 읽기 전용을 검증할 수 없는 CLI 어댑터는 기본값에서 거부되며, `--yolo`/`--dangerously-*`/`--always-approve`는 쓰지 않습니다. 변경은 `--allow-write`로 명시적 옵트인(별도의 비안전 선택이며 exec 샌드박스 우회가 아님).
- **당신의 체크아웃은 불가침** — `exec`는 `.git` 분리 클론에서만 작업, fetch 전용 반환.
- **동일 벤더 중첩 거부** — Claude Code 안 claude, Codex 안 codex 어드바이저 거부(`--allow-self`로 해제).
- **local-only는 엄격** — `execution_policy = "local-only"`는 위치가 검증된 로컬 provider만 허용(Ollama: loopback 엔드포인트 + 신뢰할 로컬 모델 메타데이터; `:cloud`·원격 호스트·클라우드 CLI는 remote; LM Studio/lemonade는 검증 가능한 로컬 메타데이터가 없으면 unknown). unknown은 통과하지 못하고 `--ready`/`--allow-write`로 우회할 수 없으며, 알 수 없는 정책 값도 거부합니다.
- **인증은 관측 전까지 unknown** — 토큰 없는 프로브는 버전/플래그 상태만 갱신하고 이전 인증 관측은 고유 타임스탬프로 보존합니다. 관측된 실패만 거부권을 가지며 unknown을 성공으로 표시하지 않습니다(CLI 버전·연결/인증 컨텍스트가 바뀌면 무효화, 비밀 값은 저장 안 함).
- **시크릿은 디스크에 남지 않음** — 알려진 키/토큰 포맷 마스킹. 단 마스킹은 완전하지 않고 어드바이저별 응답 아티팩트에는 프롬프트 전문(diff 포함)이 남을 수 있습니다(아래 diff 입력·`--no-artifacts`·`clean` 참고). scribe는 xllm 아티팩트를 쓰지 않지만 provider 측 보존은 xllm이 통제하지 못합니다.
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
  `grok:grok-4.6@high`, `ollama:qwen3.6:latest`. 프로젝트 프로파일: `.xllm/xllm-providers.toml`.
- **출력 규약** — 사람용 실행 결과의 **마지막 stdout 줄이 아티팩트/인덱스 경로**입니다
  (`.xllm/artifacts/…`). 기계용은 `ask --json` / `review blind|debate|council --json`이 stdout에
  **JSON 객체 하나**(`schema_version:2`, 진행 로그는 stderr)를 냅니다. `review`의
  blind/debate/council(roles 제외) 구조화 판정은 산문보다 먼저 `.xllm/panel-ledger.jsonl`(append-only)에
  기록됩니다.
- **안전 플래그** (ask/review) — `--allow-write`(어드바이저 파일 쓰기 옵트인) ·
  `--allow-self`(동일 벤더 중첩 해제) · `--no-artifacts`(아티팩트 미저장; `XLLM_NO_ARTIFACTS=1`도 동일).
  `--allow-write`/`--allow-self`는 사용자의 명시적 요청 없이는 쓰지 않는 것이 규약입니다.
- **긴 프롬프트** — Windows argv ~32KB 한계가 있습니다. `--prompt-file <경로>`를 쓰세요
  (review 계열은 24KB 초과 시 자동으로 파일 경유).
- **diff 입력** — 어느 심의 모드에서든 `--staged | --base <ref> | --diff-file <path>` 중 하나로
  diff를 넣을 수 있습니다. `--base <ref>`는 `git diff <ref>`(two-dot) — **워킹트리 대 ref** 비교라
  미커밋 변경까지 포함합니다(merge-base 삼점 비교가 아님; 커밋된 브랜치 diff만 원하면 커밋 후 사용).
  git으로 결정적으로 수집되어 **24KB**(diff 바이트) 예산 안에서 파일/hunk 경계로 잘려 모든
  어드바이저에 **전달됩니다**(너무 큰 단일 hunk는 줄 경계로 분할, 바이너리는 불투명 파일로 표기).
  생략된 모든 파일/hunk는 **DIFF COVERAGE 매니페스트**로 열거되어 md·원장·JSON 결과에 나타납니다
  — "전체를 봤다"고 말하지 말고 covered/omitted를 그대로 전하세요.
  **저장 정책(정확히):** 원장과 md 인덱스에는 diff 본문이 쓰이지 않고 메타데이터+커버리지 매니페스트만
  남습니다. 그러나 기본 실행에서는 어드바이저별 응답 아티팩트에 `Original task`와 프롬프트(**diff 본문
  포함**, 시크릿 마스킹)가 남으므로 "diff를 저장하지 않는다"는 말은 사실이 아닙니다.
  `--no-artifacts`를 주면 blind/debate/council의 자식 호출은 아티팩트를 만들지 않고, md 인덱스도 쓰지
  않으며(결과는 출력 또는 `--json`), 원장에는 판정·상태·attribution·usage·adherence·커버리지 메타데이터만
  남고 질문/주장 텍스트와 diff는 쓰이지 않습니다. 이미 보존된 아티팩트는 `clean`으로 지우세요.

### 의견 — `ask`

```text
ask   <spec> "<prompt>"  [--json] [--schema-file <path>] [--propose] [--prompt-file <path>] [--allow-write] [--allow-self] [--no-artifacts]
```

```bash
node scripts/xllm.mjs ask codex@high "이 마이그레이션 설계의 위험을 짚어줘"
```

- 사람용 출력: 어드바이저 1명의 진짜 답을 `.xllm/artifacts/ask/…` 아티팩트로 남깁니다(프롬프트+출력,
  시크릿 마스킹). 어드바이저는 이 대화를 볼 수 없으므로 필요한 컨텍스트만 프롬프트에 담으세요.
- `--json`: stdout에 **JSON 객체 하나**(진행 로그는 stderr), 치명적 오류도 같은 봉투로 반환합니다.
  `{ schema_version:2, raw, exitCode, durationMs, artifactPath, patchPath, failure, attribution, usage,
  cost_estimate, structured }` — `raw`는 최종 응답 텍스트뿐(프롬프트·stderr 없음). `attribution`은
  요청 대 실행을 구분합니다: `requested_provider/model`, `executed_provider`, `transmitted_model`,
  `substituted_from`, `reported_model`(provider가 보고하지 않으면 `null` — 요청·전송 모델이나 답변
  본문에서 추정하지 않음), `identity_status`(`resolved`|`mutable`|`unresolved`; 전체 모델 ID는 불변 정체성이
  없으면 mutable이고 `opus`/`sonnet`/`latest`/`default`/`auto` 같은 별칭은 resolved가 아님),
  `model_revision`, `requested_effort`/`effective_effort`, `cli_version`, `surface`
  (`cli-agentic`|`http-completion`), `execution_location`(`local`|`remote`|`unknown`). 네이티브 머신 출력이
  있는 어댑터(Codex `--json`, Claude `--output-format json`, Ollama/LM Studio HTTP)는 보고된 메타데이터를
  채우고, 나머지 어댑터는 거짓 정체성 대신 `unresolved`로 남습니다. **resolved 결과만 증거/라우팅 키**가 됩니다.
- `--schema-file <path>`: 구조화 출력 요청. 네이티브 스키마를 지원하는 provider는 그것을 쓰고, 아니면
  프롬프트 계약 + 제한된 재시도로 폴백합니다(제약된 생성을 주장하지 않음). 결과 객체는 `structured`.
- `--propose`를 붙이면 의견 대신 **unified diff**를 받습니다 — `artifacts/proposals/`에 `.patch`
  사이드카로 저장되고, 아무것도 적용되지 않습니다.
- 병렬 다중 어드바이저 + 합의 깊이 종합은 이제 `review roles` — 아래 참고.

### 심의 — `review` (`blind` · `roles` · `debate`* · `council`*)

\* debate/council은 **실험 기능**입니다.

```text
review blind   p1,p2[,p3] "<질문>"      [--tiebreak] [--ready=a,b,c]      # 권장 기본
review roles   p1,p2[,p3] "<prompt>"   [--propose] [--prompt-file <path>] [--allow-write] [--allow-self] [--no-artifacts]
review debate  p1,p2[,p3] "<질문/주장>"                                  # 실험
review council p1,p2[,p3] "<질문>"      [--tiebreak] [--ready=a,b,c]      # 실험
review stats [--json]                  쌍별 일치 행렬 (strict 정체성 증거 + tiebreak 행 합산)
review outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no

diff 입력(위 모든 모드): --staged | --base <ref> | --diff-file <path>
```

```bash
node scripts/xllm.mjs review blind codex,grok,gemini "이 캐시 설계가 동시성에 안전한가?" --tiebreak
node scripts/xllm.mjs review roles ollama:qwen3.6:latest,codex "advisor 스크립트 보안 리뷰"
node scripts/xllm.mjs review debate ollama:llama3.2,ollama:gemma4 "이 인증 흐름은 토큰 재사용에 취약하다" --staged
node scripts/xllm.mjs review council codex,grok,gemini "결제 웹훅을 재설계해야 하는가?" --tiebreak
```

> 구 명칭 `multi`/`panel`/`debate`/`council` 톱레벨 명령은 **v0.28.0에서 제거**되었습니다 —
> `review <mode>`로 쓰세요 (구 명칭 입력 시 대체 명령을 알려주는 에러가 납니다).

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
- **debate (실험)** — R0 블라인드 주장 → R1 상호 반박(구체적 메커니즘+falsifier, decisive/soft 태그) →
  R2 저자 방어 → **기계적 판정**(judge LLM 없음, 순서 불변). 저자가 못 막은 decisive falsifier만
  주장을 KILL하고, 단순 이견은 UNRESOLVED이며 **라운드가 실패하면 UNRESOLVED**입니다.
  정체성은 모델 단위 — 같은 ollama 위의 llama↔gemma도 서로 공격합니다.
- **council (실험)** — blind(독립 발산) → debate(적대 수렴)을 한 명령으로. 1단계가 split이면 타이브레이커
  주장이 2단계에 **저자로만** 참여합니다(원 멤버 주장을 밀어내지 않음, 토론자 아님).
- **실험 상태** — debate/council의 이득은 입증되지 않았습니다. 이전 측정(5·10막)은 SURVIVED 라벨이 시딩
  결함 대응 여부를 추적하지 못했고(품질 판별 ≈0), council의 생존 주장이 blind 합집합보다 재현율이
  낮았습니다. strict 정체성·반복·보류 평가 방식의 재평가는 **보류 중**이며, 개선이 측정되었다고
  주장하지 않습니다. 고위험 권고의 근거로 쓰지 마세요.
- **비용 감각** — `ask`/`review roles` < `review blind` < `review debate`(~2–3×) <
  `review council`(~3–4×). SURVIVED는 "적대적 검증을 통과했다"는 프로토콜 결과이지 증명이 아니며,
  중요한 것은 직접 재검증하세요.

### 변경 위임 — `propose` · `exec`

```text
propose <spec> "<변경 요청>"
exec sandbox-check                          # OS 샌드박스 검증(모델 호출 없음; exit 0 ok / 3 not ok, JSON 리포트)
exec <spec> "<과제>" --test-cmd "npm test"  [--timeout-ms N] [--keep-clone] [--allow-self]
exec list | exec cleanup <id>|--all
```

```bash
node scripts/xllm.mjs propose codex@high "login()에 입력 검증 추가"
node scripts/xllm.mjs exec codex@high "slugify 유닛 테스트 추가" --test-cmd "npm test"
```

- `propose`는 read-only 그대로입니다 — 산출물은 `.patch`뿐이고 적용은 항상 사용자 몫
  (`git apply --check` → 리뷰 → 병합).
- `exec`는 **임시 로컬 클론**에서 편집→빌드→테스트를 돌리고 `refs/xllm/exec/<id>`(fetch 전용) +
  `.patch` + 증거 아티팩트(`.md` + 기계용 `.json`, `<state>/artifacts/exec/`)를 돌려줍니다.
  **codex만** 허용됩니다(네이티브 OS 샌드박스: 클론에만 쓰기, 시스템 temp·호스트 저장소·홈 자격증명
  디렉터리 차단, 네트워크 off, 사용자 codex 설정 무시). claude는 샌드박스가 Bash 도구에만 적용되고
  권한 모드는 격리가 아니므로 거부되며 나머지 provider도 거부됩니다. **우회 옵션이 없습니다** —
  `--sandbox-mode`/`--allow-write`/`--ready`는 거부되고, `execution_policy = "local-only"`는 클론 전에
  exec를 거부합니다(codex는 클라우드).
- **fail-closed** — 클론 전에 이 머신에서 샌드박스를 프로브합니다(클론 안 쓰기만 성공, temp/홈/저장소 쓰기
  실패, 저장소·자격증명 읽기 거부, 비밀 env 없음). 실패하면 `blocked`(exit 3)이고 아무것도 클론하지
  않습니다. 클론은 `origin` 제거·hardlink 없음·`.git` 읽기 전용(커밋은 호스트가, 훅 비활성)이며,
  메인 저장소/클론의 HEAD·refs·config·hooks 변조가 감지되면 `tampered`로 가져오지 않습니다.
- **검증** — `--test-cmd`는 호스트 셸이 아니라 같은 샌드박스(`codex sandbox`)에서 허용목록 환경으로
  실행됩니다. 없으면 결과는 `unverified`이고 **green이 아닙니다**. executor의 주장은 증거가 아닙니다.
- **상태** — `green`(변경 + 샌드박스 테스트 통과 + 검증 정의 불변, exit 0) · `no-change`/`timeout`/`refused`/`executor-failed`
  (executor가 비정상 종료했고 변경 없음 — `no-change`와 구분; 변경이 있으면 `not-green`; exit 1) ·
  `unverified`/`not-green`/`definition-changed`(package scripts·러너 설정·CI·테스트 명령에 지명된 파일을
  executor가 편집함 — 통과가 원래 기준을 증명하지 못함; exit 2) · `blocked`/`tampered`(exit 3).
- **Windows** — 읽기 거부(deny-read)가 필요한 Windows 백엔드는 프로비저닝된 `elevated` 샌드박스(또는 명시적 MXC)가
  있어야 하며, 없으면 프리플라이트가 지원 불가로 `blocked` 처리합니다(프리플라이트와 실행 모두 `windows.sandbox = elevated` 고정).
- **핸드백 절차** — 증거 아티팩트의 `status`·`verification`·`tamper` 확인 →
  `git diff <base>..refs/xllm/exec/<id>` 리뷰 → `git merge --no-ff` → **병합 후 직접 재검증**
  (executor-green은 증거이지 신뢰가 아님) → `exec cleanup <id>`.

### 저비용 산문 (선택) — `scribe`

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
- diff/log는 라우팅된 어드바이저에게 **전송됩니다**(클라우드면 원격). xllm은 이를 아티팩트로 쓰지
  않지만(`--no-artifacts`) provider 측 보존은 통제하지 못합니다. 민감한 저장소는 scribe를 로컬
  모델에 핀하고 `execution_policy = "local-only"`를 쓰세요: `profile set-role scribe ollama:qwen3.6:latest@low`.

### 계측·진단 — `traits` · `bench` · `contracts` · `inventory` · `doctor` · `smoke` · `dry-run`

```text
traits [--json]          strict 증거 기반 특성 프로파일 (표본 수 상시 노출; 레거시·unresolved 기록은 라우팅 제외)
contracts [--live]       CLI 계약 프로브: 플래그 드리프트, 실패 분류; --live는 클라우드별 소형 호출 1회
inventory [--refresh]    머신 역량 캐시 (설치된 CLI, pull된 ollama 모델; 24h TTL)
doctor                   프로바이더 + 경로 건강 진단 (사람용)
smoke [--live]           드라이 스모크 / READY 프로바이더 라이브 확인
dry-run <spec> "<p>"     실제 호출 없이 조립될 커맨드라인 확인
```

- `traits`는 손으로 쓴 모델 인상론을 배제하고 실측만 파생합니다. 증거 키는 실행된 provider · 보고된
  모델/리비전 · 유효 effort · 표면 · CLI 버전이며, 모델 정체성이 resolved가 아니거나 bare 모델명/
  레거시 기록이면 **비라우팅**입니다(표시는 하되 선택에 영향 없음). `xllm bench`의 상세는 아래
  [벤치마크 재현](#재현).

### 라우팅 — `pick` · `infer` · `roles` · `profile`

```text
pick <role> <task>       역할×과제 → 모델/강도 자동 선정 (+실측 특성; --no-traits는 실측 품질 라우팅만 끔)
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

- `pick` 출력에는 `execution:`(위치+정책), `cost:`(정적 휴리스틱 — 가격 아님; 원격에서 서빙되는 로컬 런타임
  모델은 0이 아닌 unknown-remote), `measured:`(measured | measured-baseline-kept | none | not-applicable | disabled),
  `refused:` 줄이 붙습니다. 거부 종류: `policy`(local-only는 검증된 로컬 가중치 필요) · `safety`(`advisor_eligible`
  false — "safety unverified") · `health`(관측된 실패). 만족하는 후보가 없으면 stderr
  `unsatisfiable: <reason>`(`--json`이면 `{ok:false, error:{code:'ROUTING_UNSATISFIABLE', …}}`)와 exit 2.
- `doctor`/계약 상태는 `flags ok · auth unknown|verified|failed @ts · safety native-flags|unverified|prompt-only`를
  분리해 보여줍니다. 인증 관측은 토큰 없는 프로브 후에도 유지되고(자체 12h TTL), CLI 버전·계정/엔드포인트
  컨텍스트가 바뀌면 폐기되며, 관측된 실패만 거부권을 갖습니다.
  **건강 게이트(정확히):** 유효한(같은 CLI 버전·계정/엔드포인트 컨텍스트, 12h TTL 이내) 인증 실패 관측은 역할 핀과
  명시적 `--ready` 목록을 포함한 **모든 라우트**에서 provider를 막으며, 우회 플래그는 없습니다. 더 새로운 성공 관측
  (실제 호출 또는 `xllm-contracts --live`)·TTL 만료·버전/컨텍스트 변경으로만 풀립니다. 인증 외 건강 종류는
  기존 규칙(명시적 `--ready`는 바이너리 유무/계약 드리프트에 대해 권위 있고, 역할 핀은 우회)을 유지합니다.
  관측이 없는(unknown) 상태는 막지 않습니다. `--no-traits`는 실측 **품질**(벤치) 라우팅만 끄고, 관측된 인증 실패
  건강 게이트는 로드된 캐시로 계속 적용됩니다(`measured: disabled — … (health observations still apply)`).
- 모델 선택: 명시 모델(`--model`/역할 핀/프로파일 기본값)이 없고 inventory `model_details`가 있으면 `pick`은
  설치된 모델마다 후보를 만들어 각자의 메타데이터로 게이트하고(local-only: 검증된 로컬 가중치만, `:cloud`·미검증
  모델은 개별 거부) 승자 모델을 스펙에 담습니다(예: `ollama:llama3.2:latest@high`). any-ready 폴백도 동일하게
  확장되며 준비 상태를 우회하지 않습니다. inventory 메타데이터도 기본 모델도 없으면 local-only에서 bare provider는
  라우팅 불가입니다.

### 유지관리 — `which` · `remember` · `list-providers` · `clean`

```text
which                    해석된 advisor 스크립트 경로 출력
remember                 .xllm/xllm-advisor-path 마커 + 아티팩트 디렉토리(자기 무시 .gitignore) 생성
list | list-providers    프로바이더 목록 JSON
clean [--older-than=DAYS]   보존된 어드바이저 아티팩트 삭제
discipline remove [--target <path>]   이전 버전이 설치한 xllm 마커 블록 제거(제거 전용 — xllm은 더 이상 지침 블록을 설치하지 않음)
```

---

## 개발

```bash
npm test              # 279개 테스트 (라이브 LLM 불필요)
npm run check         # 문법 + 3개 호스트 매니페스트/스킬 검증
npm run ci            # check + test + smoke + bench selftest
npm run bench:selftest   # 채점기 결정적 자체 검사 (호출 없음)
node scripts/xllm.mjs bench run …   # 라이브 평가: --live --max-calls --deadline-minutes 명시 시에만 호출
```

**레이아웃**

```text
.claude-plugin/ .codex-plugin/ .agents/   3개 호스트 매니페스트
skills/                                    Claude Code + Codex 공유 스킬 5종
scripts/  xllm-advisor.js  xllm-exec.js  xllm-scribe.js  xllm-review.js  xllm-diff.js
          xllm-panel.js  xllm-debate.js  xllm-council.js  xllm-contracts.js  xllm-bench.js
          xllm-structured.js  xllm-routing.js  xllm-traits.js  xllm-evidence.js  xllm.mjs
benchmarks/  tasks/  FINDINGS.md            시딩 결함 벤치마크
docs/  index.html SCOPE.md *-design.md …   소개 페이지 + 스코프/설계/로드맵 문서
.grok/  skills/                             Grok Build 어댑터 (ask/xllm/xllm-setup)
```

---

## 범위 (Scope)

**포함**: 크로스-벤더 어드바이저, 로컬 LLM, diff 제안, 단일 태스크 격리 실행, 저비용 산문 레인,
비용 라우팅, 다양성 계측(패널·원장·벤치마크), 심의(블라인드 패널 + 실험적 debate/council).

**불포함(의도적)**: 에이전트 OS 이식, HUD/훅 엔진, 대형 스킬 카탈로그, xllm 자체 **무한 루프·자율 팀·
오케스트레이션 상태기계**(autopilot류), 자동 병합, push/배포, 자격증명 처리, 다수결 자동 적용
("투표=진리" 엔진) — 실행 오케스트레이션과 다중 태스크 조합은 호스트 네이티브의 몫입니다.
(debate/council은 한 질문에 대한 **유한한** 실험적 심의 파이프라인이지 실행 루프가 아닙니다.)

---

## 벤치마크 — "우리는 측정했습니다"

xllm은 **자기 핵심 주장을 반증할 수 있는** 시딩 결함 벤치마크를 내장합니다. 알려진 결함을 심은
코드 리뷰 과제에서 검출률·**쌍별 오류 상관**·심의 결과를 측정합니다. 실측은 시간순으로 누적됐고,
"탈상관이 측정된 곳에만 다양성을 쓰고, 그것이 실제로 도움이 되는지도 잰다"는 제품 동작으로
귀결됩니다. **긍정적 결과를 보장하는 도구가 아니라, 도움이 될 때를 감지하는 계측기입니다.**

> **역사적 기록입니다 — 현행 증거로 쓰이지 않습니다.** 아래 1~11막은 strict 정체성 증거 체계(실행된
> provider·보고된 모델/리비전·유효 effort·표면·CLI 버전 키) **이전**에 bare 모델명 기준으로 측정한
> 단일 세트·소수 반복 결과입니다. 그 결과 파일에는 attribution이 없어 **라우팅이 무시**합니다(unresolved
> legacy data는 비라우팅). 수치는 당시 측정의 기록으로만 읽고, 현행 방법으로는 `xllm bench`(아래
> [재현](#재현))로 반복·보류 세트·사람 판정과 함께 다시 재야 합니다. 특히 debate/council은 **개선이
> 측정되었다고 주장하지 않으며** 재평가는 보류 중입니다.

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
벤치마크가 잰 것이 곧 라우터가 하는 일이 됐습니다. *(역사적 기록: 현행 라우터는 attribution이 resolved인
증거만 소비하므로, 이 레거시 결과 파일은 더 이상 선택에 영향을 주지 않습니다.)*

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

### 9막 — 진짜 로컬 경량 트리오: 역대 최대 배당 (2026-07-18 · 3회 반복)

지금까지의 배당은 전부 *클라우드* 모델에서 나왔습니다("무료 로컬" 패널조차 ollama-cloud
엔드포인트). SOTA에 가까운 패널일수록 회수가 적었으니(8막 프론티어 트리오 +0.33), 능력 축을
더 내려 **소비자 GPU 한 장의 VRAM에 올라가는 진짜 경량 로컬 모델**로 내려가면 배당이 더
커져야 합니다. 검증했습니다: `ornith:latest`(5.6GB, ~9B) · `gemma4:latest`(9.6GB) ·
`qwen3-coder:30b`(18GB) — 전부 가중치 로컬, 전부 `http-completion`(동일 표면), hard-set 3회.
에러 0/54콜, 1회 실행 ~10분, 비용 0원.

| 실행 | ornith (5.6GB) | qwen3-coder (18GB) | gemma4 (9.6GB) | 최고 단일 | 합집합 | 배당 |
|------|--------|---------|----------|-----------|--------|------|
| 1 | 15 | 13 | 8 | 15 | 19/21 | **+4** |
| 2 | 15 | 15 | 9 | 15 | 19/21 | **+4** |
| 3 | 14 | 11 | 7 | 14 | 16/21 | **+2** |

**배당 = [+4, +4, +2], 평균 3.33 — 벤치 역사상 최대**(종전 최고: 7막 2.33). 3회 누적 합집합은
**21개 결함 전부**, 영구 공동 맹점 **0개**. 그리고 **탈상관–배당 곡선이 4개 점으로 단조
증가함이 확인됐습니다**:

| 패널 | 평균 쌍별 일치율 | 평균 배당 |
|------|-----------------|-----------|
| 프론티어 3종 @low (8막) | 0.841 | +0.33 |
| 대등 클라우드 3종 (6막) | 0.735 | +2.0 |
| nemotron 계열 + gpt-oss (7막) | 0.691 | +2.33 |
| **경량 로컬 3종 (이번)** | **0.609** | **+3.33** |

쌍별로는 ornith↔gemma4 **0.524** — 역대 가장 탈상관된 쌍(종전 super↔nano 0.603을 경신).
능력 겹침이 적을수록 오류 상관이 낮고, 낮을수록 합집합 회수가 큽니다 — 앙상블 이론의 예측
그대로입니다.

**최심층 맹점이 5.6GB 모델에게 뚫렸습니다.** codex·grok·gemma4:cloud·glm-5.2·nemotron이
전부 놓치던 `h6 double-fire`를 **ornith가 3회 중 2회** 잡았습니다(qwen3-coder도 1회). 계보가
무엇이든 오류 프로파일이 *다르면* 합집합이 그 차이를 수확합니다. 한 가지 정련: ornith는 매
실행 최고 단일이었지만(순위 회전 없음) 배당은 +4까지 나왔습니다 — 6막의 "무지배자" 조건의
본질은 순위가 아니라 **낮은 천장**입니다(ornith 15/21은 여지 6을 남기고, 나머지가 강하게
탈상관하며 그 여지를 채움).

**사용자 가설의 확인이자 아크의 완성입니다.** 이 hard-set에서 배당은 패널 능력의 단조 감소
함수입니다: SOTA일수록 다양성이 사줄 게 없고, 소비자 GPU 한 장에 들어가는 경량 3종이
합집합 19/21 — 프론티어 단일(claude 19.3, grok 20)과 결함 1개 차이 — 을 **추가 비용 0원,
~10분**에 냈습니다. 정직한 한계: 3회차가 +2로 꺼져(σ=0.94) 6막의 σ=0과 달리 경량 모델은
개별 노이즈가 큽니다; gemma4:latest는 단독 8/21로 약하며 순전히 탈상관으로 자리값을 합니다;
ornith는 커뮤니티 모델이라 정체성은 "측정된 오류 프로파일"로만 취급해야 합니다.

### 10막 — council 첫 측정: 공격적으로 죽이지만, 품질은 못 가린다 (2026-07-18)

마지막 미측정 심의 모드였던 council(블라인드 패널 → 그 주장들에 대한 적대 debate)을 9막과
같은 경량 로컬 트리오로 hard-set 6과제에서 측정했습니다(태스크당 청크, ~83분, 에러 0).
council의 첫 측정이자, 심의(deliberation)의 경량-로컬 극단 첫 측정입니다(5막은 프론티어 쌍).

| 버킷 | 생존 | 비율 |
|------|------|------|
| grounded (참 결함) 주장 | 9 / 18 | 0.500 |
| surplus 주장 | 15 / 30 | 0.500 |
| **품질 판별** | | **0.000** |

태스크별 판별은 −0.33 ~ +0.67로 요동치다 정확히 0으로 상쇄됐습니다. 다음 날 mid-tier
클라우드 트리오(6막 구성)로 같은 측정을 반복해 **세 영역의 삼각형이 닫혔습니다**:

| 영역 | kill 비율 | grounded 생존 | 판별 | 생존 커버 vs blind 합집합 |
|------|-----------|---------------|------|---------------------------|
| 프론티어 debate (5막) | 12.5% | 0.87 | −0.01 | (미측정) |
| mid-tier 클라우드 council | 10.4% | 0.88 | −0.03 | 11/21 vs 19–20/21 |
| 경량 로컬 council (이번) | **48%** | 0.50 | 0.00 | 8/21 vs 19/21 |

mid-tier는 두 극단 사이가 아니라 **프론티어 쪽에 붙습니다** — kill 행동은 탈상관이 아니라
능력을 따라갑니다. 강하고 정렬된 모델은 죽일 만한 확신-오류를 거의 안 만들고(심의가 할 일이
없음), 경량 탈상관 모델은 **무차별로 반박해 절반을 죽이는데 grounded와 surplus가 같은
비율로** 죽습니다(심의가 많이 일하지만 품질을 추적하지 않음). "그럴듯한 오류는 죽고 옳은
주장은 살아남는다"는 이야기는 이 계측기에서 **측정된 세 영역 어디에서도** 실측 근거가
없습니다.

**심의는 재현율을 깎습니다 — 검출은 블라인드 패널로.** council의 생존 주장이 커버한 시딩
결함은 **8/21** — 같은 트리오의 블라인드 single 합집합 **19/21**의 절반 이하입니다(참 검출의
절반이 debate에서 죽었고, 태스크당 8주장 캡이 커버리지를 더 압축). 경량 로컬 모델의 실용
라우팅이 이제 측정으로 결정됩니다: **결함을 찾을 땐 `review blind`(배당 +3.33), council의
적대 단계는 측정된 정밀도를 더하지 못한 채 재현율만 뺍니다.** 예외가 메커니즘을 정직하게
지켜줍니다: h6에선 grounded 두 주장(double-fire·no-cleanup)이 공격을 버텨 +0.67 판별 —
경량 모델도 진짜 주장을 방어해낼 때는 작동하지만, 평균적으로는 아닙니다.

정직한 한계: 태스크당 1회(council은 단일 호출의 ~8배 비용), surplus ≠ 거짓(판별은 하한),
8주장 캡은 프로토콜 형태의 손실, 그리고 이것은 하나의 트리오 — 중형 클라우드 council은 두
측정 극단 사이 어딘가일 수 있습니다.

### 11막 — 고효율은 실력이 아니라 다양성을 산다: 배당 +2 → +3 (2026-07-19)

마지막 open item — "대등 mid-tier 패널의 +2가 고효율에서 더 커지는가" — 는 그동안 측정
불가였습니다: ollama 전송이 `@effort`를 조용히 버렸기 때문입니다. v0.29의 effort→think
매핑(라이브 검증: glm/gemma4/nemotron은 `think` 수용, llama3.2는 거부→think 없이 자동
재시도)으로 실험이 가능해져, 6막 트리오를 `@high`로 hard-set 3회 재실행했습니다(에러 0).

| | 6막 (기본 effort) | @high (thinking on) |
|--|-------------------|---------------------|
| 배당 | +2 · +2 · +2 (평균 2.0) | +3 · +4 · +2 (평균 **3.0**) |
| 평균 쌍별 일치율 | 0.735 | **0.704** |
| 실행별 최고 단일 | 17 · 17 · 18 | 15 · 15 · 18 |
| 실행별 합집합 | 19 · 19 · 20 | 18 · 19 · 20 |

**배당은 컸지만, "효율을 올리면 더 잘 찾는다"는 방식이 아니었습니다.** thinking은 천장을
올리지 않았습니다 — 합집합은 그대로(18–20)이고 최고 단일은 오히려 **떨어졌습니다**(17→15).
개별 모델은 더 시끄러워졌습니다(gemma4가 12·12·18로 ±6, 역대 최대 단일 모델 요동). 고효율이
산 것은 **탈상관**입니다: 일치율 0.735→0.704, 최고-단일 여지 확대, 그 결과 합집합−최고 격차
(=배당)가 2.0→3.0. 순위는 여전히 회전하고(각자 어느 실행에선 최고), 영구 맹점 0, 3회 누적
합집합 21/21입니다.

**곡선에 대한 정직한 주름 하나.** 5개 패널이 측정된 지금, 일치율→배당 관계는 강하게
음(-)이지만 더 이상 *엄밀한* 단조는 아닙니다: 이 패널(0.704→+3.0)이 더 탈상관된 7막
(0.691→+2.33)을 앞서는데, 최고 단일이 낮아(15 vs 17) 채울 여지가 더 컸기 때문입니다.
3막이 말한 그대로 두 동인이 함께 작동합니다: **배당 = 탈상관 × 여지(headroom)**.
5개 점: 0.841→+0.33 · 0.735→+2.0 · **0.704→+3.0** · 0.691→+2.33 · 0.609→+3.33.

### 측정 표면 태그 (모델 vs 하네스 교락)

이제 모든 결과가 각 프로바이더의 측정 표면을 기록합니다: `cli-agentic`(자체 도구·추론을 돌릴 수
있는 벤더 CLI — codex·claude·grok·gemini…) vs `http-completion`(원 모델 — ollama·lmstudio).
벤치의 측정 단위는 **원 모델이 아니라 xllm이 호출하는 어드바이저 표면**이라는 것을 명시합니다 —
강한 CLI 점수는 모델 실력일 수도, 하네스 증폭일 수도 있습니다. 기록을 위해: **xllm은 grok을
team/agent 모드로 부른 적이 없습니다** — 호출은 `grok -m … --reasoning-effort … -p` 원샷 print,
read-only이며 모든 클라우드 CLI와 동일합니다. 다만 grok의 `-p`도 벤더 CLI이므로 `cli-agentic`입니다.

### 재현

현행 벤치는 `xllm bench`(= `scripts/xllm-bench.js`)입니다. **라이브 호출은 명시적 옵트인**이며 예산 상한이
필수입니다: `--live --max-calls N --deadline-minutes M` 셋 모두 있어야 실행되고, `--live` 없이 `run`을 돌리면
호출 계획(횟수·표면)만 출력하고 **호출·쓰기는 0**입니다. 모든 호출은 `xllm-advisor.js --json`을 거치며 실패한 셀은
기록되되 미검출로 채점되지 않습니다. 결과는 프로젝트 상태 디렉터리 `<state>/benchmarks/{results,adjudications,cases}/`
(기본 `.xllm/benchmarks/`, `XLLM_STATE_DIR` 존중)에 저장되며, 저장소의 `benchmarks/results/`에 있는 attribution 없는
레거시 파일은 라우팅이 무시합니다.

```bash
# 계획만 출력 (호출 0) → 예산을 정해 라이브 실행. provider 스펙에는 모델이 필수
node scripts/xllm.mjs bench run --providers codex:gpt-5.5,ollama:qwen3.6:latest --tasks-file heldout-tasks --repeats 3
node scripts/xllm.mjs bench run --providers codex:gpt-5.5,ollama:qwen3.6:latest --tasks-file heldout-tasks --repeats 3 --live --max-calls 40 --deadline-minutes 60
node scripts/xllm.mjs bench grade-selftest        # 채점기 결정적 자체 검사 (호출 없음)
```

- **반복·분할** — `--repeats N`(기본 3; 1은 `--regression`일 때만), `--split dev|heldout|all`. 보류(heldout) 세트는
  `benchmarks/tasks/heldout-tasks.json`이며 **합성(synthetic) 다중 파일/긴 diff 케이스**이고 실제 사례라는 출처를 주장하지 않습니다.
- **arms** — `--arms single,anchor-review,final`(`--anchor`/`--reviewer`/`--synthesizer`/`--panel` 지정). 패널은 **같은
  단일 응답들의 합집합**이라 추가 호출이 없습니다. 최종 채택(final)은 합집합과 분리해 평가합니다.
- **사람 판정** — regex 적중은 *후보*일 뿐입니다. `bench adjudicate export RUN [--out FILE] [--unblind]` →
  사람이 claim_id별 판정(불확실성 포함) → `bench adjudicate apply FILE [--replace]`, 진행은 `bench adjudicate status RUN`.
- **비교** — `bench compare --run RUN[,RUN..] --baseline ARM --arms ARM,ARM [--split heldout] [--difficulty-threshold 0.70]
  [--strongest SPEC] [--candidate-only]`(ARM: `single:SPEC` · `strongest-single` · `panel:SPEC+SPEC` · `local-panel` ·
  `anchor-review` · `final` · `native:LABEL`). 난이도 필터는 `--difficulty-threshold`(모든 모델의 검출률이 임계 이하인 과제만 hard)입니다.
  반복≥3 쌍, 실패 셀은 쌍별 제외, 반복별 분산 유지 — 가짜 정밀도를 만들지 않습니다.
- **네이티브 기준선·실사례** — `bench export-prompts --tasks-file NAME --out DIR`로 프롬프트(+sha256 매니페스트)를 내보내
  호스트 안에서 직접 돌린 뒤 `bench import-native FILE`(해시 검증, 호스트/모델은 자기보고라 *unverified*로 표시; 에뮬레이션 없음).
  사용자가 제공한 회고적 실제 버그는 `bench import-cases FILE [--name N]`(스키마 `xllm-bench-cases/1`)로 가져와 `--tasks-file N`으로 씁니다.
- `bench report RUN` · `bench list`로 결과를 열람합니다.

전체 기록: [`benchmarks/FINDINGS.md`](benchmarks/FINDINGS.md)(역사적) ·
로드맵: [`docs/diversity-roadmap.md`](docs/diversity-roadmap.md)

---

## 라이선스

MIT — [LICENSE](LICENSE)
