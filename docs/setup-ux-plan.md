# setup posture packs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `setup [pack]` CLI that resolves machine inventory into role pins (preview by default, `--apply` to write), so users pick a posture instead of hand-typing `provider[:model][@effort]` specs.

**Architecture:** A pure `resolveSetupPlan(inventory, opts)` in `xllm-routing.js` maps a pack name → `{roles, warnings, evidence, recommended_packs}`; `xllm-advisor.js` gains a `--setup` mode that builds inventory, applies `--role` overrides, and (only on `--apply`) validates + atomically writes/deletes `[roles]` keys; `xllm.mjs` gets a thin `setup` subcommand. Pins are minimized ("lighter pins" — a pin freezes measured routing) per `docs/setup-ux-design.md`.

**Tech Stack:** Node ≥ 18, ES modules, no deps. Hand-rolled test runner `scripts/test-advisor.mjs` (`test(name, fn)` + `assert`). Reuses existing `modelCapability`, `getProviderCostMeta`, `passesCapabilityFloor`, `parseProviderSpec`, `buildInventory`, `setProfileValue`, `upsertTomlKey`.

## Global Constraints

- Node ≥ 18; `shell: false`; no new dependencies.
- `npm run ci` (check + test + smoke + bench:selftest) MUST pass with NO live LLM.
- Tests are pure/fixture only; destructive/config-writing tests isolate via a tmp `root` arg (`setProfileValue(section,key,value,root)`) or `XLLM_STATE_DIR` — never touch real `.xllm/`.
- Advisors stay read-only; `setup` writes ONLY local config and ONLY under `--apply`.
- Evidence over lore: no hand-authored model personas; every pick carries an `evidence` basis label; sample-gated measurement never invented.
- Cloud specs OMIT the model (`provider@effort`); local specs INCLUDE the pulled model (`ollama:qwen3.6:latest@low`).
- Effort buckets: Quick=`low`, Standard=`medium`, Deep=`high`, Deep+=`xhigh`.
- A pin freezes measured routing → "lighter pins": `balanced` (default) pins at most a free local critic; `quality`/`frugal`/`local` are explicit-constraint packs that pin; `skip` clears posture pins.
- Design of record: `docs/setup-ux-design.md`. This plan implements v1 only (no `cloud`/`nim` provider packs).

---

### Task 1: Delete-key TOML API

TOML has no `null`; `setProfileValue` always stringifies. OPEN roles and `skip` need to REMOVE a `[roles]` key, so add a pure `deleteTomlKey` + a writing `deleteProfileKey`.

**Files:**
- Modify: `scripts/xllm-advisor.js` (add after `upsertTomlKey`, ~line 539, and after `setProfileValue`, ~line 552)
- Test: `scripts/test-advisor.mjs` (add near the existing `upsertTomlKey`/`setProfileValue` tests, ~line 505)

**Interfaces:**
- Produces: `deleteTomlKey(text: string, section: string, key: string) -> string` (removes the `key = ...` line inside `[section]`; no-op if absent); `deleteProfileKey(section: string, key: string, root=process.cwd()) -> string` (returns the file path; creates nothing if file absent).

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test-advisor.mjs`:

```js
test('deleteTomlKey removes only the target key in the section', () => {
  const src = '[roles]\nanalysis = "codex@high"\ncritic = "ollama:llama3.2@low"\n';
  const out = deleteTomlKey(src, 'roles', 'analysis');
  assert.ok(!/analysis\s*=/.test(out), 'analysis removed');
  assert.ok(/critic\s*=\s*"ollama:llama3.2@low"/.test(out), 'critic kept');
});

test('deleteTomlKey is a no-op when key or section absent', () => {
  const src = '[roles]\ncritic = "ollama@low"\n';
  assert.strictEqual(deleteTomlKey(src, 'roles', 'analysis'), src);
  assert.strictEqual(deleteTomlKey(src, 'defaults', 'critic'), src);
});

test('deleteProfileKey removes a pin and round-trips through the parser', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-del-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp);
    setProfileValue('roles', 'critic', 'ollama:llama3.2@low', tmp);
    deleteProfileKey('roles', 'analysis', tmp);
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/analysis\s*=/.test(body), 'analysis pin gone');
    assert.ok(/critic\s*=/.test(body), 'critic pin kept');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

Add `deleteTomlKey, deleteProfileKey` to the import block at the top of `scripts/test-advisor.mjs` (the `from './xllm-advisor.js'` list).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `deleteTomlKey is not defined` (import throws / first new test errors).

- [ ] **Step 3: Implement in `scripts/xllm-advisor.js`**

After `upsertTomlKey` (right before `setProfileValue`):

