---
name: exec
description: >
  Delegate a bounded implementation task to codex executing in an ISOLATED
  clone under a verified OS sandbox — it edits there, the test runs in the
  same sandbox, and the host gets back a git ref plus evidence; the user's
  checkout is never touched. Use when the user wants codex to implement, fix,
  or refactor something off the main session. Escalation ladder: ask (opinion)
  → propose (static diff) → exec (verified branch).
---

# exec — Isolated executor (xllm)

The executor works in an **ephemeral local clone** — the user's checkout,
branches, index, and config remain read-only territory it can never reach.
Deliverable: `refs/xllm/exec/<id>` fetched into the main repo + a `.patch` +
an evidence artifact (`.md` + machine-readable `.json`). Merge, push, and
credentials stay with the host.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-exec.js"`.
Other hosts: `<plugin-root>/scripts/xllm-exec.js` (two directories above this
SKILL.md).

## Run (Bash tool)

```bash
node <xllm-exec.js> sandbox-check                       # proves the OS sandbox here; no model call (exit 0 ok / 3 not ok)
node <xllm-exec.js> run codex@high "<bounded task>" --test-cmd "npm test" [--timeout-ms N] [--keep-clone]
node <xllm-exec.js> list
node <xllm-exec.js> cleanup <id>|--all
```

- Give a **bounded, self-contained task** — the executor sees only the clone,
  not this conversation. Always pass `--test-cmd`: without it the result is
  `unverified`, never green.
- **codex only.** Claude (its sandbox covers the Bash tool only; permission
  modes are not isolation) and every other provider are refused. There is no
  bypass: `--sandbox-mode`, `--allow-write` and `--ready` are rejected.
- `execution_policy = "local-only"` refuses exec before anything is cloned
  (codex is a cloud provider); no flag overrides it.
- Same-vendor nesting refused (no codex executor inside Codex) unless the user
  explicitly asks for `--allow-self`.
- Fail-closed: before cloning, the sandbox is probed on this machine (writes
  land only in the clone; temp/home/repo untouched; repo and credential reads
  denied; network off). If that fails the status is `blocked` (exit 3) and
  nothing is cloned — tell the user, do not look for a workaround. On Windows
  the deny-read backend needs a provisioned `elevated` sandbox (or explicit
  MXC); without it the preflight reports it unsupported and blocks.
- The test command runs through the same sandbox with an allow-listed
  environment — never a host shell.

## Statuses (evidence artifact / `.json` `status`)

| status | exit | meaning |
|---|---|---|
| `green` | 0 | changed + sandboxed test passed + verification definitions unchanged |
| `no-change` / `timeout` / `refused` | 1 | nothing to hand back / ran out / not allowed |
| `executor-failed` | 1 | the executor exited abnormally and changed nothing (distinct from `no-change`; with changes it is `not-green`) |
| `unverified` | 2 | no `--test-cmd` — executor claims only |
| `not-green` | 2 | the test failed |
| `definition-changed` | 2 | the executor edited what defines the test bar (package scripts, runner config, CI, files named in the command) — a pass does not prove the original bar |
| `blocked` | 3 | sandbox unverifiable or the test could not run inside it |
| `tampered` | 3 | main-repo or clone config/hooks/refs changed — nothing is fetched |

## Handback flow (host-side, after exit)

1. Read the evidence artifact (last stdout line) — check `status`,
   `verification`, and `tamper`.
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
- Opinion or review only → `ask`/`review`. A static small change → `propose`.
