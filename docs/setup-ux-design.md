# xllm setup UX — arg-driven posture packs (2026-07-17)

> Drafted in a brainstorming session with the maintainer, then hardened by the
> repo's own adversarial method: codex@high and grok@high each reviewed (Round 1),
> then rebutted each other (Round 2, anchored on verified code paths). They
> converged; the outcome is folded in below and the raw rounds are in
> `.xllm/artifacts/ask/*round-2*`. One product-shaping question (how heavily packs
> should pin) is left for maintainer adjudication ("Residual for USER adjudication").

## Problem

Today `setup` is a **skill** (`skills/setup/SKILL.md`), not a binary: the host
LLM scans the machine (`xllm-advisor.js --inventory`), then asks one
`AskUserQuestion` per role (analysis / design / critic), and pins each answer as
a free-text `provider[:model][@effort]` spec via `--set-role` into
`.xllm/xllm-providers.toml`.

Measured pain (maintainer): picking provider+model+effort as a free-text spec is
fiddly and error-prone; cloud model names aren't discoverable so users guess;
effort levels are opaque at selection time; three role questions feel heavy and
the role names are unexplained. The cross-vendor consult (both advisors,
independently) converged on: preset "posture" packs as the default, effort shown
as a few legible buckets, cloud model names avoided (provider default), and a
deterministic pack→pins resolver rather than LLM whimsy.

## Decisions (decision record)

1. **Deterministic CLI subcommand is the home for arg-driven selection.** A
   non-interactive command computes pins from inventory; the skill becomes a
   thin conversational shell over it. (Not skill-args-only: those give no
   determinism and no offline test.)
2. **Argument vocabulary = posture packs + per-role overrides.** A non-interactive
   command cannot "run an interaction style", so the arg selects *which preset
   produces the pins*, not *how the wizard asks*.
3. **Preview by default; `--apply` writes.** Honors the unanimous
   "preview before write" rule. `--setup <pack>` prints the resolved plan and
   writes nothing; `--setup <pack> --apply` writes the `[roles]` pins.
4. **Packs (v1): `balanced` (default) · `quality` · `frugal` · `local` · `skip`.**
   `local` = fully offline/private/free, all roles on local runtimes; distinct
   from `frugal` (hybrid: cloud only for the hardest role).
5. **`cloud` (ollama cloud) and `nim` (NVIDIA NIM free) packs are phased out to
   follow-on specs.** They are provider-layer work (new/extended adapters), not
   pack recipes; see Roadmap. This spec ships only packs over *existing*
   providers.

## Command contract

```text
node scripts/xllm.mjs setup [pack] [--role R=SPEC ...] [--apply] [--json] [--sensitive auto|yes|no]

  pack ∈ { balanced (default) | quality | frugal | local | skip }

  (no --apply)  print the resolved plan (human + evidence + warnings); write nothing
  --apply       persist [roles] pins; DELETE keys for OPEN/no-pin roles; `skip` clears posture pins
  --role R=SPEC override one resolved role with an exact spec (repeatable; SEMANTICALLY validated)
  --json        machine-readable plan { roles, warnings, evidence, recommended_packs } — skill renders; tests assert
  --sensitive   security-sensitivity hint from the host's LOCAL skim (never sends repo content;
                bare-CLI `auto` ≡ no, since there is no host skim)
```

Underneath: a new `--setup` mode in `xllm-advisor.js`; `xllm.mjs setup` is a thin
wrapper (same pattern as the existing `doctor`/`inventory` wrappers).

Safety: read-only advisors are untouched — `setup` only writes local config, and
only under `--apply`. `skip` is the escape hatch: it does not merely "write
nothing" — it **clears** the posture-owned role keys so routing actually takes
over (see "skip semantics").

## Round 2 convergence (codex×grok adversarial review)

The review (raw rounds in `.xllm/artifacts/ask/*round-2*`) reached these verdicts,
last round anchored on verified code paths (`route.pinned` skips cost-sort /
health / bench-LCB / effort-bump; `pickAdvisorForRole` sorts low-intensity
non-security roles by `relative_cost`; `setProfileValue` does `String(value)`;
pins carry exact effort — no `xhigh` bump). All are folded into the sections below.

- **A pin is a persistent routing override, not an evidence-backed recommendation.**
  A pinned role permanently bypasses measured routing and cost re-sorting until the
  user re-runs setup. Therefore **minimize pins**: pin only what the user genuinely
  wants frozen (offline / privacy / an explicit max-spend lock), never a temporary
  inventory state or a "panel diversity" story.
