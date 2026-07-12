<div align="center">

# xllm

### 하나의 세션에서 모든 모델을. 크로스-벤더 LLM 다양성.

에이전틱 코딩 도구(Claude Code · Codex · Grok Build)는 제조사 단일 LLM에 락인됩니다.
**xllm**은 다른 벤더와 로컬 모델을 그 세션 안으로 불러옵니다 — 기본은 read-only.

**[🌐 소개 페이지](https://kimmingul.github.io/xllm/)** · **v0.17.0** · MIT

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

## 벤치마크 — "우리는 측정했습니다"

xllm은 **자기 핵심 주장을 반증할 수 있는** 시딩 결함 벤치마크를 내장합니다. 알려진 결함을 심은
코드 리뷰 과제에서 단일 프로바이더 vs 블라인드 패널의 검출률과 **쌍별 오류 상관**을 비교합니다.

### 첫 실측 결과 (codex vs grok, 11개 결함)

| 리뷰어 | 검출 | 놓침 |
|--------|------|------|
| codex (단독) | 10 / 11 | `no-fail-return` |
| grok (단독) | 10 / 11 | `no-fail-return` |
| 패널 (합집합) | 10 / 11 | `no-fail-return` |

**쌍별 오류 상관 = 1.0, 추가 검출 = 0.** 서로 다른 벤더(OpenAI codex, xAI grok)인데도 잘 알려진
결함 클래스에서는 오류가 완벽히 상관되어, 크로스-벤더 다양성이 여기서는 연극이었습니다 —
앙상블 이론이 "오류가 탈상관일 때만 다양성이 배당을 낸다"고 예측한 그대로입니다.

이것은 미션의 기각이 아니라 **정밀화**입니다. xllm의 답은 **탈상관이 측정된 곳에만 다양성을 쓰는
것**입니다: 패널 원장이 쌍별 일치율을 추적하고, 타이브레이커는 측정된 일치율이 **가장 낮은**
모델로 갑니다 — 벤더 계보가 아니라 측정값으로. 자기 제품의 주장을 반증할 수 있는 계측기,
이것이 "증거 없이 이득을 주장"하는 도구와의 정직한 차이입니다.

```bash
npm run bench:live                                    # 기본 세트(잘 알려진 결함)
node scripts/xllm-bench.js run --providers codex,grok --tasks-file hard-tasks   # 어려운/탈상관 세트
```

전체 기록: [`benchmarks/FINDINGS.md`](benchmarks/FINDINGS.md) · [`docs/diversity-roadmap.md`](docs/diversity-roadmap.md)

---

## 핵심 기능

| 기능 | 설명 |
|------|------|
| **블라인드 패널 (`panel`)** | 동일 프롬프트를 N개 모델에 블라인드로 보내 **다양성을 측정**. 구조화 판정이 산문보다 먼저 append-only 원장에 기록되고, 누적 쌍별 일치 행렬을 제공. |
| **측정 타이브레이커** | 패널이 **split**이면 원장의 실측 일치율이 가장 낮은 **미참여** 프로바이더를 자동 선정(혈통 아님) — 제안은 항상 무료 기록, 실제 추가 호출은 `--tiebreak` 옵트인. 타이브레이크의 쌍별 행이 다시 원장에 쌓여 **다음 선정의 근거**가 됨(측정→라우팅 루프 폐쇄). |
| **특성 프로파일 (`traits`)** | 원장·벤치마크·계약 캐시에서 **실측 특성만** 파생(손으로 쓴 모델 인상론 금지, 표본 수 상시 노출). 판단 역할 라우팅은 시딩 결함 검출률의 **Wilson 95% 하한**을 공유 결함셋 게이트(과제≥4·기회≥12·+0.10) 하에 소비 — 측정이 tier/비용 경계를 넘을 수 있음. 증거 없으면 기존 라우팅과 비트 동일. `--no-traits`로 비활성. |
| **적대적 검토 (`debate`)** | 크로스-벤더 모델이 서로 **반박**해 틀린 주장을 죽이고 **품질로 수렴**. decisive falsifier만 KILL, 단순 이견은 UNRESOLVED. judge LLM 없는 기계적 판정. 이 기능 자체가 xllm 적대 방식으로 설계됨. |
| **2단계 파이프라인 (`council`)** | `panel`(독립 발산) → `debate`(적대 수렴)을 한 명령으로. 독립적으로 도출된 주장을 반박 검증 → survived/killed/unresolved. 최고 중요도 결정용. |
| **합의 깊이 종합** | 주장별로 만장일치/다수결/의견분열/단일출처 라벨. 실패 어드바이저는 기권. 합의는 신뢰도 메타데이터이지 진리가 아님. |
| **비용 인지 라우팅** | 가벼운 일은 무료 로컬·low effort, 무거운 판단은 strong tier. 초소형 로컬 모델은 판단 역할 투표권 거부(능력 하한). |
| **scribe** | 커밋 메시지·PR 본문·릴리스 노트를 가장 싼 healthy 모델이 작성, 결정적 검증. 기계적 작업에 SOTA 요금을 쓰지 않음. |
| **구조화 출력 견고성** | 검토 계열(panel/debate/council)의 JSON 계약 파싱을 견고한 단일 추출기로 통합(맨 JSON·트레일링 콤마·줄바꿈 래핑 처리) + 비준수 시 1회 교정 재시도. 프로바이더별 **계약 준수도**(first/retry/failed) 리포트로 약한·로컬 모델도 안정 참여. |
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

Claude Code와 Codex는 동일한 호스트 중립 스킬 7종(`ask`, `multi`, `debate`, `council`, `exec`, `scribe`, `setup`)을
`./skills/`에서 공유합니다. 팀·루프·플래닝·검증은 **의도적으로 포팅하지 않았습니다** — 호스트
네이티브 기능이 이미 담당합니다. 플러그인 이름: Grok Build에서 `grok-xllm`, Claude/Codex에서 `xllm`.

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

## CLI 명령 요약

```text
node scripts/xllm.mjs <command>

ask <spec> "<prompt>"        단일 어드바이저 (read-only)
multi p1,p2 "<prompt>"       병렬 다중 어드바이저 + 합의 계약 인덱스
panel run p1,p2 "<q>" [--tiebreak] [--ready=a,b]
                             블라인드 독립 패널 → 판정 원장 (다양성 측정);
                             split이면 실측 일치율 최저 미참여 모델을 타이브레이커로
                             제안(무료)·실행(--tiebreak 옵트인)
panel stats | outcome <id>   쌍별 일치 행렬(+tiebreak 행 합산) / 결정 채택 기록
debate run p1,p2 "<q>"       적대적 검토: 모델이 서로 반박 → survived/killed/unresolved (품질 극대화)
council run p1,p2 "<q>" [--tiebreak] [--ready=a,b]
                             2단계 파이프라인: panel(독립) → debate(적대) 한 번에;
                             1단계 split 시 타이브레이커 주장이 2단계에 저자로만 참여
propose <spec> "<change>"    diff 제안 → artifacts/proposals/*.patch
exec <spec> "<task>"         격리 실행 → refs/xllm/exec/<id> + 증거
scribe commit|pr|release|notes   저비용 산문 → stdout (git 실행은 사용자)
traits [--json]              실측 특성 프로파일(원장/벤치/계약 파생, 표본 수 노출)
contracts [--live]           프로바이더 계약 프로브(드리프트/실패분류/인증)
inventory [--refresh]        머신 역량 캐시
profile show|set-role|set-default   프로젝트 프로파일
doctor | smoke [--live]      상태 진단 / 스모크
pick|pick-team|infer|roles   역할·강도·비용 라우팅 (+실측 특성; --no-traits로 레거시)
```

스펙 문법: `provider[:model][@effort]` — 예: `codex@high`, `claude:opus@medium`,
`ollama:qwen3.6:latest`.

---

## 개발

```bash
npm test          # 단위 테스트 121개 (라이브 LLM 불필요)
npm run check     # 문법 + 3개 호스트 매니페스트/스킬 검증
npm run ci        # check + test + smoke + bench selftest
npm run bench:live   # 시딩 결함 다양성 벤치마크 (라이브 프로바이더 필요)
```

**레이아웃**

```text
.claude-plugin/ .codex-plugin/ .agents/   3개 호스트 매니페스트
skills/                                    Claude Code + Codex 공유 스킬 7종
scripts/  grok-ask-advisor.js  xllm-exec.js  xllm-scribe.js
          xllm-panel.js  xllm-debate.js  xllm-council.js  xllm-contracts.js  xllm-bench.js
          xllm-structured.js  xllm-routing.js  xllm-traits.js  xllm.mjs
benchmarks/  tasks/  FINDINGS.md            시딩 결함 벤치마크
docs/  index.html  diversity-roadmap.md     소개 페이지 + 로드맵
.grok/  skills/ agents/ personas/ docs/     Grok Build 어댑터
```

---

## 범위 (Scope)

**포함**: 크로스-벤더 어드바이저, 로컬 LLM, diff 제안, 단일 태스크 격리 실행, 저비용 산문 레인,
비용 라우팅, 다양성 계측(패널·원장·벤치마크), 경계가 명확한 심의(적대적 debate, 2단계 council).

**불포함(의도적)**: 에이전트 OS 이식, HUD/훅 엔진, 대형 스킬 카탈로그, xllm 자체 **무한 루프·자율 팀·
오케스트레이션 상태기계**(autopilot류), 자동 병합, push/배포, 자격증명 처리, 다수결 자동 적용
("투표=진리" 엔진) — 실행 오케스트레이션과 다중 태스크 조합은 호스트 네이티브의 몫입니다.
(debate/council은 한 질문에 대한 **유한한** 심의 파이프라인이지 실행 루프가 아닙니다.)

## 라이선스

MIT — [LICENSE](LICENSE)
