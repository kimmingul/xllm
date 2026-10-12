#!/usr/bin/env node
/**
 * Role + intensity based advisor routing for xllm.
 *
 *   node scripts/xllm-routing.js pick security "auth token refresh"
 *   node scripts/xllm-routing.js infer "typo in README"
 *
 * Importable from xllm-advisor / tests.
 */

import {
  loadProviderProfiles,
  resolvePreferredProvider,
  parseProviderSpec,
  getSupportedProviders,
  detectAvailableProviders,
  getProviderCostMeta,
  buildInventory,
} from './xllm-advisor.js';
import { executionPolicyDecision, executionLocation } from './xllm-evidence.js';
import {
  healthDecision,
  adherenceVeto,
  sharedBenchComparison,
  resolveCandidateEvidence,
  loadTraits,
  TRAIT_GATES,
  ROUTABLE_BENCH_ROLES,
} from './xllm-traits.js';
import process from 'process';

/** Canonical roles for the routing table */
export const ROUTING_ROLES = [
  'explore',
  'implement',
  'security',
  'architecture',
  'design',
  'critic',
  'tests',
  'analysis',
  'docs',
  'verify',
  'scribe',
];

/**
 * Built-in role → preferred advisors (ordered fallbacks).
 * effort is base; intensity may bump/lower it.
 */
export const BUILTIN_ROLE_ROUTES = {
  explore: {
    providers: ['ollama', 'lmstudio', 'grok'],
    effort: 'low',
    native_agent: 'explore',
    prefer_native: true,
    notes: 'Cheap local map; native explore preferred when no CLI needed',
  },
  implement: {
    providers: ['grok', 'codex', 'ollama'],
    effort: 'medium',
    native_agent: 'executor',
    prefer_native: true,
    notes: 'Default: Grok native executor; CLI only if delegated externally',
  },
  security: {
    providers: ['codex', 'claude', 'grok'],
    effort: 'high',
    native_agent: 'security-reviewer',
    prefer_native: false,
    notes: 'Strong cloud critic for auth/injection/secrets',
  },
  architecture: {
    providers: ['codex', 'claude', 'grok'],
    effort: 'high',
    native_agent: 'architect',
    prefer_native: false,
    notes: 'Deep analysis; high effort',
  },
  design: {
    providers: ['antigravity', 'gemini', 'grok', 'ollama'],
    effort: 'medium',
    native_agent: null,
    prefer_native: false,
    notes: 'Antigravity preferred over gemini',
  },
  critic: {
    providers: ['ollama', 'lmstudio', 'grok', 'codex'],
    effort: 'medium',
    native_agent: 'critic',
    prefer_native: false,
    notes: 'Volume reviews local; escalate to codex on high intensity',
  },
  tests: {
    providers: ['ollama', 'grok', 'codex'],
    effort: 'medium',
    native_agent: 'executor',
    prefer_native: true,
    notes: 'Prefer native test runs; local for test design suggestions',
  },
  analysis: {
    providers: ['codex', 'claude', 'grok'],
    effort: 'high',
    native_agent: 'planner',
    prefer_native: false,
    notes: 'xllm analysis lane',
  },
  docs: {
    providers: ['ollama', 'grok', 'antigravity'],
    effort: 'low',
    native_agent: 'writer',
    prefer_native: true,
    notes: 'Cheap local or native writing',
  },
  verify: {
    providers: ['codex', 'grok', 'ollama'],
    effort: 'medium',
    native_agent: 'verifier',
    prefer_native: true,
    notes: 'Evidence first via native tools; CLI second opinion on high',
  },
  scribe: {
    providers: ['ollama', 'lmstudio', 'antigravity', 'grok'],
    effort: 'low',
    native_agent: null,
    prefer_native: false,
    notes: 'Mechanical prose (commit/PR/release text); cheapest healthy first',
  },
};

const HIGH_SIGNALS =
  /\b(secur(e|ity)|authn?|authz|oauth|jwt|token|crypto|encrypt|password|secret|inject|xss|csrf|ssrf|rce|payment|billing|pci|hipaa|race|deadlock|concurrent|migrat(e|ion)|architecture|redesign|prod(uction)?|incident|breach|p0|critical|threat)\b/i;

const LOW_SIGNALS =
  /\b(typo|readme|comment|rename|format|lint|style|docs? only|changelog|wording|copy.?edit|simple|trivial|nit)\b/i;

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

// Judgment roles where a tiny local model shouldn't get a vote (diversity
// theater guard from the debate). Capability floor applies here.
export const JUDGMENT_ROLES = ['security', 'architecture', 'verify', 'critic'];

/**
 * Rough capability class of a model from its name — heuristic, not lineage
 * scoring. Returns { size_class, kind }. Unknown → assume capable (cloud
 * models have no local size signal).
 */
export function modelCapability(spec) {
  const s = String(spec || '').toLowerCase();
  const kind = /coder?|code|deepseek|qwen.*coder|starcoder/.test(s)
    ? 'code'
    : /embed/.test(s)
      ? 'embed'
      : 'general';
  const bMatch = s.match(/[:\-](\d+(?:\.\d+)?)b\b/) || s.match(/\b(\d+(?:\.\d+)?)b\b/);
  const billions = bMatch ? Number(bMatch[1]) : null;
  let size_class = 'unknown';
  if (billions != null) {
    if (billions < 4) size_class = 'tiny';
    else if (billions < 12) size_class = 'small';
    else if (billions < 40) size_class = 'medium';
    else size_class = 'large';
  }
  return { size_class, kind, billions };
}

/**
 * Capability floor guard: is this model allowed to hold a vote on this role?
 * Only local/tiny models on judgment roles are blocked (unless overridden).
 * Cloud models and unknown sizes pass — we don't invent limits we can't see.
 */
export function passesCapabilityFloor(role, providerSpec, { tier = null, allowBelowFloor = false } = {}) {
  if (allowBelowFloor) return { ok: true, reason: 'override' };
  const normRole = normalizeRole(role) || role;
  if (!JUDGMENT_ROLES.includes(normRole)) return { ok: true, reason: 'non-judgment role' };
  if (tier && tier !== 'local') return { ok: true, reason: 'non-local tier' };
  const cap = modelCapability(providerSpec);
  if (cap.size_class === 'tiny') {
    return {
      ok: false,
      reason: `local ${cap.billions}B model below capability floor for judgment role '${normRole}'`,
    };
  }
  return { ok: true, reason: cap.size_class };
}

function normalizeRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  const aliases = {
    explorer: 'explore',
    research: 'explore',
    executor: 'implement',
    impl: 'implement',
    implementation: 'implement',
    coder: 'implement',
    sec: 'security',
    security_reviewer: 'security',
    'security-reviewer': 'security',
    arch: 'architecture',
    architect: 'architecture',
    ux: 'design',
    ui: 'design',
    designer: 'design',
    review: 'critic',
    reviewer: 'critic',
    test: 'tests',
    testing: 'tests',
    qa: 'tests',
    plan: 'analysis',
    planner: 'analysis',
    analyze: 'analysis',
    doc: 'docs',
    documentation: 'docs',
    writer: 'docs',
    verification: 'verify',
    verifier: 'verify',
  };
  const key = aliases[r] || r;
  return ROUTING_ROLES.includes(key) ? key : null;
}

