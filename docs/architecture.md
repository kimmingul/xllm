# Architecture — xllm

> `<state>` = project state dir: `.xllm/` (default) or legacy `.grok/` when the project already uses it.

## Principles

1. **Host-native first** — the host CLI (Claude Code · Codex · Grok Build) keeps subagents,
   plan mode, hooks, and all orchestration. xllm adds only what the host structurally cannot:
   other vendors' independent opinions, free local models, and measured diversity.
2. **One multi-LLM door** — every external model call goes through `scripts/xllm-advisor.js`
   (quoting, stdin-vs-argv, Windows shims, timeouts, env sanitization, artifact capture).
   Skills never hand-build `codex exec` / `claude -p` invocations. Each call returns one result
   envelope (`advisor --json`, `schema_version: 2`): `raw` (final response only), `exitCode`,
   `failure`, `artifactPath`, `usage`, `structured`, and an `attribution` block separating what was
   requested (`requested_provider/model`) from what ran (`executed_provider`, `transmitted_model`,
   `reported_model`, `identity_status` = `resolved|mutable|unresolved`, `model_revision`,
   `effective_effort`, `cli_version`, `surface`, `execution_location` = `local|remote|unknown`).
   Missing provider metadata is `null`, never inferred from the request or the answer text.
3. **Artifacts over chat memory** — durable paths under `<state>/artifacts/`; the last stdout
   line of every human-mode command is the artifact/index path (`--json` prints one object instead).
4. **Evidence over claims** — structured verdicts land in the append-only ledger *before* any
   prose; derived views (stats, traits) never write back; no hand-written model lore — measured
   values with sample sizes only. Evidence is keyed strictly by the resolved attribution
   (executed provider, reported model/revision, effective effort, surface, CLI version); bare model
   names, aliases and legacy records are shown but never route.
5. **Thin over clever** — skills are playbooks over scripts; no second agent OS, no loops, no
   orchestration state machines (see [SCOPE.md](./SCOPE.md)).

## Components

```text
┌──────────────────────────────────────────────────────────────┐
│  Host session (Claude Code · Codex · Grok Build)             │
│  shared skills: ask review exec scribe(optional) setup       │
│  (Grok Build adapter: ask · xllm · xllm-setup)               │
└──────────────────────────────┬───────────────────────────────┘
                               │  shell: node scripts/xllm.mjs <command>
                               ▼
   ┌───────────────┬────────────────────┬──────────────┬─────────────────┐
   ▼               ▼                    ▼              ▼                 ▼
 xllm-advisor   xllm-review          xllm-exec      xllm-scribe     xllm-bench
 (ask · propose) (blind · roles;       (ephemeral     (optional       xllm-traits
                  debate/council        clone, OS      cheap git       xllm-routing
                  experimental;         sandbox        prose)
                  dispatches to         verified)
                  xllm-panel/-debate/
                  -council; diff via
                  xllm-diff.js)
   │               │                    │              │
   └───────────────┴──────────┬─────────┴──────────────┘
                              ▼
   cloud CLIs: codex · claude · gemini · grok · antigravity · cursor   (eligible only when read-only is verified)
   local runtimes: ollama (HTTP :11434) · lmstudio (HTTP) · lemonade
                              │
                              ▼
   <state>/artifacts/{ask,xllm,proposals,exec}     (xllm = review roles indexes; per-advisor artifacts hold the prompt)
   <state>/panel-ledger.jsonl                      (append-only verdict ledger; blind/debate/council only)
   <state>/benchmarks/{results,adjudications,cases}  (xllm bench output; same project state dir traits reads)
```

Old top-level nouns `multi`/`panel`/`debate`/`council` were removed in v0.28.0;
`review roles` is the coverage mode (not measured — `measurement: false`
in its index JSON), `review blind` is the default measured mode, and `review debate`/`review council`
are **experimental** (benefit unproven; re-evaluation pending) — they write the ledger too.

## Execution boundaries

- **Read-only is verified, not assumed.** Only adapters whose read-only boundary xllm can verify run
  as default advisors; an installed binary is not an eligible advisor, and `doctor` reports safety
  separately from binary readiness. `--allow-write` is a separate unsafe opt-in.
- **`execution_policy`** (profile `[defaults]`): `any` (default) or `local-only`. Local-only is strict
  and fails closed: location `unknown` is refused, cloud CLIs and `:cloud` models are remote, and no
  `--ready`/`--allow-write` flag bypasses it. Unknown policy values fail closed.
- **Auth is unknown until observed.** Token-free health probes update version/flag status only and
  preserve earlier auth observations with their own timestamp; only an observed failure vetoes a
  provider.
- **Diff review coverage.** `xllm-diff.js` cuts to a 24KB budget at file/hunk boundaries and enumerates
  every omitted file/hunk in a coverage manifest carried by the md index, ledger and `--json` result.
  The ledger/index never contain the diff body, but default per-advisor artifacts hold the full prompt
  (diff included, secrets redacted); `--no-artifacts` suppresses them.

## The measurement loop

Evidence is written once, derived many times, and finally *routes* — only if its model identity
is resolved:

```text
review blind / debate / council ──► <state>/panel-ledger.jsonl ──┐
xllm bench (repeats ≥ 3, held-out) ► <state>/benchmarks/results ─┼──► xllm-traits ──► xllm-routing
contract probes ─────────────────► contract cache ───────────────┘    Wilson 95% LCB,   pick
                                                                      sample sizes      (gates: tasks ≥ 4 ·
                                                                      always visible     opportunities ≥ 12 ·
                                                                                         margin +0.10)
```

What the benchmark measures is what the router does — for strictly attributed evidence. Records without
a resolved identity (legacy results under `benchmarks/results/`, bare specs) are displayed but
non-routing. With no usable evidence, routing stays on the built-in baseline (`--no-traits` disables
measured-quality routing only; observed auth-failure health gating still applies). The live benchmark is opt-in with an explicit budget (`--live --max-calls --deadline-minutes`);
its panel arm is the union of the same single responses, and adoption of a final synthesis is evaluated
separately. Regex hits are candidates until a human adjudicates them. Notable historical findings are in
[benchmarks/FINDINGS.md](../benchmarks/FINDINGS.md) (pre-strict-identity; not routing evidence).

## Layering

| Layer | Surface | Depends on |
|-------|---------|------------|
| L0 | `xllm-advisor.js` — the one door; `xllm-diff.js` — deterministic diff collector (`--staged`/`--base`/`--diff-file`) | Node ≥ 18 + provider CLIs / local runtimes / git |
| L1 | `ask` · `review roles` · `propose` | L0 |
| L2 | `review blind` (· `review debate` · `review council`, experimental) | L0 + structured-output extractor + ledger |
| L2 | `scribe` (optional) | L0 + deterministic collectors/validators |
| L3 | `exec` | L0 + separate-`.git` clone + verified OS sandbox (fail-closed) |
| — | `bench` · `traits` · `pick` | ledger + results (read-only derivation) |

The escalation ladder (`ask` → `propose` → `exec`) grows advisor freedom per rung; power over
the user's checkout stays **zero on every rung** — merge, push, and credentials are host-side.
