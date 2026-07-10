# grok-xllm

**v0.5.0** — Cross-vendor LLM advisor plugin for [Grok Build](https://grok.x.ai), **Claude Code**, and **Codex**.

The host CLI is the **conductor**. External and local models are **advisors**.

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

## Install

### Grok Build

```bash
# Local checkout
grok plugin install . --trust

# From GitHub
grok plugin install kimmingul/grok-xllm --trust
```

### Claude Code

```text
/plugin marketplace add kimmingul/grok-xllm
/plugin install xllm@xllm
```

Then in a session: `/xllm:setup`, `/xllm:ask codex@high "…"`,
`/xllm:multi codex,gemini "…"`.

The Claude adapter ports **only** the cross-vendor core (`ask`, `multi`,
`setup`). Teams, loops, planning, and verification are NOT ported — Claude
Code's native agents, tasks, and verify/review skills already cover them.
Note: `claude` as an advisor is refused inside Claude Code (same-provider
nesting); use codex/gemini/grok/cursor or local models.

### Codex

```bash
# From GitHub
codex plugin marketplace add https://github.com/kimmingul/grok-xllm.git
codex plugin add xllm@xllm

# Local checkout
codex plugin marketplace add D:\repo\xllm
codex plugin add xllm@xllm
```

The same three skills (`ask`, `multi`, `setup`) load from `./skills/` via
`.codex-plugin/plugin.json`. Inside Codex, `codex` as an advisor is refused
(same-provider nesting); use claude/gemini/grok/cursor or local models.

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
| `/ask` | One headless advisor + artifact (`--propose` → diff proposal) |
| `/xllm` | 2+ advisors + consensus-labeled synthesis (unanimous/majority/split/single-source) |
| `/ralph` | Story loop until evidence |
| `/verify` | PASS/FAIL evidence table |
| `/team` | Parallel workers; **must** run `pick-team` first |
| `/xllm-setup` | Inventory + doctor + per-project advisor wizard (`--set-role`) |

## Per-project profile & cost-aware routing

```bash
node scripts/xllm.mjs inventory              # machine capability cache (24h TTL)
node scripts/xllm.mjs profile set-role analysis codex@high   # pin for THIS project
node scripts/xllm.mjs profile show
```

Providers carry coarse `tier` / `relative_cost` / `latency_class` metadata
(TOML-overridable). Routing sends low-intensity work to the cheapest healthy
model (local first) and high-intensity judgment roles to the strongest tier;
`[roles]` pins override everything, effort included.

## Proposal mode (file work, advisors stay read-only)

```bash
node scripts/xllm.mjs propose codex@high "add input validation to login()"
node scripts/grok-ask-advisor.js --multi --propose codex,gemini "…"  # N candidate patches
```

Advisors return unified diffs saved as `.patch` artifacts; nothing is applied.
Validate with `git apply --check`, review, then apply yourself.

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
plugin.json             # Grok Build manifest
.claude-plugin/         # Claude Code manifest + marketplace (plugin name: xllm)
.codex-plugin/          # Codex manifest (plugin name: xllm)
.agents/plugins/        # Codex marketplace.json (self-hosted)
skills/                 # Host-neutral skills shared by Claude Code + Codex
package.json
scripts/                # host-neutral core
  grok-ask-advisor.js   # multi-LLM entry
  xllm-routing.js       # role/intensity picker
  xllm.mjs              # CLI
  xllm-doctor.js
.grok/                  # Grok Build adapter
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
