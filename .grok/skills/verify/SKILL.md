---
name: verify
description: >
  Structured evidence-based verification against acceptance criteria.
  Use after implementation, before claiming done, and inside /ralph loops.
  Writes a pass/fail report under .grok/artifacts/verify/.
argument-hint: "<what to verify> [criteria: ...]"
user-invocable: true
---

# /verify — Evidence table, not vibes

## Protocol

1. **Collect criteria**
   - From user list, story AC, PRD, or plan file.
   - If none given: derive 3–7 concrete criteria from the stated goal (and label them as derived).

2. **Fresh evidence only**
   - Re-run tests/build/lint/typecheck with `run_terminal_command` (do not reuse old chat claims).
   - `read_file` / `grep` for behavior that tests do not cover.
   - Optional second opinion: `node <advisor.js> codex "Verify these criteria: ..."` (resolve path like `/ask`)

3. **Score each criterion**

   | ID | Criterion | Result | Evidence |
   |----|-----------|--------|----------|
   | C1 | … | PASS/FAIL | `cmd` output snippet / `file:line` |

4. **Write report**

   Path: `.grok/artifacts/verify/<slug>-<timestamp>.md`

   ```markdown
   # Verify report
   - Goal: ...
   - Created: ISO
   - Overall: PASS | FAIL

   ## Criteria
   | ID | Criterion | Result | Evidence |
   |----|-----------|--------|----------|
   | C1 | ... | PASS | ... |

   ## Commands run
   - `...` → exit 0

   ## Gaps / next fixes
   - ...
   ```

5. **Verdict**
   - Overall **PASS** only if every criterion is PASS with concrete evidence.
   - On FAIL: list minimal fix actions; do not soften language.

## Anti-patterns

- “Should work” / “looks correct” without command or file evidence.
- Marking PASS when tests were not run.
- Ignoring flaky or skipped tests.

## Example

```text
/verify token refresh against: rotates refresh token, revokes old, tests cover race, no secrets in logs
```
