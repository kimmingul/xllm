# CLAUDE.md — xllm

먼저 읽기: CONTRIBUTING.md(개발 루프·릴리스 체크리스트·관례) · docs/SCOPE.md(만들지 않을 것).

## 명령

- `npm run ci` — check+test+smoke+bench selftest. 라이브 LLM 없이 통과해야 하며 GitHub Actions와 동일 구성
- `npm test` — 순수 함수 + 픽스처만(디스크/라이브 금지). 파괴적 동작 테스트는 격리가 실제로 작동했는지 단언할 것(XLLM_STATE_DIR 패턴)
- 릴리스 = CONTRIBUTING 체크리스트 + 주석 태그 `vX.Y.Z` + `gh release create`(CHANGELOG 발췌를 노트로)

## 구조

- 어드바이저 진입점은 `scripts/xllm-advisor.js` 하나 (grok-ask-advisor.js shim은 v0.21.0에서 제거됨)
- 런타임 상태는 `.xllm/`(panel-ledger.jsonl·artifacts·xllm-providers.toml); `.grok/`은 Grok Build 어댑터 전용
- 증거는 append-only, 파생 뷰(stats/traits)는 절대 역기록 금지, 손으로 쓴 모델 인상론 금지(실측+표본 수 노출)

## 관례

- 비자명 설계는 codex@high×grok@high 적대 리뷰 2–3라운드(마지막 라운드는 검증된 코드 사실로 앵커) → docs/<feature>-design.md에 수렴 기록, 잔여 쟁점은 사용자 판정
- 프로토콜/전송 변경은 테스트만으로 출하 금지 — 라이브 e2e 후 출하

## 함정 (실측으로 진단됨)

- Windows argv ~32KB: 긴 프롬프트는 `--prompt-file`(검토 계열은 24KB 초과 시 자동 파일 경유); grok/gemini는 argv 전달이라 회피 불가, codex/claude는 stdin
- ollama는 HTTP API(localhost:11434)로 호출; `ollama list/stop`은 CLI 유지. `ollama ps`가 비었는데 cudaMalloc OOM이면 서버가 wedge된 것 — 재시작이 해법
- 양쪽 모델이 같은 단계에서 두 번 연속 실패하면 모델이 아니라 공유 전송층을 의심할 것
