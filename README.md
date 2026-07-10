# grok-xllm

**v0.1.1** — Multi-LLM orchestration plugin for [Grok Build](https://grok.x.ai).

Grok is the **conductor**. External and local models are **advisors**.

Grok Build already has subagents, plan mode, skills, and hooks.  
**grok-xllm** adds:

1. **Real multi-CLI advisors** — codex, claude, grok, antigravity (gemini fallback), cursor, plus **local** ollama / lmstudio  
2. **Evidence-gated work** — `/ralph` + `/verify`  
3. **Team playbook with auto routing** — role + intensity → model/effort (`pick-team`)  
4. **Provider profiles** — `.grok/xllm-providers.toml`

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

This writes `.grok/xllm-advisor-path`. See [`.grok/docs/install.md`](.grok/docs/install.md).

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

Artifacts: `.grok/artifacts/{ask,xllm,ralph,team,verify}/`

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
