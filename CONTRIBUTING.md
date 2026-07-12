# Contributing to xllm

## Read this first — scope is intentional and narrow

See [`.grok/docs/SCOPE.md`](.grok/docs/SCOPE.md).

**In scope:** cross-vendor advisors (ask/multi), local LLMs, the review
family (`panel` / `debate` / `council`), the escalation ladder
(ask → propose → exec), `scribe`, measured routing (ledger/bench/traits),
the seeded-defect benchmark, doctor/contracts.

**Out of scope (deliberate):** hooks engines, HUD, agent-OS runtimes
(ralph/ultrawork/autopilot — host-native features already cover them), full
skill dumps, and any hand-authored model personality/lineage lore. Evidence
must be measured, with sample sizes visible ("no lineage astrology").

## Dev loop

```bash
npm run check     # syntax + host manifest/skill validation
npm test          # unit tests (no live LLMs required)
npm run smoke     # dry-run smoke (no live LLMs; --live opts in)
npm run ci        # check + test + smoke + bench selftest — CI runs the same
```

GitHub Actions mirrors `npm run ci` on ubuntu + windows. A PR is not ready
until `npm run ci` is green locally.

## Working conventions

- **Design before code, adversarially.** Non-trivial designs go through a
  2–3 round cross-vendor adversarial review using xllm's own method
  (independent designs → cross-rebuttal → fact-anchored final round), and
  the converged result lands in `docs/<feature>-design.md`. See
  `docs/debate-design.md`, `docs/tiebreak-design.md`, `docs/traits-design.md`.
- **Evidence discipline.** The panel ledger is append-only; never mutate or
  hand-edit records. `benchmarks/results/`, ledger, and advisor artifacts
  are gitignored operational state. Derived views (stats/traits) never write
  back into evidence streams.
- **CRLF hygiene (Windows).** After editing scripts, normalize line endings:
  `sed -i 's/\r$//' scripts/<file>`.
- **Windows argv limit.** Windows caps a command line at ~32KB. The
  caller→advisor hop escapes it with `--prompt-file <path>` (the structured
  layer switches automatically past ~24KB), but providers whose CLI takes
  the prompt as an argv argument (grok, gemini, …) cannot receive oversize
  prompts at all — the advisor fails fast with `prompt-too-long`. For long
  prompts use a stdin-based provider (codex, claude).
- **New behavior gets tests.** Pure functions preferred; tests use fixtures,
  not disk or live LLMs.

## Release checklist (version bump)

1. Bump the version in ALL of: `package.json`, `plugin.json`,
   `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (two
   fields), `.codex-plugin/plugin.json`, and `VERSION` in
   `scripts/grok-ask-advisor.js`; update the badge in `README.md`.
2. Add a `CHANGELOG.md` entry (what + why + live-verification evidence).
3. `npm run ci` green; live e2e for behavior that has a runtime surface.
4. Commit, then tag: `git tag -a vX.Y.Z -m "xllm vX.Y.Z"` and push the tag.
   Hosts install from git — the tagged commit IS the release artifact.

## Adding a provider

1. `PROVIDER_BINARIES` + `resolveSpawnConfig` in `scripts/grok-ask-advisor.js`
2. Health check if local; contracts probe entry if it has drift-prone flags
3. Unit tests in `scripts/test-advisor.mjs`
4. Doc line in `.grok/docs/local-llms.md` or README

## Changing skills

- Keep skills short and imperative; Claude Code and Codex share `./skills/`.
- Always route external models through `grok-ask-advisor.js`.
- Mention artifact paths; never trust chat alone for completion.

## PR checklist

- [ ] Fits SCOPE.md (thin plugin; no agent-OS features)
- [ ] `npm run ci` green
- [ ] New behavior has tests; evidence-based features expose `n`
- [ ] No secrets or gitignored state (ledger/results/artifacts) committed
- [ ] CHANGELOG entry