function normalizeIntensity(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (['low', 'l', 'cheap', 'light'].includes(s)) return 'low';
  if (['medium', 'med', 'm', 'normal', 'default'].includes(s)) return 'medium';
  if (['high', 'h', 'heavy', 'hard', 'critical', 'xhigh', 'max'].includes(s)) {
    return s === 'xhigh' || s === 'max' ? 'high' : 'high';
  }
  return null;
}

/**
 * Infer low|medium|high from free text (+ optional explicit override).
 */
export function inferIntensity(taskText = '', explicit = null) {
  const ex = normalizeIntensity(explicit);
  if (ex) return { intensity: ex, source: 'explicit', signals: [] };

  const text = String(taskText || '');
  const signals = [];
  let score = 0;

  if (HIGH_SIGNALS.test(text)) {
    score += 2;
    signals.push('high-keyword');
  }
  if (LOW_SIGNALS.test(text)) {
    score -= 2;
    signals.push('low-keyword');
  }
  // length heuristic
  if (text.length > 400) {
    score += 1;
    signals.push('long-brief');
  }
  if (/\b(multi-?file|refactor|rewrite|migrate|overhaul)\b/i.test(text)) {
    score += 1;
    signals.push('large-change');
  }
  if (/\b(one.?line|single file|tiny|minor)\b/i.test(text)) {
    score -= 1;
    signals.push('small-change');
  }

  let intensity = 'medium';
  if (score >= 2) intensity = 'high';
  else if (score <= -1) intensity = 'low';

  return { intensity, source: 'inferred', signals, score };
}

function bumpEffort(base, intensity) {
  const b = EFFORT_ORDER.includes(base) ? base : 'medium';
  let idx = EFFORT_ORDER.indexOf(b);
  if (intensity === 'high') idx = Math.min(EFFORT_ORDER.length - 1, idx + 1);
  if (intensity === 'low') idx = Math.max(0, idx - 1);
  // security/architecture already high → xhigh on high intensity
  if (intensity === 'high' && (b === 'high' || idx >= 2)) {
    return 'xhigh';
  }
  return EFFORT_ORDER[idx];
}

function mergeRoleRoutes(profiles) {
  const routes = { ...BUILTIN_ROLE_ROUTES };
  // deep clone provider arrays
  for (const k of Object.keys(routes)) {
    routes[k] = {
      ...routes[k],
      providers: [...(routes[k].providers || [])],
    };
  }
  // [routing.roles.*] object tweaks apply first; [roles] string pins are an
  // explicit user decision and override the same role.
  const custom = {
    ...(profiles?.routing?.roles || {}),
    ...(profiles?.roles || {}),
  };
  for (const [role, conf] of Object.entries(custom)) {
    const key = normalizeRole(role) || role;
    // String form pins the role to an exact spec: analysis = "codex@high"
    if (typeof conf === 'string') {
      const spec = parseProviderSpec(conf, profiles);
      if (!spec) continue;
      const base = routes[key] || {
        providers: [],
        effort: 'medium',
        prefer_native: false,
        native_agent: null,
        notes: '',
      };
      routes[key] = {
        ...base,
        providers: [spec.provider],
        model: spec.model || '',
        effort: spec.effort || base.effort,
        prefer_native: false,
        pinned: true,
        notes: `pinned by project profile (${conf})`,
      };
      continue;
    }
    if (!conf || typeof conf !== 'object') continue;
    const base = routes[key] || {
      providers: [],
      effort: 'medium',
      prefer_native: false,
      notes: '',
    };
    let providers = base.providers;
    if (conf.providers) {
      providers = Array.isArray(conf.providers)
        ? conf.providers
        : String(conf.providers)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    } else if (conf.provider) {
      providers = [conf.provider, ...base.providers.filter((p) => p !== conf.provider)];
    }
    routes[key] = {
      ...base,
      providers: providers.map((p) => String(p).toLowerCase()),
      effort: conf.effort || conf.default_effort || base.effort,
      model: conf.model || conf.default_model || base.model || '',
      prefer_native:
        conf.prefer_native !== undefined
          ? conf.prefer_native === true || conf.prefer_native === 'true'
          : base.prefer_native,
      native_agent: conf.native_agent || base.native_agent,
      notes: conf.notes || base.notes,
    };
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Execution boundary, eligibility and cost (shared by pick / tiebreak / setup)
// ---------------------------------------------------------------------------

/** No candidate satisfies policy / safety / health. Never silently relaxed. */
export class RoutingUnsatisfiableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RoutingUnsatisfiableError';
    this.code = 'ROUTING_UNSATISFIABLE';
    Object.assign(this, details);
  }
}

/** Persisted execution policy: 'any' (default) | 'local-only'. Unknown values fail closed downstream. */
export function executionPolicyOf(profiles) {
  return profiles?.defaults?.execution_policy || 'any';
}

/** A FRESH, VALID observed auth failure: this account is known not to work. */
function observedAuthFailure(h) {
  return !!h && h.fresh === true && h.kind === 'auth' && h.blocking_source === 'auth';
}

/**
 * Health verdict for one provider: 'veto' | 'demote' | 'ignore'.
 *
 * An observed (fresh, context-matching) auth failure is a hard veto that
 * pins and explicit --ready lists CANNOT ride over; it clears only through a
 * newer observation (success), TTL expiry, or a CLI-version / account-context
 * change. There is no override. Everything else keeps the kind-aware rules: an
 * explicit ready list is authority for binary-presence/contract kinds, and
 * profile pins bypass non-auth health. Unknown health never vetoes.
 */
function healthVerdict(provider, traits, { readySource, detectedReady, pinned = false }) {
  if (!traits || !traits.health) return 'ignore';
  if (observedAuthFailure(traits.health[provider])) return 'veto';
  if (pinned) return 'ignore';
  return healthDecision(provider, traits.health, { readySource, detectedReady });
}

/** Per-model server metadata from inventory.model_details (ollama lists `name:latest`). */
function modelInfoFor(inventory, provider, model) {
  const details = inventory?.providers?.[provider]?.model_details;
  if (!details || !model) return null;
  const m = String(model);
  return details[m] ?? details[`${m}:latest`] ?? details[m.replace(/:latest$/, '')] ?? null;
}

/**
 * Hard gate for ONE candidate: safety eligibility (explicit
 * advisor_eligible === false only — a missing field is unknown, not unsafe),
 * then the execution policy. Applies to pins, --ready lists and fallbacks alike.
 */