- **Panel FINDINGS ≠ sequential roles (category error).** The decorrelation
  dividend is about *simultaneous* multi-advisor views on one defect set;
  analysis→design→critic is a pipeline. Pack prose must NOT justify sequential
  provider spread with "diversity dividend." Cold-start provider spread is allowed
  only as labeled `cross_cli_cold_start` (unmeasured coverage); the ledger's
  measured agreement wins whenever its sample gate is met.
- **No paid critic pin.** frugal/balanced never pin a cloud critic on the
  no-local fallback — they omit the pin (role left OPEN to routing) and warn.

## Pack resolver — pure function

`resolveSetupPlan(inventory, { pack, host, overrides, sensitive })`
→ `{ roles: { analysis, design, critic }, warnings: string[], evidence, recommended_packs }`

A role value is either a **spec string** (pin it) or **`null`** (OPEN — leave to
measured routing; on `--apply` this means *delete the key*, never write the string
`"null"`). `recommended_packs` is an ordered pack list for the skill's 4-option UI.
`evidence` labels every pick's basis (`measured_low_agreement`+`n`,
`cross_cli_cold_start`, `unranked_cold_start`, `single_lab_collapse`, `size_unknown`,
`routing_mode: pinned|open`) — never a capability persona.

Lives in `xllm-routing.js` (already the routing home; exported for offline unit
tests). Deterministic — no LLM, no network, no clock.

Inputs it consumes from `buildInventory()`: per provider `{ installed, healthy,
tier, relative_cost, models[] }`. `host` = detected host vendor (e.g. `claude`
for Claude Code).

Rules shared by all packs:
- **READY only** (`installed && healthy`); **host vendor excluded** from
  recommended picks (cross-vendor rule).
- **Cloud specs omit the model** (`provider@effort`) → provider default, because
  cloud catalogs are not discoverable. **Local specs include the pulled model**
  (`ollama:qwen3.6:latest@low`) because those *are* discoverable.
- **Effort buckets**: Quick=`low`, Standard=`medium`, Deep=`high`, **Deep+=`xhigh`**
  (added post-review: unpinned routing already emits `xhigh` for hard judgment, so
  `quality` must be able to store `xhigh` or it would be *weaker* than no pin).

Recipe — **lighter pins** (post-review): pin only genuine constraints; leave other
roles OPEN so measured routing/traits keep working. Every fallback warns, never silent.

| pack | analysis | design | critic | what it actually pins |
|------|----------|--------|--------|-----------------------|
| **balanced** (default) | **OPEN** | **OPEN** | local@low **iff** a local is READY, else OPEN | at most the critic → a free local second opinion; judgment stays measured |
| **quality** | strong@**xhigh** | strong@high | OPEN (or strong@medium) | explicit max-spend **lock**; labeled a lock, not "measured" |
| **frugal** | OPEN (or cheapest strong/balanced@medium **only if** it beats default, warned) | local@low iff present else OPEN | local@low iff present else **OPEN** (never paid) | locals only; nothing paid frozen |
| **local** | most-capable local@medium | **different runtime/model** local@low | smallest local@low | full pins — offline/privacy IS the constraint; freeze is the point |
| **skip** | clear | clear | clear | deletes posture-owned role keys → routing |