```js
/** Remove `key` inside `[section]` if present. Returns text unchanged if absent. */
export function deleteTomlKey(text, section, key) {
  const lines = String(text || '').split(/\r?\n/);
  const header = `[${section}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) { start = i; break; }
  }
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp('^\\s*' + escapedKey + '\\s*=');
  for (let i = start + 1; i < end; i++) {
    if (keyRe.test(lines[i])) { lines.splice(i, 1); return lines.join('\n'); }
  }
  return String(text || '');
}
```

After `setProfileValue`:

```js
/** Delete a key from the project profile TOML (no-op if file/key absent). */
export function deleteProfileKey(section, key, root = process.cwd()) {
  const dir = resolveStateDir(root);
  const file = path.join(dir, 'xllm-providers.toml');
  if (!fs.existsSync(file)) return file;
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, deleteTomlKey(text, section, key), 'utf8');
  loadProviderProfiles({ force: true });
  return file;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all three new tests `ok`).

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-advisor.js scripts/test-advisor.mjs
git commit -m "feat(setup): add deleteTomlKey/deleteProfileKey for OPEN roles + skip-clear"
```

---

### Task 2: Resolver skeleton — shared helpers + `balanced` + `skip`

Build the pure resolver with all shared helpers, plus the two lightest packs. Other packs throw `not-yet-implemented` until Tasks 3–4.

**Files:**
- Modify: `scripts/xllm-routing.js` (append after `suggestTiebreaker`, ~line 682; `modelCapability`/`getProviderCostMeta` already exist above)
- Test: `scripts/test-advisor.mjs` (append a `--- setup packs ---` block at end, before the final pass count)

**Interfaces:**
- Consumes: `modelCapability(spec)`, `getProviderCostMeta` is NOT needed here — the `inventory` object already carries `tier`/`relative_cost`/`kind`/`installed`/`healthy`/`models` per provider (see `buildInventory`).
- Produces:
  - `SETUP_PACKS: string[]` = `['balanced','quality','frugal','local','skip']`
  - `SETUP_ROLES: string[]` = `['analysis','design','critic']`
  - `resolveSetupPlan(inventory, { pack='balanced', host=null, overrides={}, sensitive='no' }) -> { pack, roles: {analysis, design, critic}, warnings: string[], evidence: object }` where each role value is a spec string or `null` (OPEN). (`recommended_packs` is added in Task 5.)

Import shape of `inventory` (from `buildInventory()`):
```
{ host_cli: 'claude'|null, providers: { [name]: {
    kind:'cloud'|'local', installed:bool, healthy:bool,
    tier:'strong'|'balanced'|'local', relative_cost:number, models?:string[] } } }
```

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test-advisor.mjs` (and add `resolveSetupPlan, SETUP_PACKS` to a new import line `from './xllm-routing.js'` near the top — there is currently no routing import in this file, so add:
`import { resolveSetupPlan, SETUP_PACKS, recommendPacks } from './xllm-routing.js';` — `recommendPacks` is used starting Task 5; importing early is harmless once it exists, but to keep Task 2 green import only what exists now: `import { resolveSetupPlan, SETUP_PACKS } from './xllm-routing.js';`):

```js
// Fixture inventories for setup packs
const INV_RICH = {
  host_cli: 'claude',
  providers: {
    codex:  { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    grok:   { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:6 },
    gemini: { kind:'cloud', installed:true, healthy:true, tier:'balanced', relative_cost:4 },
    claude: { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    ollama: { kind:'local', installed:true, healthy:true, tier:'local',    relative_cost:0,
              models:['qwen3.6:14b','llama3.2:3b'] },
  },
};

test('setup balanced pins only a local critic; analysis/design OPEN; host excluded', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'balanced' });
  assert.strictEqual(plan.roles.analysis, null, 'analysis OPEN');
  assert.strictEqual(plan.roles.design, null, 'design OPEN');
  assert.ok(/^ollama:/.test(plan.roles.critic), 'critic pinned to a local');
  assert.ok(plan.roles.critic.endsWith('@low'), 'critic @low');
  assert.ok(!/claude/.test(JSON.stringify(plan.roles)), 'host vendor never recommended');
});

test('setup skip yields all-OPEN roles', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'skip' });
  assert.deepStrictEqual(plan.roles, { analysis:null, design:null, critic:null });
});

test('SETUP_PACKS lists the five v1 packs', () => {
  assert.deepStrictEqual(SETUP_PACKS, ['balanced','quality','frugal','local','skip']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveSetupPlan is not defined`.

- [ ] **Step 3: Implement in `scripts/xllm-routing.js`** (append at end, before the `// CLI` banner at ~line 700)

