# grok-xllm

**v0.2.0** — Multi-LLM orchestration plugin for [Grok Build](https://grok.x.ai).

Grok is the **conductor**. External and local models are **advisors**.

Grok Build already has subagents, plan mode, skills, and hooks.  
**grok-xllm** adds:

1. **Real multi-CLI advisors** — codex, claude, grok, antigravity (gemini fallback), cursor, plus **local** ollama / lmstudio  
2. **Evidence-guided work** — `/ralph` + `/verify` (prompt-level protocol: the skills instruct the host to demand evidence; they are not a mechanical gate)  
3. **Team playbook with auto routing** — role + intensity → model/effort (`pick-team`)  
4. **Provider profiles** — `.xllm/xllm-providers.toml` (legacy `.grok/` honored)

## Safety model

- **Advisors are read-only by default.** No approval bypass, no sandbox escape
  (`codex --sandbox read-only`; no `--yolo`, no `--dangerously-*`, no
  `--always-approve`). Opt in to mutating advisors with `--allow-write` or
  `XLLM_ALLOW_MUTATION=1`.
- **Same-provider nesting is refused** (e.g. asking a claude advisor from
  inside Claude Code). Override with `--allow-self` / `XLLM_ALLOW_SELF=1`.
- **Host session env vars are stripped** before spawning advisors
  (Claude/Codex/Grok session identifiers).
- **Artifacts persist prompts and outputs** under `<state>/artifacts/` with
  well-known secret formats redacted, plus a self-ignoring `.gitignore`.
  Use `--no-artifacts` / `XLLM_NO_ARTIFACTS=1` to print instead of writing,
  and `xllm clean [--older-than=DAYS]` for retention.

## Install (Grok plugin)

```bash
# Local checkout
grok plugin install . --trust

# From GitHub
grok plugin install kimmingul/grok-xllm --trust
```

Repo: [github.com/kimmingul/grok-xllm](https://github.com/kimmingul/grok-xllm)

Validate:

```bash
grok plugin validate .
```

In a Grok session:

```text
/xllm-setup
/ask codex@high "Review this change"
/xllm codex,antigravity "Security + design review"
/team "Refactor auth with tests"
```

### Other projects (consumer repos)

Scripts live in the plugin install path, not always in your app repo. Once per project:

```bash
node /path/to/grok-xllm/scripts/xllm.mjs remember
```

This writes `<state>/xllm-advisor-path` (state dir: `.xllm/`, or legacy `.grok/` when the project already uses it). See [`.grok/docs/install.md`](.grok/docs/install.md).

**Requirements:** Node ≥ 18. Install only the advisor CLIs you need (codex, claude, ollama, …).

## Spec: provider / model / effort

```text
provider
provider:model
provider@effort
provider:model@effort
```

| Example | Meaning |
|---------|---------|
| `codex@high` | Codex + high reasoning effort |
| `claude:opus@medium` | Model + effort |
| `ollama:qwen3.6:latest` | Local model |
| `antigravity:…` | Preferred design advisor (over gemini) |

```bash
node scripts/xllm.mjs ask codex@high "…"
node scripts/xllm.mjs multi codex@high,antigravity "…"
node scripts/xllm.mjs pick-team "refactor payment webhooks" --json
node scripts/xllm.mjs doctor
```

Profiles and role routing: [`.grok/xllm-providers.toml`](.grok/xllm-providers.toml).

## Skills

| Skill | Purpose |
|-------|---------|
| `/ask` | One headless advisor + artifact |
| `/xllm` | 2+ advisors + synthesis |
| `/ralph` | Story loop until evidence |
| `/verify` | PASS/FAIL evidence table |
| `/team` | Parallel workers; **must** run `pick-team` first |
| `/xllm-setup` | Doctor + path marker + recommendations |

Artifacts: `<state>/artifacts/{ask,xllm,ralph,team,verify}/` (secret-redacted; see Safety model)

## Auto routing (/team)

```bash
node scripts/xllm.mjs pick security "auth token race" --json
node scripts/xllm.mjs pick-team "Refactor auth with tests" --json
node scripts/xllm.mjs infer "fix typo in README"
```

| Role | Bias |
|------|------|
| explore / docs | local or native, low effort |
| implement / tests | native executor |
| security / architecture | codex, high→xhigh |
| design | antigravity > gemini |
| critic | ollama; high intensity → cloud |

## Development

```bash
npm test          # unit tests (no live LLM required)
npm run check     # syntax + plugin layout
npm run ci        # check + test + smoke
npm run doctor
npm run smoke:live   # optional live READY provider
```

## Layout

```text
plugin.json
package.json
scripts/
  grok-ask-advisor.js   # multi-LLM entry
  xllm-routing.js       # role/intensity picker
  xllm.mjs              # CLI
  xllm-doctor.js
.grok/
  skills/ agents/ personas/
  xllm-providers.toml
  docs/
examples/
```

## Scope

In scope: multi-CLI advisors, local LLMs, evidence loops, thin team routing.  
Out of scope: full agent OS ports, HUD/hooks engines, huge skill dumps.

Details: [`.grok/docs/SCOPE.md`](.grok/docs/SCOPE.md).

## License

MIT — see [LICENSE](LICENSE).

## Notes

- **Windows:** antigravity headless is limited → auto-fallback to gemini when chosen.  
- Public version line starts at **0.1.x**.  