Why `balanced` (the default) pins so little: on a capable machine the *point* of
xllm is measured routing + judgment gates. Pinning all three roles would convert
setup into a measurement kill-switch. `balanced` therefore pins at most a free
local critic and leaves analysis/design OPEN. (This reshapes "pack" from "your 3
advisors" to "a routing posture" — see the user-adjudication residual at the end.)

`local` detail unchanged (decorrelation-first spread across runtimes/models); it is
the one pack where full pins are correct because the offline/private constraint is
exactly what the user wants frozen.

`sensitive=yes` (host local skim only) nudges `analysis` toward Deep and **forbids**
any paid critic pin; it never adds a question. Bare CLI `--sensitive auto` ≡ no.

The `local` spread is decorrelation-first — matches `benchmarks/FINDINGS.md`
(dividend in mid-tier *decorrelated* panels): different runtime, else different
model string (ollama:qwen vs ollama:llama; ollama vs lmstudio vs lemonade). Zero
cloud calls — the prompt never leaves the machine.

## Thin-inventory fallbacks (all surfaced as warnings)

| situation | behavior |
|-----------|----------|
| only host vendor READY | recommend `skip`; refuse same-vendor pins (no nesting theater) |
| no local model pulled | `balanced`/`frugal` critic → **OPEN (no pin)**, warned "no local → critic left to routing; re-run setup after pull" — never a paid cloud critic pin |
| only one cloud lab | `quality` design reuses that lab, labeled `single_lab_collapse` ("best available, not cross-lab"); `balanced`/`frugal` just stay OPEN |
| `local` with 0 local models | pack unsatisfiable → warning + guidance (`ollama pull …`, install lmstudio/lemonade), recommend `skip` or (later) a cloud pack |
| `local` with 1 local model | all three roles share it; labeled `single_model` (no decorrelation) |
| only tiny local models | judgment-role capability-floor warning; allowed for `critic`, flagged low-confidence for analysis/design |

## Skill integration

`skills/setup/SKILL.md` Step 3 is rewritten around the resolver:
- Default action: run `setup balanced --json`, render the plan preview through
  the host UI, and on the user's accept run `setup <pack> --apply` (or
  `--role R=SPEC` for a partial tweak).
- The **interactive UX options** from the consult (accept-then-tweak-one-role;
  per-role effort cards) remain as optional skill branches built on the *same*
  `--json` plan + `--role` overrides — the CLI is the deterministic core, the
  skill is the conversational shell.
- **4-option cap**: five packs exceed the host UI's 4-option limit, so the skill
  renders the resolver's ordered **`recommended_packs`** (truncated to 4, `skip`
  always reachable). The ranking is a pure function of inventory in the tested
  resolver — the skill only renders it, never re-implements it.
- Print the shared effort legend + one-line role glosses before any choice.

## `--role` override validation (must-fix, post-review)

`parseProviderSpec` checks only syntax + effort name. `--apply` must additionally
validate the WHOLE candidate profile **before any write**, all-or-nothing:
role ∈ known roles · provider ∈ meta · READY (`installed && healthy`) ·
host-exclusion policy · pinned model actually present in inventory ·
effort ∈ `KNOWN_EFFORTS` · sensitivity policy (no paid critic under `sensitive=yes`).
Any failure → non-zero exit, **zero** TOML mutation.

## `skip` semantics & the delete-key gap (must-fix, post-review)