```js
// ---------------------------------------------------------------------------
// Setup posture packs (docs/setup-ux-design.md)
// ---------------------------------------------------------------------------

export const SETUP_PACKS = ['balanced', 'quality', 'frugal', 'local', 'skip'];
export const SETUP_ROLES = ['analysis', 'design', 'critic'];

/** READY, non-host providers as {name, kind, tier, relative_cost, models}. */
function setupReady(inventory, { excludeHost = true } = {}) {
  const host = excludeHost ? inventory.host_cli : null;
  return Object.entries(inventory.providers || {})
    .filter(([name, p]) => p && p.installed && p.healthy && name !== host)
    .map(([name, p]) => ({ name, ...p }));
}
function setupCloud(inv) { return setupReady(inv).filter((p) => p.kind === 'cloud'); }
function setupCheapest(list) {
  return list.length ? [...list].sort((a, b) => a.relative_cost - b.relative_cost)[0] : null;
}
/** Strong tier first, then balanced; cheapest within tier. */
function setupStrongCloud(cloud) {
  const strong = cloud.filter((p) => p.tier === 'strong');
  if (strong.length) return setupCheapest(strong);
  const bal = cloud.filter((p) => p.tier === 'balanced');
  return bal.length ? setupCheapest(bal) : null;
}
/** Expand local runtimes into candidate models. ollama enumerates; others = provider default. */
function setupLocals(inv) {
  const out = [];
  for (const p of setupReady(inv).filter((x) => x.kind === 'local')) {
    if (p.name === 'ollama' && Array.isArray(p.models) && p.models.length) {
      for (const m of p.models) {
        out.push({ provider: 'ollama', runtime: 'ollama', spec: `ollama:${m}`, model: m, cap: modelCapability(m) });
      }
    } else {
      out.push({ provider: p.name, runtime: p.name, spec: p.name, model: null, cap: modelCapability('') });
    }
  }
  return out;
}
function setupSizeDesc(a, b) { return (b.cap.billions ?? -1) - (a.cap.billions ?? -1); }
function setupSizeAsc(a, b) {
  return (a.cap.billions ?? Infinity) - (b.cap.billions ?? Infinity);
}
const setupCloudSpec = (p, effort) => `${p.name}@${effort}`;
const setupLocalSpec = (c, effort) => `${c.spec}@${effort}`;

/**
 * Resolve a posture pack into role pins. Pure: no fs / network / clock.
 * Role values are a spec string (pin) or null (OPEN → measured routing).
 */
export function resolveSetupPlan(inventory, { pack = 'balanced', host = null, overrides = {}, sensitive = 'no' } = {}) {
  const inv = { ...inventory, host_cli: host || inventory.host_cli || null };
  const roles = { analysis: null, design: null, critic: null };
  const warnings = [];
  const evidence = {};

  if (pack === 'skip') {
    for (const r of SETUP_ROLES) evidence[r] = { routing_mode: 'open', basis: 'skip' };
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }

  if (pack === 'balanced') {
    evidence.analysis = { routing_mode: 'open', basis: 'measurement_first' };
    evidence.design = { routing_mode: 'open', basis: 'measurement_first' };
    const locals = setupLocals(inv);
    if (locals.length) {
      const critic = [...locals].sort(setupSizeAsc)[0];
      roles.critic = setupLocalSpec(critic, 'low');
      evidence.critic = { routing_mode: 'pinned', basis: 'local_second_opinion',
        size: critic.cap.billions != null ? `${critic.cap.billions}B` : 'size_unknown' };
    } else {
      evidence.critic = { routing_mode: 'open', basis: 'open_no_local' };
      warnings.push('no local model → critic left to built-in routing; re-run setup after `ollama pull`');
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }

  if (pack === 'quality' || pack === 'frugal' || pack === 'local') {
    throw new Error(`setup pack '${pack}' not yet implemented`);
  }
  throw new Error(`unknown setup pack: ${pack}`);
}

/** Apply --role overrides + sensitive policy, then return the plan object. */
function finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv) {
  // sensitive policy is layered in Task 3; overrides validated at apply time.
  for (const [r, spec] of Object.entries(overrides || {})) {
    if (SETUP_ROLES.includes(r)) {
      roles[r] = spec === null ? null : String(spec);
      evidence[r] = { routing_mode: spec ? 'pinned' : 'open', basis: 'user_override' };
    }
  }
  return { pack, roles, warnings, evidence };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (three new setup tests `ok`; existing tests unaffected).

Also run: `npm run check`
Expected: PASS (`node --check scripts/xllm-routing.js` clean).

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-routing.js scripts/test-advisor.mjs
git commit -m "feat(setup): resolveSetupPlan skeleton + balanced/skip packs"
```

---

### Task 3: `quality` + `frugal` packs + sensitive policy

Add the two cloud-constraint packs and layer the `sensitive=yes` policy into `finishSetupPlan`.

**Files:**
- Modify: `scripts/xllm-routing.js` (replace the `throw` branch from Task 2; extend `finishSetupPlan`)
- Test: `scripts/test-advisor.mjs`

**Interfaces:**
- Consumes: helpers from Task 2 (`setupCloud`, `setupStrongCloud`, `setupCheapest`, `setupLocals`, `setupCloudSpec`, `setupLocalSpec`, `setupSizeDesc`).
- Produces: `resolveSetupPlan` handles `quality` and `frugal`; `finishSetupPlan` enforces: `sensitive==='yes'` → no paid (cloud) critic pin (force critic OPEN + warn) and analysis effort floored to `high`.

- [ ] **Step 1: Write the failing tests**

```js
const INV_NOLOCAL = {
  host_cli: 'claude',
  providers: {
    codex:  { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    gemini: { kind:'cloud', installed:true, healthy:true, tier:'balanced', relative_cost:4 },
    claude: { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
  },
};

test('setup quality pins strong analysis at xhigh (lock, not measured)', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'quality' });
  assert.ok(/@xhigh$/.test(plan.roles.analysis), 'analysis @xhigh');
  assert.ok(['codex@xhigh','grok@xhigh'].includes(plan.roles.analysis), 'analysis is a strong cloud, no model');
  assert.strictEqual(plan.evidence.analysis.basis, 'explicit_lock');
});

test('setup frugal never pins a paid critic; prefers local, else OPEN', () => {
  const rich = resolveSetupPlan(INV_RICH, { pack: 'frugal' });
  assert.ok(/^ollama:/.test(rich.roles.critic), 'critic local when present');
  const nolocal = resolveSetupPlan(INV_NOLOCAL, { pack: 'frugal' });
  assert.strictEqual(nolocal.roles.critic, null, 'critic OPEN when no local (never paid)');
  assert.ok(nolocal.warnings.some((w) => /critic/.test(w)));
});

test('setup sensitive=yes forbids paid critic and floors analysis effort', () => {
  const plan = resolveSetupPlan(INV_NOLOCAL, { pack: 'quality', sensitive: 'yes' });
  assert.ok(plan.roles.critic === null || /^ollama:/.test(plan.roles.critic), 'no paid critic pin');
  assert.ok(/@(high|xhigh)$/.test(plan.roles.analysis), 'analysis effort >= high');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setup pack 'quality' not yet implemented`.

