# v0.27 backlog — review-family polish

> v0.26.0 최종 whole-branch 리뷰에서 이월된 항목들 (출처: 태스크별 리뷰 + 최종 리뷰 triage).
> 전부 소형 — 적대 설계 리뷰 불요, 항목별 TDD로 바로 구현 가능.

## 핵심 (기능/일관성)

1. **prompt-file 임계값 상수 통일** — advisor `--multi`의 temp-file 가드는 `24 * 1024`(24576자,
   `xllm-advisor.js`), structured 레이어는 `PROMPT_FILE_THRESHOLD = 24000`(`xllm-structured.js`).
   둘 다 문자 기반(윈도우 argv 한계 단위로 올바름)이지만 상수가 달라 드리프트 위험.
   → 한 곳(structured가 자연스러움)에서 export해 공유. 단, advisor→structured import는
   사이클(structured가 advisor를 import)이므로 방향 주의: 상수를 xllm-diff.js(무의존)나
   별도 소형 모듈로 옮기는 편이 안전.
2. **`--base <ref>` 의미론 결정 (사용자 판정 필요)** — 현재 `git diff <ref>`(two-dot,
   워킹트리 비교, 미커밋 변경 포함). 브랜치 리뷰 용도로는 merge-base(three-dot) 기대가 흔함.
   → 옵션 A: 현행 유지 + README/스킬에 한 줄 명시. 옵션 B: `<ref>...HEAD`로 변경(또는
   `--base-merge` 추가). 결정 후 `collectReviewDiff` + 문서.
3. **R2 defend 프롬프트에 diff 컨텍스트 부재** — R0 주장·R1 반박은 diff를 보지만
   `buildDefendPrompt`는 claim+attacks만. 코드 리뷰 debate에서 저자가 코드 없이 방어하는 비대칭.
   → 컨텍스트 추가(비용 증가) 또는 skills/review + README에 비대칭 명시 중 택일.
4. **parseDiffFlags error-UX** — `--base --tiebreak`처럼 플래그형 토큰을 ref 값으로 수용해
   "unknown ref: --tiebreak"라는 혼란스러운 에러. → 값이 `--`로 시작하면 "missing value" 에러.

## 소형 (정리)

5. truncateDiff 마커의 바이트 수치가 경계 바이트 제거분만큼 과소 표기 (표시 전용).
6. byteSlice 경계의 원본 U+FFFD 문자를 절단 아티팩트로 오인 제거 (극히 드묾).
7. collectReviewDiff: git 바이너리 부재와 not-a-repo가 같은 에러 메시지.
8. windowsHide: xllm-review.js spawn엔 있고 xllm.mjs run()엔 없음 — 통일.
9. `.grok/skills/xllm/SKILL.md`: `<xllm.mjs>` 플레이스홀더가 정의(~84행)보다 먼저 사용(~50행).
10. runDebate/runDebateOnClaims의 promptQuestion 합성 중복 — 공유 헬퍼 고려.

## 예약 (v0.28.0)

- 구 명칭 alias 제거: `multi`/`panel`/`debate`/`council` 톱레벨 케이스 + xllm.mjs 도움말의
  유예 문구 + README/docs의 "v0.27.x까지" 언급 일괄 정리. discipline 블록은 v2 그대로 유효.

## 참고 (별도 트랙, polish 아님)

- council 모드 라이브 벤치 미측정 (debate만 측정됨) — benchmarks/FINDINGS.md open item.
- 고효율 mid-tier no-dominator 패널 재실행으로 +2 배당 성장 여부 확인.
