---
name: team
description: >
  Practical parallel execution with automatic model/effort routing by role and
  task intensity. Native spawn_subagent + CLI advisors (via xllm-routing +
  grok-ask-advisor), coordinated with todo_write.
argument-hint: "[N] <task>"
user-invocable: true
---

# /team — Parallel mixed workers + auto routing

Not a heavy runtime. Use Grok natives + advisor script.  
**Always pick model/effort via the routing table before launching CLI workers.**

## 0. Auto route (mandatory first step)

Resolve advisor path (`.grok/xllm-advisor-path` / env / `./scripts/…`), then:

```bash
# Full team plan (roles + provider@effort)
node <plugin>/scripts/xllm-routing.js pick-team "<user task>" --json

# Or single role
node <plugin>/scripts/xllm-routing.js pick security "<user task>" --json
node <plugin>/scripts/xllm-routing.js infer "<user task>"
```

If doctor READY set is known, pass it:

```bash
node …/xllm-routing.js pick-team "<task>" --ready=codex,ollama,grok --json
```

**Follow the JSON picks.** Do not invent `codex@high` ad hoc when the router already chose.

| Field | Meaning |
|-------|---------|
| `use_native: true` | `spawn_subagent` with `native_agent` |
| `use_native: false` | `node <advisor.js> <spec> "…"` |
| `spec` | e.g. `codex@xhigh`, `ollama:llama3.2@medium`, `native:executor` |
| `intensity` | `low` / `medium` / `high` from task keywords |

### Built-in role defaults (overridable in `.grok/xllm-providers.toml`)

| Role | Prefer | Base effort | Notes |
|------|--------|-------------|--------|
| explore | native explore / ollama | low | cheap map |
| implement | native executor | medium | CLI only if forced |
| security | codex | high→xhigh | cloud gate |
| architecture | codex / claude | high | deep analysis |
| design | **antigravity** > gemini | medium | Windows → gemini fallback |
| critic | ollama; high→codex | medium | volume local |
| tests | native / ollama | medium | |
| docs | native / ollama | low | |
| analysis | codex | high | xllm multi-advisor style |
| verify | native verifier | medium | CLI second opinion on high |

Intensity signals (examples): security/auth/payment/race/migrate → **high**; typo/readme/nit → **low**.

## 1. Decompose

- Use router `roles` (or max 2–4 from pick-team).
- `todo_write` each role/story with AC + owner + planned `spec` from the pick.

## 2. Launch in parallel

- **Native** (`use_native`):  
  `spawn_subagent` with `subagent_type` ≈ `native_agent` (`executor`, `explore`, `security-reviewer`, `critic`, `verifier`, …), `background: true`.  
  Use `isolation: "worktree"` when edits may collide.
- **CLI** (`!use_native`):  
  ```bash
  node <advisor.js> <spec> "<scoped task + paths + AC>"
  ```
  Example: `node <advisor.js> codex@xhigh "Security review of auth refresh…"`

## 3. Coordinate

- Update todos; collect `.grok/artifacts/ask/*`.
- Stuck → re-`pick` with `--force-cli` or higher intensity, or reassign.

## 4. Synthesize

- Read artifacts + subagent summaries.
- Optional: `/xllm` using analysis+design defaults (codex + antigravity).
- Write `.grok/artifacts/team/<slug>-summary.md` including **routing plan JSON** (roles, intensity, specs used).

## 5. Done

- Todos completed; security/architecture paths have critic/verify evidence when intensity is high.

## Examples

```text
/team Refactor auth: security + implement + tests
/team Payment webhook idempotency with parallel explore + implement + verify
```

Behind the scenes you must run `pick-team` first, e.g.:

```bash
node scripts/xllm-routing.js pick-team "Refactor auth module" --json
# → implement native:executor, security codex@xhigh, tests native, critic ollama@…
```

## Rules

- **Never skip the router** for CLI model/effort on /team.
- One writer stream per file area (or worktrees).
- If a provider is MISSING, re-run pick with `--ready=…` excluding it, or drop that worker.
- Surface every artifact path and the routing decision in the final summary.