- [ ] **Step 3: Implement** — replace the `throw` branch in `resolveSetupPlan` with `quality` + `frugal` (keep `local` throwing):

```js
  if (pack === 'quality') {
    const cloud = setupCloud(inv);
    const a = setupStrongCloud(cloud);
    if (a) { roles.analysis = setupCloudSpec(a, 'xhigh'); evidence.analysis = { routing_mode:'pinned', basis:'explicit_lock' }; }
    const d = setupStrongCloud(cloud.filter((p) => !a || p.name !== a.name)) || a;
    if (d) {
      roles.design = setupCloudSpec(d, 'high');
      evidence.design = { routing_mode:'pinned', basis:'explicit_lock' };
      if (a && d.name === a.name) warnings.push('single_lab_collapse: only one strong lab READY — design reuses it (best available, not cross-lab)');
    }
    const strongCritic = setupStrongCloud(cloud);
    if (strongCritic) { roles.critic = setupCloudSpec(strongCritic, 'medium'); evidence.critic = { routing_mode:'pinned', basis:'explicit_lock' }; }
    else {
      const locals = setupLocals(inv);
      if (locals.length) { const c = [...locals].sort(setupSizeDesc)[0]; roles.critic = setupLocalSpec(c, 'medium'); evidence.critic = { routing_mode:'pinned', basis:'largest_local' }; }
    }
    if (!cloud.length) warnings.push('no non-host cloud READY — quality falls back to local; consider `local` pack');
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }

  if (pack === 'frugal') {
    const cloud = setupCloud(inv);
    const locals = setupLocals(inv);
    const a = setupCheapest(cloud.filter((p) => p.tier === 'strong' || p.tier === 'balanced'));
    if (a) { roles.analysis = setupCloudSpec(a, 'medium'); evidence.analysis = { routing_mode:'pinned', basis:'cost_lock' }; }
    else if (locals.length) { const la = [...locals].sort(setupSizeDesc)[0]; roles.analysis = setupLocalSpec(la, 'medium'); evidence.analysis = { routing_mode:'pinned', basis:'cost_lock_local' }; }
    if (locals.length) {
      const cheapLocal = [...locals].sort(setupSizeAsc)[0];
      roles.design = setupLocalSpec(cheapLocal, 'low'); evidence.design = { routing_mode:'pinned', basis:'local_cheap' };
      roles.critic = setupLocalSpec(cheapLocal, 'low'); evidence.critic = { routing_mode:'pinned', basis:'local_cheap' };
    } else {
      evidence.design = { routing_mode:'open', basis:'open_no_local' };
      evidence.critic = { routing_mode:'open', basis:'open_no_local' };
      warnings.push('no local model → design & critic left to routing (frugal never pins a paid critic)');
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }
```

Extend `finishSetupPlan` — insert BEFORE the overrides loop:

```js
  if (sensitive === 'yes') {
    // never freeze a paid critic on security-sensitive work
    if (roles.critic && !/^ollama:|^lmstudio(@|$)|^lemonade(@|$)/.test(roles.critic)) {
      roles.critic = null;
      evidence.critic = { routing_mode: 'open', basis: 'sensitive_no_paid_critic' };
      warnings.push('sensitive=yes: refused a paid critic pin — left to routing');
    }
    // floor analysis effort to at least high
    if (roles.analysis && /@(low|medium)$/.test(roles.analysis)) {
      roles.analysis = roles.analysis.replace(/@(low|medium)$/, '@high');
      evidence.analysis = { ...(evidence.analysis || {}), sensitive_bumped: true };
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS. Run: `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-routing.js scripts/test-advisor.mjs
git commit -m "feat(setup): quality + frugal packs + sensitive=yes policy"
```

---

### Task 4: `local` pack — decorrelation spread, capability warnings, degenerate cases

**Files:**
- Modify: `scripts/xllm-routing.js` (replace the remaining `local` throw)
- Test: `scripts/test-advisor.mjs`

**Interfaces:**
- Consumes: `setupLocals`, `setupSizeDesc`, `setupSizeAsc`, `passesCapabilityFloor` (already in file), `JUDGMENT_ROLES`.
- Produces: `resolveSetupPlan` handles `local`: full local pins spread across runtimes/models; `single_model`, `unsatisfiable`, and `capability_floor` warnings.

- [ ] **Step 1: Write the failing tests**

```js
const INV_LOCAL2 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b','llama3.2:3b'] } } };
const INV_LOCAL1 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b'] } } };
const INV_LOCAL0 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:false, tier:'local', relative_cost:0, models:[] } } };

test('setup local spreads across models and pins all three', () => {
  const plan = resolveSetupPlan(INV_LOCAL2, { pack: 'local' });
  assert.ok(/^ollama:qwen3.6:14b@medium$/.test(plan.roles.analysis), 'most-capable → analysis');
  assert.ok(/^ollama:/.test(plan.roles.design) && plan.roles.design !== plan.roles.analysis, 'design a different local');
  assert.ok(/^ollama:llama3.2:3b@low$/.test(plan.roles.critic), 'smallest → critic');
});

test('setup local with one model shares it and warns single_model', () => {
  const plan = resolveSetupPlan(INV_LOCAL1, { pack: 'local' });
  assert.ok(plan.roles.analysis && plan.roles.critic, 'roles pinned');
  assert.ok(plan.warnings.some((w) => /single_model/.test(w)));
});