`setProfileValue` does `String(value)` — there is no way to *remove* a role key
today, and writing `null` yields the dead pin `"null"`. Two consequences:
- A new `deleteProfileKey('roles', role)` (or `clearRoles`) helper is required.
- `setup skip --apply` must **clear** the posture-owned role keys (real "back to
  built-in routing"), not silently leave stale pins. Likewise, an OPEN role in any
  pack means *delete that key on apply*, not write a string. Ownership: track which
  role keys setup wrote (e.g. a managed-block comment or a sidecar marker) so
  `skip`/re-apply only touch setup-owned pins, never hand-authored ones.

## Code layout & modules

- `xllm-routing.js` — `resolveSetupPlan()` pure fn + pack recipes + effort
  buckets + `recommended_packs` ranking + evidence-label + warning constructors.
  The only place recipes live.
- `xllm-advisor.js` — `--setup` dispatch in `parseArgs`/`main`; reuses
  `buildInventory()`; adds `deleteProfileKey`; semantic-validates `--role` before
  atomic write.
- `xllm.mjs` — `setup` subcommand (thin wrapper) + help entry.
- `skills/setup/SKILL.md` — Step 3 rewrite; effort legend + role gloss constants.

## Testing (offline, no live LLM — CI-green rule)

`npm test` fixtures feed synthetic inventories to `resolveSetupPlan()` and assert
pins + warnings:
- **rich** (codex, grok, gemini, ollama[qwen,llama]) → `balanced` pins critic-local
  only, analysis/design OPEN (keys deleted); `local` full-pins spread across models
- **host-only** (only claude READY) → `skip` recommendation, no same-vendor pins
- **no-local** → `balanced`/`frugal` critic OPEN + warning; **no cloud critic pin**
- **single-cloud** (one lab + local) → `quality` `single_lab_collapse` label
- **local-empty** → `local` unsatisfiable path
- **tiny-local-only** → capability-floor warning
- **sensitive=yes** → analysis→Deep; any paid critic pin refused
- **quality** → analysis stores `@xhigh` (not capped at `@high`)

CLI-level: `--setup X` (no `--apply`) writes nothing (assert TOML untouched via
`XLLM_STATE_DIR` isolation); `--apply` writes pins AND deletes keys for OPEN roles;
`setup skip --apply` on a profile with existing posture pins **clears** them (not a
no-op); a bad `--role` override causes zero mutation (atomic).

## Out of scope / phased roadmap

Deliberately **not** in this spec (each = its own spec, provider adapter +
tier/cost/auth + its pack + **live e2e before ship**, per the protocol/transport
rule):

- **`cloud` pack — ollama cloud** (`ollama:<model>:cloud`). The existing ollama
  adapter (POST `/api/generate`) already routes `:cloud`-tagged models through a
  signed-in daemon, so invocation is likely reusable. Work: classify `:cloud` as
  non-local **tier + non-zero cost + auth-required** (so routing/floors don't
  treat it as free local); pin models from a **config list** (cloud catalog not
  reliably enumerable); health = signed-in probe.
- **`nim` pack — NVIDIA NIM free endpoint** (`https://integrate.api.nvidia.com`,
  OpenAI-compatible `POST /v1/chat/completions`, `Authorization: Bearer
  $NVIDIA_API_KEY`). Work: a new provider adapter modeled on `lmstudio`
  (OpenAI-compatible HTTP), profile/health/inventory entries, and a
  **config-driven, versioned** model list.

**Honesty constraints for both** (evidence-over-lore; no fake catalogs):
- Never hardcode a drifting model roster. Ship a curated, **as-of-dated** config
  list the user edits; prove existence only via `smoke --live`; detect drift via
  `contracts`.
- "Free" is time-varying (NVIDIA credits/rate limits change). Do **not** promise
  it in the name/UI as a guarantee — frame as a curated default, terms may change.
- Example tags the maintainer floated (`gemma4:cloud`, `glm-5.2:cloud`,
  `qwen3.5:cloud`, `nemotron-3-ultra:cloud`, `deepseek-v4…`) are **unverified**
  and treated as configurable examples only, proven by smoke — never asserted.

## Adversarial review outcome (resolved)

The five residual issues were resolved by the codex×grok review (converged):

1. **Local capability signal** → evidence (traits/ledger) only when the sample
   gate passes; otherwise stable deterministic order labeled `unranked_cold_start`
   / `size_unknown` (size only if parseable from the tag `\d+(\.\d+)?[bB]`). No
   name→capability lore. `--role` is the power-user escape.
2. **"Different-lab"** → allowed as `cross_cli_cold_start` coverage only; never
   called "diversity dividend"; measured ledger agreement wins when gated.
3. **`--apply` gating** → NOT via `mutationAllowed` (that gates advisor runs);
   `--apply` itself is the write consent, preview is the default.
4. **4-option down-selection** → resolver emits ordered `recommended_packs`; skill
   renders only.
5. **frugal cloud critic** → no paid pin; role left OPEN (routing) + warning.

Plus two must-fix issues the review surfaced (now in the design): `--role`
semantic validation before atomic write; `skip --apply` must clear posture pins
(delete-key API), not no-op. And three landmines folded in: no `null` string in
TOML (delete-key); bare `--sensitive auto ≡ no`; `quality` must store `xhigh` or
drop the "max quality" claim.

## Pin philosophy — DECIDED: lighter pins (R-A)

The review's central converged recommendation — **"minimize pins; a pin freezes
measurement and cost for that role"** — reshapes what a "posture pack" is. The
maintainer adjudicated in favor of it (2026-07-17):

> **Default `balanced` pins at most a free local critic and leaves analysis/design
> OPEN to measured routing. `quality` and `local` are the packs that pin heavily
> (explicit max-spend lock / offline constraint). A "pack" is a routing posture,
> not a fixed 3-advisor panel.**

Rationale: philosophically aligned (xllm's measurement instruments keep working)
and code-anchored (`route.pinned` bypasses cost-sort / health / bench-LCB /
effort-bump). Accepted tradeoff: a near-empty default pack reads as "nothing
chosen" to some users — mitigated by the preview explicitly narrating what stays
OPEN and why ("analysis/design left to measured routing; critic → free local
second opinion"), and `routing_mode: open|pinned` shown per role.

(Rejected alternatives, for the record: R-B keep full 3-role pins — tangible "I
chose my panel" UX but freezes measurement; R-C hybrid full-pins at Standard
effort with an un-freeze note. Both lose the measurement loop the product exists
to run.)