function candidateGate(provider, model, { profiles, env, inventory }) {
  const info = modelInfoFor(inventory, provider, model);
  const d = executionPolicyDecision(provider, model, { profiles, env, modelInfo: info });
  if (inventory?.providers?.[provider]?.advisor_eligible === false) {
    return {
      allowed: false,
      kind: 'safety',
      location: d.location,
      reason: `${provider}: read-only enforcement unverified (safety unverified) — excluded from automatic advising`,
      modelInfo: info,
    };
  }
  if (!d.allowed) return { allowed: false, kind: 'policy', location: d.location, reason: d.reason, modelInfo: info };
  return { allowed: true, kind: null, location: d.location, reason: null, modelInfo: info };
}

const UNKNOWN_REMOTE_COST = 5;

/**
 * Static heuristic cost label — NOT a price. A local-tier runtime serving a
 * REMOTE model (e.g. ollama `…:cloud`) is not free: its cost is unknown, so it
 * gets the mid-scale default instead of the runtime's zero.
 */
function routingCost(provider, model, profiles, location) {
  const meta = getProviderCostMeta(provider, profiles);
  if (meta.tier === 'local' && location === 'remote') {
    return {
      ...meta,
      tier: 'unknown',
      tier_rank: 1,
      relative_cost: UNKNOWN_REMOTE_COST,
      cost_basis: 'static-heuristic-unknown-remote',
    };
  }
  return { ...meta, cost_basis: 'static-heuristic' };
}

function refusalSummary(refusals) {
  return refusals
    .map((r) => `${r.provider}${r.model ? ':' + r.model : ''} — ${r.reason}`)
    .join('; ');
}

/**
 * Pick advisor for a role given task intensity and optional ready provider set.
 *
 * Every candidate (route order, pin, ready fallback) passes the same gates:
 * advisor safety eligibility, then execution policy; observed health vetoes
 * apply to unpinned roles under a non-explicit ready set. If nothing is left
 * the call THROWS RoutingUnsatisfiableError — it never falls back to a dead,
 * refused or invented provider.
 *
 * options.inventory (buildInventory result) supplies model_details /
 * advisor_eligible; options.env the endpoint environment.
 *
 * @returns {{
 *   role, intensity, intensity_source, provider, model, effort, spec,
 *   native_agent, prefer_native, use_native, reason, fallbacks, signals,
 *   execution_policy, measured_basis, cost
 * }}
 */
