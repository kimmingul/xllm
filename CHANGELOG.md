# Changelog

## 0.2.0 — 2026-07-11

### Security / safety (breaking defaults)
- **Advisors run read-only by default.** Removed unconditional approval/sandbox
  bypasses: `codex` now uses `--sandbox read-only` (was
  `--dangerously-bypass-approvals-and-sandbox`), `gemini` drops `--yolo`,
  `antigravity` drops `--dangerously-skip-permissions`, `grok` drops
  `--always-approve`, `cursor` keeps its sandbox (was `--sandbox disabled
  --force --trust`). Opt in with `--allow-write` or `XLLM_ALLOW_MUTATION=1`.
- **Same-provider nesting refused by default** (claude→claude, codex→codex,
  grok→grok detected via host session env). Override: `--allow-self` /
  `XLLM_ALLOW_SELF=1`.
- **Expanded host env sanitization**: also strips `CLAUDECODE_SESSION_ID`,
  `CLAUDE_CODE_SSE_PORT`, `GROK_CLI_SESSION`, `CODEX_SANDBOX`,
  `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`.
- **Artifact privacy**: well-known secret formats (OpenAI/Anthropic keys, AWS,
  GitHub PAT, Slack, Google, JWT) are redacted before persisting; artifacts get
  a self-ignoring `.gitignore`; new `--no-artifacts` / `XLLM_NO_ARTIFACTS=1`
  opt-out and `--clean-artifacts [--older-than=DAYS]` retention command.

### Fixed
- **lemonade without `LEMONADE_BIN` now fails loudly** instead of emitting
  synthetic text with exit 0 (silent-failure removal).
- **`plugin.json` no longer references the non-existent `./.grok/commands/`**;
  `check-plugin` now validates that every manifest path target exists.
- **Routing no longer assumes all providers are installed**: `pick`/`pick-team`
  without `--ready=` now probe installed binaries (and local server health)
  via `detectAvailableProviders()`.
- Doctor output now states explicitly that cloud READY means "binary responds"
  and auth is only proven by `smoke --live`.

### Changed
- **`--multi` runs providers in parallel** (one child process per provider)
  instead of sequentially; the index records per-provider exit codes.
- **Host-neutral state dir**: `.xllm/` is the default for new projects, with
  existing `.grok/` honored (lookup order: `XLLM_STATE_DIR` → `.xllm/` →
  `.grok/`). Applies to profiles, advisor-path marker, and artifacts.
- `CODEX_PLUGIN_ROOT` recognized alongside `GROK/XLLM/OMG/CLAUDE_PLUGIN_ROOT`.
- Docs/skills reword "evidence-gated" claims as prompt-level protocol, not a
  mechanical gate.

## 0.1.1 — 2026-07-10

### Changed
- Rename multi-advisor skill **`/ccg` → `/xllm`** (drop OMC-derived name)
- Artifact dir: `.grok/artifacts/xllm/` (was `ccg/`)

## 0.1.0 — 2026-07-10

Initial public release of **grok-xllm** — multi-LLM orchestration for Grok Build.

### Features
- Headless multi-CLI advisors: `/ask`, `/xllm` via `scripts/grok-ask-advisor.js`
- Spec syntax: `provider[:model][@effort]` (e.g. `codex@high`, `ollama:qwen3.6:latest`)
- Provider profiles: `.grok/xllm-providers.toml`
- Prefer **antigravity** over gemini for design-side defaults (Windows → gemini fallback)
- Role + intensity routing: `scripts/xllm-routing.js` (`pick`, `pick-team`, `infer`)
- Evidence loops: `/ralph`, `/verify`
- Team playbook: `/team` (native subagents + CLI advisors)
- Setup/doctor: `/xllm-setup`, `node scripts/xllm.mjs doctor`
- Local LLMs: ollama, lmstudio, lemonade
- First-class Windows support (`shell:false`, npm `.cmd` shim unwrap)

### Skills
`ask`, `xllm`, `ralph`, `team`, `verify`, `xllm-setup`
