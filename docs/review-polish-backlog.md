# v0.27 backlog — review-family polish

> v0.26.0 최종 whole-branch 리뷰에서 이월된 항목들 (출처: 태스크별 리뷰 + 최종 리뷰 triage).
> **상태: 1–10 전부 구현 완료 (2026-07-18, 항목별 TDD).** 아래는 결정 기록.

## 핵심 (기능/일관성) — 완료

1. ✅ **prompt-file 임계값 상수 통일** — `PROMPT_FILE_THRESHOLD = 24000`을 무의존 모듈
   `xllm-diff.js`로 이동(단일 출처), structured는 re-export, advisor `--multi`의
   `24 * 1024` 리터럴을 공유 상수로 교체.
2. ✅ **`--base <ref>` 의미론 — 현행 two-dot 유지 + 문서화 (사용자 판정)** —
   `git diff <ref>`(워킹트리 비교, 미커밋 포함) 유지. README·skills/review·.grok 스킬에
   "merge-base 삼점 비교가 아님"을 명시. 시맨틱 변경/`--base-merge` 추가는 하지 않음.
3. ✅ **R2 defend에 diff 컨텍스트 추가 (사용자 판정)** — `buildDefendPrompt(claim, attacks,
   question)`으로 R0/R1과 같은 promptQuestion(질문+diff)을 방어자에게도 제공.
   비용 증가(diff 크기만큼)를 감수하고 대칭 확보.
4. ✅ **parseDiffFlags error-UX** — `--base`/`--diff-file` 값이 `--`로 시작하면
   "requires a ref/path" 에러 (git ref는 `-`로 시작할 수 없음).

## 소형 (정리) — 완료

5. ✅ truncateDiff 마커가 경계 후퇴분 포함 정확한 제거 바이트 수를 표기.
6. ✅ byteSlice의 U+FFFD 스트립 제거 — 절단점을 코드포인트 경계로 후퇴시키는 방식으로
   재구현, 원본 U+FFFD 보존.
7. ✅ collectReviewDiff: git 바이너리 부재(`git binary not found on PATH`)와
   not-a-repo를 구분.
8. ✅ windowsHide: xllm.mjs run()에도 추가 — spawn 계열 전부 통일.
9. ✅ `.grok/skills/xllm/SKILL.md`: `<xllm.mjs>` 정의를 첫 사용(3단계) 앞으로 이동.
10. ✅ promptQuestion 합성 중복 → `questionWithContext()` 헬퍼(xllm-diff.js),
    debate×2 + panel×1 교체.

## 예약 (v0.28.0)

- 구 명칭 alias 제거: `multi`/`panel`/`debate`/`council` 톱레벨 케이스 + xllm.mjs 도움말의
  유예 문구 + README/docs의 "v0.27.x까지" 언급 일괄 정리. discipline 블록은 v2 그대로 유효.

## 참고 (별도 트랙, polish 아님)

- council 모드 라이브 벤치 미측정 (debate만 측정됨) — benchmarks/FINDINGS.md open item.
- 고효율 mid-tier no-dominator 패널 재실행으로 +2 배당 성장 여부 확인.