export function pickAdvisorForRole(role, options = {}) {
  const profiles = options.profiles || loadProviderProfiles();
  const env = options.env || process.env;
  const inventory = options.inventory || null;
  const policy = executionPolicyOf(profiles);
  const gateCtx = { profiles, env, inventory };
  const routes = mergeRoleRoutes(profiles);
  const normRole = normalizeRole(role) || String(role || 'analysis').toLowerCase();
  const route = routes[normRole] || routes.analysis;

  const inferred = inferIntensity(options.taskText || options.task || '', options.intensity);
  let intensity = inferred.intensity;

  // Role-forced floors/ceilings
  if (['security', 'architecture'].includes(normRole) && intensity === 'low') {
    intensity = 'medium'; // never go too cheap on security/arch unless forced
  }
  if (options.forceIntensity) {
    intensity = normalizeIntensity(options.forceIntensity) || intensity;
  }

  // Pinned roles keep the user's exact effort; otherwise bump by intensity.
  let effort = route.pinned
    ? route.effort || 'medium'
    : bumpEffort(route.effort || 'medium', intensity);
  if (!route.pinned) {
    // security high → xhigh
    if (normRole === 'security' && intensity === 'high') effort = 'xhigh';
    if (normRole === 'explore' && intensity === 'low') effort = 'low';
    if (normRole === 'docs') effort = intensity === 'high' ? 'medium' : 'low';
  }

  if (options.forceNative === true && policy !== 'any') {
    throw new RoutingUnsatisfiableError(
      `execution_policy ${policy}: host-native agents have no verifiable execution location; --force-native refused`,
      { role: normRole, refusals: [{ provider: 'native', model: null, kind: 'policy', reason: 'native location unverifiable' }] }
    );
  }

  const modelFor = (p) => options.model || route.model || profiles.providers?.[p]?.default_model || '';
  const locationOf = (p) =>
    executionLocation(p, modelFor(p), { env, modelInfo: modelInfoFor(inventory, p, modelFor(p)) });
  const costOf = (p) => routingCost(p, modelFor(p), profiles, locationOf(p));

  // Cost/tier-aware ordering (skipped for profile-pinned roles):
  // high intensity on judgment roles → strongest tier first;
  // low intensity outside security/arch → cheapest first (verified-local free).
  // Stable sort preserves the route's preference order within equal ranks.
  let providerOrder = [...route.providers];
  if (!route.pinned) {
    if (
      intensity === 'high' &&
      ['critic', 'verify', 'tests', 'security'].includes(normRole)
    ) {
      providerOrder = providerOrder
        .map((p, i) => ({ p, i, rank: costOf(p).tier_rank }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.p);
    }
    if (intensity === 'low' && !['security', 'architecture'].includes(normRole)) {
      providerOrder = providerOrder
        .map((p, i) => ({ p, i, cost: costOf(p).relative_cost }))
        .sort((a, b) => a.cost - b.cost || a.i - b.i)
        .map((x) => x.p);
    }
  }

  const ready = options.readyProviders
    ? new Set(options.readyProviders.map((p) => String(p).toLowerCase()))
    : null;

  // Gate 1 — safety eligibility + execution policy, for EVERY candidate
  // including pins and explicit --ready lists.
  const refusals = [];
  const resolved = providerOrder.map((raw) => {
    const pref = resolvePreferredProvider(raw, profiles);
    return { raw, p: pref.provider, pref };
  });
  // Model-level candidates: with no explicit model (option / role pin /
  // profile default), a provider that has inventory model_details expands to
  // ONE candidate PER installed model, each gated on its OWN metadata — a
  // verified-local model is routable; a ':cloud' or unverified one is refused
  // individually. Capability-floor-passing models come first (stable order).
  const modelsFor = (p, explicit) => {
    if (explicit) return [explicit];
    const names = Object.keys(inventory?.providers?.[p]?.model_details || {});
    if (!names.length) return [''];
    const tier = getProviderCostMeta(p, profiles).tier;
    const floorRank = (m) => (passesCapabilityFloor(normRole, `${p}:${m}`, { tier }).ok ? 0 : 1);
    return names
      .map((m, i) => ({ m, i }))
      .sort((a, b) => floorRank(a.m) - floorRank(b.m) || a.i - b.i)
      .map((x) => x.m);
  };
  let cands = [];
  for (const c of resolved) {
    for (const model of modelsFor(c.p, modelFor(c.p))) {
      const g = candidateGate(c.p, model, gateCtx);
      if (!g.allowed) {
        refusals.push({ provider: c.p, model: model || null, kind: g.kind, location: g.location, reason: g.reason });
        continue;
      }
      cands.push({ ...c, model, location: g.location });
    }
  }

  // Measured routing layer (docs/traits-design.md). With no traits object
  // this whole block is inert — ordering stays bit-identical to pre-traits
  // behavior (cold-start identity). Health needs `options.traits` (callers pass
  // loadTraits()); an observed auth failure vetoes even pins / explicit ready.
  // `useTraits: false` turns off QUALITY (bench) evidence only; observed health
  // (auth failures) from the same traits object still applies.
  const traits = options.traits || null;
  const qualityEvidence = options.useTraits !== false;
  const readySource = options.readySource || (options.readyProviders ? 'detected' : 'absent');
  const traitDecisions = [];
  if (traits && traits.health) {
    const keep = [];
    const demoted = [];
    for (const c of cands) {
      const d = healthVerdict(c.p, traits, {
        readySource,
        detectedReady: options.readyProviders || null,
        pinned: !!route.pinned,
      });
      const h = traits.health[c.p];
      if (d === 'veto') {
        refusals.push({
          provider: c.p, model: c.model || null, kind: 'health',
          reason: `observed ${h?.kind} failure (${h?.blocking_source || 'probe'})`,
        });
        traitDecisions.push({ trait: 'health', provider: c.p, action: 'veto', kind: h?.kind });
      } else if (d === 'demote') {
        demoted.push(c);
        traitDecisions.push({ trait: 'health', provider: c.p, action: 'demote', kind: h?.kind });
      } else {
        keep.push(c);
      }
    }
    cands = [...keep, ...demoted]; // vetoed candidates are GONE — never restored as a fallback
  }

  let benchDecision = null;
  let measuredBasis;
  if (!traits || !qualityEvidence) {
    measuredBasis = {
      status: 'disabled',
      detail: traits ? 'measured quality routing disabled (health observations still apply)' : 'measured routing off (no traits loaded)',
    };
  } else if (route.pinned) {
    measuredBasis = { status: 'not-applicable', detail: 'role is pinned by profile' };
  } else if (!ROUTABLE_BENCH_ROLES.includes(normRole)) {
    measuredBasis = { status: 'not-applicable', detail: `no benchmark measures role '${normRole}'` };
  } else {
    const pool = cands.filter((c) => !ready || ready.has(c.p));
    const rows = pool.map((c) => {
      const ce = resolveCandidateEvidence(c.p, c.model, effort, traits);
      const b = ce.key ? traits.evidence?.[ce.key]?.bench_defect_detection : null;
      const meta = routingCost(c.p, c.model, profiles, c.location);
      return {
        ...c,
        key: ce.key,
        keyReason: ce.reason,
        bench: b && b.gated ? b : null,
        floorOk: passesCapabilityFloor(normRole, c.model ? `${c.p}:${c.model}` : c.p, { tier: meta.tier }).ok,
        cost: meta.relative_cost,
      };
    });
    const label = (c) => `${c.p}${c.model ? ':' + c.model : ''}`;
    const baseline = rows[0];
    const measured = rows.filter((c) => c.bench && c.floorOk);
    let detail = null;
    // Preconditions: baseline itself measured; ≥2 measured floor-passing
    // candidates. A measured candidate never overrides an unmeasured baseline.
    if (!baseline) detail = 'no eligible candidates to compare';
    else if (!baseline.key) detail = `baseline ${label(baseline)} has no evidence identity: ${baseline.keyReason}`;
    else if (!baseline.bench)
      detail = `baseline ${label(baseline)} lacks gated bench evidence (≥${TRAIT_GATES.bench_min_cells} adjudicated opportunities, ≥${TRAIT_GATES.bench_min_runs} runs each)`;
    else if (!baseline.floorOk) detail = `baseline ${label(baseline)} is below the capability floor`;
    else if (measured.length < 2) detail = 'fewer than 2 candidates have gated bench evidence for their current identity';
    else {
      const qualifying = [];
      let comparable = 0;
      for (const c of measured) {
        if (c.p === baseline.p && c.model === baseline.model) continue;
        const cmp = sharedBenchComparison(c.bench, baseline.bench);
        if (
          !cmp ||
          cmp.shared_tasks < TRAIT_GATES.bench_min_shared_tasks ||
          cmp.shared_opportunities < TRAIT_GATES.bench_min_shared_opportunities
        )
          continue;
        comparable += 1;
        const jump = cmp.candidate_lcb >= cmp.baseline_lcb + TRAIT_GATES.bench_lcb_margin;
        const cheaperParity =
          c.cost < baseline.cost && cmp.candidate_lcb >= cmp.baseline_lcb - TRAIT_GATES.bench_lcb_parity;
        if (jump || cheaperParity) qualifying.push({ ...c, cmp, via: jump ? 'lcb-margin' : 'cheaper-parity' });
      }
      if (qualifying.length) {
        qualifying.sort((a, b) => b.cmp.candidate_lcb - a.cmp.candidate_lcb || a.cost - b.cost);
        const bestLcb = qualifying[0].cmp.candidate_lcb;
        const near = qualifying
          .filter((q) => bestLcb - q.cmp.candidate_lcb <= TRAIT_GATES.bench_lcb_parity)
          .sort((a, b) => a.cost - b.cost);
        const winner = near[0];
        cands = [winner, ...cands.filter((c) => !(c.raw === winner.raw && c.model === winner.model))];
        benchDecision = {
          trait: 'bench_defect_detection',
          selected: label(winner),
          baseline: label(baseline),
          via: winner.via,
          candidate_lcb: winner.cmp.candidate_lcb,
          baseline_lcb: winner.cmp.baseline_lcb,
          shared_tasks: winner.cmp.shared_tasks,
          shared_opportunities: winner.cmp.shared_opportunities,
        };
        traitDecisions.push(benchDecision);
      } else if (!comparable) {
        detail = `shared adjudicated opportunities below gates (tasks ≥${TRAIT_GATES.bench_min_shared_tasks}, opportunities ≥${TRAIT_GATES.bench_min_shared_opportunities})`;
      } else {
        detail = `measured, but no candidate beat ${label(baseline)} under the margin/parity gates — baseline kept`;
      }
    }
    measuredBasis = benchDecision
      ? { status: 'measured', detail: `${benchDecision.selected} over ${benchDecision.baseline} (${benchDecision.via})` }
      : { status: detail && detail.startsWith('measured, but') ? 'measured-baseline-kept' : 'none', detail };
  }

  const tried = [];
  let chosen = null;
  let chosenC = null;
  for (const c of cands) {
    tried.push(c.p);
    if (ready && !ready.has(c.p)) continue;
    chosenC = c;
    break;
  }
  let fallbackNote = null;

  // Last resort: another READY provider — but only one that passes the same
  // gates and is not health-vetoed. Never a dead/refused/invented provider.
  if (!chosenC && ready && ready.size) {
    const seen = new Set(resolved.map((c) => c.p));
    fallback: for (const p of ready) {
      if (seen.has(p)) continue;
      const explicit = options.model || profiles.providers?.[p]?.default_model || '';
      if (
        traits?.health &&
        healthVerdict(p, traits, {
          readySource,
          detectedReady: options.readyProviders || null,
          pinned: !!route.pinned,
        }) === 'veto'
      ) {
        refusals.push({ provider: p, model: explicit || null, kind: 'health', reason: `observed ${traits.health[p]?.kind} failure` });
        continue;
      }
      for (const model of modelsFor(p, explicit)) {
        const g = candidateGate(p, model, gateCtx);
        if (!g.allowed) {
          refusals.push({ provider: p, model: model || null, kind: g.kind, location: g.location, reason: g.reason });
          continue;
        }
        chosenC = { raw: p, p, pref: { provider: p, substituted: false }, model, location: g.location };
        fallbackNote = 'no route provider ready — fell back to a ready provider that passes policy and health';
        break fallback;
      }
    }
  }
  if (!chosenC) {
    throw new RoutingUnsatisfiableError(
      `No advisor satisfies role '${normRole}' under execution_policy ${policy}` +
        (refusals.length ? `: ${refusalSummary(refusals)}` : ready ? ': none of the READY providers fit the route' : ''),
      { role: normRole, policy, refusals }
    );
  }
  chosen = chosenC.p;
  const substituted = chosenC.pref?.substituted ? { from: chosenC.pref.from, reason: chosenC.pref.reason } : null;
  let model = chosenC.model || '';

  // Prefer native when route says so and intensity not forcing external.
  // A non-'any' execution policy disables native: host agents have no
  // verifiable execution location.
  const preferNative = !route.pinned && !!route.prefer_native;
  let useNative =
    options.forceCli === true
      ? false
      : options.forceNative === true
        ? true
        : preferNative && !(intensity === 'high' && ['critic', 'verify'].includes(normRole));
  if (policy !== 'any') useNative = false;

  let spec = chosen;
  if (model) spec = `${chosen}:${model}`;
  if (effort && !useNative) spec = `${spec}@${effort}`;

  // Validate via parseProviderSpec when not native-only
  let parsed = null;
  if (!useNative) {
    parsed = parseProviderSpec(spec, profiles);
    if (parsed) {
      spec = parsed.spec;
      model = parsed.model || model;
      effort = parsed.effort || effort;
    }
  }

  const cost = routingCost(chosen, model, profiles, chosenC.location);
  const noBasis =
    traits && measuredBasis.status === 'none' ? `no measured basis: ${measuredBasis.detail}` : '';

  return {
    role: normRole,
    intensity,
    intensity_source: inferred.source,
    signals: inferred.signals || [],
    provider: chosen,
    model: model || null,
    effort: useNative ? null : effort,
    spec: useNative ? `native:${route.native_agent || normRole}` : spec,
    native_agent: route.native_agent || null,
    prefer_native: preferNative,
    use_native: useNative,
    reason: [
      route.notes || '',
      benchDecision
        ? `measured bench: ${benchDecision.selected} LCB ${benchDecision.candidate_lcb} vs ${benchDecision.baseline} ${benchDecision.baseline_lcb} over ${benchDecision.shared_opportunities} shared opportunities (${benchDecision.shared_tasks} tasks, via ${benchDecision.via})`
        : '',
      noBasis,
      fallbackNote || '',
    ]
      .filter(Boolean)
      .join(' · '),
    fallbacks: [...new Set(tried)].filter((p) => p !== chosen),
    substituted,
    route_effort_base: route.effort,
    pinned: !!route.pinned,
    execution_policy: { policy, location: chosenC.location, allowed: true, reason: null },
    measured_basis: measuredBasis,
    ...(refusals.length ? { policy_refusals: refusals } : {}),
    ...(traitDecisions.length ? { trait_decisions: traitDecisions } : {}),
    cost,
    capability_floor: passesCapabilityFloor(normRole, spec, {
      tier: cost.tier,
      allowBelowFloor: options.allowBelowFloor,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tiebreaker: identity-aware, policy-gated
// ---------------------------------------------------------------------------

/** Provider-neutral model name: lowercase, no ':latest', no cloud marker. */
export function normalizeModelName(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '')
    .replace(/[:-]cloud$/, '');
}

/**
 * Underlying model identity for diversity. The transport (provider/runtime) is
 * NOT part of it: the same weights or the same model name reached through two
 * runtimes is one voice. A local digest is authoritative.
 */
export function underlyingIdentity(provider, model, { modelInfo = null } = {}) {
  return {
    provider: String(provider || '').toLowerCase(),
    name: normalizeModelName(model) || null,
    digest: modelInfo?.digest ? String(modelInfo.digest).toLowerCase() : null,
  };
}

/** True when two identities cannot be PROVEN different. */
export function identitiesCollide(a, b) {
  if (a.digest && b.digest) return a.digest === b.digest;
  if (a.name && b.name) return a.name === b.name;
  // At least one side runs its provider default (model unknown): only a
  // different provider can be proven a different lab/model.
  return a.provider === b.provider;
}

/**
 * Suggest a tiebreaker for a split panel: a not-yet-consulted MODEL (not merely
 * provider), preferring the one with the LOWEST measured agreement to the
 * panel (most decorrelated), falling back to a different-tier strong
 * provider. Never uses lineage — only measured agreement keyed by evidence
 * identity.
 *
 * Candidates are ready entries (provider or provider:model); a bare local
 * runtime expands to every model in opts.inventory.model_details, so a
 * different proven local model on the same runtime is a valid tiebreaker.
 * Identical underlying identity is never counted twice. Safety eligibility,
 * execution policy (even for explicit --ready), observed health and
 * adherence apply as vetoes.
 *
 * @param onPanel       provider specs already on the panel
 * @param ready         available providers / specs
 * @param ledgerMatrix  [{evidence:[keyA,keyB], agreement_rate}] from ledgerStats
 * @param opts          { readySource, inventory, env, panelEvidence:[key|null per onPanel] }
 * @returns {{provider:string|null, runtime?, model?, spec?, measured_agreement?, reason, refusals?}}
 *   provider is the RUNNABLE spec (provider or provider:model).
 */
export function suggestTiebreaker(onPanel, ready, ledgerMatrix = [], profiles = null, traits = null, opts = {}) {
  const prof = profiles || loadProviderProfiles();
  const env = opts.env || process.env;
  const inventory = opts.inventory || null;
  const readySource = opts.readySource || 'detected';
  const gateCtx = { profiles: prof, env, inventory };

  const panel = onPanel.map((s, i) => {
    const ps = parseProviderSpec(s, prof);
    const provider = ps ? ps.provider : String(s).split(/[:@]/)[0].toLowerCase();
    const model = ps ? ps.model : null;
    const evidence =
      opts.panelEvidence && opts.panelEvidence[i] !== undefined
        ? opts.panelEvidence[i]
        : ps && traits
          ? resolveCandidateEvidence(provider, model, ps.effort, traits).key
          : null;
    return {
      spec: s,
      identity: underlyingIdentity(provider, model, { modelInfo: modelInfoFor(inventory, provider, model) }),
      evidence,
    };
  });

  const readyProviders = ready.map((r) => String(r).split(/[:@]/)[0].toLowerCase());
  const entries = [];
  for (const entry of ready) {
    const ps = parseProviderSpec(entry, prof);
    if (!ps) continue;
    const explicit = /:/.test(String(entry).trim().replace(/@[^@:]*$/, '').replace(/^[^:]*/, ''));
    const details = inventory?.providers?.[ps.provider]?.model_details;
    if (!explicit && details && Object.keys(details).length) {
      for (const m of Object.keys(details)) entries.push({ ps: { ...ps, model: m }, explicit: true });
    } else {
      entries.push({ ps, explicit });
    }
  }

  const refusals = [];
  const cands = [];
  for (const { ps, explicit } of entries) {
    const info = modelInfoFor(inventory, ps.provider, ps.model);
    const label = explicit && ps.model ? `${ps.provider}:${ps.model}` : ps.provider;
    const refuse = (kind, reason) =>
      refusals.push({ provider: ps.provider, model: ps.model || null, kind, reason });
    const identity = underlyingIdentity(ps.provider, ps.model, { modelInfo: info });
    const clash = panel.find((pm) => identitiesCollide(identity, pm.identity));
    if (clash) {
      refuse('same-identity', `same underlying model as panelist ${clash.spec}`);
      continue;
    }
    if (cands.some((c) => identitiesCollide(identity, c.identity))) {
      refuse('same-identity', 'duplicate of another candidate (same underlying model)');
      continue;
    }
    const g = candidateGate(ps.provider, ps.model, gateCtx);
    if (!g.allowed) {
      refuse(g.kind, g.reason);
      continue;
    }
    // Trait vetoes (docs/traits-design.md D′): never spend the one blind call on
    // a provider whose contracts freshly fail in ways detection can't see, or a
    // known ≥25% structured-output abstainer (n≥10, by evidence identity).
    const ev = traits ? resolveCandidateEvidence(ps.provider, ps.model, ps.effort, traits).key : null;
    if (traits) {
      const hd = healthVerdict(ps.provider, traits, {
        readySource,
        detectedReady: readyProviders,
      });
      if (hd === 'veto') {
        refuse('health', `health ${traits.health?.[ps.provider]?.kind}`);
        continue;
      }
      if (adherenceVeto(ev, traits)) {
        refuse(
          'adherence',
          `structured-output failed rate ≥${TRAIT_GATES.adherence_veto_failed_rate} at n≥${TRAIT_GATES.adherence_veto_n}`
        );
        continue;
      }
    }
    cands.push({
      spec: label,
      runtime: ps.provider,
      model: ps.model || null,
      identity,
      evidence: ev,
      location: g.location,
      tier_rank: routingCost(ps.provider, ps.model, prof, g.location).tier_rank,
    });
  }

  if (!cands.length) {
    return {
      provider: null,
      reason: refusals.length
        ? `all unconsulted candidates refused (${refusals.map((r) => `${r.provider}${r.model ? ':' + r.model : ''}: ${r.reason}`).join('; ')})`
        : 'no unconsulted providers available',
      refusals,
    };
  }

  // Lowest measured agreement against any panelist, matched by EVIDENCE
  // identity (never spec-string/substring matching).
  const agreementFor = (cand) => {
    if (!cand.evidence) return null;
    const rates = [];
    for (const row of ledgerMatrix) {
      if (row.agreement_rate == null || !Array.isArray(row.evidence)) continue;
      for (const pm of panel) {
        if (!pm.evidence) continue;
        const [x, y] = row.evidence;
        if ((x === cand.evidence && y === pm.evidence) || (y === cand.evidence && x === pm.evidence)) {
          rates.push(row.agreement_rate);
        }
      }
    }
    return rates.length ? Math.min(...rates) : null;
  };

  const scored = cands
    .map((c) => ({ ...c, measured_agreement: agreementFor(c) }))
    .sort((a, b) => {
      const am = a.measured_agreement, bm = b.measured_agreement;
      if (am != null && bm != null) return am - bm; // lowest agreement wins
      if (am != null) return -1;
      if (bm != null) return 1;
      return a.tier_rank - b.tier_rank; // no data → strongest tier
    });

  const pick = scored[0];
  return {
    provider: pick.spec,
    spec: pick.spec,
    runtime: pick.runtime,
    model: pick.model,
    location: pick.location,
    evidence_key: pick.evidence,
    measured_agreement: pick.measured_agreement,
    ...(refusals.length ? { refusals } : {}),
    reason:
      pick.measured_agreement != null
        ? `lowest measured agreement (${pick.measured_agreement}) with the panel`
        : 'no agreement data yet — strongest unconsulted tier',
  };
}

export function formatPickHuman(pick) {
  const lines = [
    `role:       ${pick.role}`,
    `intensity:  ${pick.intensity} (${pick.intensity_source})`,
    `use:        ${pick.use_native ? pick.spec : `CLI ${pick.spec}`}`,
    pick.use_native
      ? `agent:      ${pick.native_agent || pick.role}`
      : `provider:   ${pick.provider}${pick.model ? ':' + pick.model : ''} @${pick.effort}`,
    pick.execution_policy
      ? `execution:  ${pick.execution_policy.location} (policy ${pick.execution_policy.policy})`
      : null,
    pick.cost ? `cost:       ${pick.cost.relative_cost} (${pick.cost.cost_basis || 'static heuristic'}, not a price)` : null,
    pick.measured_basis ? `measured:   ${pick.measured_basis.status}${pick.measured_basis.detail ? ' — ' + pick.measured_basis.detail : ''}` : null,
    pick.reason ? `notes:      ${pick.reason}` : null,
    pick.substituted
      ? `fallback:   ${pick.substituted.from} → ${pick.provider} (${pick.substituted.reason})`
      : null,
    ...(pick.policy_refusals || []).map(
      (r) => `refused:    ${r.provider}${r.model ? ':' + r.model : ''} [${r.kind}] ${r.reason}`
    ),
  ].filter(Boolean);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Setup posture packs (docs/setup-ux-design.md)
// ---------------------------------------------------------------------------

export const SETUP_PACKS = ['balanced', 'quality', 'frugal', 'local', 'skip'];
export const SETUP_ROLES = ['analysis', 'design', 'critic'];

/**
 * READY, non-host providers as {name, kind, tier, relative_cost, models}.
 * `advisor_eligible === false` means read-only enforcement is unverified
 * (safety unverified): never offered by setup. A missing field is unknown.
 */
function setupReady(inventory, { excludeHost = true } = {}) {
  const host = excludeHost ? inventory.host_cli : null;
  return Object.entries(inventory.providers || {})
    .filter(([name, p]) => p && p.installed && p.healthy && name !== host && p.advisor_eligible !== false)
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
/**
 * Expand local runtimes into candidate models from the inventory's per-model
 * server metadata. Models served from a REMOTE host (ollama `…:cloud`) are not
 * local and never listed. With `strict`, a model must be DEMONSTRABLY local
 * (executionLocation === 'local' from its metadata); a runtime without
 * per-model metadata then contributes nothing. Without `strict`, a runtime
 * with no metadata keeps the legacy provider-default candidate.
 */
function setupLocals(inv, { strict = false, env = process.env } = {}) {
  const out = [];
  for (const p of setupReady(inv).filter((x) => x.kind === 'local')) {
    const details = p.model_details && typeof p.model_details === 'object' ? p.model_details : {};
    const names = Object.keys(details).length
      ? Object.keys(details)
      : p.name === 'ollama' && Array.isArray(p.models)
        ? p.models
        : [];
    if (names.length) {
      for (const m of names) {
        const info = details[m] || null;
        const location = executionLocation(p.name, m, { env, modelInfo: info });
        if (location === 'remote') continue;
        if (strict && location !== 'local') continue;
        out.push({ provider: p.name, runtime: p.name, spec: `${p.name}:${m}`, model: m, cap: modelCapability(m), location });
      }
    } else if (!strict) {
      out.push({ provider: p.name, runtime: p.name, spec: p.name, model: null, cap: modelCapability(''), location: 'unknown' });
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
 *
 * Execution policy: the `local` pack sets execution_policy 'local-only' and
 * pins only demonstrably local models. Any other pack PRESERVES the
 * persisted `executionPolicy` (never silently relaxes it): under a non-'any'
 * policy it offers no cloud pin and only demonstrably local models, and when
 * none exist the plan is `unsatisfiable` (ok:false) — callers must not apply it.
 */
export function resolveSetupPlan(inventory, { pack = 'balanced', host = null, overrides = {}, sensitive = 'no', executionPolicy = 'any', env = process.env } = {}) {
  const inv = { ...inventory, host_cli: host || inventory.host_cli || null };
  const roles = { analysis: null, design: null, critic: null };
  const warnings = [];
  const evidence = {};
  const policy = pack === 'local' ? 'local-only' : executionPolicy || 'any';
  const strict = policy !== 'any';
  const locals = pack === 'skip' ? [] : setupLocals(inv, { strict, env });
  const cloud = strict ? [] : setupCloud(inv);
  const ctx = { policy, strict, env, localCount: locals.length };

  if (pack === 'skip') {
    for (const r of SETUP_ROLES) evidence[r] = { routing_mode: 'open', basis: 'skip' };
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
  }

  if (pack === 'balanced') {
    evidence.analysis = { routing_mode: 'open', basis: 'measurement_first' };
    evidence.design = { routing_mode: 'open', basis: 'measurement_first' };
    if (locals.length) {
      const critic = [...locals].sort(setupSizeAsc)[0];
      roles.critic = setupLocalSpec(critic, 'low');
      evidence.critic = { routing_mode: 'pinned', basis: 'local_second_opinion',
        size: critic.cap.billions != null ? `${critic.cap.billions}B` : 'size_unknown' };
    } else {
      evidence.critic = { routing_mode: 'open', basis: 'open_no_local' };
      warnings.push('no local model → critic left to built-in routing; re-run setup after `ollama pull`');
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
  }

  if (pack === 'quality') {
    const a = setupStrongCloud(cloud);
    if (a) { roles.analysis = setupCloudSpec(a, 'xhigh'); evidence.analysis = { routing_mode:'pinned', basis:'explicit_lock' }; }
    else { evidence.analysis = { routing_mode: 'open', basis: 'no_cloud' }; }
    const d = setupStrongCloud(cloud.filter((p) => !a || p.name !== a.name)) || a;
    if (d) {
      roles.design = setupCloudSpec(d, 'high');
      evidence.design = { routing_mode:'pinned', basis:'explicit_lock' };
      if (a && d.name === a.name) warnings.push('single_lab_collapse: only one strong lab READY — design reuses it (best available, not cross-lab)');
    }
    else { evidence.design = { routing_mode: 'open', basis: 'no_cloud' }; }
    const strongCritic = setupStrongCloud(cloud);
    if (strongCritic) { roles.critic = setupCloudSpec(strongCritic, 'medium'); evidence.critic = { routing_mode:'pinned', basis:'explicit_lock' }; }
    else {
      if (locals.length) { const c = [...locals].sort(setupSizeDesc)[0]; roles.critic = setupLocalSpec(c, 'medium'); evidence.critic = { routing_mode:'pinned', basis:'largest_local' }; }
      else { evidence.critic = { routing_mode: 'open', basis: 'no_cloud_no_local' }; }
    }
    if (!cloud.length) warnings.push(strict
      ? `execution_policy ${policy}: no cloud pins offered`
      : 'no non-host cloud READY — quality falls back to local; consider `local` pack');
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
  }

  if (pack === 'frugal') {
    const a = setupCheapest(cloud.filter((p) => p.tier === 'strong' || p.tier === 'balanced'));
    if (a) {
      roles.analysis = setupCloudSpec(a, 'medium'); evidence.analysis = { routing_mode:'pinned', basis:'cost_lock' };
      warnings.push('frugal pinned a paid analysis provider — this freezes cost/measurement for that role; use `skip` or `--role` to leave it OPEN');
    }
    else if (locals.length) { const la = [...locals].sort(setupSizeDesc)[0]; roles.analysis = setupLocalSpec(la, 'medium'); evidence.analysis = { routing_mode:'pinned', basis:'cost_lock_local' }; }
    else { evidence.analysis = { routing_mode: 'open', basis: 'open_no_provider' }; }
    if (locals.length) {
      const cheapLocal = [...locals].sort(setupSizeAsc)[0];
      roles.design = setupLocalSpec(cheapLocal, 'low'); evidence.design = { routing_mode:'pinned', basis:'local_cheap' };
      roles.critic = setupLocalSpec(cheapLocal, 'low'); evidence.critic = { routing_mode:'pinned', basis:'local_cheap' };
    } else {
      evidence.design = { routing_mode:'open', basis:'open_no_local' };
      evidence.critic = { routing_mode:'open', basis:'open_no_local' };
      warnings.push('no local model → design & critic left to routing (frugal never pins a paid critic)');
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
  }

  if (pack === 'local') {
    if (!locals.length) {
      warnings.push('no demonstrably local model — `local` pack unsatisfiable (needs per-model server metadata proving local weights); run `ollama pull <model>` and refresh inventory, or use `skip`');
      for (const r of SETUP_ROLES) evidence[r] = { routing_mode:'open', basis:'local_unsatisfiable' };
      return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
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
    evidence.analysis = { routing_mode:'pinned', basis:'most_capable_local', size: label(analysis), verified_local: true };
    evidence.design = { routing_mode:'pinned', basis: design.runtime !== analysis.runtime ? 'cross_runtime' : 'different_model', size: label(design), verified_local: true };
    evidence.critic = { routing_mode:'pinned', basis:'smallest_local', size: label(critic), verified_local: true };
    if (locals.length === 1) warnings.push('single_model: only one local model — all roles share it (no decorrelation)');
    // capability-floor visibility for judgment role critic; analysis/design get a soft warn if tiny
    for (const [r, c] of [['analysis', analysis], ['design', design], ['critic', critic]]) {
      if (c.cap.size_class === 'tiny') warnings.push(`capability floor: ${r} local is ${c.cap.billions}B (tiny) — low confidence on judgment`);
    }
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx);
  }

  throw new Error(`unknown setup pack: ${pack}`);
}

/** Inventory-conditioned pack ordering for the skill's 4-option UI. skip always present. */
export function recommendPacks(inventory, { executionPolicy = 'any', env = process.env } = {}) {
  const strict = executionPolicy !== 'any';
  const cloud = strict ? [] : setupCloud(inventory);
  const locals = setupLocals(inventory, { strict, env });
  if (!cloud.length && !locals.length) return ['skip'];
  let order;
  if (!cloud.length) order = ['local', 'frugal', 'balanced', 'skip'];
  else if (!locals.length) order = ['balanced', 'quality', 'frugal', 'skip'];
  else order = ['balanced', 'quality', 'frugal', 'local', 'skip'];
  // `local` needs demonstrably local weights; never recommend an unsatisfiable pack.
  if (!setupLocals(inventory, { strict: true, env }).length) order = order.filter((p) => p !== 'local');
  if (!order.includes('skip')) order.push('skip');
  return order;
}

/**
 * Apply --role overrides + sensitive policy, then return the plan object.
 * Overrides can NOT bypass the execution policy or safety eligibility: a
 * refused override is reported in `errors` (plan.ok === false) and not applied.
 */
function finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv, ctx) {
  const errors = [];
  // sensitive policy: never freeze a paid critic on security-sensitive work, floor analysis effort
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
  const unsatisfiable = ctx.strict && pack !== 'skip' && ctx.localCount === 0;
  if (unsatisfiable) {
    errors.push({
      role: null,
      spec: null,
      reason: `execution_policy ${ctx.policy} requires a demonstrably local model, but none is verified local (inventory model_details)`,
    });
  }
  // overrides validated against safety eligibility + execution policy.
  const minimal = { providers: {}, defaults: {} };
  for (const [r, spec] of Object.entries(overrides || {})) {
    if (!SETUP_ROLES.includes(r)) continue;
    if (spec === null) {
      roles[r] = null;
      evidence[r] = { routing_mode: 'open', basis: 'user_override' };
      continue;
    }
    const ps = parseProviderSpec(String(spec), minimal);
    if (!ps) {
      errors.push({ role: r, spec: String(spec), reason: `unknown provider spec: ${spec}` });
      continue;
    }
    if (inv.providers?.[ps.provider]?.advisor_eligible === false) {
      errors.push({ role: r, spec: String(spec), reason: `${ps.provider}: read-only enforcement unverified (safety unverified)` });
      continue;
    }
    const d = executionPolicyDecision(ps.provider, ps.model, {
      profiles: { defaults: { execution_policy: ctx.policy } },
      env: ctx.env,
      modelInfo: modelInfoFor(inv, ps.provider, ps.model),
    });
    if (!d.allowed) {
      errors.push({ role: r, spec: String(spec), reason: d.reason });
      continue;
    }
    roles[r] = String(spec);
    evidence[r] = { routing_mode: 'pinned', basis: 'user_override' };
  }
  const ok = errors.length === 0;
  return {
    pack,
    roles,
    warnings,
    evidence,
    recommended_packs: recommendPacks(inv, { executionPolicy: ctx.policy, env: ctx.env }),
    execution_policy: ctx.policy,
    ok,
    unsatisfiable,
    errors,
    error: ok ? null : errors.map((e) => (e.role ? `${e.role}: ${e.reason}` : e.reason)).join('; '),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error(`xllm-routing — role/intensity advisor picker

Usage:
  node scripts/xllm-routing.js pick <role> [task text...]
  node scripts/xllm-routing.js infer [task text...]
  node scripts/xllm-routing.js roles

Options:
  --intensity=low|medium|high
  --force-cli          Prefer CLI even if role prefers native
  --force-native       Prefer native agent
  --ready=codex,ollama Comma list of READY providers (else detect installed binaries);
                       an explicit list is authoritative for binary/contract health, but a
                       fresh observed auth failure still blocks it
  --no-traits          Disable measured QUALITY routing (observed auth failures still apply)
  --json               JSON output
`);
  process.exit(1);
}

function parseCli(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--intensity=')) flags.intensity = a.slice('--intensity='.length);
    else if (a === '--force-cli') flags.forceCli = true;
    else if (a === '--force-native') flags.forceNative = true;
    else if (a.startsWith('--ready=')) {
      flags.readyProviders = a
        .slice(8)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--allow-below-floor') flags.allowBelowFloor = true;
    else if (a === '--no-traits') flags.noTraits = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function main() {
  const { flags, positional } = parseCli(process.argv);
  if (flags.help || positional.length === 0) usage();

  const cmd = positional[0];

  if (cmd === 'roles') {
    console.log(JSON.stringify({ roles: ROUTING_ROLES, routes: BUILTIN_ROLE_ROUTES }, null, 2));
    return;
  }

  if (cmd === 'infer') {
    const task = positional.slice(1).join(' ') || '';
    const r = inferIntensity(task, flags.intensity);
    if (flags.json) console.log(JSON.stringify(r, null, 2));
    else console.log(`${r.intensity} (${r.source}) signals=${(r.signals || []).join(',') || '-'}`);
    return;
  }

  if (cmd === 'pick') {
    const role = positional[1];
    const task = positional.slice(2).join(' ') || '';
    if (!role) usage();
    let inventory = null;
    try {
      inventory = buildInventory({}); // cached; supplies model_details + advisor_eligible
    } catch {
      inventory = null;
    }
    let pick;
    try {
      pick = pickAdvisorForRole(role, {
        taskText: task,
        intensity: flags.intensity,
        forceCli: flags.forceCli,
        forceNative: flags.forceNative,
        allowBelowFloor: flags.allowBelowFloor,
        readyProviders: flags.readyProviders || detectAvailableProviders(),
        readySource: flags.readyProviders ? 'explicit' : 'detected',
        traits: loadTraits(process.cwd()), // health observations always load
        useTraits: !flags.noTraits, // --no-traits disables quality evidence only
        inventory,
      });
    } catch (err) {
      if (!(err instanceof RoutingUnsatisfiableError)) throw err;
      if (flags.json) {
        console.log(
          JSON.stringify({ ok: false, error: { code: err.code, message: err.message, refusals: err.refusals || [] } }, null, 2)
        );
      } else {
        console.error(`unsatisfiable: ${err.message}`);
      }
      process.exit(2);
    }
    if (flags.json) console.log(JSON.stringify(pick, null, 2));
    else {
      console.log(formatPickHuman(pick));
      if (pick.capability_floor && !pick.capability_floor.ok) {
        console.log(`floor:      ⚠ ${pick.capability_floor.reason} (--allow-below-floor to override)`);
      }
      if (!pick.use_native) {
        console.log(`\n# CLI\nnode scripts/xllm-advisor.js ${pick.spec} "<prompt>"`);
      } else {
        console.log(`\n# Native\nspawn_subagent type=${pick.native_agent || 'general-purpose'}`);
      }
    }
    return;
  }

  usage();
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('xllm-routing.js') ||
    process.argv[1].replace(/\\/g, '/').endsWith('scripts/xllm-routing.js'));

if (isMain) {
  main();
}
