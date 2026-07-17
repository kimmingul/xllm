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
} from './xllm-advisor.js';
import {
  healthDecision,
  adherenceVeto,
  sharedBenchComparison,
  resolveCandidateKey,
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
    providers: ['ollama', 'lmstudio', 'gemini', 'grok'],
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

/**
 * Pick advisor for a role given task intensity and optional ready provider set.
 *
 * @returns {{
 *   role, intensity, intensity_source, provider, model, effort, spec,
 *   native_agent, prefer_native, use_native, reason, fallbacks, signals
 * }}
 */
export function pickAdvisorForRole(role, options = {}) {
  const profiles = options.profiles || loadProviderProfiles();
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

  // Cost/tier-aware ordering (skipped for profile-pinned roles):
  // high intensity on judgment roles → strongest tier first;
  // low intensity outside security/arch → cheapest first (local models free).
  // Stable sort preserves the route's preference order within equal ranks.
  let providerOrder = [...route.providers];
  if (!route.pinned) {
    const meta = (p) => getProviderCostMeta(p, profiles);
    if (
      intensity === 'high' &&
      ['critic', 'verify', 'tests', 'security'].includes(normRole)
    ) {
      providerOrder = providerOrder
        .map((p, i) => ({ p, i, rank: meta(p).tier_rank }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.p);
    }
    if (intensity === 'low' && !['security', 'architecture'].includes(normRole)) {
      providerOrder = providerOrder
        .map((p, i) => ({ p, i, cost: meta(p).relative_cost }))
        .sort((a, b) => a.cost - b.cost || a.i - b.i)
        .map((x) => x.p);
    }
  }

  const ready = options.readyProviders
    ? new Set(options.readyProviders.map((p) => String(p).toLowerCase()))
    : null;

  // Measured routing layer (docs/traits-design.md). With no traits object
  // this whole block is inert — ordering stays bit-identical to pre-traits
  // behavior (cold-start identity). Role pins bypass it entirely.
  const traits = options.useTraits === false ? null : options.traits || null;
  const readySource = options.readySource || (options.readyProviders ? 'detected' : 'absent');
  const traitDecisions = [];
  let healthOverride = null;
  let benchDecision = null;
  if (traits && traits.health && !route.pinned) {
    const keep = [];
    const demoted = [];
    const vetoed = [];
    for (const raw of providerOrder) {
      const p = resolvePreferredProvider(raw, profiles).provider;
      const d = healthDecision(p, traits.health, {
        readySource,
        detectedReady: options.readyProviders || null,
      });
      if (d === 'veto') {
        vetoed.push(raw);
        traitDecisions.push({ trait: 'health', provider: p, action: 'veto', kind: traits.health[p]?.kind });
      } else if (d === 'demote') {
        demoted.push(raw);
        traitDecisions.push({ trait: 'health', provider: p, action: 'demote', kind: traits.health[p]?.kind });
      } else {
        keep.push(raw);
      }
    }
    if (!keep.length && !demoted.length && vetoed.length) {
      // Never invent availability: keep the legacy order but say so loudly.
      healthOverride = 'all-candidates-blocked';
    } else {
      providerOrder = [...keep, ...demoted];
    }
  }
  if (traits && traits.specs && !route.pinned && ROUTABLE_BENCH_ROLES.includes(normRole)) {
    const cands = providerOrder
      .map((raw) => ({ raw, p: resolvePreferredProvider(raw, profiles).provider }))
      .filter((c) => !ready || ready.has(c.p))
      .map((c) => {
        const key = resolveCandidateKey(c.p, route, profiles);
        const b = traits.specs[key]?.bench_defect_detection;
        const meta = getProviderCostMeta(c.p, profiles);
        return {
          ...c,
          key,
          bench: b && b.gated ? b : null,
          floorOk: passesCapabilityFloor(normRole, key, { tier: meta.tier }).ok,
          cost: meta.relative_cost,
        };
      });
    const baseline = cands[0];
    const measured = cands.filter((c) => c.bench && c.floorOk);
    // Preconditions: baseline itself measured; ≥2 measured floor-passing
    // candidates. A measured candidate never overrides an unmeasured baseline.
    if (baseline && baseline.bench && baseline.floorOk && measured.length >= 2) {
      const qualifying = [];
      for (const c of measured) {
        if (c.p === baseline.p) continue;
        const cmp = sharedBenchComparison(c.bench, baseline.bench);
        if (
          !cmp ||
          cmp.shared_tasks < TRAIT_GATES.bench_min_shared_tasks ||
          cmp.shared_opportunities < TRAIT_GATES.bench_min_shared_opportunities
        )
          continue;
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
        providerOrder = [winner.raw, ...providerOrder.filter((r) => r !== winner.raw)];
        benchDecision = {
          trait: 'bench_defect_detection',
          selected: winner.key,
          baseline: baseline.key,
          via: winner.via,
          candidate_lcb: winner.cmp.candidate_lcb,
          baseline_lcb: winner.cmp.baseline_lcb,
          shared_tasks: winner.cmp.shared_tasks,
          shared_opportunities: winner.cmp.shared_opportunities,
        };
        traitDecisions.push(benchDecision);
      }
    }
  }

  const tried = [];
  let chosen = null;
  let substituted = null;

  for (const raw of providerOrder) {
    const pref = resolvePreferredProvider(raw, profiles);
    const p = pref.provider;
    tried.push(p);
    if (ready && !ready.has(p)) continue;
    // if ready set empty of this provider, still allow if no ready filter
    chosen = p;
    if (pref.substituted) {
      substituted = { from: pref.from, reason: pref.reason };
    }
    break;
  }

  // last resort: any ready, or first in list
  if (!chosen) {
    if (ready && ready.size) {
      chosen = [...ready][0];
    } else {
      chosen = providerOrder[0] || 'grok';
    }
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

  // model from route or provider profile default
  const pconf = profiles.providers?.[chosen] || {};
  let model = route.model || pconf.default_model || '';
  if (options.model) model = options.model;

  // Prefer native when route says so and intensity not forcing external
  const preferNative = !route.pinned && !!route.prefer_native;
  const useNative =
    options.forceCli === true
      ? false
      : options.forceNative === true
        ? true
        : preferNative && !(intensity === 'high' && ['critic', 'verify'].includes(normRole));

  const specParts = [chosen];
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
    ]
      .filter(Boolean)
      .join(' · '),
    fallbacks: tried.filter((p) => p !== chosen),
    substituted,
    route_effort_base: route.effort,
    pinned: !!route.pinned,
    ...(traitDecisions.length ? { trait_decisions: traitDecisions } : {}),
    ...(healthOverride ? { health_override: healthOverride } : {}),
    cost: getProviderCostMeta(chosen, profiles),
    capability_floor: passesCapabilityFloor(normRole, spec, {
      tier: getProviderCostMeta(chosen, profiles).tier,
      allowBelowFloor: options.allowBelowFloor,
    }),
  };
}

/**
 * Suggest a tiebreaker for a split panel: a not-yet-consulted provider,
 * preferring the one with the LOWEST measured agreement to the panel (most
 * decorrelated), falling back to a different-tier strong provider. Never
 * uses lineage — only measured agreement from the ledger.
 *
 * @param onPanel  provider specs already on the panel
 * @param ready    available provider names
 * @param ledgerMatrix  [{pair:"a ↔ b", agreement_rate}] from `panel stats`
 */
export function suggestTiebreaker(onPanel, ready, ledgerMatrix = [], profiles = null, traits = null, opts = {}) {
  const prof = profiles || loadProviderProfiles();
  const onSet = new Set(onPanel.map((s) => String(s).split(/[:@]/)[0].toLowerCase()));
  let candidates = ready.filter((p) => !onSet.has(String(p).toLowerCase()));
  if (!candidates.length) return { provider: null, reason: 'no unconsulted providers available' };

  // Trait vetoes (docs/traits-design.md D′): never spend the one blind call on
  // a provider whose contracts freshly fail in ways detection can't see, or a
  // known ≥25% structured-output abstainer (n≥10). Transient/demote-class
  // health is ignored here — measurement dominates and retry is runtime's job.
  // Selection itself is untouched: lowest measured agreement at any
  // comparable_runs ≥ 1 (the v0.15.0 loop stays exactly as shipped).
  if (traits) {
    const vetoes = [];
    candidates = candidates.filter((p) => {
      const hd = healthDecision(p, traits.health || {}, {
        readySource: opts.readySource || 'detected',
        detectedReady: ready,
      });
      if (hd === 'veto') {
        vetoes.push(`${p}: health ${traits.health[p]?.kind}`);
        return false;
      }
      if (adherenceVeto(resolveCandidateKey(p, null, prof), traits)) {
        vetoes.push(
          `${p}: structured-output failed rate ≥${TRAIT_GATES.adherence_veto_failed_rate} at n≥${TRAIT_GATES.adherence_veto_n}`
        );
        return false;
      }
      return true;
    });
    if (!candidates.length) {
      return { provider: null, reason: `all unconsulted candidates vetoed (${vetoes.join('; ')})` };
    }
  }

  // Score candidates by lowest measured agreement against any panelist.
  const agreementFor = (cand) => {
    const rates = ledgerMatrix
      .filter((m) => m.pair.toLowerCase().includes(String(cand).toLowerCase()))
      .filter((m) => onPanel.some((p) => m.pair.toLowerCase().includes(String(p).split(/[:@]/)[0].toLowerCase())))
      .map((m) => m.agreement_rate)
      .filter((r) => r != null);
    return rates.length ? Math.min(...rates) : null;
  };

  const scored = candidates
    .map((c) => ({ provider: c, measured_agreement: agreementFor(c), tier_rank: getProviderCostMeta(c, prof).tier_rank }))
    .sort((a, b) => {
      const am = a.measured_agreement, bm = b.measured_agreement;
      if (am != null && bm != null) return am - bm; // lowest agreement wins
      if (am != null) return -1;
      if (bm != null) return 1;
      return a.tier_rank - b.tier_rank; // no data → strongest tier
    });

  const pick = scored[0];
  return {
    provider: pick.provider,
    measured_agreement: pick.measured_agreement,
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
    pick.reason ? `notes:      ${pick.reason}` : null,
    pick.substituted
      ? `fallback:   ${pick.substituted.from} → ${pick.provider} (${pick.substituted.reason})`
      : null,
  ].filter(Boolean);
  return lines.join('\n');
}

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

  if (pack === 'quality') {
    const cloud = setupCloud(inv);
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
      const locals = setupLocals(inv);
      if (locals.length) { const c = [...locals].sort(setupSizeDesc)[0]; roles.critic = setupLocalSpec(c, 'medium'); evidence.critic = { routing_mode:'pinned', basis:'largest_local' }; }
      else { evidence.critic = { routing_mode: 'open', basis: 'no_cloud_no_local' }; }
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
    return finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv);
  }

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

  throw new Error(`unknown setup pack: ${pack}`);
}