test('setup local with no local models is unsatisfiable → all OPEN + warn', () => {
  const plan = resolveSetupPlan(INV_LOCAL0, { pack: 'local' });
  assert.deepStrictEqual(plan.roles, { analysis:null, design:null, critic:null });
  assert.ok(plan.warnings.some((w) => /no local|pull/.test(w)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setup pack 'local' not yet implemented`.

- [ ] **Step 3: Implement** — replace the `local` throw branch:

```js
  if (pack === 'local') {
    const locals = setupLocals(inv);
    if (!locals.length) {
      warnings.push('no local model pulled — `local` pack unsatisfiable; run `ollama pull <model>` (or install lmstudio/lemonade), or use `skip`');
      for (const r of SETUP_ROLES) evidence[r] = { routing_mode:'open', basis:'local_unsatisfiable' };
      return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
    }
    const byBig = [...locals].sort(setupSizeDesc);
    const bySmall = [...locals].sort(setupSizeAsc);
    const analysis = byBig[0];
    const critic = bySmall[0];
    // design: prefer a different runtime, else a different model spec, else reuse
    const design = locals.find((c) => c.runtime !== analysis.runtime)
      || locals.find((c) => c.spec !== analysis.spec) || analysis;
    roles.analysis = setupLocalSpec(analysis, 'medium');
    roles.design = setupLocalSpec(design, 'low');
    roles.critic = setupLocalSpec(critic, 'low');
    const label = (c) => c.cap.billions != null ? `${c.cap.billions}B` : 'size_unknown';
    evidence.analysis = { routing_mode:'pinned', basis:'most_capable_local', size: label(analysis) };
    evidence.design = { routing_mode:'pinned', basis: design.runtime !== analysis.runtime ? 'cross_runtime' : 'different_model', size: label(design) };
    evidence.critic = { routing_mode:'pinned', basis:'smallest_local', size: label(critic) };
    if (locals.length === 1) warnings.push('single_model: only one local model — all roles share it (no decorrelation)');
    // capability-floor visibility for judgment role critic; analysis/design get a soft warn if tiny
    for (const [r, c] of [['analysis', analysis], ['design', design], ['critic', critic]]) {
      if (c.cap.size_class === 'tiny') warnings.push(`capability floor: ${r} local is ${c.cap.billions}B (tiny) — low confidence on judgment`);
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS. Run: `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-routing.js scripts/test-advisor.mjs
git commit -m "feat(setup): local pack — decorrelation spread + degenerate cases"
```

---

### Task 5: `recommended_packs` ordering

Add the inventory-conditioned pack ranking the skill renders into its 4-option UI.

**Files:**
- Modify: `scripts/xllm-routing.js` (add `recommendPacks`; call it inside `resolveSetupPlan`'s return via `finishSetupPlan`)
- Test: `scripts/test-advisor.mjs`

**Interfaces:**
- Produces: `recommendPacks(inventory) -> string[]` (ordered, always contains `skip`); `resolveSetupPlan(...).recommended_packs` populated.

- [ ] **Step 1: Write the failing tests**

```js
test('recommendPacks demotes local when no local models', () => {
  const r = recommendPacks(INV_NOLOCAL);
  assert.ok(r.includes('skip'), 'skip always present');
  assert.ok(r.indexOf('local') === -1 || r.indexOf('local') > r.indexOf('balanced'), 'local not surfaced first');
  assert.strictEqual(r[0], 'balanced');
});

test('recommendPacks surfaces local first when no non-host cloud', () => {
  const r = recommendPacks(INV_LOCAL2);
  assert.strictEqual(r[0], 'local');
  assert.ok(r.includes('skip'));
});

test('resolveSetupPlan includes recommended_packs', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'balanced' });
  assert.ok(Array.isArray(plan.recommended_packs) && plan.recommended_packs.includes('skip'));
});
```

Add `recommendPacks` to the routing import line in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `recommendPacks is not defined`.

- [ ] **Step 3: Implement** — add `recommendPacks` after `resolveSetupPlan`, and populate in `finishSetupPlan`:

```js
/** Inventory-conditioned pack ordering for the skill's 4-option UI. skip always present. */
export function recommendPacks(inventory) {
  const cloud = setupCloud(inventory);
  const locals = setupLocals(inventory);
  if (!cloud.length && !locals.length) return ['skip'];
  let order;
  if (!cloud.length) order = ['local', 'frugal', 'skip', 'balanced'];
  else if (!locals.length) order = ['balanced', 'quality', 'frugal', 'skip'];
  else order = ['balanced', 'quality', 'frugal', 'local'];
  if (!order.includes('skip')) order = [...order.slice(0, 3), 'skip'];
  return order;
}
```

In `finishSetupPlan`, change the final return to:

```js
  return { pack, roles, warnings, evidence, recommended_packs: recommendPacks(inv) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS. Run: `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-routing.js scripts/test-advisor.mjs
git commit -m "feat(setup): recommended_packs ordering for skill 4-option UI"
```

---

### Task 6: `applySetupPlan` — semantic validation + atomic write/delete

Validate the whole resolved plan (including `--role` overrides) against inventory, then write pins / delete OPEN keys atomically. This lives in the advisor (needs fs).

**Files:**
- Modify: `scripts/xllm-advisor.js` (add `applySetupPlan` after `deleteProfileKey`)
- Test: `scripts/test-advisor.mjs`

**Interfaces:**
- Consumes: `parseProviderSpec`, `setProfileValue`, `deleteProfileKey`, an `inventory` object, `SETUP_ROLES` (import from routing — dynamic to avoid the advisor→routing cycle, OR duplicate the 3-element constant locally in advisor). Use a local constant `const SETUP_ROLE_KEYS = ['analysis','design','critic'];` in advisor to avoid the cycle.
- Produces: `validateSetupPin(spec, role, inventory) -> {ok:boolean, error?:string}`; `applySetupPlan(plan, { inventory, apply=false, root=process.cwd() }) -> { written:string[], deleted:string[], errors:string[] }`. On any validation error and `apply=true`, throws before ANY write (atomic).

- [ ] **Step 1: Write the failing tests**

```js
const APPLY_INV = {
  host_cli:'claude',
  providers:{
    codex:{ kind:'cloud', installed:true, healthy:true, tier:'strong', relative_cost:7 },
    ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b'] },
    gemini:{ kind:'cloud', installed:false, healthy:false, tier:'balanced', relative_cost:4 },
  },
};

test('applySetupPlan writes pins and deletes OPEN keys atomically', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp); // pre-existing pin
    const plan = { pack:'balanced', roles:{ analysis:null, design:null, critic:'ollama:qwen3.6:14b@low' } };
    const res = applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp });
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/analysis\s*=/.test(body), 'OPEN analysis key deleted');
    assert.ok(/critic\s*=\s*"ollama:qwen3.6:14b@low"/.test(body), 'critic pinned');
    assert.ok(res.deleted.includes('analysis') && res.written.includes('critic'));
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan rejects a pin to a non-READY provider with zero writes', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply2-'));
  try {
    const plan = { pack:'balanced', roles:{ analysis:'gemini@high', design:null, critic:null } };
    assert.throws(() => applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp }), /not READY|gemini/);
    assert.ok(!fs.existsSync(path.join(tmp, '.xllm', 'xllm-providers.toml')), 'no file written on validation failure');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan skip clears all posture role keys', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply3-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp);
    setProfileValue('roles', 'critic', 'ollama:qwen3.6:14b@low', tmp);
    const plan = { pack:'skip', roles:{ analysis:null, design:null, critic:null } };
    applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp });
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/analysis\s*=/.test(body) && !/critic\s*=/.test(body), 'posture pins cleared');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
```

Add `applySetupPlan` to the advisor import list in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `applySetupPlan is not defined`.

- [ ] **Step 3: Implement in `scripts/xllm-advisor.js`** (after `deleteProfileKey`):

```js
const SETUP_ROLE_KEYS = ['analysis', 'design', 'critic'];

