#!/usr/bin/env node
/**
 * grok-xllm advisor — single entry for headless multi-LLM calls.
 *
 * Spec syntax:
 *   provider
 *   provider:model
 *   provider@effort
 *   provider:model@effort
 *   ollama:qwen3.6:latest@medium
 *
 * Usage:
 *   node scripts/grok-ask-advisor.js <spec> "<prompt>"
 *   node scripts/grok-ask-advisor.js --list-providers
 *   node scripts/grok-ask-advisor.js --doctor
 *   node scripts/grok-ask-advisor.js --which | --remember
 *   node scripts/grok-ask-advisor.js --dry-run <spec> "<prompt>"
 *   node scripts/grok-ask-advisor.js --multi p1,p2 "<prompt>"
 *
 * Profiles: .grok/xllm-providers.toml (see loadProviderProfiles)
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import process from 'process';

const VERSION = '0.9.0';
const PRODUCT = 'grok-xllm';
const PLUGIN_NAMES = ['grok-xllm', 'oh-my-grok'];

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'agy',
  grok: 'grok',
  cursor: 'cursor-agent',
  ollama: 'ollama',
  lmstudio: 'curl',
  lemonade: 'lemonade',
};

// antigravity listed before gemini — preferred design-side cloud advisor
const CLOUD_PROVIDERS = [
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'grok',
  'cursor',
];
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'lemonade'];

const KNOWN_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const IS_WINDOWS = process.platform === 'win32';
const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE || 'http://localhost:1234';
const MARKER_NAMES = ['xllm-advisor-path', 'omg-advisor-path'];

// Host-neutral state dir (.xllm) with legacy .grok fallback for existing projects
const NEUTRAL_STATE_DIR = '.xllm';
const LEGACY_STATE_DIR = '.grok';
const STATE_DIRS = [NEUTRAL_STATE_DIR, LEGACY_STATE_DIR];

/**
 * Resolve the per-project state directory.
 * Priority: XLLM_STATE_DIR env → existing .xllm/ → existing .grok/ → .xllm/ (new default).
 */
export function resolveStateDir(root = process.cwd(), env = process.env) {
  if (env.XLLM_STATE_DIR) return path.resolve(root, env.XLLM_STATE_DIR);
  for (const d of STATE_DIRS) {
    try {
      if (fs.existsSync(path.join(root, d))) return path.join(root, d);
    } catch {
      /* ignore */
    }
  }
  return path.join(root, NEUTRAL_STATE_DIR);
}

/** Advisors are read-only by default; mutation requires explicit opt-in. */
export function mutationAllowed(env = process.env, flags = {}) {
  if (flags.allowWrite) return true;
  return env.XLLM_ALLOW_MUTATION === '1';
}

/** Built-in defaults; overridden by xllm-providers.toml */
const BUILTIN_PROFILES = {
  defaults: {
    analysis_provider: 'codex',
    design_provider: 'antigravity',
    design_fallback: 'gemini',
    timeout_ms: 300000,
  },
  providers: {
    // tier: strong | balanced | local — coarse capability class
    // relative_cost: 0 (free/local) … 10 — deliberately relative, NOT $ prices
    // latency_class: fast | medium | slow — typical headless round-trip
    codex: {
      default_model: '',
      default_effort: '',
      effort_via: 'config',
      effort_config_key: 'model_reasoning_effort',
      timeout_ms: 300000,
      tier: 'strong',
      relative_cost: 7,
      latency_class: 'slow',
    },
    claude: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'strong',
      relative_cost: 7,
      latency_class: 'medium',
    },
    grok: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'strong',
      relative_cost: 6,
      latency_class: 'medium',
    },
    antigravity: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'balanced',
      relative_cost: 5,
      latency_class: 'medium',
    },
    gemini: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'balanced',
      relative_cost: 4,
      latency_class: 'medium',
    },
    cursor: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'balanced',
      relative_cost: 5,
      latency_class: 'medium',
    },
    ollama: {
      default_model: 'llama3.2',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'local',
      relative_cost: 0,
      latency_class: 'medium',
    },
    lmstudio: {
      default_model: 'local-model',
      default_effort: '',
      temperature: 0.7,
      timeout_ms: 300000,
      tier: 'local',
      relative_cost: 0,
      latency_class: 'medium',
    },
    lemonade: {
      default_model: 'default',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'local',
      relative_cost: 0,
      latency_class: 'medium',
    },
  },
};

const TIER_RANK = { strong: 0, balanced: 1, local: 2 };