/** Inventory-conditioned pack ordering for the skill's 4-option UI. skip always present. */
export function recommendPacks(inventory) {
  const cloud = setupCloud(inventory);
  const locals = setupLocals(inventory);
  if (!cloud.length && !locals.length) return ['skip'];
  let order;
  if (!cloud.length) order = ['local', 'frugal', 'balanced', 'skip'];
  else if (!locals.length) order = ['balanced', 'quality', 'frugal', 'skip'];
  else order = ['balanced', 'quality', 'frugal', 'local', 'skip'];
  if (!order.includes('skip')) order.push('skip');
  return order;
}

/** Apply --role overrides + sensitive policy, then return the plan object. */
function finishSetupPlan(pack, roles, warnings, evidence, overrides, sensitive, inv) {
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
  // overrides validated at apply time.
  for (const [r, spec] of Object.entries(overrides || {})) {
    if (SETUP_ROLES.includes(r)) {
      roles[r] = spec === null ? null : String(spec);
      evidence[r] = { routing_mode: spec ? 'pinned' : 'open', basis: 'user_override' };
    }
  }
  return { pack, roles, warnings, evidence, recommended_packs: recommendPacks(inv) };
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
                       an explicit list is authoritative (contracts health ignored)
  --no-traits          Disable measured trait routing (legacy/debug path)
  --json               JSON output
`);
  process.exit(1);
}

function parseCli(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--intensity=')) flags.intensity = a.slice(13);
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
    const pick = pickAdvisorForRole(role, {
      taskText: task,
      intensity: flags.intensity,
      forceCli: flags.forceCli,
      forceNative: flags.forceNative,
      allowBelowFloor: flags.allowBelowFloor,
      readyProviders: flags.readyProviders || detectAvailableProviders(),
      readySource: flags.readyProviders ? 'explicit' : 'detected',
      traits: flags.noTraits ? null : loadTraits(process.cwd()),
    });
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