/** Validate one resolved pin against inventory. Returns {ok, error?}. */
export function validateSetupPin(spec, role, inventory) {
  if (!SETUP_ROLE_KEYS.includes(role)) return { ok: false, error: `unknown role: ${role}` };
  const parsed = parseProviderSpec(spec);
  if (!parsed) return { ok: false, error: `invalid spec: ${spec}` };
  const p = inventory.providers?.[parsed.provider];
  if (!p) return { ok: false, error: `unknown provider: ${parsed.provider}` };
  if (!(p.installed && p.healthy)) return { ok: false, error: `provider not READY: ${parsed.provider}` };
  if (parsed.provider === inventory.host_cli) return { ok: false, error: `host vendor excluded: ${parsed.provider}` };
  if (parsed.model && p.kind === 'local' && Array.isArray(p.models) && !p.models.includes(parsed.model)) {
    return { ok: false, error: `local model not pulled: ${parsed.model}` };
  }
  return { ok: true };
}

/**
 * Validate the whole plan (pins + overrides) against inventory, then — only if
 * apply — write pins and DELETE keys for OPEN (null) roles. Atomic: any
 * validation error throws before a single write.
 */
export function applySetupPlan(plan, { inventory, apply = false, root = process.cwd() } = {}) {
  const errors = [];
  for (const role of SETUP_ROLE_KEYS) {
    const spec = plan.roles[role];
    if (spec == null) continue; // OPEN
    const v = validateSetupPin(spec, role, inventory);
    if (!v.ok) errors.push(`${role}: ${v.error}`);
  }
  if (errors.length) {
    if (apply) throw new Error(`setup validation failed (no changes written): ${errors.join('; ')}`);
    return { written: [], deleted: [], errors };
  }
  const written = [];
  const deleted = [];
  if (apply) {
    for (const role of SETUP_ROLE_KEYS) {
      const spec = plan.roles[role];
      if (spec == null) { deleteProfileKey('roles', role, root); deleted.push(role); }
      else { setProfileValue('roles', role, spec, root); written.push(role); }
    }
  }
  return { written, deleted, errors: [] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS. Run: `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-advisor.js scripts/test-advisor.mjs
git commit -m "feat(setup): applySetupPlan — atomic validated write/delete"
```

---

### Task 7: `--setup` CLI dispatch in the advisor

Wire the mode: build inventory, resolve plan, merge `--role` overrides, preview (default) or `--apply`; `--json` for the skill/tests.

**Files:**
- Modify: `scripts/xllm-advisor.js` — `parseArgs` (~line 2287, near other `args[0] === '--x'` branches) + `main` (~line 2456, near other mode handlers) + `usage()` help text (~line 1280)
- Test: `scripts/test-advisor.mjs` (spawn the CLI; assert stdout JSON + no-write-on-preview)

**Interfaces:**
- Consumes: `buildInventory`, `applySetupPlan`; dynamic `import('./xllm-routing.js')` for `resolveSetupPlan` (avoids the top-level cycle).
- Produces: CLI `node scripts/xllm-advisor.js --setup <pack> [--apply] [--role R=SPEC ...] [--json] [--sensitive auto|yes|no]`.

- [ ] **Step 1: Write the failing test**

```js
test('--setup balanced --json previews without writing', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-cli-'));
  try {
    const res = spawnSync(process.execPath,
      [path.join(root, 'scripts', 'xllm-advisor.js'), '--setup', 'skip', '--json'],
      { encoding:'utf8', env:{ ...process.env, XLLM_STATE_DIR: tmp } });
    assert.strictEqual(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.strictEqual(plan.pack, 'skip');
    assert.ok(!fs.existsSync(path.join(tmp, 'xllm-providers.toml')), 'preview writes nothing');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
```

(`spawnSync` is already imported? No — add `import { spawnSync } from 'child_process';` at the top of the test file if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — exit non-zero / unknown mode (advisor `usage()` on unrecognized `--setup`).

- [ ] **Step 3: Implement**

In `parseArgs`, before the final `parseProviderSpec(args[0])` fallthrough:

```js
  if (args[0] === '--setup') {
    const pack = args[1] && !args[1].startsWith('--') ? args[1] : 'balanced';
    const overrides = {};
    let sensitive = 'auto';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--role' && args[i + 1]) {
        const [r, ...rest] = args[++i].split('=');
        overrides[r] = rest.join('=');
      } else if (args[i] === '--sensitive' && args[i + 1]) {
        sensitive = args[++i];
      }
    }
    return { mode: 'setup', pack, overrides, sensitive, flags };
  }
```

(`flags.apply` — extend the flag loop near line 2249 to set `flags.apply = true` on `--apply`, and `flags.json` on `--json` if not already tracked.)

In `main`, add a handler (after the `set-default` block, ~line 2455):

```js
  if (parsed.mode === 'setup') {
    const { resolveSetupPlan } = await import('./xllm-routing.js');
    const inv = buildInventory({});
    const sensitive = parsed.sensitive === 'auto' ? 'no' : parsed.sensitive; // bare CLI has no host skim
    const plan = resolveSetupPlan(inv, {
      pack: parsed.pack, host: inv.host_cli, overrides: parsed.overrides, sensitive,
    });
    let applied = { written: [], deleted: [], errors: [] };
    if (parsed.flags.apply) {
      applied = applySetupPlan(plan, { inventory: inv, apply: true });
    }
    if (parsed.flags.json) {
      console.log(JSON.stringify({ ...plan, applied, apply: !!parsed.flags.apply }, null, 2));
    } else {
      console.log(formatSetupPlanHuman(plan, { apply: !!parsed.flags.apply, applied }));
    }
    process.exit(0);
  }
```

Add `formatSetupPlanHuman` near the other formatters (e.g. after `buildInventory`, or in the "Public helpers" region):

```js
export function formatSetupPlanHuman(plan, { apply = false, applied = {} } = {}) {
  const lines = [`setup pack: ${plan.pack}${apply ? ' (applied)' : ' (preview — nothing written)'}`, ''];
  for (const role of ['analysis', 'design', 'critic']) {
    const spec = plan.roles[role];
    const ev = plan.evidence?.[role] || {};
    lines.push(`  ${role.padEnd(9)} ${spec ? spec : 'OPEN (measured routing)'}${ev.basis ? `   · ${ev.basis}` : ''}`);
  }
  if (plan.warnings?.length) { lines.push('', 'warnings:'); for (const w of plan.warnings) lines.push(`  ⚠ ${w}`); }
  if (apply) lines.push('', `written: ${(applied.written || []).join(', ') || '-'}   deleted: ${(applied.deleted || []).join(', ') || '-'}`);
  else lines.push('', 'apply with:  node scripts/xllm.mjs setup ' + plan.pack + ' --apply');
  return lines.join('\n');
}
```

Add a `--setup` line to `usage()`:

```js
  node scripts/xllm-advisor.js --setup <pack> [--apply] [--role R=SPEC] [--json] [--sensitive auto|yes|no]
                     (posture packs: balanced|quality|frugal|local|skip; preview unless --apply)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` → PASS.
Manual smoke: `node scripts/xllm-advisor.js --setup balanced` (human preview), `--setup local --json`.
Run: `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm-advisor.js scripts/test-advisor.mjs
git commit -m "feat(setup): --setup CLI mode (preview/apply/role/json/sensitive)"
```

---

### Task 8: `xllm.mjs setup` subcommand + help

**Files:**
- Modify: `scripts/xllm.mjs` (add `setup` dispatch near the other `run(script, args)` cases + a help line, ~line 42-76)

**Interfaces:**
- Consumes: advisor `--setup` mode.
- Produces: `node scripts/xllm.mjs setup [pack] [--apply] [--role ...] [--json] [--sensitive ...]` forwards to `xllm-advisor.js --setup ...`.

- [ ] **Step 1: Write the failing test**

```js
test('xllm.mjs setup subcommand forwards to advisor --setup', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-mjs-'));
  try {
    const res = spawnSync(process.execPath,
      [path.join(root, 'scripts', 'xllm.mjs'), 'setup', 'skip', '--json'],
      { encoding:'utf8', env:{ ...process.env, XLLM_STATE_DIR: tmp } });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(JSON.parse(res.stdout).pack, 'skip');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `xllm.mjs` prints help / exits non-zero on unknown `setup` command.

- [ ] **Step 3: Implement in `scripts/xllm.mjs`**

Add a dispatch case in the command switch (mirroring how `ask`/`doctor` call `run(advisor, [...])`):

```js
if (cmd === 'setup') {
  run(advisor, ['--setup', ...rest]);
}
```

Add to the `help()` text under Commands:

```
  setup [pack] [--apply]  Resolve inventory→role pins (posture packs); preview unless --apply
                          packs: balanced(default)|quality|frugal|local|skip; --role R=SPEC --json --sensitive
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` → PASS. Run: `npm run check` → PASS (check runs `node --check scripts/xllm.mjs` + `check-plugin.mjs`).

- [ ] **Step 5: Commit**

```bash
git add scripts/xllm.mjs scripts/test-advisor.mjs
git commit -m "feat(setup): xllm setup subcommand"
```

---

### Task 9: setup SKILL.md Step 3 rewrite + docs + CI green

Point the skill at the deterministic resolver and finish with a full CI run.

**Files:**
- Modify: `skills/setup/SKILL.md` (Step 3 — the per-role Q&A section) and, if present, `.grok/skills/xllm-setup/SKILL.md` (mirror the same prose)
- Modify: `README.md` (one row/line noting `setup` packs, near the CLI reference table)

**Interfaces:** None (prose only). Verified by `check-plugin.mjs` (runs in `npm run check`) and manual read.

- [ ] **Step 1: Rewrite `skills/setup/SKILL.md` Step 3**

Replace the "Per-project advisor wizard (Q&A)" step body with:

```markdown
## Step 3 — Per-project advisor wizard (posture packs)

Resolve pins deterministically; the skill only renders and confirms.

1. **Preview the recommended pack** (default `balanced`):

   ```bash
   node <advisor.js> --setup balanced --json
   ```

   The resolver returns `{ roles, warnings, evidence, recommended_packs }`.
   `balanced` leaves analysis/design OPEN (measured routing) and pins at most a
   free local critic — a pin FREEZES measured routing, so packs pin only genuine
   constraints. `quality` = max-spend lock, `frugal` = cost lock, `local` =
   offline lock, `skip` = clear pins.

2. **Ask ONE question** using the host's UI, offering the first four of
   `recommended_packs` (always include `skip`). On Claude Code use
   AskUserQuestion with the resolver's top pack labeled "(Recommended)"; show the
   effort legend (Quick=low / Standard=medium / Deep=high) and one-line role
   glosses. Never invent cloud model names — cloud pins omit the model.

3. **Show the resolved preview** (roles + warnings + which stay OPEN and why),
   then on the user's accept:

   ```bash
   node <advisor.js> --setup <pack> --apply
   ```

   Partial tweak: `--role analysis=grok@high` (validated; one bad override writes
   nothing). Reverting: `node <advisor.js> --setup skip --apply` clears the
   posture pins. Verify with `node <advisor.js> --profile-show`.

Never send repository contents to advisors during setup — your analysis stays
local; only the resulting config is written.
```

- [ ] **Step 2: Update README.md**

Add one line to the command reference (near the `/xllm:setup` or CLI table):

```markdown
| `setup [pack]` | 인벤토리→역할 핀을 결정적으로 해석(포스처 팩); `--apply` 전엔 미리보기 | `scripts/xllm-advisor.js --setup` |
```

- [ ] **Step 3: Verify skill structure**

Run: `npm run check`
Expected: PASS (`check-plugin.mjs` validates skill/plugin structure).

- [ ] **Step 4: Full CI**

Run: `npm run ci`
Expected: PASS — check + test + smoke + bench:selftest all green, no live LLM.

- [ ] **Step 5: Commit**

```bash
git add skills/setup/SKILL.md README.md
git commit -m "docs(setup): posture-pack wizard in setup skill + README"
```

---

## Self-Review

**Spec coverage** (against `docs/setup-ux-design.md`):
- Command contract `setup [pack] --apply/--role/--json/--sensitive` → Tasks 7, 8. ✓
- `resolveSetupPlan` pure fn in routing, roles = spec|null, evidence labels, recommended_packs → Tasks 2–5. ✓
- Lighter pins: balanced critic-only, quality/frugal/local pin, skip clears → Tasks 2, 3, 4, 6. ✓
- Thin-inventory fallbacks (no-local OPEN not paid, single-lab, local unsatisfiable/single-model, tiny floor) → Tasks 2–4. ✓
- `--role` atomic semantic validation before write → Task 6. ✓
- skip clears posture pins; delete-key API (no null string) → Tasks 1, 6. ✓
- `--sensitive auto` bare = no; sensitive=yes forbids paid critic + floors analysis → Tasks 3, 7. ✓
- `quality` stores `xhigh` → Task 3. ✓
- Cloud omit model / local include model → Tasks 2–4 spec builders. ✓
- Skill renders recommended_packs, never re-implements ranking → Task 9. ✓
- Out of scope: `cloud`/`nim` packs NOT built. ✓ (roadmap only)

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `resolveSetupPlan` returns `{pack, roles, warnings, evidence, recommended_packs}` consistently (Task 2 defines, Task 5 adds `recommended_packs` via `finishSetupPlan`'s single return). `applySetupPlan(plan, {inventory, apply, root})` and `validateSetupPin(spec, role, inventory)` names match across Tasks 6–7. Helper names (`setupLocals`, `setupCloud`, `setupStrongCloud`, `setupCheapest`, `setupSizeDesc`, `setupSizeAsc`, `setupCloudSpec`, `setupLocalSpec`) defined in Task 2, reused Tasks 3–5. `deleteTomlKey`/`deleteProfileKey` (Task 1) used in Task 6. ✓

**Note on cycle:** advisor must NOT top-level-import routing (routing already imports advisor). Task 6 uses a local `SETUP_ROLE_KEYS` constant; Task 7 uses dynamic `import('./xllm-routing.js')` inside `main`. ✓
