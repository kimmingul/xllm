---
name: exec
description: >
  Delegate a bounded implementation task to another vendor's CLI executing in
  an ISOLATED clone — it edits, builds, and tests there, then hands back a
  verified git ref plus evidence; the user's checkout is never touched. Use
  when the user wants a different vendor (codex) to implement, fix, or
  refactor something, or wants work done off the main session. Escalation
  ladder: ask (opinion) → propose (static diff) → exec (verified branch).
---

# exec — Isolated cross-vendor executor (xllm)

The executor works in an **ephemeral local clone** — the user's checkout,
branches, index, and config remain read-only territory it can never reach.
Deliverable: `refs/xllm/exec/<id>` fetched into the main repo + a `.patch` +
a test-evidence artifact. Merge, push, and credentials stay with the host.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-exec.js"`.
Other hosts: `<plugin-root>/scripts/xllm-exec.js` (two directories above this
SKILL.md).

## Run (Bash tool)

```bash
node <xllm-exec.js> run codex@high "<bounded task>" --test-cmd "npm test"
node <xllm-exec.js> list
node <xllm-exec.js> cleanup <id>|--all
```

- Give a **bounded, self-contained task** — the executor sees only the clone,
  not this conversation. Include the verification command whenever possible;
  without `--test-cmd` the evidence is executor claims only.
- Capable providers only (codex; claude when not the host). Unsandboxed CLIs
  (gemini/grok/cursor) and pure text models (ollama) are refused — they
  cannot execute safely.
- Same-vendor nesting refused (no codex executor inside Codex).
- If the OS sandbox is unavailable on this machine, exec **fails closed**;
  only re-run with `--sandbox-mode bypass` after telling the user it means
  clone-level isolation (workflow isolation, not an OS security boundary).

## Handback flow (host-side, after exit)

1. Read the evidence artifact (last stdout line) — check `Status`
   (green / not-green / no-change / timeout) and `Main repo integrity`.
2. Review: `git diff <base>..refs/xllm/exec/<id>`
3. Merge only after review: `git merge --no-ff refs/xllm/exec/<id>`
   (or cherry-pick / `git apply` the .patch).
4. **Re-run your own verification after merging** — executor-green is
   evidence, not trust.
5. `node <xllm-exec.js> cleanup <id>` when done.

Failures are honest: not-green still hands back the branch with failing
evidence; never present it as success.

## When NOT to use

- Multi-task orchestration, loops, teams → host-native agents compose
  multiple exec calls; xllm deliberately ships only this one primitive.
- Same-vendor parallel work → host-native subagents.
- Opinion or review only → `ask`/`multi`. A static small change → `propose`.
