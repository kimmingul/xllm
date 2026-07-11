# Changelog

## 0.12.0 — 2026-07-11

### Added — `debate`: adversarial multi-LLM review
The quality-maximizing complement to the independent `panel`. Where panel
MEASURES diversity (blind, independent), debate SPENDS it: cross-vendor models
see and try to REFUTE each other's claims so plausible-but-wrong ones die and
correct ones survive.

**Designed via xllm's own adversarial method** — codex@high and grok@high each
proposed a design, then rebutted each other over two rounds and converged
(docs/debate-design.md). Notable concessions from that debate: codex dropped
its independent-adjudicator layer (needs 5 distinct providers per claim,
collapses at the realistic N=2–3); grok dropped mechanical vote-counting
("a vote dressed as logic") and the 12-claim cap.

- `xllm debate run p1,p2[,p3] "<question>"`: R0 blind claims → R1 refute
  (foreign claims only, concrete mechanism + falsifier, tagged decisive/soft)
  → R2 defend (holds/amend/concede) → **mechanical classification**
  (SURVIVED / KILLED / UNRESOLVED), order-immune, no judge LLM.
- **Kill power comes from evidence tier, not vendor count**: only a DECISIVE
  falsifier the author can't defeat kills a claim; a SOFT/confabulated attack
  can never kill alone; mere disagreement → UNRESOLVED. Works at N=2.
- Status is a **protocol outcome, not truth** — SURVIVED ≠ proven; nothing is
  auto-applied; ledger (`type: "debate"`) records everything before prose.
- `classifyDebateClaim` is a pure, unit-tested function (the crux of the
  design). New `skills/debate/SKILL.md` for Claude Code + Codex.
- Live e2e (codex vs grok, "is Array.sort() without a comparator safe for
  numbers?"): 6 claims survived, 1 killed — a grok claim overstated with
  "only" was narrowed via `amend` under codex's attack. Tests 90 → 99.

## 0.11.0 — 2026-07-11

### Changed — canonical repository moved to github.com/kimmingul/xllm
The project's home is now **github.com/kimmingul/xllm** (was grok-xllm).
Install commands and manifest `repository`/`homepage` URLs updated
accordingly. Plugin identities are unchanged: `grok-xllm` on Grok Build,
`xllm` on Claude Code / Codex.

### Added — harder/decorrelated benchmark task set
Follow-up to v0.10.0's first finding (frontier models had correlated errors
on well-known defects → no dividend). This adds a task set designed to make
models DIVERGE, to locate where the diversity dividend actually appears.

- `benchmarks/tasks/hard-tasks.json`: 6 tasks, 21 subtle/ambiguous defects
  (floating-point drift, backoff jitter/ceiling, true-LRU recency, interval
  boundary semantics, parseInt radix/NaN/money-float, once-emitter listener
  leak + double-invoke) — the kind of bug where careful reasoning, not
  pattern-matching, decides detection.
- `xllm-bench run --tasks-file <name|path>`: run any task set (bare name
  resolves under `benchmarks/tasks/`). Every defect regex is validated on
  load.
- Empirical finding on this set recorded separately in
  `benchmarks/FINDINGS.md` once the live run completes.

## 0.10.0 — 2026-07-11

### Added — seeded-defect benchmark + evidence-driven routing
Third and final diversity-roadmap improvement: the controlled experiment that
proves or refutes the diversity dividend, plus the routing guards that spend
diversity only where it has decision value.

- `xllm-bench` (scripts/xllm-bench.js) + `benchmarks/tasks/tasks.json`: six
  code-review tasks with KNOWN planted defects (SQLi, XSS, off-by-one, TOCTOU,
  assignment-in-condition, hardcoded secret, missing token expiry, …).
  Compares single-provider vs blind-panel-union detection and reports
  incremental defects, misses, duration, and **pairwise error correlation**
  (shared blind spots — the correlated-failure signal). Deterministic regex
  grading; live providers required, so it runs as `npm run bench:live`, not
  in CI (`bench:selftest` keeps the grader honest in CI).
- Capability floor (`passesCapabilityFloor`, `modelCapability`): tiny local
  models (<4B) are refused a vote on JUDGMENT roles (security/architecture/
  verify/critic) — "a 3B prose model voting on security is noise." Non-judgment
  roles, cloud models, and unknown sizes pass; `--allow-below-floor` overrides.
  `pick` output now carries `capability_floor`.