/** Coarse cost/capability metadata for a provider (profile-overridable). */
export function getProviderCostMeta(provider, profiles = null) {
  const prof = (profiles || loadProviderProfiles()).providers[provider] || {};
  const builtin = BUILTIN_PROFILES.providers[provider] || {};
  const tier = prof.tier || builtin.tier || 'balanced';
  return {
    tier,
    tier_rank: TIER_RANK[tier] ?? 1,
    relative_cost: Number(
      prof.relative_cost ?? builtin.relative_cost ?? 5
    ),
    latency_class: prof.latency_class || builtin.latency_class || 'medium',
  };
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function getSupportedProviders() {
  return Object.keys(PROVIDER_BINARIES);
}

export function getProviderMeta() {
  const profiles = loadProviderProfiles();
  return {
    version: VERSION,
    product: PRODUCT,
    cloud: [...CLOUD_PROVIDERS],
    local: [...LOCAL_PROVIDERS],
    all: getSupportedProviders(),
    defaults: profiles.defaults,
    spec_syntax: 'provider[:model][@effort]',
    efforts: [...KNOWN_EFFORTS],
    notes: {
      antigravity: 'Preferred over gemini for design-side /xllm when available',
      windows_antigravity: 'Falls back to gemini on Windows headless',
    },
  };
}

export function getOllamaModels() {
  const res = spawnSync('ollama', ['list'], {
    encoding: 'utf8',
    shell: false,
    timeout: 8000,
  });
  if (res.error || res.status !== 0) return [];
  return (res.stdout || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export function checkServerHealth(provider) {
  if (provider === 'ollama') {
    const res = spawnSync('ollama', ['list'], {
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
    });
    return !res.error && res.status === 0;
  }
  if (provider === 'lmstudio' || provider === 'lemonade') {
    const url = `${LMSTUDIO_BASE}/v1/models`;
    const res = spawnSync(
      IS_WINDOWS ? 'curl.exe' : 'curl',
      ['-s', '--max-time', '2', url],
      { encoding: 'utf8', shell: false }
    );
    if (!res.error && res.status === 0 && (res.stdout || '').trim()) return true;
    const res2 = spawnSync('curl', ['-s', '--max-time', '2', url], {
      encoding: 'utf8',
      shell: false,
    });
    return !res2.error && res2.status === 0 && !!(res2.stdout || '').trim();
  }
  return true;
}

export function parseLMStudioResponse(stdout) {
  try {
    const json = JSON.parse(stdout);
    const choice = json.choices && json.choices[0];
    if (choice?.message?.content) return choice.message.content;
    if (json.content) return json.content;
    if (json.error) return `Error: ${JSON.stringify(json.error)}`;
    return stdout;
  } catch {
    return stdout;
  }
}

export function slugify(s) {
  return (
    String(s || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  );
}

export function isEffortToken(s) {
  if (!s) return false;
  const t = String(s).toLowerCase();
  if (KNOWN_EFFORTS.has(t)) return true;
  // allow numeric-ish custom levels
  return /^[a-z][a-z0-9_-]{0,20}$/i.test(t) && t.length <= 16;
}

/**
 * Parse provider[:model][@effort]
 * Model may contain colons (ollama:qwen3.6:latest).
 * Effort is trailing @token when it looks like an effort level.
 */
export function parseProviderSpec(spec, profiles = null) {
  let raw = String(spec || '').trim();
  if (!raw) return null;

  let effort = null;
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const cand = raw.slice(at + 1).trim();
    if (isEffortToken(cand)) {
      effort = cand.toLowerCase();
      raw = raw.slice(0, at);
    }
  }

  let provider;
  let model = null;
  const idx = raw.indexOf(':');
  if (idx === -1) {
    provider = raw.toLowerCase();
  } else {
    provider = raw.slice(0, idx).toLowerCase();
    model = raw.slice(idx + 1) || null;
  }

  if (!PROVIDER_BINARIES[provider]) return null;

  const prof = (profiles || loadProviderProfiles()).providers[provider] || {};
  if (!model && prof.default_model) model = String(prof.default_model);
  if (!effort && prof.default_effort) effort = String(prof.default_effort).toLowerCase();

  const parts = [provider];
  if (model) parts[0] = `${provider}:${model}`;
  const label = effort ? `${parts[0]}@${effort}` : parts[0];

  return { provider, model, effort, spec: label };
}

/** Minimal TOML subset reader (tables + string/number/bool/string-array). */
export function parseSimpleToml(text) {
  const root = {};
  let cursor = root;
  for (let line of String(text || '').split(/\r?\n/)) {
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      cursor = root;
      for (const p of sec[1].split('.')) {
        if (!cursor[p] || typeof cursor[p] !== 'object') cursor[p] = {};
        cursor = cursor[p];
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else if (val === 'true' || val === 'false') {
      val = val === 'true';
    } else if (/^-?\d+$/.test(val)) {
      val = Number(val);
    } else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    cursor[kv[1]] = val;
  }
  return root;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function profileSearchPaths() {
  const paths = [];
  if (process.env.XLLM_PROVIDERS_PATH) paths.push(process.env.XLLM_PROVIDERS_PATH);
  for (const dir of STATE_DIRS) {
    paths.push(path.join(process.cwd(), dir, 'xllm-providers.toml'));
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    for (const dir of STATE_DIRS) {
      paths.push(path.join(home, dir, 'xllm-providers.toml'));
    }
  }
  // plugin checkout relative to this file
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const dir of STATE_DIRS) {
      paths.push(path.join(here, '..', dir, 'xllm-providers.toml'));
    }
  } catch {
    /* ignore */
  }
  return paths;
}

let _profilesCache = null;

export function loadProviderProfiles({ force = false } = {}) {
  if (_profilesCache && !force) return _profilesCache;
  let merged = {
    defaults: { ...BUILTIN_PROFILES.defaults },
    providers: { ...BUILTIN_PROFILES.providers },
  };
  // deep clone providers
  merged.providers = JSON.parse(JSON.stringify(BUILTIN_PROFILES.providers));

  for (const p of profileSearchPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = parseSimpleToml(fs.readFileSync(p, 'utf8'));
      if (parsed.defaults) {
        merged.defaults = { ...merged.defaults, ...parsed.defaults };
      }
      if (parsed.providers) {
        for (const [name, conf] of Object.entries(parsed.providers)) {
          merged.providers[name] = {
            ...(merged.providers[name] || {}),
            ...conf,
          };
        }
      }
      // Role pins and routing overrides consumed by xllm-routing
      if (parsed.roles) merged.roles = { ...parsed.roles };
      if (parsed.routing) merged.routing = parsed.routing;
      merged._loaded_from = p;
      break; // first existing wins (search order is priority)
    } catch {
      /* try next */
    }
  }

  // env timeout override
  const envTimeout = Number(
    process.env.XLLM_ADVISOR_TIMEOUT_MS || process.env.OMG_ADVISOR_TIMEOUT_MS || 0
  );
  if (envTimeout > 0) merged.defaults.timeout_ms = envTimeout;

  _profilesCache = merged;
  return merged;
}

const PROFILE_TEMPLATE = `# xllm provider profile (project-local)
# Managed by \`xllm profile set-role\` / \`set-default\`; hand-edits are preserved.
#
# [roles]                pins a role to an exact spec, e.g.
#   analysis = "codex@high"
#   design = "gemini"
#   critic = "ollama:qwen3.6:latest@low"
#
# [providers.<name>]     overrides: default_model, default_effort, timeout_ms,
#                        tier (strong|balanced|local), relative_cost (0-10),
#                        latency_class (fast|medium|slow)
`;

/**
 * Line-based TOML upsert: replaces \`key = ...\` inside [section] (or appends
 * the section) while preserving every other line and comment.
 */
export function upsertTomlKey(text, section, key, value) {
  const lines = String(text || '').split(/\r?\n/);
  const header = `[${section}]`;
  const kvLine = `${key} = ${JSON.stringify(String(value))}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('', header, kvLine, '');
    return out.join('\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp('^\\s*' + escapedKey + '\\s*=');
  for (let i = start + 1; i < end; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = kvLine;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, kvLine);
  return lines.join('\n');
}

/** Write a key into the project profile TOML (created from template if absent). */
export function setProfileValue(section, key, value, root = process.cwd()) {
  const dir = resolveStateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'xllm-providers.toml');
  const text = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : PROFILE_TEMPLATE;
  fs.writeFileSync(file, upsertTomlKey(text, section, key, value), 'utf8');
  loadProviderProfiles({ force: true });
  return file;
}

/**
 * Prefer antigravity over gemini. On Windows headless, fall back to design_fallback.
 */
export function resolvePreferredProvider(name, profiles = null) {
  const prof = profiles || loadProviderProfiles();
  let p = String(name || '').toLowerCase();
  if (p === 'antigravity' && IS_WINDOWS) {
    const fb = (prof.defaults.design_fallback || 'gemini').toLowerCase();
    return {
      provider: fb,
      substituted: true,
      from: 'antigravity',
      reason: 'antigravity headless blocked on Windows',
    };
  }
  return { provider: p, substituted: false };
}

export function pickDefaultXllmPair(readyCloud = [], readyLocal = [], profiles = null) {
  const prof = profiles || loadProviderProfiles();
  const analysis = (prof.defaults.analysis_provider || 'codex').toLowerCase();
  let design = (prof.defaults.design_provider || 'antigravity').toLowerCase();
  const designFb = (prof.defaults.design_fallback || 'gemini').toLowerCase();

  const ready = new Set([...(readyCloud || []), ...(readyLocal || [])]);
  const prefer = (candidates) => candidates.find((c) => ready.has(c));

  // Design side: antigravity first, then gemini, then anything cloud
  if (design === 'antigravity' && IS_WINDOWS) design = designFb;
  const designPick =
    prefer([design, designFb, 'antigravity', 'gemini', 'grok', 'claude']) || null;

  const analysisPick =
    prefer([analysis, 'codex', 'claude', 'grok', 'ollama']) || designPick;

  // ensure two distinct when possible
  let a = analysisPick;
  let b = designPick;
  if (a && b && a === b) {
    b = prefer(['codex', 'antigravity', 'gemini', 'grok', 'claude', 'ollama'].filter((x) => x !== a));
  }
  if (!a && readyLocal[0]) a = readyLocal[0];
  if (!b && readyCloud.find((c) => c !== a)) b = readyCloud.find((c) => c !== a);
  return [a, b].filter(Boolean);
}

/**
 * Pure spawn config resolver.
 * options: { effort, timeoutMs, temperature, profiles }
 */
export function resolveSpawnConfig(
  provider,
  model = null,
  prompt = '',
  env = process.env,
  options = {}
) {
  const profiles = options.profiles || loadProviderProfiles();
  const pconf = profiles.providers[provider] || {};
  const effort = options.effort || null;
  const allowMutation = !!options.allowMutation;
  // Advisors give opinions; by default they must not be able to edit the tree.
  const codexSafety = allowMutation
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'read-only'];
  const timeoutMs =
    options.timeoutMs ||
    pconf.timeout_ms ||
    profiles.defaults.timeout_ms ||
    300000;

  const resolvedModel =
    model ||
    pconf.default_model ||
    (provider === 'ollama' ? env.OLLAMA_DEFAULT_MODEL : null) ||
    (provider === 'lmstudio' ? env.LMSTUDIO_MODEL : null) ||
    (provider === 'lemonade' ? env.LEMONADE_MODEL : null) ||
    null;

  const needsStdin =
    (provider === 'codex' || provider === 'claude') &&
    (IS_WINDOWS ||
      prompt.length > 400 ||
      prompt.includes('\n') ||
      /[^\x00-\x7F]/.test(prompt));

  /** Insert model/effort flags into args (before trailing prompt or `-`). */
  function withModelEffort(baseArgs, promptMode) {
    // promptMode: 'arg' | 'stdin-dash' | 'none'
    const args = [...baseArgs];
    const tail = [];
    if (promptMode === 'arg') {
      // last element is prompt — pop, add flags, re-push
      const p = args.pop();
      appendModelEffortFlags(provider, args, resolvedModel, effort, pconf);
      args.push(p);
      return args;
    }
    if (promptMode === 'stdin-dash') {
      // last is '-'
      const dash = args.pop();
      appendModelEffortFlags(provider, args, resolvedModel, effort, pconf);
      args.push(dash);
      return args;
    }
    appendModelEffortFlags(provider, args, resolvedModel, effort, pconf);
    return args;
  }

  if (needsStdin) {
    if (provider === 'codex') {
      return {
        binary: 'codex',
        args: withModelEffort(['exec', ...codexSafety, '-'], 'stdin-dash'),
        usesStdin: true,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    }
    // claude: flags before -p; prompt via stdin
    const claudeArgs = [];
    if (resolvedModel) claudeArgs.push('--model', resolvedModel);
    if (effort) claudeArgs.push('--effort', effort);
    claudeArgs.push('-p');
    return {
      binary: 'claude',
      args: claudeArgs,
      usesStdin: true,
      timeoutMs,
      model: resolvedModel,
      effort,
    };
  }

  switch (provider) {
    case 'codex':
      return {
        binary: 'codex',
        args: withModelEffort(['exec', ...codexSafety, prompt], 'arg'),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    case 'gemini': {
      const args = [];
      if (resolvedModel) args.push('--model', resolvedModel);
      args.push('-p', prompt);
      if (allowMutation) args.push('--yolo');
      return {
        binary: 'gemini',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    }
    case 'antigravity': {
      const args = allowMutation ? ['--dangerously-skip-permissions'] : [];
      if (resolvedModel) args.push('--model', resolvedModel);
      args.push('-p', prompt);
      return {
        binary: 'agy',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    }
    case 'grok': {
      const args = [];
      if (resolvedModel) args.push('-m', resolvedModel);
      if (effort) args.push('--reasoning-effort', effort);
      args.push('-p', prompt);
      if (allowMutation) args.push('--always-approve');
      return {
        binary: 'grok',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    }
    case 'cursor': {
      const cursorArgs = allowMutation
        ? ['--print', '--force', '--trust', '--sandbox', 'disabled', prompt]
        : ['--print', prompt];
      return {
        binary: 'cursor-agent',
        args: withModelEffort(cursorArgs, 'arg'),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
        mutation: allowMutation,
      };
    }
    case 'claude':
      return {
        binary: 'claude',
        args: withModelEffort(['-p', prompt], 'arg'),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
    case 'ollama': {
      const ollamaModel = resolvedModel || 'llama3.2';
      return {
        binary: 'ollama',
        args: ['run', ollamaModel, prompt],
        usesStdin: false,
        timeoutMs,
        model: ollamaModel,
        effort,
      };
    }
    case 'lmstudio': {
      const lmModel = resolvedModel || 'local-model';
      const temperature =
        options.temperature ?? pconf.temperature ?? 0.7;
      const body = {
        model: lmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      };
      // some local servers accept reasoning effort in body
      if (effort) body.reasoning_effort = effort;
      const curlBin = IS_WINDOWS ? 'curl.exe' : 'curl';
      return {
        binary: curlBin,
        args: [
          '-s',
          '--max-time',
          String(Math.floor(timeoutMs / 1000)),
          `${LMSTUDIO_BASE}/v1/chat/completions`,
          '-H',
          'Content-Type: application/json',
          '-d',
          JSON.stringify(body),
        ],
        usesStdin: false,
        timeoutMs,
        model: lmModel,
        effort,
      };
    }
    case 'lemonade': {
      const lemonadeModel = resolvedModel || 'default';
      if (!env.LEMONADE_BIN) {
        // No synthetic fallback: an unavailable advisor must fail loudly,
        // otherwise its "opinion" gets synthesized into real decisions.
        return {
          binary: null,
          args: [],
          usesStdin: false,
          timeoutMs,
          model: lemonadeModel,
          effort,
          unavailable:
            'LEMONADE_BIN is not set — lemonade advisor is unavailable',
        };
      }
      return {
        binary: env.LEMONADE_BIN,
        args: ['run', lemonadeModel, prompt],
        usesStdin: false,
        timeoutMs,
        model: lemonadeModel,
        effort,
      };
    }
    default:
      return {
        binary: 'claude',
        args: withModelEffort(['-p', prompt], 'arg'),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
  }
}

function appendModelEffortFlags(provider, args, model, effort, pconf) {
  if (model) {
    switch (provider) {
      case 'codex':
        args.push('-m', model);
        break;
      case 'claude':
        args.push('--model', model);
        break;
      case 'grok':
        args.push('-m', model);
        break;
      case 'antigravity':
        args.push('--model', model);
        break;
      case 'gemini':
        args.push('--model', model);
        break;
      case 'cursor':
        // cursor-agent model flag varies; pass as --model when set
        args.push('--model', model);
        break;
      default:
        break;
    }
  }

  if (!effort) return;

  switch (provider) {
    case 'codex': {
      const via = pconf.effort_via || 'config';
      if (via === 'config') {
        const key = pconf.effort_config_key || 'model_reasoning_effort';
        args.push('-c', `${key}=${effort}`);
      } else {
        args.push('--config', `model_reasoning_effort=${effort}`);
      }
      break;
    }
    case 'claude':
      args.push('--effort', effort);
      break;
    case 'grok':
      args.push('--reasoning-effort', effort);
      break;
    case 'antigravity':
      // agy models list shows High/Medium/Low as part of model name often;
      // if effort alone, try --model suffix only when no model set is already handled.
      // No dedicated effort flag in help — skip unless model embeds it.
      break;
    case 'gemini':
      // unknown dedicated flag; skip
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Output cleaners / artifacts
// ---------------------------------------------------------------------------

export function extractSummary(raw, exitCode) {
  if (exitCode !== 0) return `Failed with exit code ${exitCode}.`;
  const text = cleanModelText(String(raw || '')).trim();
  if (!text) return 'Completed with empty output.';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isNoiseLine(l));
  if (lines.length === 0) return 'Completed.';
  return lines.slice(-3).join(' ').slice(0, 280);
}

export function extractActionItems(raw) {
  const text = cleanModelText(String(raw || ''));
  const items = [];
  const re = /^\s*[-*]\s+(\[[ xX]\]\s+)?(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null && items.length < 8) {
    const line = m[2].trim();
    if (line.length < 8 || line.length > 200) continue;
    if (/^(is it|does it|analyze|identify|formulate|verify constraints)/i.test(line)) {
      continue;
    }
    items.push(line);
  }
  if (items.length === 0) return ['(none extracted — review raw output)'];
  return items;
}

function isNoiseLine(line) {
  if (/^thinking\b/i.test(line)) return true;
  if (/^\.\.\.done thinking/i.test(line)) return true;
  if (/^[?\s\u2800-\u28FF·.•]+$/.test(line)) return true;
  if (/^here'?s a thinking process/i.test(line)) return true;
  return false;
}

export function cleanModelText(raw) {
  let s = String(raw || '')
    // All CSI sequences (colors, cursor moves, erase, private modes like
    // [?25h/[?2026l from progress spinners), OSC titles, and stray ESCs —
    // not just SGR color codes.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r/g, '');
  s = s.replace(/Thinking\.\.\.[\s\S]*?\.\.\.done thinking\./gi, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/Here'?s a thinking process:[\s\S]*?(?=\n{2,}|\n[A-Z])/gi, '');
  s = s.replace(/^.*ROCm.*$/gim, '');
  s = s.replace(/^.*ggml_.*$/gim, '');
  s = s.replace(/^[?\uFFFD？\s\u2800-\u28FF·.•█░▒▓]+$/gmu, '');
  s = s.replace(/^[?\uFFFD？\u2800-\u28FF·.•█░▒▓]+\s*/gmu, '');
  s = s.replace(/(?:\n[?\uFFFD？\s\u2800-\u28FF·.•█░▒▓]*)+$/gu, '');
  s = s.replace(
    /[?\uFFFD？\u2800-\u28FF·.•█░▒▓](?:\s*[?\uFFFD？\u2800-\u28FF·.•█░▒▓]){2,}\s*$/gu,
    ''
  );
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

export function cleanOllamaOutput(raw) {
  return cleanModelText(raw);
}

export function cleanCodexOutput(raw) {
  let s = String(raw || '');
  const markers = [
    /\nOpenAI Codex v/i,
    /\n--------\nworkdir:/i,
    /\nsession id:/i,
    /\nhook: SessionStart/i,
  ];
  let cut = -1;
  for (const re of markers) {
    const m = s.search(re);
    if (m > 0 && (cut < 0 || m < cut)) cut = m;
  }
  if (cut > 0) s = s.slice(0, cut);
  return cleanModelText(s);
}

/** Conservative patterns for well-known credential formats. */
export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub PAT (fine-grained)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** Redact well-known secret formats before anything is persisted to disk. */
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m) => `${m.slice(0, 6)}…[REDACTED]`);
  }
  return s;
}

export const ARTIFACT_SUBDIRS = [
  'ask',
  'xllm',
  'ralph',
  'team',
  'verify',
  'proposals',
  'exec',
];

/**
 * Proposal mode: the advisor must PROPOSE a change, never claim to apply one.
 * Output contract keeps advisors read-only while enabling file work.
 */
export const PROPOSAL_INSTRUCTIONS = `You are producing a CHANGE PROPOSAL. You must NOT apply, write, or claim to have applied any change — you have no write access.

Output contract:
1. A short rationale (a few sentences).
2. Exactly one fenced code block labeled diff containing a unified diff (git style, a/ and b/ path prefixes) that implements the requested change. For a new document, use a diff that creates the file.
3. Nothing after the diff block.

If you cannot produce a concrete diff, say why instead of inventing one.`;

export function buildProposalPrompt(task) {
  return `${PROPOSAL_INSTRUCTIONS}\n\n## Requested change\n\n${task}`;
}

/** Extract the unified diff from a proposal response, or null. */
export function extractProposalPatch(raw) {
  const m = String(raw || '').match(/```(?:diff|patch)\r?\n([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].replace(/\r/g, '');
  return body.endsWith('\n') ? body : body + '\n';
}

/**
 * Create artifact subdirs under the project state dir, and drop a
 * self-ignoring .gitignore so raw prompts/outputs never get committed.
 */
export function ensureArtifactDirs(root = process.cwd()) {
  const base = path.join(resolveStateDir(root), 'artifacts');
  for (const sub of ARTIFACT_SUBDIRS) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  const gi = path.join(base, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, '*\n!.gitignore\n', 'utf8');
  }
  return base;
}

/** Delete persisted artifacts (optionally only those older than N days). */
export function cleanArtifacts(root = process.cwd(), { olderThanDays = null } = {}) {
  const base = path.join(resolveStateDir(root), 'artifacts');
  const cutoff =
    olderThanDays != null ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;
  let removed = 0;
  if (!fs.existsSync(base)) return removed;
  for (const sub of ARTIFACT_SUBDIRS) {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name === '.gitkeep' || name === '.gitignore') continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (cutoff != null && st.mtimeMs >= cutoff) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

export function writeArtifact({
  provider,
  model = null,
  effort = null,
  original,
  finalPrompt,
  raw,
  exitCode,
  durationMs = null,
  meta = {},
  kind = 'ask',
}) {
  const root = process.cwd();
  const sub = ARTIFACT_SUBDIRS.includes(kind) ? kind : 'ask';
  const dir = path.join(ensureArtifactDirs(root), sub);
  original = redactSecrets(original);
  finalPrompt = redactSecrets(finalPrompt);
  raw = redactSecrets(raw);

  const providerLabel = model ? `${provider}-${slugify(model)}` : provider;
  const file = path.join(dir, `${providerLabel}-${slugify(original)}-${ts()}.md`);
  const summary = extractSummary(raw, exitCode);
  const actions = extractActionItems(raw);

  const lines = [
    `# ${provider}${model ? `:${model}` : ''}${effort ? `@${effort}` : ''} advisor artifact`,
    '',
    `- Provider: ${provider}`,
    model ? `- Model: ${model}` : null,
    effort ? `- Effort: ${effort}` : null,
    `- Exit code: ${exitCode}`,
    durationMs != null ? `- Duration ms: ${durationMs}` : null,
    `- Advisor version: ${VERSION}`,
    `- Created at: ${new Date().toISOString()}`,
    `- Host: ${process.platform}`,
    meta.multi ? `- Multi-run: yes` : null,
    meta.substituted ? `- Substituted from: ${meta.from}` : null,
    '',
    '## Original task',
    '',
    original,
    '',
    '## Final prompt sent',
    '',
    finalPrompt,
    '',
    '## Raw output',
    '',
    '```text',
    raw || '(no output)',
    '```',
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Action items',
    '',
    ...actions.map((a) => `- ${a}`),
    '',
  ].filter((x) => x !== null);

  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export const CONSENSUS_LABELS = ['unanimous', 'majority', 'split', 'single-source'];

export const SYNTHESIS_CONTRACT = `## Synthesis contract (for the host)

Read every artifact above, extract the substantive claims, and label each:

| Label | Meaning |
|-------|---------|
| unanimous | every successful advisor addressed AND supported it |
| majority | more than half support it; no strong counter-evidence from the rest |
| split | advisors disagree — do not act on it without a tiebreaker |
| single-source | only one advisor raised it — treat as a lead, not a finding |

Rules:
- Cite the supporting/opposing advisor specs next to each claim.
- Consensus is confidence metadata, not truth — unanimous claims can still be wrong.
- For split claims, consider one tiebreaker run with a vendor not yet consulted.
- Advisors that failed count as abstentions, never as support.`;

/**
 * Write the multi-run index: human markdown + machine-readable JSON sidecar.
 * results: [{ spec, code, artifact }]
 */
export function writeMultiIndex({
  prompt,
  results,
  propose = false,
  root = process.cwd(),
}) {
  const dir = path.join(ensureArtifactDirs(root), 'xllm');
  const base = `multi-${slugify(prompt)}-${ts()}`;
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  const failed = results.filter((r) => r.code !== 0).length;
  const task = redactSecrets(prompt);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        advisor_version: VERSION,
        task,
        propose,
        failures: failed,
        results: results.map((r) => ({
          spec: r.spec,
          exit_code: r.code,
          artifact: r.artifact || null,
          patch: r.patch || null,
        })),
        consensus_labels: CONSENSUS_LABELS,
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    mdPath,
    [
      `# xllm multi-run index${propose ? ' (proposal mode)' : ''}`,
      '',
      `- Created at: ${new Date().toISOString()}`,
      `- Providers: ${results.map((r) => r.spec).join(', ')}`,
      `- Failures: ${failed}`,
      `- Machine-readable: ${jsonPath}`,
      '',
      '## Results',
      '',
      ...results.map(
        (r) =>
          `- ${r.spec}: exit ${r.code}${r.artifact ? ` — ${r.artifact}` : ''}${r.patch ? ` (patch: ${r.patch})` : ''}`
      ),
      '',
      '## Task',
      '',
      task,
      '',
      SYNTHESIS_CONTRACT,
      '',
      ...(propose
        ? [
            '## Proposal handling (for the host)',
            '',
            'Each successful advisor produced a candidate patch. Judge them against',
            'each other (correctness, minimality, style fit), pick or merge the best,',
            'validate with `git apply --check <patch>`, and apply only after review.',
            '',
          ]
        : []),
    ].join('\n'),
    'utf8'
  );

  return { mdPath, jsonPath, failed };
}

function usage(exitCode = 1) {
  console.error(`${PRODUCT} advisor v${VERSION}
Usage:
  node scripts/grok-ask-advisor.js <provider[:model][@effort]> "<prompt>"
  node scripts/grok-ask-advisor.js --list-providers
  node scripts/grok-ask-advisor.js --doctor
  node scripts/grok-ask-advisor.js --which | --remember
  node scripts/grok-ask-advisor.js --dry-run <spec> "<prompt>"
  node scripts/grok-ask-advisor.js --multi p1,p2[,p3] "<prompt>"   (runs in parallel)
  node scripts/grok-ask-advisor.js --propose <spec> "<change request>"   (diff proposal)
  node scripts/grok-ask-advisor.js --inventory [--refresh]   (machine capability cache)
  node scripts/grok-ask-advisor.js --profile-show
  node scripts/grok-ask-advisor.js --set-role <role> <spec>   (project role pin)
  node scripts/grok-ask-advisor.js --set-default <key> <value>
  node scripts/grok-ask-advisor.js --clean-artifacts [--older-than=DAYS]

Safety (defaults):
  Advisors run READ-ONLY (no approvals bypass / no sandbox escape).
    --allow-write | XLLM_ALLOW_MUTATION=1   opt in to mutating advisors
  Same-provider advising inside that provider's own CLI is refused.
    --allow-self  | XLLM_ALLOW_SELF=1       override
  Artifacts persist prompts/outputs (secrets redacted).
    --no-artifacts | XLLM_NO_ARTIFACTS=1    print output instead of writing

Providers: ${getSupportedProviders().join(', ')}
Spec: provider | provider:model | provider@effort | provider:model@effort
  e.g. codex@high  claude:opus@medium  ollama:qwen3.6:latest  antigravity:…
Profiles: .xllm/xllm-providers.toml (legacy .grok/ also honored)
Env: XLLM_ADVISOR_PATH, XLLM_PLUGIN_ROOT, XLLM_PROVIDERS_PATH,
     XLLM_ADVISOR_TIMEOUT_MS, XLLM_STATE_DIR
`);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Binary resolution (Windows npm shims)
// ---------------------------------------------------------------------------

export function resolveBinaryPath(binary) {
  if (!binary) return binary;
  if (path.isAbsolute(binary) && fs.existsSync(binary)) return binary;

  if (IS_WINDOWS) {
    const pathEnv = process.env.PATH || '';
    const ordered = ['.exe', '.cmd', '.bat', '.com', ''];
    for (const dir of pathEnv.split(';')) {
      if (!dir) continue;
      for (const ext of ordered) {
        const full = path.join(dir, binary + ext);
        try {
          if (fs.existsSync(full)) return full;
        } catch {
          /* ignore */
        }
      }
    }
    const where = spawnSync('where.exe', [binary], {
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
    });
    if (!where.error && where.status === 0) {
      const first = (where.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
    return binary;
  }

  const which = spawnSync('which', [binary], {
    encoding: 'utf8',
    shell: false,
    timeout: 3000,
  });
  if (!which.error && which.status === 0) {
    const first = (which.stdout || '').trim().split('\n')[0];
    if (first) return first;
  }
  return binary;
}

export function resolveSpawnTarget(binary) {
  const resolved = resolveBinaryPath(binary);
  if (!IS_WINDOWS || !/\.(cmd|bat)$/i.test(resolved)) {
    return { command: resolved, argsPrefix: [] };
  }

  try {
    const text = fs.readFileSync(resolved, 'utf8');
    const m =
      text.match(/"%dp0%\\(node_modules\\[^"]+\.js)"/i) ||
      text.match(/%dp0%\\(node_modules\\[^\s"]+\.js)/i) ||
      text.match(/"(node_modules\\[^"]+\.js)"/i);
    if (m) {
      const jsPath = path.join(path.dirname(resolved), m[1].replace(/\\/g, path.sep));
      if (fs.existsSync(jsPath)) {
        return { command: process.execPath, argsPrefix: [jsPath] };
      }
    }
  } catch {
    /* fall through */
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    argsPrefix: ['/d', '/s', '/c', resolved],
    viaCmd: true,
  };
}

function binaryOnPath(binary) {
  const resolved = resolveBinaryPath(binary);
  if (resolved !== binary && fs.existsSync(resolved)) return true;
  const res = spawnSync(resolved, ['--version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 5000,
  });
  if (!res.error && (res.status === 0 || res.status === null)) return true;
  if (IS_WINDOWS) return false;
  const which = spawnSync('which', [binary], {
    encoding: 'utf8',
    shell: false,
    timeout: 3000,
  });
  return !which.error && which.status === 0;
}

function ensureBinary(binary, { isLocal = false, optional = false } = {}) {
  if (binaryOnPath(binary)) return true;
  const msg = `[ask] Missing binary: ${binary}. Install it and ensure it is in PATH.`;
  if (isLocal || optional) {
    console.error(msg + ' (continuing)');
    return false;
  }
  console.error(msg);
  process.exit(1);
}

/** Host session variables that must never leak into a spawned advisor CLI. */
export const HOST_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDECODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'GROK_SESSION_ID',
  'GROK_CLI_SESSION',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
];

export function buildAdvisorEnv(provider, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const k of HOST_SESSION_ENV_VARS) delete env[k];
  if (provider === 'codex') {
    delete env.RUST_LOG;
    delete env.RUST_BACKTRACE;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Failure taxonomy + bounded retry (contract floor — see docs/diversity-roadmap.md)
// ---------------------------------------------------------------------------

const AUTH_RE =
  /\b(401|403 forbidden|unauthorized|not logged in|login required|please (log ?in|sign ?in)|invalid api key|api key (missing|not set)|authentication (failed|required)|credential|token expired)\b/i;
const TRANSIENT_RE =
  /\b(429|rate limit|too many requests|overloaded|capacity|temporar(y|ily)|try again|502 bad gateway|503|504|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang ?up|network (error|failure))\b/i;

/**
 * Classify a spawnSync-like result into a structured failure:
 * missing-binary / timeout / auth / transient / permanent / ok.
 * Pure — safe to unit-test with fixture objects.
 */
export function classifyFailure(result = {}) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`;
  if (
    result.error?.code === 'ENOENT' ||
    /not recognized as an internal or external command|command not found|No such file or directory/i.test(text)
  ) {
    return {
      kind: 'missing-binary',
      retryable: false,
      hint: 'Install the CLI and ensure it is on PATH.',
    };
  }
  if (result.timedOut || result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    return {
      kind: 'timeout',
      retryable: false,
      hint: 'Increase timeout or check for hangs; timeouts are usually systemic, not transient.',
    };
  }
  if ((result.status ?? 0) !== 0 && AUTH_RE.test(text)) {
    return {
      kind: 'auth',
      retryable: false,
      hint: 'Run the provider CLI login flow, then verify with `contracts --live`.',
    };
  }
  if ((result.status ?? 0) !== 0 && TRANSIENT_RE.test(text)) {
    return {
      kind: 'transient',
      retryable: true,
      hint: 'Retried automatically with jittered backoff.',
    };
  }
  if ((result.status ?? 0) !== 0 || result.error) {
    return {
      kind: 'permanent',
      retryable: false,
      hint: 'Read the provider output; this is not a retry candidate.',
    };
  }
  return { kind: 'ok', retryable: false, hint: null };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Bounded jittered retry around a synchronous attempt. Retries ONLY when
 * classifyFailure says transient. maxAttempts includes the first try.
 */
export function withRetry(
  attemptFn,
  { maxAttempts = 2, baseDelayMs = 600, sleep = sleepMs } = {}
) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = attemptFn(attempt);
    const cls = classifyFailure(last);
    last.failure = cls;
    if (cls.kind === 'ok' || !cls.retryable) return { ...last, attempts: attempt };
    if (attempt < maxAttempts) {
      const delay = baseDelayMs * attempt + Math.floor(Math.random() * 400);
      sleep(delay);
    }
  }
  return { ...last, attempts: maxAttempts };
}

/** Detect which agentic CLI (if any) is hosting this process. */
export function detectHostCli(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE_SESSION_ID) {
    return 'claude';
  }
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) {
    return 'codex';
  }
  if (env.GROK_SESSION_ID || env.GROK_CLI_SESSION) return 'grok';
  return null;
}

/** Machine-level xllm home (inventory cache). Overridable for tests. */
export function xllmHomeDir(env = process.env) {
  if (env.XLLM_HOME) return env.XLLM_HOME;
  const home = env.USERPROFILE || env.HOME || process.cwd();
  return path.join(home, NEUTRAL_STATE_DIR);
}

/**
 * Machine capability inventory: which advisor CLIs are installed/healthy and
 * (for ollama) which models are actually pulled. Cached with a TTL because
 * probing every binary takes seconds. Cloud model catalogs are deliberately
 * NOT enumerated — CLIs expose them inconsistently and auth is only proven
 * by a live call (smoke --live).
 */
export function buildInventory({
  refresh = false,
  ttlMs = 24 * 60 * 60 * 1000,
  env = process.env,
} = {}) {
  const dir = xllmHomeDir(env);
  const file = path.join(dir, 'inventory.json');
  if (!refresh) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < ttlMs) {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...cached, cached: true, path: file };
      }
    } catch {
      /* probe fresh */
    }
  }

  const profiles = loadProviderProfiles();
  const providers = {};
  for (const p of getSupportedProviders()) {
    const entry = {
      binary: p === 'lemonade' ? env.LEMONADE_BIN || null : PROVIDER_BINARIES[p],
      kind: LOCAL_PROVIDERS.includes(p) ? 'local' : 'cloud',
      installed: false,
      healthy: false,
      auth_verified: null,
      notes: [],
      ...getProviderCostMeta(p, profiles),
    };
    if (p === 'lmstudio') {
      entry.installed = binaryOnPath('curl') || binaryOnPath('curl.exe');
      entry.healthy = checkServerHealth('lmstudio');
      if (!entry.healthy) entry.notes.push(`server not responding at ${LMSTUDIO_BASE}`);
    } else if (p === 'lemonade') {
      entry.installed = !!env.LEMONADE_BIN && binaryOnPath(env.LEMONADE_BIN);
      entry.healthy = entry.installed;
      if (!env.LEMONADE_BIN) entry.notes.push('LEMONADE_BIN not set — unavailable');
    } else {
      entry.installed = binaryOnPath(PROVIDER_BINARIES[p]);
      if (LOCAL_PROVIDERS.includes(p)) {
        entry.healthy = entry.installed && checkServerHealth(p);
        if (p === 'ollama' && entry.healthy) entry.models = getOllamaModels();
      } else {
        entry.healthy = entry.installed;
        if (entry.installed) entry.notes.push('binary found; auth unverified (smoke --live)');
      }
      if (p === 'antigravity' && IS_WINDOWS) {
        entry.healthy = false;
        entry.notes.push('headless blocked on Windows — gemini fallback');
      }
    }
    providers[p] = entry;
  }

  const inv = {
    inventory_version: 1,
    advisor_version: VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    host_cli: detectHostCli(env),
    providers,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(inv, null, 2), 'utf8');
  } catch {
    /* inventory is best-effort cache */
  }
  return { ...inv, cached: false, path: file };
}

/**
 * Cheap availability probe for routing: binary present (plus server health
 * for local providers). Does NOT verify cloud auth — see doctor/smoke --live.
 */
export function detectAvailableProviders(env = process.env) {
  const out = [];
  for (const p of getSupportedProviders()) {
    if (p === 'lemonade') {
      if (env.LEMONADE_BIN && binaryOnPath(env.LEMONADE_BIN)) out.push(p);
      continue;
    }
    if (p === 'lmstudio') {
      if (checkServerHealth('lmstudio')) out.push(p);
      continue;
    }
    if (p === 'antigravity' && IS_WINDOWS) continue; // headless blocked
    if (!binaryOnPath(PROVIDER_BINARIES[p])) continue;
    if (p === 'ollama' && !checkServerHealth('ollama')) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

const ADVISOR_BASENAME = 'grok-ask-advisor.js';

function pathIfExists(p) {
  try {
    if (p && fs.existsSync(p)) return path.resolve(p);
  } catch {
    /* ignore */
  }
  return null;
}

function advisorUnderRoot(root) {
  if (!root) return null;
  return (
    pathIfExists(path.join(root, 'scripts', ADVISOR_BASENAME)) ||
    pathIfExists(path.join(root, ADVISOR_BASENAME))
  );
}

function scanGrokInstallsForAdvisor() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return null;
  const grokHome = path.join(home, '.grok');
  const candidates = [];
  for (const n of PLUGIN_NAMES) {
    candidates.push(
      path.join(grokHome, 'plugins', n, 'scripts', ADVISOR_BASENAME),
      path.join(grokHome, 'plugins', n, ADVISOR_BASENAME)
    );
  }
  for (const c of candidates) {
    const hit = pathIfExists(c);
    if (hit) return hit;
  }

  const installed = path.join(grokHome, 'installed-plugins');
  try {
    if (!fs.existsSync(installed)) return null;
    for (const name of fs.readdirSync(installed)) {
      const root = path.join(installed, name);
      const script = advisorUnderRoot(root);
      if (!script) continue;
      const manifest =
        pathIfExists(path.join(root, 'plugin.json')) ||
        pathIfExists(path.join(root, '.grok-plugin', 'plugin.json'));
      if (manifest) {
        try {
          const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (j.name && !PLUGIN_NAMES.includes(j.name)) continue;
        } catch {
          /* keep */
        }
      }
      if (/grok-xllm|xllm|oh-my-grok|ohmygrok/i.test(name) || manifest) {
        return script;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function resolveAdvisorScriptPath() {
  const fromEnvFile = pathIfExists(
    process.env.XLLM_ADVISOR_PATH || process.env.OMG_ADVISOR_PATH
  );
  if (fromEnvFile) return fromEnvFile;

  for (const key of [
    'GROK_PLUGIN_ROOT',
    'XLLM_PLUGIN_ROOT',
    'OMG_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_ROOT',
    'CODEX_PLUGIN_ROOT',
  ]) {
    const hit = advisorUnderRoot(process.env[key]);
    if (hit) return hit;
  }

  for (const dir of STATE_DIRS) {
    for (const markerName of MARKER_NAMES) {
      const marker = path.join(process.cwd(), dir, markerName);
      try {
        if (fs.existsSync(marker)) {
          const line = fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)[0];
          const hit = pathIfExists(line);
          if (hit) return hit;
        }
      } catch {
        /* ignore */
      }
    }
  }

  const fromCwd = advisorUnderRoot(process.cwd());
  if (fromCwd) return fromCwd;

  const scanned = scanGrokInstallsForAdvisor();
  if (scanned) return scanned;

  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return path.join(process.cwd(), 'scripts', ADVISOR_BASENAME);
  }
}

export function rememberAdvisorPath(projectRoot = process.cwd()) {
  const advisor = resolveAdvisorScriptPath();
  const dir = resolveStateDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'xllm-advisor-path');
  fs.writeFileSync(marker, `${advisor}\n`, 'utf8');
  ensureArtifactDirs(projectRoot);
  return { advisor, marker };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export function runAdvisor({
  provider,
  model = null,
  effort = null,
  prompt,
  originalTask = null,
  dryRun = false,
  multi = false,
  allowWrite = false,
  allowSelf = false,
  noArtifacts = false,
  propose = false,
  quiet = false,
}) {
  const profiles = loadProviderProfiles();
  let meta = {};

  // Prefer antigravity; auto-fallback on Windows
  const pref = resolvePreferredProvider(provider, profiles);
  if (pref.substituted) {
    console.error(
      `[xllm] ${pref.reason} → using ${pref.provider} instead of ${pref.from}`
    );
    meta = { substituted: true, from: pref.from };
    provider = pref.provider;
  }

  const allowMutation = mutationAllowed(process.env, { allowWrite });
  const env = buildAdvisorEnv(provider);
  const original =
    originalTask ||
    process.env.XLLM_ASK_ORIGINAL_TASK ||
    process.env.OMG_ASK_ORIGINAL_TASK ||
    process.env.OMC_ASK_ORIGINAL_TASK ||
    prompt;

  const pconf = profiles.providers[provider] || {};
  const resolvedEffort = effort || pconf.default_effort || null;
  let resolvedModel = model || pconf.default_model || null;
  if (provider === 'ollama' && !resolvedModel) {
    resolvedModel = env.OLLAMA_DEFAULT_MODEL || pconf.default_model || 'llama3.2';
  }

  if (['ollama', 'lmstudio', 'lemonade'].includes(provider)) {
    if (!checkServerHealth(provider)) {
      console.error(
        `[${provider}] Server health check failed. Is the server running? Proceeding anyway.`
      );
    }
  }

  if (provider === 'ollama' && !model) {
    const models = getOllamaModels();
    if (models.length) {
      console.error(`[ollama] Available models: ${models.join(', ')}`);
    }
  }

  const promptToSend = propose ? buildProposalPrompt(prompt) : prompt;

  const cfg = resolveSpawnConfig(provider, resolvedModel, promptToSend, env, {
    effort: resolvedEffort || null,
    profiles,
    allowMutation,
  });
  const finalModel = cfg.model || resolvedModel;
  const finalEffort = cfg.effort || resolvedEffort;

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          provider,
          model: finalModel,
          effort: finalEffort,
          binary: cfg.binary,
          args: cfg.args.map((a) =>
            typeof a === 'string' && a.length > 120 ? a.slice(0, 120) + '…' : a
          ),
          usesStdin: cfg.usesStdin,
          timeoutMs: cfg.timeoutMs,
          mutation: allowMutation,
          unavailable: cfg.unavailable || false,
          substituted: meta.substituted || false,
        },
        null,
        2
      )
    );
    return { artifactPath: null, exitCode: 0, raw: '', durationMs: 0, dryRun: true };
  }

  if (cfg.unavailable) {
    const msg = `[${provider}] ${cfg.unavailable}`;
    console.error(msg);
    return { artifactPath: null, exitCode: 1, raw: msg, durationMs: 0 };
  }

  // Same-provider advising from inside that provider's own CLI nests
  // sessions and shares auth/sandbox state — refuse unless explicitly allowed.
  const host = detectHostCli();
  if (
    host &&
    host === provider &&
    !allowSelf &&
    process.env.XLLM_ALLOW_SELF !== '1'
  ) {
    const msg =
      `[xllm] Refusing same-provider advising: host CLI is '${host}'. ` +
      `Pass --allow-self or set XLLM_ALLOW_SELF=1 to override.`;
    console.error(msg);
    return { artifactPath: null, exitCode: 1, raw: msg, durationMs: 0 };
  }

  if (provider !== 'lmstudio') {
    const isLocal = LOCAL_PROVIDERS.includes(provider);
    ensureBinary(cfg.binary, { isLocal });
  } else {
    ensureBinary(cfg.binary, { isLocal: true, optional: true });
  }

  const target = resolveSpawnTarget(cfg.binary);

  let finalCommand = target.command;
  let finalArgs = [...(target.argsPrefix || []), ...cfg.args];

  if (target.viaCmd) {
    finalCommand = process.env.ComSpec || 'cmd.exe';
    const bat = resolveBinaryPath(cfg.binary);
    const quotedArgs = cfg.args
      .map((a) => (/\s|"/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
      .join(' ');
    finalArgs = ['/d', '/s', '/c', `"${bat}" ${quotedArgs}`];
  }

  const runOpts = {
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    env,
    shell: false,
    timeout: cfg.timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
    ...(cfg.usesStdin ? { input: promptToSend } : {}),
  };

  const started = Date.now();
  // Contract floor: bounded jittered retry, transient failures only.
  const result = withRetry(() => spawnSync(finalCommand, finalArgs, runOpts));
  const durationMs = Date.now() - started;
  if (result.attempts > 1) {
    console.error(
      `[${provider}] transient failure — retried (${result.attempts} attempts)`
    );
  }

  let stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let raw = [stdout, stderr].filter(Boolean).join('\n\n');
  let code = typeof result.status === 'number' ? result.status : 1;

  if (result.error) {
    raw = `[spawn error] ${result.error.message}\n\n${raw}`;
    code = code || 1;
  }
  if (result.signal) {
    raw = `[killed by signal ${result.signal}]\n\n${raw}`;
    code = code || 1;
  }
  if (code !== 0 && result.failure && result.failure.kind !== 'ok') {
    console.error(
      `[${provider}] failure class: ${result.failure.kind}${result.failure.hint ? ` — ${result.failure.hint}` : ''}`
    );
  }

  if (provider === 'lmstudio' && stdout) {
    raw = parseLMStudioResponse(stdout);
  }
  if (provider === 'ollama') {
    raw = cleanOllamaOutput(raw);
  }
  if (provider === 'codex') {
    raw = cleanCodexOutput(raw);
  }
  if (provider === 'antigravity' && code === 0 && raw.trim() === '') {
    code = 1;
    raw = raw || '(empty output from antigravity — treated as failure)';
  }

  let artifactPath = null;
  let patchPath = null;
  if (noArtifacts || process.env.XLLM_NO_ARTIFACTS === '1') {
    if (!quiet) console.log(raw || '(no output)');
  } else {
    artifactPath = writeArtifact({
      provider,
      model: finalModel,
      effort: finalEffort,
      original,
      finalPrompt: promptToSend,
      raw,
      exitCode: code,
      durationMs,
      meta: { multi, propose, ...meta },
      kind: propose ? 'proposals' : 'ask',
    });
    if (propose && code === 0) {
      const patch = extractProposalPatch(raw);
      if (patch) {
        patchPath = artifactPath.replace(/\.md$/, '.patch');
        fs.writeFileSync(patchPath, patch, 'utf8');
        console.error(`[${provider}] patch: ${patchPath}`);
        console.error(
          `[${provider}] review then apply with: git apply --check "${patchPath}"`
        );
      } else {
        console.error(
          `[${provider}] proposal contained no diff block — read the artifact for its explanation`
        );
      }
    }
    if (!quiet) console.log(artifactPath);
  }
  if (result.error) {
    console.error(`[${provider}] ${result.error.message}`);
  }

  return { artifactPath, patchPath, exitCode: code, raw, durationMs };
}

export function runDoctor() {
  const profiles = loadProviderProfiles({ force: true });
  const report = {
    version: VERSION,
    product: PRODUCT,
    platform: process.platform,
    cwd: process.cwd(),
    state_dir: resolveStateDir(),
    profiles_loaded_from: profiles._loaded_from || '(built-in)',
    defaults: profiles.defaults,
    safety: {
      advisors_read_only: !mutationAllowed(),
      mutation_opt_in: '--allow-write or XLLM_ALLOW_MUTATION=1',
    },
    providers: {},
    recommendations: [],
  };

  for (const p of getSupportedProviders()) {
    const entry = {
      binary: PROVIDER_BINARIES[p],
      kind: LOCAL_PROVIDERS.includes(p) ? 'local' : 'cloud',
      binaryOk: false,
      healthOk: false,
      notes: [],
      default_model: profiles.providers[p]?.default_model || '',
      default_effort: profiles.providers[p]?.default_effort || '',
    };

    if (p === 'lmstudio') {
      entry.binaryOk = binaryOnPath('curl') || binaryOnPath('curl.exe');
      entry.healthOk = checkServerHealth('lmstudio');
      if (!entry.healthOk) entry.notes.push(`Start LM Studio server at ${LMSTUDIO_BASE}`);
    } else if (p === 'lemonade') {
      if (process.env.LEMONADE_BIN) {
        entry.binaryOk = binaryOnPath(process.env.LEMONADE_BIN);
        entry.healthOk = entry.binaryOk;
      } else {
        entry.binaryOk = false;
        entry.healthOk = false;
        entry.notes.push('Set LEMONADE_BIN — lemonade is unavailable without it');
      }
    } else if (p === 'antigravity' && IS_WINDOWS) {
      entry.binaryOk = binaryOnPath('agy');
      entry.healthOk = false;
      entry.notes.push(
        'Headless blocked on Windows — auto-fallback to gemini; prefer antigravity on macOS/Linux'
      );
    } else {
      entry.binaryOk = binaryOnPath(PROVIDER_BINARIES[p]);
      if (LOCAL_PROVIDERS.includes(p)) {
        entry.healthOk = entry.binaryOk && checkServerHealth(p);
        if (p === 'ollama' && entry.healthOk) {
          entry.models = getOllamaModels();
        }
      } else {
        // "READY" for cloud providers means the binary responds — it does
        // NOT prove auth or a working headless request.
        entry.healthOk = entry.binaryOk;
        entry.authVerified = null;
        if (entry.binaryOk) {
          entry.notes.push(
            'binary found; auth not verified — run `smoke --live` to confirm'
          );
        }
      }
    }

    report.providers[p] = entry;
  }

  const isReady = (p) =>
    report.providers[p].binaryOk && report.providers[p].healthOk === true;

  const readyCloud = CLOUD_PROVIDERS.filter(isReady);
  const readyLocal = LOCAL_PROVIDERS.filter(isReady);
  report.readyCloud = readyCloud;
  report.readyLocal = readyLocal;

  if (readyCloud.length === 0 && readyLocal.length === 0) {
    report.recommendations.push(
      'No advisors ready. Install codex/antigravity/grok or start ollama.'
    );
  } else {
    const pair = pickDefaultXllmPair(readyCloud, readyLocal, profiles);
    report.recommendations.push(
      `Suggested /xllm default (antigravity>gemini for design): ${pair.join(',')}`
    );
  }
  if (IS_WINDOWS) {
    report.recommendations.push(
      'On Windows: codex, grok, claude, ollama, lmstudio; antigravity→gemini fallback'
    );
  } else {
    report.recommendations.push(
      'Prefer antigravity over gemini for design-side reviews'
    );
  }
  report.recommendations.push(
    'Spec syntax: provider[:model][@effort]  e.g. codex@high  antigravity:model  ollama:qwen3.6:latest'
  );

  ensureArtifactDirs(process.cwd());
  report.artifactsReady = true;

  try {
    const remembered = rememberAdvisorPath(process.cwd());
    report.advisorPath = remembered.advisor;
    report.advisorMarker = remembered.marker;
    report.recommendations.push(`Advisor script: ${remembered.advisor}`);
  } catch {
    report.advisorPath = resolveAdvisorScriptPath();
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {
    allowWrite: false,
    allowSelf: false,
    noArtifacts: false,
    propose: false,
    refresh: false,
  };
  let olderThan = null;
  const args = [];
  for (const a of argv.slice(2)) {
    if (a === '--allow-write') {
      flags.allowWrite = true;
    } else if (a === '--allow-self') {
      flags.allowSelf = true;
    } else if (a === '--no-artifacts') {
      flags.noArtifacts = true;
    } else if (a === '--propose') {
      flags.propose = true;
    } else if (a === '--refresh') {
      flags.refresh = true;
    } else if (/^--older-than=\d+$/.test(a)) {
      olderThan = Number(a.split('=')[1]);
    } else {
      args.push(a);
    }
  }
  if (args.length === 0) usage();

  if (args[0] === '--list-providers') return { mode: 'list', flags };
  if (args[0] === '--doctor') return { mode: 'doctor', flags };
  if (args[0] === '--which') return { mode: 'which', flags };
  if (args[0] === '--remember') return { mode: 'remember', flags };
  if (args[0] === '--inventory') return { mode: 'inventory', flags };
  if (args[0] === '--profile-show') return { mode: 'profile-show', flags };
  if (args[0] === '--set-role') {
    if (args.length < 3) {
      console.error('Usage: --set-role <role> <provider[:model][@effort]>');
      process.exit(1);
    }
    return { mode: 'set-role', role: args[1], spec: args[2], flags };
  }
  if (args[0] === '--set-default') {
    if (args.length < 3) {
      console.error('Usage: --set-default <key> <value>');
      process.exit(1);
    }
    return { mode: 'set-default', key: args[1], value: args[2], flags };
  }
  if (args[0] === '--clean-artifacts') {
    return { mode: 'clean-artifacts', flags, olderThan };
  }
  if (args[0] === '--help' || args[0] === '-h') return { mode: 'help', flags };

  if (args[0] === '--dry-run') {
    const spec = parseProviderSpec(args[1]);
    const prompt = args.slice(2).join(' ').trim();
    if (!spec || !prompt) usage();
    return { mode: 'dry-run', ...spec, prompt, flags };
  }
  if (args[0] === '--multi') {
    const list = (args[1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const prompt = args.slice(2).join(' ').trim();
    if (list.length < 2 || !prompt) {
      console.error('--multi requires at least two providers and a prompt');
      usage();
    }
    const providers = list.map((s) => {
      const p = parseProviderSpec(s);
      if (!p) {
        console.error(`Unknown provider: ${s}`);
        process.exit(1);
      }
      return p;
    });
    return { mode: 'multi', providers, prompt, flags };
  }

  const spec = parseProviderSpec(args[0]);
  const prompt = args.slice(1).join(' ').trim();
  if (!spec || !prompt) usage();
  return { mode: 'run', ...spec, prompt, flags };
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.mode === 'help') usage(0);
  if (parsed.mode === 'list') {
    console.log(JSON.stringify(getProviderMeta(), null, 2));
    process.exit(0);
  }
  if (parsed.mode === 'which') {
    console.log(resolveAdvisorScriptPath());
    process.exit(0);
  }
  if (parsed.mode === 'remember') {
    const r = rememberAdvisorPath();
    console.log(r.advisor);
    console.error(`marker: ${r.marker}`);
    process.exit(0);
  }
  if (parsed.mode === 'doctor') {
    const report = runDoctor();
    const anyReady =
      (report.readyCloud && report.readyCloud.length > 0) ||
      (report.readyLocal && report.readyLocal.length > 0);
    process.exit(anyReady ? 0 : 2);
  }
  if (parsed.mode === 'clean-artifacts') {
    const removed = cleanArtifacts(process.cwd(), {
      olderThanDays: parsed.olderThan,
    });
    console.log(`removed ${removed} artifact file(s)`);
    process.exit(0);
  }
  if (parsed.mode === 'inventory') {
    const inv = buildInventory({ refresh: parsed.flags.refresh });
    console.log(JSON.stringify(inv, null, 2));
    process.exit(0);
  }
  if (parsed.mode === 'profile-show') {
    const profiles = loadProviderProfiles({ force: true });
    console.log(
      JSON.stringify(
        { state_dir: resolveStateDir(), ...profiles },
        null,
        2
      )
    );
    process.exit(0);
  }
  if (parsed.mode === 'set-role') {
    const spec = parseProviderSpec(parsed.spec);
    if (!spec) {
      console.error(`Invalid spec: ${parsed.spec}`);
      process.exit(1);
    }
    const role = String(parsed.role).toLowerCase();
    const file = setProfileValue('roles', role, parsed.spec);
    console.log(`${file}: roles.${role} = "${parsed.spec}"`);
    process.exit(0);
  }
  if (parsed.mode === 'set-default') {
    const file = setProfileValue('defaults', parsed.key, parsed.value);
    console.log(`${file}: defaults.${parsed.key} = "${parsed.value}"`);
    process.exit(0);
  }

  if (parsed.mode === 'dry-run') {
    runAdvisor({
      provider: parsed.provider,
      model: parsed.model,
      effort: parsed.effort,
      prompt: parsed.prompt,
      dryRun: true,
      allowWrite: parsed.flags.allowWrite,
      propose: parsed.flags.propose,
    });
    process.exit(0);
  }

  if (parsed.mode === 'multi') {
    // Each provider runs as its own child process, concurrently.
    const self = fileURLToPath(import.meta.url);
    const childFlags = [];
    if (parsed.flags.allowWrite) childFlags.push('--allow-write');
    if (parsed.flags.allowSelf) childFlags.push('--allow-self');
    if (parsed.flags.noArtifacts) childFlags.push('--no-artifacts');
    if (parsed.flags.propose) childFlags.push('--propose');

    const runOne = (p) =>
      new Promise((resolve) => {
        console.error(`[multi] running ${p.spec}...`);
        const child = spawn(
          process.execPath,
          [self, ...childFlags, p.spec, parsed.prompt],
          { env: process.env, windowsHide: true }
        );
        let out = '';
        let errBuf = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => {
          errBuf += d;
          process.stderr.write(d);
        });
        child.on('error', (e) =>
          resolve({ spec: p.spec, code: 1, out: `[spawn error] ${e.message}`, err: '' })
        );
        child.on('close', (code) =>
          resolve({ spec: p.spec, code: code ?? 1, out: out.trim(), err: errBuf })
        );
      });

    const raw = await Promise.all(parsed.providers.map(runOne));
    const results = raw.map((r) => {
      const artifact = r.code === 0 && r.out ? r.out.split(/\r?\n/).pop() : null;
      const patchMatch = (r.err || '').match(/patch: (.+\.patch)/);
      return { spec: r.spec, code: r.code, artifact, patch: patchMatch ? patchMatch[1].trim() : null, out: r.out };
    });
    const failed = results.filter((r) => r.code !== 0).length;

    if (parsed.flags.noArtifacts || process.env.XLLM_NO_ARTIFACTS === '1') {
      for (const r of results) {
        console.log(`\n===== ${r.spec} (exit ${r.code}) =====\n`);
        console.log(r.out || '(no output)');
      }
      process.exit(failed > 0 && failed === results.length ? 1 : 0);
    }

    const index = writeMultiIndex({
      prompt: parsed.prompt,
      results,
      propose: parsed.flags.propose,
    });
    console.log(index.mdPath);
    process.exit(failed > 0 && failed === results.length ? 1 : 0);
  }

  const result = runAdvisor({
    provider: parsed.provider,
    model: parsed.model,
    effort: parsed.effort,
    prompt: parsed.prompt,
    allowWrite: parsed.flags.allowWrite,
    allowSelf: parsed.flags.allowSelf,
    noArtifacts: parsed.flags.noArtifacts,
    propose: parsed.flags.propose,
  });
  process.exit(result.exitCode === 0 ? 0 : result.exitCode || 1);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('grok-ask-advisor.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
