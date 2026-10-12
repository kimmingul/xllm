# Getting started — xllm

한 저장소, 세 호스트(Claude Code · Codex · Grok Build). Node ≥ 18과 사용할 어드바이저 CLI만
있으면 됩니다.

## 1. 플러그인 설치

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

## 2. 셋업

Claude Code / Codex에서는 `setup` 스킬(`/xllm:setup`), Grok Build에서는 `/xllm-setup`을 실행하세요 —
머신 인벤토리 스캔 → 프로젝트 마커 생성 → 역할별 어드바이저 핀 Q&A까지 안내합니다.

CLI로 직접 하려면:

```bash
node scripts/xllm.mjs doctor      # 프로바이더 + 경로 건강 진단
node scripts/xllm.mjs remember    # .xllm/ 마커 + 아티팩트 디렉토리 생성
```

다른 프로젝트에서 쓸 때:

```bash
node /path/to/xllm/scripts/xllm.mjs remember
```

READY 상태의 어드바이저가 **최소 1개** 필요합니다. 설치 상세는 [install.md](./install.md),
로컬 모델은 [local-llms.md](./local-llms.md)를 보세요.

## 3. 핵심 루프

**필요한 만큼만 올라갑니다:** 호스트 단독 → `ask`로 다른 벤더 1명 → 여러 모델의 독립 의견이 필요할 때
`review blind`. debate/council은 **실험 기능**(이득 미입증, 재평가 보류)이라 고위험 결정의 근거로 쓰지 않습니다.

호스트 안에서 스킬로:

```text
/xllm:ask     codex에게 scripts/xllm-advisor.js를 5줄로 요약해달라고 해줘
/xllm:review  ollama:qwen3.6:latest와 codex에게 advisor 스크립트를 블라인드로 보안 리뷰해줘
```

CLI로 직접:

```bash
node scripts/xllm.mjs ask codex@high "이 설계를 리뷰해줘"
node scripts/xllm.mjs review blind codex,grok "이 캐시 설계가 동시성에 안전한가?"
```

전체 명령(심의 `review blind`/`roles`, 실험적 `debate`/`council`, 선택 기능 `scribe`, 계측 `traits`·`bench` 등)은
[README 명령 레퍼런스](../README.md#명령-레퍼런스)를 보세요. 코드를 외부로 보내고 싶지 않다면
`profile set-default execution_policy local-only`(위치가 검증된 로컬 provider만 허용, unknown은 거부).

## 4. 에스컬레이션 사다리

```text
ask      의견 — read-only 아티팩트 (`--json`이면 attribution 포함 JSON 한 개)
propose  정적 diff — .patch 반환, 적용은 항상 사용자
exec     검증된 OS 샌드박스의 격리 클론에서 편집→테스트 — 검증된 브랜치(refs/xllm/exec/<id>) 반환
```

어느 단에서도 어드바이저는 당신의 체크아웃을 만질 수 없습니다.

## 멘탈 모델

- **호스트 CLI** = 지휘자 (도구, 편집, 종합)
- **어드바이저 CLI** = 초빙 비평가 (읽기 전용 경계가 검증된 어댑터만 — 설치 ≠ 적격)
- **원장·벤치마크** = 합의는 신뢰도 메타데이터이지 진리가 아님 — 모델 정체성이 resolved인 증거만 라우팅에 반영됩니다

더 보기: [SCOPE.md](./SCOPE.md) · [architecture.md](./architecture.md) ·
[install.md](./install.md) · [local-llms.md](./local-llms.md)