- Measured-agreement tiebreaker (`suggestTiebreaker`): on a split, suggest an
  unconsulted provider with the LOWEST measured pairwise agreement (from the
  panel ledger) — empirical decorrelation, never lineage. Falls back to the
  strongest unconsulted tier when no agreement data exists.
- Bench excludes crashed providers from the dividend and correlation
  (`valid_comparison` flag) — a model that OOM'd is not a data point; grading
  it as "found 0 defects" would confound the result (found by live e2e).

### First empirical finding (docs/diversity-roadmap.md §7)
The instrument's first valid run (codex vs grok, 11 seeded defects) measured
**pairwise error correlation 1.0** — both frontier vendors caught the same 10
defects and missed the identical one, so the panel added zero. On well-known
defect classes, cross-vendor diversity was theater. This does not refute the
mission; it sharpens it: spend diversity only where decorrelation is MEASURED
(`panel stats`), not assumed. The honest, uncomfortable first measurement is
itself the differentiator from "claims benefits without evidence."

## 0.9.0 — 2026-07-11

### Added — blind same-prompt panel + claim/agreement ledger
Second diversity-roadmap improvement: the measurement instrument that
separates model-diversity from prompt-diversity.

- `xllm panel run p1,p2[,p3] "<question>"` (scripts/xllm-panel.js): every
  panelist gets the IDENTICAL prompt, blind, and must end with a structured
  verdict json (approve/reject/mixed + confidence + key claims, own words).
  Deterministic extraction; one corrective retry for protocol violations
  (small local models need it — observed live).
- **Record-before-narrative**: append-only ledger
  (`<state>/panel-ledger.jsonl`) written before the human index; the index
  presents the ledger table first (minority verdicts flagged) and instructs
  the host that prose synthesis is UX and may not override the ledger.
  Outcomes are separate records, never mutations.
- **Abstentions never agree**: failed/invalid panelists yield null pairwise
  entries; consensus labels (unanimous/majority/split/single-source/
  no-verdicts) computed over valid verdicts only.
- `xllm panel stats`: cumulative pairwise agreement matrix — the measured
  decorrelation source for tiebreaker choice (never lineage metadata).
- `xllm panel outcome <run-id> --adopted … --helpful yes|no`: the decision
  adoption loop ("the missing dependent variable").
- Local-runtime lane management: panelists sharing a local provider run
  sequentially with `ollama stop` unloads in between (live-observed CUDA
  OOM when two models load at once).

### Fixed (found by live e2e)
- `rawFromArtifact` truncated raw output at the first inner fenced block —
  the verdict json never reached the extractor; now anchored on the trailing
  Summary heading.
- Verdict JSON with terminal-wrapped newlines inside string literals
  (ollama TTY) is repaired before parsing.

Live e2e: llama3.2 + gemma4 blind panel → both reject → unanimous; ledger,
pairwise matrix, corrective retry, model unload, and outcome recording all
exercised for real. Tests 77 → 83.

## 0.8.0 — 2026-07-11

### Added — minimal executable provider contract floor
First of three approved diversity-roadmap improvements
(docs/diversity-roadmap.md): the hygiene layer that makes later diversity
experiments trustworthy. Deliberately thin.

- `xllm contracts [--live] [--json]` (scripts/xllm-contracts.js):
  - **Token-free capability probes** — checks each installed CLI's `--help`
    for the exact flags xllm spawns with (codex `--sandbox/--cd/-c`, claude
    `-p/--model/--permission-mode`, grok `--reasoning-effort`, …) and records
    the CLI version → **flag-drift detection** (exit 2 on drift). Live-tested
    against the 5 installed CLIs on this machine.
  - **Opt-in live auth mini-call** (`--live`) — one tiny prompt per healthy
    cloud provider proves auth (READY only means "binary responds");
    same-vendor host skipped; report cached at `~/.xllm/contracts.json`.
- **Structured failure taxonomy** in the core (`classifyFailure`):
  missing-binary / timeout / auth / transient / permanent / ok, from stderr
  patterns — pure and fixture-tested. Advisor failures now print their class
  and a hint.
