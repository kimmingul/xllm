# Architecture — xllm

> `<state>` = project state dir: `.xllm/` (default) or legacy `.grok/` when the project already uses it.

## Principles

1. **Host-native first** — the host CLI (Claude Code · Codex · Grok Build) keeps subagents,
   plan mode, hooks, and all orchestration. xllm adds only what the host structurally cannot:
   other vendors' independent opinions, free local models, and measured diversity.
2. **One multi-LLM door** — every external model call goes through `scripts/xllm-advisor.js`
   (quoting, stdin-vs-argv, Windows shims, timeouts, env sanitization, artifact capture).
   Skills never hand-build `codex exec` / `claude -p` invocations.
3. **Artifacts over chat memory** — durable paths under `<state>/artifacts/`; the last stdout
   line of every command is the artifact/index path.
4. **Evidence over claims** — structured verdicts land in the append-only ledger *before* any
   prose; derived views (stats, traits) never write back; no hand-written model lore — measured
   values with sample sizes only.
5. **Thin over clever** — skills are playbooks over scripts; no second agent OS, no loops, no
   orchestration state machines (see [SCOPE.md](./SCOPE.md)).

## Components

```text
┌──────────────────────────────────────────────────────────────┐
│  Host session (Claude Code · Codex · Grok Build)             │
│  shared skills: ask review exec scribe setup                 │
│  (Grok Build adapter: ask · xllm · xllm-setup)               │
└──────────────────────────────┬───────────────────────────────┘
                               │  shell: node scripts/xllm.mjs <command>
                               ▼
   ┌───────────────┬────────────────────┬──────────────┬─────────────────┐
   ▼               ▼                    ▼              ▼                 ▼
 xllm-advisor   xllm-review          xllm-exec      xllm-scribe     xllm-bench
 (ask · propose) (roles·blind·        (ephemeral     (cheap git      xllm-traits
                  debate·council;      clone)         prose)         xllm-routing
                  dispatches to
                  xllm-panel/-debate/
                  -council; diff via
                  xllm-diff.js)
   │               │                    │              │
   └───────────────┴──────────┬─────────┴──────────────┘
                              ▼
   cloud CLIs: codex · claude · gemini · grok · antigravity · cursor
   local runtimes: ollama (HTTP :11434) · lmstudio (HTTP) · lemonade
                              │
                              ▼
   <state>/artifacts/{ask,xllm,proposals,exec}     (xllm = review roles indexes)
   <state>/panel-ledger.jsonl                      (append-only verdict ledger; blind/debate/council only)
```

Old top-level nouns `multi`/`panel`/`debate`/`council` were removed in v0.28.0;
`review roles` is the coverage mode (not measured — `measurement: false`
in its index JSON), `review blind`/`review debate`/`review council` write the ledger.

## The measurement loop

Evidence is written once, derived many times, and finally *routes*:

```text
review blind / debate / council ──► <state>/panel-ledger.jsonl ──┐
seeded-defect bench ─────────────► benchmarks/results/*.json ────┼──► xllm-traits ──► xllm-routing
contract probes ─────────────────► contract cache ───────────────┘    Wilson 95% LCB,   pick
                                                                      sample sizes      (gates: tasks ≥ 4 ·
                                                                      always visible     opportunities ≥ 12 ·
                                                                                         margin +0.10)
```

What the benchmark measures is what the router does. With no evidence, routing stays
bit-identical to the legacy baseline (`--no-traits` forces this). Raw bench runs are
gitignored; notable findings are transcribed to [benchmarks/FINDINGS.md](../benchmarks/FINDINGS.md).

## Layering

| Layer | Surface | Depends on |
|-------|---------|------------|
| L0 | `xllm-advisor.js` — the one door; `xllm-diff.js` — deterministic diff collector (`--staged`/`--base`/`--diff-file`) | Node ≥ 18 + provider CLIs / local runtimes / git |
| L1 | `ask` · `review roles` · `propose` | L0 |
| L2 | `review blind` · `review debate` · `review council` | L0 + structured-output extractor + ledger |
| L2 | `scribe` | L0 + deterministic collectors/validators |
| L3 | `exec` | L0 + separate-`.git` clone + OS sandbox (codex/claude only, fail-closed) |
| — | `bench` · `traits` · `pick` | ledger + results (read-only derivation) |

The escalation ladder (`ask` → `propose` → `exec`) grows advisor freedom per rung; power over
the user's checkout stays **zero on every rung** — merge, push, and credentials are host-side.
