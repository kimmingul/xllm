# grok-xllm

**v0.10.0** — [Grok Build](https://grok.x.ai), **Claude Code**, **Codex**를 위한 크로스-벤더 LLM 어드바이저 플러그인.

호스트 CLI가 **지휘자(conductor)**, 외부·로컬 모델이 **조언자(advisor)**입니다.

호스트는 이미 서브에이전트, plan mode, 스킬, 훅을 갖고 있습니다.
**xllm은 호스트가 구조적으로 할 수 없는 것만 추가합니다:**

1. **진짜 크로스-벤더 의견** — codex, claude, gemini, antigravity, grok, cursor + **로컬** ollama / lmstudio / lemonade
2. **에스컬레이션 사다리** — `ask`(의견) → `propose`(정적 diff) → `exec`(격리 실행 + 검증된 브랜치)
3. **합의 깊이 종합** — 다중 조언을 만장일치/다수결/의견분열/단일출처로 라벨링
4. **비용 인지 라우팅** — 가벼운 일은 무료 로컬 모델, 무거운 판단은 강한 모델 (`scribe`, tier 메타데이터, 역할 핀)

## 설치

### Grok Build

```bash
# 로컬 체크아웃
grok plugin install . --trust

# GitHub에서
grok plugin install kimmingul/grok-xllm --trust
```

### Claude Code

```text
/plugin marketplace add kimmingul/grok-xllm
/plugin install xllm@xllm
```

세션에서: `/xllm:setup`, `/xllm:ask codex@high "…"`, `/xllm:multi codex,gemini "…"`,
`/xllm:exec codex "…"`, `/xllm:scribe`.

### Codex

```bash
codex plugin marketplace add https://github.com/kimmingul/grok-xllm.git
codex plugin add xllm@xllm
```

Claude Code와 Codex는 동일한 호스트 중립 스킬 5종(`ask`, `multi`, `exec`,
`scribe`, `setup`)을 `./skills/`에서 공유합니다. 팀·루프·플래닝·검증은
**의도적으로 포팅하지 않았습니다** — 호스트 네이티브 기능이 이미 담당합니다.

### 다른 프로젝트(소비자 저장소)에서

프로젝트마다 한 번:

```bash
node /path/to/grok-xllm/scripts/xllm.mjs remember
```

`<state>/xllm-advisor-path` 마커가 기록됩니다. `<state>` = 프로젝트 상태
디렉터리: 기본 `.xllm/`, 기존 프로젝트는 레거시 `.grok/` 그대로 인정.

**요구사항:** Node ≥ 18. 사용할 어드바이저 CLI만 설치하면 됩니다.

## 안전 모델

- **어드바이저는 기본 read-only.** 승인 우회·샌드박스 탈출 플래그 없음
  (codex는 `--sandbox read-only`; `--yolo`, `--dangerously-*`,
  `--always-approve` 미사용). 변경 허용은 `--allow-write` 또는
  `XLLM_ALLOW_MUTATION=1`로 명시적 옵트인.
- **동일 벤더 중첩 거부** — Claude Code 안에서 claude 어드바이저, Codex 안에서
  codex 어드바이저는 거부됩니다 (`--allow-self` / `XLLM_ALLOW_SELF=1`로 해제).
- **호스트 세션 환경변수 스트리핑** — Claude/Codex/Grok 세션 식별자를 제거한
  뒤 스폰합니다.
- **아티팩트 시크릿 마스킹** — 잘 알려진 자격증명 포맷(API 키, PAT, JWT 등)을
  저장 전 마스킹하고, 자기 무시 `.gitignore`로 커밋 유출을 차단합니다.
  `--no-artifacts` / `XLLM_NO_ARTIFACTS=1`로 저장 생략,
  `xllm clean [--older-than=일수]`로 보존 관리.
- **침묵 실패 금지** — 사용 불가 프로바이더는 합성 출력 대신 명확한 실패를
  반환합니다.

## 스펙 문법

```text
provider | provider:model | provider@effort | provider:model@effort
```

| 예시 | 의미 |
|------|------|
| `codex@high` | Codex + high reasoning effort |
| `claude:opus@medium` | 모델 + effort 지정 |
| `ollama:qwen3.6:latest` | 로컬 모델 (모델명에 콜론 허용) |
| `antigravity:…` | 디자인 쪽 선호 어드바이저 (gemini보다 우선, Windows는 gemini 폴백) |

## 에스컬레이션 사다리: ask → propose → exec

단이 올라갈수록 어드바이저의 자유는 커지지만, **사용자 체크아웃에 대한 권한은
모든 단에서 0**입니다 — 늘어나는 것은 격리 공간 안의 자유뿐입니다.

```bash
# 1) 의견 (read-only)
node scripts/xllm.mjs ask codex@high "이 설계를 리뷰해줘"

# 2) 정적 diff 제안 — git apply --check 후 직접 적용
node scripts/xllm.mjs propose codex@high "login()에 입력 검증 추가"
node scripts/grok-ask-advisor.js --multi --propose codex,gemini "…"   # 후보 패치 N개 경쟁

# 3) 격리 실행 — 임시 클론에서 편집→빌드→테스트 후 검증된 브랜치 반환
node scripts/xllm.mjs exec codex@high "X를 구현해줘" --test-cmd "npm test"
node scripts/xllm.mjs exec list
node scripts/xllm.mjs exec cleanup <id>
```

### exec 불변식

- 사용자의 체크아웃·브랜치·index·config는 **절대 불가침** — 실행은 `.git`이
  분리된 임시 로컬 클론에서만 일어나고, 결과는 fetch 전용으로
  `refs/xllm/exec/<id>`에 반환됩니다(+ `.patch` + 증거 아티팩트).
- 병합·push·자격증명은 항상 호스트 측.
- **샌드박스 가능한 프로바이더만** 실행 허용(codex `workspace-write`, claude
  `acceptEdits`) — 그 외 CLI와 순수 텍스트 모델은 거부. OS 샌드박스가
  고장난 머신에서는 **fail-closed**로 거부하며, `--sandbox-mode bypass`는
  "클론 수준 격리만 제공됨"을 인지한 명시적 옵트인입니다.
- 검증은 executor의 주장을 믿지 않습니다: `--test-cmd`는 xllm이 결정적으로
  재실행하고, 메인 저장소 변조 트립와이어(HEAD/status 전후 비교)가 증거에
  기록됩니다. 상태는 green / not-green / no-change / timeout으로 정직하게
  보고됩니다.
- 작업당 1개 태스크 — 루프/팀/파이프라인 없음. 여러 exec의 조합은 호스트
  네이티브 에이전트의 몫입니다. **executor의 green은 증거이지 신뢰가
  아닙니다** — 병합 후 직접 재검증하세요.

## scribe: 커밋 메시지에 SOTA 요금 쓰지 않기

기계적 git 산문(커밋 메시지, PR 본문, 릴리스 노트, 체인지로그)을 메인 세션의
비싼 모델 대신 **가장 싼 healthy 모델**(무료 로컬 우선)에게 맡깁니다.

```bash
MSG=$(node scripts/xllm.mjs scribe commit) && git commit -m "$MSG"
node scripts/xllm.mjs scribe pr --base main
node scripts/xllm.mjs scribe release --from v0.5.0
node scripts/xllm.mjs scribe notes --from v0.5.0
```

- 결정적 수집기가 diff/log를 모으고(LLM 무관, 24KB 캡), 모델은 **산문만**
  작성하며, git 실행은 항상 사용자/호스트가 합니다. push/tag는 모델 호출
  자체가 없습니다.
- 결정적 검증기가 Conventional Commits 형식·제목 72자·펜스 금지를 검사하고
  교정 재시도 1회 후에도 실패하면 exit 3으로 원문을 반환합니다.
- release/notes는 판단력이 필요하므로 클라우드 모델로 자동 승격됩니다.
- **diff는 어디에도 저장되지 않습니다** — git 객체 자체가 기록입니다. 민감한
  저장소는 scribe를 로컬 모델에 핀하세요:
  `xllm profile set-role scribe ollama:qwen3.6:latest@low`

## 다중 조언 + 합의 깊이

```bash
node scripts/xllm.mjs multi codex@high,gemini "보안 + 설계 리뷰"
```

`--multi` 인덱스에는 호스트를 위한 **종합 계약(synthesis contract)**과 기계
판독용 `.json` 사이드카가 포함됩니다. 호스트는 모든 아티팩트를 읽고 주장별로
라벨을 붙입니다:

| 라벨 | 의미 |
|------|------|
| unanimous | 성공한 모든 어드바이저가 다루고 지지함 |
| majority | 과반 지지, 강한 반대 증거 없음 |
| split | 의견 분열 — 타이브레이커 없이 행동 금지 |
| single-source | 한 어드바이저만 제기 — 단서이지 결론 아님 |

실패한 어드바이저는 기권으로 계산되며, **합의는 신뢰도 메타데이터이지 진리가
아닙니다** — 만장일치도 틀릴 수 있습니다.

## 다양성 계측: 블라인드 패널 + 원장

역할을 나누는 `multi`와 달리, `panel`은 **동일 프롬프트**를 모든 패널리스트에게
블라인드로 보내 모델-다양성 자체를 측정합니다.

```bash
node scripts/xllm.mjs panel run codex,gemini,ollama:qwen3.6:latest "이 접근이 안전한가?"
node scripts/xllm.mjs panel stats          # 누적 쌍별 일치율 (측정된 탈상관)
node scripts/xllm.mjs panel outcome <id> --adopted majority --helpful yes
```

각 패널리스트는 구조화 판정(approve/reject/mixed + 핵심 주장)을 반환합니다.
**원장(`<state>/panel-ledger.jsonl`)이 산문보다 먼저 기록되며** — 요약은 UX일
뿐 원장을 덮어쓸 수 없습니다. 소수 의견은 일급 아티팩트이고, 실패한
패널리스트는 기권입니다. split에서는 `stats`의 **낮은 측정 일치율**로
타이브레이커를 고릅니다 — 벤더 계보가 아니라 측정값으로.

## 다양성 배당 벤치마크 + 증거 기반 라우팅

```bash
npm run bench:live      # 시딩 결함 과제로 single vs panel 검출 비교
node scripts/xllm.mjs contracts --live         # 프로바이더 계약: 플래그 드리프트 + 인증
node scripts/xllm.mjs pick security "auth token race" --json   # capability_floor 포함
```

- **벤치마크**: 알려진 결함을 심은 코드 리뷰 과제로 단일 프로바이더 vs
  블라인드 패널의 검출률을 비교하고, 추가 검출 결함·소요·**쌍별 오류 상관**
  (공유된 맹점)을 보고합니다. 결정적 정규식 채점, 라이브 전용(CI 제외).
- **프로바이더 계약 플로어**: `contracts`가 설치된 CLI의 `--help`에서 xllm이
  의존하는 플래그를 검사해 버전 간 **드리프트를 감지**하고, 실패를
  missing-binary/auth/timeout/transient/permanent로 분류하며, transient에만
  지터 재시도를 겁니다. `--live`는 프로바이더별 실제 인증을 증명합니다.
- **능력 하한**: 초소형 로컬 모델(<4B)은 판단 역할(security/architecture/
  verify/critic)에서 투표권이 거부됩니다("3B 산문 모델의 보안 투표는 노이즈").
  `--allow-below-floor`로 오버라이드.
- **측정 기반 타이브레이커**: split 시 원장의 측정 일치율이 가장 낮은
  미참여 프로바이더를 제안 — 계보 점수 없음.

## 인벤토리·프로젝트 프로파일·비용 라우팅

```bash
node scripts/xllm.mjs inventory                    # 머신 역량 캐시 (24h TTL, --refresh)
node scripts/xllm.mjs profile set-role analysis codex@high    # 이 프로젝트에 역할 핀
node scripts/xllm.mjs profile show
```

- **인벤토리**: 설치된 CLI, 헬스, ollama의 실제 설치 모델 목록을
  `~/.xllm/inventory.json`에 캐시합니다. 클라우드 카탈로그는 의도적으로 열거하지
  않습니다 — 클라우드 READY는 "바이너리 응답"일 뿐, 인증은 `smoke --live`로만
  증명됩니다.
- **비용 메타데이터**: 프로바이더마다 `tier`(strong/balanced/local),
  `relative_cost`(0~10, 상대값 — 절대 가격 아님), `latency_class`를 갖고
  TOML로 재정의할 수 있습니다.
- **라우팅**: 저강도 작업은 저비용(로컬 우선), 고강도 판단 역할
  (security/critic 등)은 strong tier 우선으로 자동 배정됩니다. `[roles]` 핀은
  effort까지 포함해 모든 것을 정확히 덮어씁니다.

```bash
node scripts/xllm.mjs pick security "auth token race" --json
node scripts/xllm.mjs pick-team "결제 웹훅 리팩터링" --json
node scripts/xllm.mjs infer "README 오타 수정"
```

| 역할 | 성향 |
|------|------|
| explore / docs / scribe | 로컬·네이티브, low effort |
| implement / tests | 네이티브 executor 우선 |
| security / architecture | codex, high→xhigh |
| design | antigravity > gemini |
| critic | ollama; 고강도면 클라우드 승격 |

## 스킬

**Grok Build** (`.grok/skills/`):

| 스킬 | 용도 |
|------|------|
| `/ask` | 단일 어드바이저 + 아티팩트 (`--propose` → diff 제안) |
| `/xllm` | 2개 이상 어드바이저 + 합의 라벨 종합 |
| `/ralph` | 증거 수집 반복 루프 (프롬프트 수준 프로토콜) |
| `/verify` | PASS/FAIL 증거 표 |
| `/team` | 병렬 워커 — 반드시 `pick-team` 선행 |
| `/xllm-setup` | 인벤토리 + doctor + 프로젝트별 어드바이저 위저드 |

**Claude Code / Codex** (`skills/` 공유): `ask`, `multi`(패널 포함), `exec`,
`scribe`, `setup` — 크로스-벤더 코어만. 호스트 네이티브와 중복되는 기능은
없습니다.

## CLI 명령 요약

```text
node scripts/xllm.mjs <command>

ask <spec> "<prompt>"        단일 어드바이저 (read-only)
multi p1,p2 "<prompt>"       병렬 다중 어드바이저 + 합의 계약 인덱스(.md/.json)
propose <spec> "<change>"    diff 제안 → artifacts/proposals/*.patch
exec <spec> "<task>"         격리 실행 → refs/xllm/exec/<id> + 증거
exec list | cleanup <id>     실행 목록 / 정리
scribe commit|pr|release|notes   저비용 산문 → stdout (git 실행은 사용자)
panel run p1,p2 "<q>"        블라인드 동일 프롬프트 패널 → 판정 원장
panel stats | outcome <id>   쌍별 일치 행렬 / 결정 채택 기록
contracts [--live]           프로바이더 계약 프로브(플래그 드리프트/실패분류/인증)
inventory [--refresh]        머신 역량 캐시
profile show|set-role|set-default   프로젝트 프로파일
doctor | smoke [--live]      상태 진단 / 스모크
pick|pick-team|infer|roles   역할·강도 라우팅
which | remember             어드바이저 경로 확인 / 마커 기록
clean [--older-than=일수]    아티팩트 삭제
```

안전 플래그: `--allow-write`, `--allow-self`, `--no-artifacts`,
`--sandbox-mode auto|bypass`(exec 전용).

## 아티팩트와 상태 디렉터리

상태 디렉터리 결정 순서: `XLLM_STATE_DIR` → 기존 `.xllm/` → 레거시 `.grok/` →
신규 `.xllm/`. 아티팩트는
`<state>/artifacts/{ask,xllm,ralph,team,verify,proposals,exec}/`에 저장되며
시크릿 마스킹과 자기 무시 `.gitignore`가 적용됩니다. 예외: scribe는 diff를
어디에도 저장하지 않습니다.

## 환경 변수

| 변수 | 용도 |
|------|------|
| `XLLM_STATE_DIR` | 프로젝트 상태 디렉터리 재정의 |
| `XLLM_HOME` | 머신 인벤토리 위치 (기본 `~/.xllm`) |
| `XLLM_EXEC_ROOT` | exec 임시 클론 루트 (기본 OS temp) |
| `XLLM_PROVIDERS_PATH` | 프로파일 TOML 경로 재정의 |
| `XLLM_ADVISOR_PATH` / `XLLM_PLUGIN_ROOT` | 어드바이저 스크립트 해석 |
| `XLLM_ADVISOR_TIMEOUT_MS` | 어드바이저 타임아웃 |
| `XLLM_ALLOW_MUTATION=1` | 어드바이저 쓰기 옵트인 |
| `XLLM_ALLOW_SELF=1` | 동일 벤더 중첩 허용 |
| `XLLM_NO_ARTIFACTS=1` | 아티팩트 저장 생략 |
| `LMSTUDIO_BASE` / `LEMONADE_BIN` | 로컬 서버/바이너리 |

## 개발

```bash
npm test          # 단위 테스트 73개 (라이브 LLM 불필요)
npm run check     # 문법 + 3개 호스트 매니페스트/스킬 정합성 검증
npm run ci        # check + test + smoke
npm run smoke:live   # 선택: 실제 READY 프로바이더로 라이브 스모크
```

## 레이아웃

```text
plugin.json             # Grok Build 매니페스트
.claude-plugin/         # Claude Code 매니페스트 + 마켓플레이스 (플러그인명: xllm)
.codex-plugin/          # Codex 매니페스트 (플러그인명: xllm)
.agents/plugins/        # Codex marketplace.json (자가 호스팅)
skills/                 # Claude Code + Codex 공유 호스트 중립 스킬 5종
scripts/                # 호스트 중립 코어
  grok-ask-advisor.js   #   멀티-LLM 진입점 (ask/propose/multi/inventory/profile)
  xllm-exec.js          #   격리 실행 프리미티브
  xllm-scribe.js        #   저비용 산문 레인
  xllm-routing.js       #   역할/강도/비용 라우팅
  xllm.mjs              #   통합 CLI
  xllm-doctor.js        #   진단
.grok/                  # Grok Build 어댑터 (스킬/에이전트/페르소나/문서)
  xllm-providers.toml   #   프로바이더 프로파일 템플릿
examples/
```

## 범위 (Scope)

**포함**: 크로스-벤더 어드바이저, 로컬 LLM, diff 제안, 단일 태스크 격리 실행,
저비용 산문 레인, 얇은 역할 라우팅.

**불포함(의도적)**: 에이전트 OS 이식, HUD/훅 엔진, 대형 스킬 카탈로그,
xllm 자체 루프/팀/파이프라인, 자동 병합, push/배포, 자격증명 처리 —
오케스트레이션과 조합은 호스트 네이티브 기능의 몫입니다.

상세: [`.grok/docs/SCOPE.md`](.grok/docs/SCOPE.md)

## 라이선스

MIT — [LICENSE](LICENSE) 참조.

## 참고

- **Windows**: antigravity headless 제한 → 선택 시 gemini로 자동 폴백.
- **Windows + exec**: codex의 workspace-write 샌드박스가 임의 디렉터리에
  capability ACL을 만들지 못하는 환경(codex-cli 0.144.1에서 관찰)에서는
  fail-closed로 거부됩니다 — `--sandbox-mode bypass`가 명시적 대안입니다.
- Codex의 로컬 git 마켓플레이스 설치는 **working tree가 아니라 git HEAD**를
  스냅샷합니다 — 로컬 체크아웃에서 설치하려면 먼저 커밋하세요.