- **Bounded jittered retry** (`withRetry`): transient failures only
  (429/5xx/network), max 2 attempts, wired into the real advisor spawn path.
  Auth/timeout/permanent failures are never retried.

## 0.7.0 — 2026-07-11

### Added — scribe: cheap-prose lane for git chores
Mechanical git prose (commit messages, PR bodies, release notes, changelog
entries) no longer burns expensive main-session tokens. Design adopted after
cross-vendor consultation (codex@high + grok@high unanimous: prose to the
cheapest model, execution stays deterministic/host-side; direct git
delegation rejected).

- `xllm scribe commit|pr|release|notes`: deterministic collectors gather
  staged diff / commit ranges (24KB cap with truncation marker, no LLM),
  strict prompt templates constrain the output (Conventional Commits, section
  contracts, "only facts present in the input"), and deterministic validators
  check the result (subject ≤72, type allowlist, no fences) with one
  corrective retry; exit 3 hands back raw text for review.
- New routing role `scribe`: local-first (free ollama/lmstudio), effort low;
  `release`/`notes` auto-escalate off local models when a cloud advisor is
  healthy. Pinnable per project (`--set-role scribe …`).
- Privacy: the diff is sent only to the routed advisor and never persisted
  (no artifact) — the git object itself is the record.
- Message → stdout for direct piping (`git commit -m "$(xllm scribe commit)"`);
  diagnostics → stderr. xllm never runs git/gh; push/tag need no model at all.
- `runAdvisor` gains a `quiet` option (library callers keep stdout clean).
- New `skills/scribe/SKILL.md`; live e2e: free llama3.2 drafted a commit
  message for a real staged diff — first attempt rejected by the validator
  (75-char subject), corrective retry passed, message used for an actual
  commit.

## 0.6.0 — 2026-07-11

