---
name: ralph
description: >
  Evidence-gated persistence loop for Grok. Stories via todo_write, critics via
  grok-ask-advisor (local+cloud), verification via /verify. Completes only with
  concrete evidence (critic approval + checks). The boulder never stops.
argument-hint: "[--critic=p1,p2] [--max-iterations=N] <task>"
user-invocable: true
---

# /ralph — Evidence-gated implementation loop

Ralph exists to stop **fake completion**: “looks good”, skipped tests, and unchecked acceptance criteria.

## Parse flags

- `--critic=ollama:qwen3.6:latest,codex@high` (optional explicit override)
- If omitted: auto-pick via routing  
  `node …/xllm-routing.js pick critic "<task>" --json` (and `security` when auth/payment keywords)
- Critics support `provider[:model][@effort]`
- `--max-iterations=N` (default **6**)
- Remainder = task goal

Resolve `<advisor.js>` like `/ask`. Then:

```bash
node <advisor.js> --doctor
```

## Loop (every iteration)

### 0. Setup (once)

1. Create `.grok/artifacts/ralph/` if needed.
2. `todo_write` stories with **verifiable** acceptance criteria in each description.
3. Write `.grok/artifacts/ralph/plan.md` with: goal, critics, max iterations, story list.
4. iteration = 1.

### 1. Pick story

- Highest-priority non-completed story → `in_progress`.
- If none left → **Final gate** (step 5).

### 2. Implement

- Smallest correct diff; match repo style.
- Use `spawn_subagent` for independent sub-work.
- Run builds/tests as you go.

### 3. Critic gate (mandatory)

For the story just implemented, call **at least one** critic (prefer **local + cloud** when both READY):

```bash
node <advisor.js> <critic> "Story: <id>. Acceptance criteria (verbatim): <list>. Changed files: <paths>. Diff summary: <...>. For EACH criterion: PASS/FAIL with evidence. Blockers? Risks?"
```

- `read_file` critic artifacts under `.grok/artifacts/ask/`.
- Any FAIL / gap → fix, re-critic, **do not** mark story completed.
- Log critic paths into `.grok/artifacts/ralph/iteration-<n>.md`.

### 4. Verify gate

Use `/verify` or the same protocol:

- Fresh test/build/lint commands via `run_terminal_command`.
- Per criterion: evidence (command output, file:line).
- Write `.grok/artifacts/verify/<story>-<ts>.md` when possible.
- Only if critics OK **and** verify OK → mark story `completed`.

### 5. Final gate (all stories done)

1. Optional `/xllm` cross-check on the whole change.
2. Full test/build sweep.
3. Summary: stories, evidence paths, remaining risks.
4. **Only then** claim done.

### Stop conditions

| Condition | Action |
|-----------|--------|
| All stories evidenced | Complete + list artifacts |
| max-iterations hit | Stop, report blockers + last evidence |
| External blocker | Pause with concrete ask for user |

## Hard rules

- No completion without: (1) story AC evidence, (2) at least one external critic artifact saying criteria met (or explicit Grok-only mode if **all** advisors missing — must label degraded).
- No `test.skip` / `.only` / TODO stubs as “done”.
- Always surface artifact paths in the final message.
- Prefer advisor script over raw provider CLIs.

## Examples

```text
/ralph Implement secure token refresh with tests
/ralph --critic=ollama:llama3.2,codex --max-iterations=8 Refactor auth module
/ralph --critic=lmstudio,grok Improve onboarding copy + validation
```

## Grok primitives

| Need | Tool |
|------|------|
| Story board | `todo_write` |
| Critics | `run_terminal_command` → `scripts/grok-ask-advisor.js` |
| Parallel sub-work | `spawn_subagent` |
| Checks | `run_terminal_command` + `/verify` |
| Goal tracking | `update_goal` if available |

The boulder never stops until evidence exists.
