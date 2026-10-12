---
name: scribe
description: >
  Route mechanical git prose — commit messages, PR titles/bodies, release
  notes, changelog entries — to the cheapest healthy model (free local ollama
  first) instead of burning main-session tokens. Use whenever the user asks to
  commit, open a PR, cut a release, or write a changelog and the prose can be
  drafted from the diff/log. The advisor writes text only (read-only); YOU run
  the git/gh commands.
---

# scribe — Optional cheap-prose lane for git chores (xllm)

Optional: only worth it when cost matters and the prose is mechanical.
You can always write the message yourself. Using scribe sends the diff/log
to the routed provider — a privacy and cost decision, not a default.

Split of labor: deterministic collectors gather the diff/log (no LLM), the
**cheapest healthy advisor** writes only the prose, and **you** execute the
git command. push/tag are pure mechanics — no model call at all.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-scribe.js"`.
Other hosts: `<plugin-root>/scripts/xllm-scribe.js` (two directories above
this SKILL.md).

## Run (Bash tool)

```bash
node <xllm-scribe.js> commit                      # staged diff → commit message
node <xllm-scribe.js> pr --base main              # commits+diffstat → PR title/body
node <xllm-scribe.js> release --from v0.5.0       # log range → release notes
node <xllm-scribe.js> notes --from v0.5.0         # log range → changelog entry
# all accept --provider <spec> to override routing
```

Message arrives on **stdout** (diagnostics on stderr), so:

```bash
MSG=$(node <xllm-scribe.js> commit) && git commit -m "$MSG"
```

## Contract

- Routing: `scribe` role resolved once through the routing policy (local-first
  when eligible); if nothing satisfies the policy the run fails instead of
  falling back. Pin per project: `--set-role scribe ollama:qwen3.6:latest@low`.
- Output is validated deterministically (Conventional Commits format, subject
  ≤72 chars, no fences, no invented facts instruction) with one corrective
  retry; **exit 3** means validation failed — show the raw text to the user
  for review instead of using it blindly.
- Privacy: the diff/log is sent to the routed provider (remote for cloud
  providers). xllm writes no artifact for it (`--no-artifacts` internally), but
  that does not control what a remote provider retains. For private code pin
  scribe to a local model (`profile set-role scribe ollama:qwen3.6:latest@low`)
  and set `execution_policy = "local-only"` — unknown-location providers are
  then refused, not assumed local.
- Show the generated message to the user (or apply directly if they asked you
  to commit), then run the git command yourself. xllm never runs git.
- Advisors stay read-only throughout — this lane generates text, nothing else.

## When NOT to use

- push / tag creation → pure git commands; no model needed at all.
- Release strategy, breaking-change judgment, "should we ship" → that is
  analysis, not scribing; use `ask`/`review roles` with a strong model.
- If no advisor is healthy: on Claude Code, spawn a host-native cheap-model
  subagent instead (Agent tool with `model: haiku` — pass it the same
  collector output and template contract); otherwise write the prose yourself.
  Never block the user on a missing advisor.
