#!/usr/bin/env node
/**
 * Role + intensity based advisor routing for grok-xllm (/team, /ralph, /xllm helpers).
 *
 *   node scripts/xllm-routing.js pick security "auth token refresh"
 *   node scripts/xllm-routing.js pick-team "refactor payment webhooks" --roles implement,security,critic
 *   node scripts/xllm-routing.js infer "typo in README"
 *
 * Importable from grok-ask-advisor / tests.
 */

import {
  loadProviderProfiles,
  resolvePreferredProvider,
  parseProviderSpec,
  getSupportedProviders,
  detectAvailableProviders,
  getProviderCostMeta,
} from './grok-ask-advisor.js';
import process from 'process';

/** Canonical roles used by /team and routing table */
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
    reason: route.notes || '',
    fallbacks: tried.filter((p) => p !== chosen),
    substituted,
    route_effort_base: route.effort,
    pinned: !!route.pinned,
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
export function suggestTiebreaker(onPanel, ready, ledgerMatrix = [], profiles = null) {
  const prof = profiles || loadProviderProfiles();
  const onSet = new Set(onPanel.map((s) => String(s).split(/[:@]/)[0].toLowerCase()));
  const candidates = ready.filter((p) => !onSet.has(String(p).toLowerCase()));
  if (!candidates.length) return { provider: null, reason: 'no unconsulted providers available' };

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

/**
 * Pick advisors for multiple roles for a /team run.
 */
export function pickTeamAdvisors(taskText, roles = null, options = {}) {
  const roleList =
    roles && roles.length
      ? roles.map(normalizeRole).filter(Boolean)
      : defaultRolesForTask(taskText);

  const picks = {};
  for (const role of roleList) {
    picks[role] = pickAdvisorForRole(role, { ...options, taskText });
  }
  return {
    task: taskText,
    intensity: inferIntensity(taskText, options.intensity),
    roles: roleList,
    picks,
  };
}

/**
 * Suggest default roles from task text for /team decomposition.
 */
export function defaultRolesForTask(taskText = '') {
  const t = String(taskText || '');
  const roles = new Set(['implement']);

  if (/\b(explor|investigat|find where|codebase|map)\b/i.test(t)) roles.add('explore');
  if (HIGH_SIGNALS.test(t) || /\b(auth|payment|security)\b/i.test(t)) roles.add('security');
  if (/\b(architect|design system|api boundary|scalability)\b/i.test(t)) {
    roles.add('architecture');
  }
  if (/\b(ux|ui|copy|onboarding|design)\b/i.test(t)) roles.add('design');
  if (/\b(test|coverage|jest|vitest|pytest)\b/i.test(t)) roles.add('tests');
  if (/\b(doc|readme|changelog)\b/i.test(t)) roles.add('docs');
  // always useful critic for multi-file / refactor
  if (/\b(refactor|multi|module|review)\b/i.test(t) || t.length > 120) {
    roles.add('critic');
  }
  // cap at 4 for thrash control
  const order = [
    'explore',
    'implement',
    'security',
    'architecture',
    'design',
    'tests',
    'critic',
    'docs',
    'verify',
  ];
  return order.filter((r) => roles.has(r)).slice(0, 4);
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
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error(`xllm-routing — role/intensity advisor picker

Usage:
  node scripts/xllm-routing.js pick <role> [task text...]
  node scripts/xllm-routing.js pick-team [task text...] [--roles a,b,c]
  node scripts/xllm-routing.js infer [task text...]
  node scripts/xllm-routing.js roles

Options:
  --intensity=low|medium|high
  --force-cli          Prefer CLI even if role prefers native
  --force-native       Prefer native agent
  --ready=codex,ollama Comma list of READY providers (else detect installed binaries)
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
    } else if (a.startsWith('--roles=')) {
      flags.roles = a
        .slice(8)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--allow-below-floor') flags.allowBelowFloor = true;
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
    });
    if (flags.json) console.log(JSON.stringify(pick, null, 2));
    else {
      console.log(formatPickHuman(pick));
      if (pick.capability_floor && !pick.capability_floor.ok) {
        console.log(`floor:      ⚠ ${pick.capability_floor.reason} (--allow-below-floor to override)`);
      }
      if (!pick.use_native) {
        console.log(`\n# CLI\nnode scripts/grok-ask-advisor.js ${pick.spec} "<prompt>"`);
      } else {
        console.log(`\n# Native\nspawn_subagent type=${pick.native_agent || 'general-purpose'}`);
      }
    }
    return;
  }

  if (cmd === 'pick-team') {
    const task = positional.slice(1).join(' ') || '';
    const plan = pickTeamAdvisors(task, flags.roles, {
      intensity: flags.intensity,
      forceCli: flags.forceCli,
      forceNative: flags.forceNative,
      readyProviders: flags.readyProviders || detectAvailableProviders(),
    });
    if (flags.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(`task intensity: ${plan.intensity.intensity} (${plan.intensity.source})`);
    console.log(`roles: ${plan.roles.join(', ')}`);
    console.log('');
    for (const role of plan.roles) {
      console.log(`## ${role}`);
      console.log(formatPickHuman(plan.picks[role]));
      console.log('');
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