### Added — isolated executor primitive (`exec`)
Third rung of the escalation ladder: ask (opinion) → propose (static diff) →
**exec (verified branch)**. Design adopted after a cross-vendor consultation
(codex@high + grok@high independently converged on "single exec primitive
under strict isolation; no loops/teams/pipelines").

- `xllm exec <spec> "<task>" [--test-cmd …]`: the foreign-vendor CLI executes
  in an **ephemeral local clone** (separate .git — it cannot pollute the main
  repo's refs/config/hooks), on branch `xllm/exec/<id>`. The user's checkout,
  branches, index, and config are never touched.
- Deliverable: ref fetched back as `refs/xllm/exec/<id>` (fetch adds objects
  only — working tree untouched) + `.patch` sidecar + evidence artifact with
  deterministic post-run verification (`--test-cmd` run by xllm, not trusted
  from the executor) and honest statuses: green / not-green / no-change /
  timeout. Partial work is handed back with failing evidence, never silently.
- Capable providers only: codex (`--sandbox workspace-write`), claude
  (`--permission-mode acceptEdits`, documented weaker). Unsandboxed CLIs
  (gemini/grok/cursor) and pure text models (ollama/lmstudio) are refused —
  a cwd change plus a warning is not a sandbox.
- **Fail-closed sandbox preflight** (token-free `codex sandbox` write probe):
  on machines where codex's Windows workspace-write sandbox lacks capability
  ACLs for the clone (observed on codex-cli 0.144.1 for arbitrary temp
  dirs), exec refuses; `--sandbox-mode bypass` is an explicit informed
  opt-in to clone-level (workflow) isolation only.
- Main-repo tamper tripwire: HEAD + status snapshot before/after execution,
  surfaced in the evidence artifact.
- Same-vendor nesting refused; env sanitization reused; merge/push/creds
  host-side; registry + `exec list` / `exec cleanup <id>|--all` GC.
- New `skills/exec/SKILL.md` (Claude Code + Codex hosts); deliberately NOT
  shipped: loops, teams, pipelines, auto-merge — composition belongs to
  host-native agents.

## 0.5.0 — 2026-07-11

Three improvements approved after a cross-vendor design review (codex@high +
grok@high independent evaluations, unanimous on scope).

### Added — machine inventory + per-project advisor profile
- `--inventory [--refresh]` / `xllm inventory`: machine capability cache at
  `~/.xllm/inventory.json` (24h TTL) — installed CLIs, health, tier/cost
  metadata, and actually-pulled ollama models. Cloud model catalogs are
  deliberately not enumerated (auth only proven by `smoke --live`).
- Coarse cost metadata per provider (`tier` strong/balanced/local,
  `relative_cost` 0–10, `latency_class`), TOML-overridable; deliberately
  relative — no absolute prices.
- Project role pins: `[roles]` table (`analysis = "codex@high"`) via
  `--set-role` / `--set-default` / `--profile-show` (`xllm profile …`),
  written with a comment-preserving line-based TOML upsert. Pinned roles
  bypass routing reorder and intensity effort-bumping.
- Cost-aware routing: low-intensity roles sort candidates by relative cost
  (local models first), high-intensity judgment roles sort by tier strength;
  `pick` output now includes `pinned` and `cost` metadata.
- setup skills rewritten as a per-project wizard: inventory → recommendations
  (host analyzes the project locally; repo contents never sent to advisors) →
  host-native Q&A (AskUserQuestion on Claude Code, "(Recommended)" first) →
  `--set-role` persistence. Empty project → ask the user to describe it.

### Added — consensus-depth synthesis
- `--multi` index now includes a synthesis contract (unanimous / majority /
  split / single-source label definitions, advisor citations, "failed
  advisors are abstentions", "consensus is confidence metadata, not truth",
  split → tiebreaker from an unconsulted vendor) plus a machine-readable
  `.json` sidecar (specs, exit codes, artifact/patch paths, labels).
- multi/xllm skills synthesize with labeled claims instead of a flat
  agreed/disagreed list.

### Added — proposal mode (file work, advisors stay read-only)
- `--propose` / `xllm propose`: wraps the request in a change-proposal
  contract (rationale + exactly one unified-diff block, no apply claims);
  artifact under `artifacts/proposals/` with an extracted `.patch` sidecar
  and a `git apply --check` hint. Works through `--multi` for N candidate
  patches (cheap models draft, strong model judges). Application is always
  host/user-side after review.

## 0.4.0 — 2026-07-11

### Added
- **Codex adapter** (`.codex-plugin/plugin.json` +
  `.agents/plugins/marketplace.json`): the same `ask` / `multi` / `setup`
  skills load in Codex from the shared `./skills/` directory. Install:
  `codex plugin marketplace add <repo>` → `codex plugin add xllm@xllm`.
  Manifest format verified against Codex CLI 0.144 installed plugins
  (visualize, superpowers), not guessed.
- Skills rewritten host-neutral: advisor script resolution documented per
  host (`CLAUDE_PLUGIN_ROOT` on Claude Code, plugin-root-relative on Codex,
  `.xllm/xllm-advisor-path` marker anywhere); same-vendor refusal wording
  generalized (no codex advisor inside Codex, etc.).
- `check-plugin` validates the Codex adapter (manifest parse, name/version
  sync, skills dir, interface block, marketplace self-hosting) and that
  shared skills document non-Claude plugin-root resolution.

### Fixed
- `cleanModelText` now strips all ANSI CSI/OSC escape sequences (cursor
  moves, erase, private modes like `[?25h` from ollama pull spinners), not
  just SGR color codes — found via live install e2e where spinner control
  codes leaked into artifact summaries.

### Notes (verified against Codex CLI 0.144.1)
- `codex plugin marketplace add <local-git-repo>` snapshots **git HEAD**,
  not the working tree — commit before installing from a local checkout.
- When `.codex-plugin/plugin.json` is absent, Codex falls back to reading
  `.claude-plugin/plugin.json` (Claude-plugin compatibility).

## 0.3.0 — 2026-07-11

### Added
- **Claude Code adapter** (`.claude-plugin/plugin.json` +
  `.claude-plugin/marketplace.json` + `skills/`): namespaced skills
  `/xllm:ask`, `/xllm:multi`, `/xllm:setup` over the same host-neutral core.
  Install: `/plugin marketplace add kimmingul/grok-xllm` →
  `/plugin install xllm@xllm`.
- Deliberately NOT ported to Claude Code: `/ralph`, `/team`, `/verify`,
  agents, personas — Claude Code's native agents/tasks/verification cover
  those; porting them would recreate redundant-orchestration overhead.
- `check-plugin` now validates the Claude adapter (manifest/marketplace
  parse, version sync with package.json, skill frontmatter,
  CLAUDE_PLUGIN_ROOT wiring, read-only language).

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
