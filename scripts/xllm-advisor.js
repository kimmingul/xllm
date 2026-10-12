#!/usr/bin/env node
/**
 * xllm advisor — single entry for headless multi-LLM calls.
 *
 * Spec syntax:
 *   provider
 *   provider:model
 *   provider@effort
 *   provider:model@effort
 *   ollama:qwen3.6:latest@medium
 *
 * Usage:
 *   node scripts/xllm-advisor.js <spec> "<prompt>"
 *   node scripts/xllm-advisor.js --list-providers
 *   node scripts/xllm-advisor.js --doctor
 *   node scripts/xllm-advisor.js --which | --remember
 *   node scripts/xllm-advisor.js --dry-run <spec> "<prompt>"
 *   node scripts/xllm-advisor.js --multi p1,p2 "<prompt>"
 *
 * Profiles: .grok/xllm-providers.toml (see loadProviderProfiles)
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import process from 'process';
import { parseDiffFlags, hasDiffSource, collectReviewDiff, buildReviewContext, diffMeta, PROMPT_FILE_THRESHOLD } from './xllm-diff.js';
import {
  PROVIDER_BINARIES,
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  KNOWN_EFFORTS,
} from './xllm-constants.js';
import { makeResult, parseProviderOutput, isMutableModel, executionLocation, executionPolicyDecision } from './xllm-evidence.js';
import { recordProviderResult } from './xllm-health.js';

// Re-exported so the 8 modules that import these from here keep working.
export { PROVIDER_BINARIES, CLOUD_PROVIDERS, LOCAL_PROVIDERS, KNOWN_EFFORTS };

const VERSION = '0.36.1';
const PRODUCT = 'xllm';
const PLUGIN_NAMES = ['xllm', 'oh-my-grok'];


// antigravity listed before gemini — preferred design-side cloud advisor


const IS_WINDOWS = process.platform === 'win32';
const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE || 'http://localhost:1234';

/** OLLAMA_HOST may be set scheme-less ("127.0.0.1:11434") — normalize. */
export function ollamaBaseUrl(env = process.env) {
  const raw = (env.OLLAMA_HOST || '').trim();
  if (!raw) return 'http://localhost:11434';
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, '') : `http://${raw.replace(/\/$/, '')}`;
}
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
    execution_policy: 'any',
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
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
      tier: 'local',
      relative_cost: 0,
      latency_class: 'medium',
    },
    lmstudio: {
      default_model: '',
      default_effort: '',
      temperature: 0.7,
      timeout_ms: 300000,
      tier: 'local',
      relative_cost: 0,
      latency_class: 'medium',
    },
    lemonade: {
      default_model: '',
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
    basis: 'heuristic',
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

export function getLocalModelDetails(provider, env = process.env) {
  const base = provider === 'ollama' ? ollamaBaseUrl(env) : (env.LMSTUDIO_BASE || 'http://localhost:1234');
  const endpoint = provider === 'ollama' ? '/api/tags' : '/api/v0/models';
  const res = spawnSync(IS_WINDOWS ? 'curl.exe' : 'curl',
    ['-fsS', '--max-time', '3', `${base}${endpoint}`],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
  if (res.error || res.status !== 0) return {};
  try {
    const json = JSON.parse(res.stdout);
    return Object.fromEntries((json.models || json.data || [])
      .filter((m) => m && (m.name || m.id || m.model))
      .map((m) => [m.name || m.id || m.model, m]));
  } catch { return {}; }
}

export function getOllamaModels() {
  return Object.keys(getLocalModelDetails('ollama'));
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

/**
 * Map spec effort to the /api/generate `think` parameter. Graded string
 * levels for gpt-oss (the family documented to take low/medium/high);
 * boolean for everything else. No effort → undefined: the payload stays
 * unchanged, so models that reject `think` never see it unless effort was
 * explicitly requested (and then a rejection triggers one retry without it).
 */
export function ollamaThinkFromEffort(effort, model) {
  if (!effort) return undefined;
  const e = String(effort).toLowerCase();
  const low = e === 'none' || e === 'minimal' || e === 'low';
  if (/^gpt-oss\b/.test(String(model || ''))) {
    return low ? 'low' : e === 'medium' ? 'medium' : 'high';
  }
  return !low;
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
/**
 * Model names that a provider CLI no longer accepts, mapped to the shipping
 * replacement. Every entry below was probed live, not guessed — see the note
 * on each. Keep this table small: it exists to rescue names that used to work
 * or that read as the obvious spelling, NOT to enumerate a roster (xllm
 * deliberately has no cloud model roster; unknown names are passed through).
 *
 * Probed 2026-08-02 on codex-cli 0.146.0 / grok 0.2.118:
 * - `gpt-5.6` → HTTP 400 "The 'gpt-5.6' model is not supported when using
 *   Codex with a ChatGPT account", plus "Model metadata not found". The
 *   shipping variants carry a suffix; sol/terra/luna all returned exit 0.
 *   sol is the mapping target as the general-purpose one.
 * - `grok-4` → "Invalid params: unknown model id". Re-measured 2026-08-23:
 *   still rejected, and the account default moved on to grok-4.6, so the
 *   rescue target follows. `grok-4.5` is still accepted and therefore must
 *   NOT be aliased — rewriting a name the CLI honours would silently change
 *   what the user asked for.
 */
export const MODEL_ALIASES = {
  codex: {
    'gpt-5.6': 'gpt-5.6-sol',
  },
  grok: {
    'grok-4': 'grok-4.6',
    'grok-4-latest': 'grok-4.6',
  },
};

/**
 * Merge the built-in seed with `[aliases.<provider>]` from xllm-providers.toml.
 * The TOML wins, so a user can retarget an entry (`"gpt-5.6" = "gpt-5.6-terra"`)
 * or switch one off with an empty value (`"gpt-5.6" = ""`) without waiting for
 * an xllm release. Keys are lowercased; lookups are case-insensitive.
 */
export function resolveAliasTable(provider, profiles = null) {
  const p = String(provider || '').toLowerCase();
  const seed = MODEL_ALIASES[p] || {};
  const table = {};
  for (const [k, v] of Object.entries(seed)) table[k.toLowerCase()] = v;

  const prof = profiles || loadProviderProfiles();
  const user = (prof.aliases && prof.aliases[p]) || null;
  if (user) {
    for (const [k, v] of Object.entries(user)) {
      // An empty value is an explicit "leave this name alone", not a typo —
      // it is how you disable a seed entry the vendor has since un-retired.
      table[String(k).toLowerCase()] = String(v ?? '');
    }
  }
  return table;
}

/**
 * Apply a measured model alias. Returns the name to actually spawn with and,
 * when a substitution happened, what it replaced so callers can say so —
 * plus where the correction came from, since a surprising rewrite should be
 * traceable to either xllm's seed or the user's own TOML.
 */
export function resolveModelAlias(provider, model, profiles = null) {
  if (!model) return { model, aliased: null };
  const prof = profiles || loadProviderProfiles();
  const table = resolveAliasTable(provider, prof);
  const key = String(model).trim().toLowerCase();
  const to = table[key];
  if (!to || to === model) return { model, aliased: null };

  // Provenance is about who *owns* the entry, not whether the value happens to
  // match the seed: a user who pins the same mapping still decided it, and the
  // notice should point them at their own file.
  const p = String(provider || '').toLowerCase();
  const userTable = (prof.aliases && prof.aliases[p]) || null;
  const ownedByUser =
    !!userTable && Object.keys(userTable).some((k) => String(k).toLowerCase() === key);
  return { model: to, aliased: { from: model, to, source: ownedByUser ? 'toml' : 'builtin' } };
}

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

  const allProfiles = profiles || loadProviderProfiles();
  const prof = allProfiles.providers[provider] || {};
  if (!model && prof.default_model) model = String(prof.default_model);
  if (!effort && prof.default_effort) effort = String(prof.default_effort).toLowerCase();

  // Retired names are corrected here — the one choke point every surface
  // (ask/review/panel/debate/bench) routes specs through. The label carries the
  // corrected name so evidence records what actually ran, not what was typed.
  const alias = resolveModelAlias(provider, model, allProfiles);
  model = alias.model;

  const parts = [provider];
  if (model) parts[0] = `${provider}:${model}`;
  const label = effort ? `${parts[0]}@${effort}` : parts[0];

  return { provider, model, effort, spec: label, modelAliased: alias.aliased };
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
    // Quoted keys matter here: model ids carry dots (`"gpt-5.6"`), and a bare
    // dotted key would mean table nesting in TOML, not a literal name.
    const kv = line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1] ?? kv[2] ?? kv[3];
    let val = kv[4].trim();
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
    cursor[key] = val;
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
      // [aliases.<provider>] — model-name corrections owned by the user, so a
      // vendor rename does not have to wait for an xllm release.
      if (parsed.aliases) merged.aliases = parsed.aliases;
      merged._loaded_from = p;
      break; // first existing wins (search order is priority)
    } catch {
      /* try next */
    }
  }

  // env timeout override. Setting only defaults.timeout_ms is not enough:
  // every built-in provider carries its own timeout_ms, and resolveSpawnConfig
  // reads pconf.timeout_ms *before* defaults — so the documented env var
  // silently did nothing for every provider. Stamp both.
  const envTimeout = Number(
    process.env.XLLM_ADVISOR_TIMEOUT_MS || 0
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
#
# [aliases.<provider>]   rewrite retired model names before spawning. Quote the
#                        keys — model ids contain dots. These win over xllm's
#                        built-in seed, so you can track a vendor rename without
#                        waiting for an xllm release. An empty value switches a
#                        seed entry off.
#   [aliases.codex]
#   "gpt-5.6" = "gpt-5.6-terra"   # retarget xllm's built-in (sol)
#   "gpt-5.5" = ""                # leave this name alone
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

const SETUP_ROLE_KEYS = ['analysis', 'design', 'critic'];

/** Validate one resolved pin against inventory. Returns {ok, error?}. */
export function validateSetupPin(spec, role, inventory, options = {}) {
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
  const policy = executionPolicyDecision(parsed.provider, parsed.model, {
    profiles: { defaults: { execution_policy: options.execution_policy || 'any' } },
    modelInfo: p.model_details?.[parsed.model],
  });
  if (!policy.allowed) return { ok: false, error: policy.reason };
  if (options.sensitive === 'yes') {
    const prov = inventory.providers?.[parsed.provider];
    const isLocal = executionLocation(parsed.provider, parsed.model, { modelInfo: prov?.model_details?.[parsed.model] }) === 'local';
    if (role === 'critic' && !isLocal) {
      return { ok: false, error: `sensitive=yes: paid critic pin not allowed (${spec})` };
    }
    if (role === 'analysis' && ['none', 'minimal', 'low', 'medium'].includes(parsed.effort)) {
      return { ok: false, error: `sensitive=yes: analysis effort must be at least high (${spec})` };
    }
  }
  return { ok: true };
}

/**
 * Validate the whole plan (pins + overrides) against inventory, then — only if
 * apply — write pins and DELETE keys for OPEN (null) roles. Atomic: any
 * validation error throws before a single write.
 */
export function applySetupPlan(plan, { inventory, apply = false, root = process.cwd(), sensitive = 'no' } = {}) {
  const errors = [];
  if (plan.errors?.length) errors.push(...plan.errors);
  if (plan.ok === false && !errors.length) errors.push(plan.error || 'setup plan is unsatisfiable');
  const executionPolicy = plan.execution_policy || loadProviderProfiles().defaults.execution_policy || 'any';
  for (const role of SETUP_ROLE_KEYS) {
    const spec = plan.roles[role];
    if (spec == null) continue; // OPEN
    const v = validateSetupPin(spec, role, inventory, { sensitive, execution_policy: executionPolicy });
    if (!v.ok) errors.push(`${role}: ${v.error}`);
  }
  if (errors.length) {
    if (apply) throw new Error(`setup validation failed (no changes written): ${errors.join('; ')}`);
    return { written: [], deleted: [], errors };
  }
  const written = [];
  const deleted = [];
  if (apply) {
    const dir = resolveStateDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'xllm-providers.toml');
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : PROFILE_TEMPLATE;
    for (const role of SETUP_ROLE_KEYS) {
      const spec = plan.roles[role];
      if (spec == null) { text = deleteTomlKey(text, 'roles', role); deleted.push(role); }
      else { text = upsertTomlKey(text, 'roles', role, spec); written.push(role); }
    }
    if (plan.execution_policy === 'local-only') text = upsertTomlKey(text, 'defaults', 'execution_policy', 'local-only');
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
    _profilesCache = null;
  }
  return { written, deleted, errors: [] };
}

/**
 * Prefer antigravity (agy) for the Gemini family; use the standalone gemini CLI
 * only when agy is not installed. Substitution is driven by what is actually on
 * PATH — never by platform.
 *
 * Through v0.30.0 this substituted antigravity → gemini on Windows
 * unconditionally, on the belief that agy had no headless mode. Measured
 * 2026-08-02 on Windows 11 with agy 1.1.9: `--help` exposes -p/--print,
 * --model, --effort, --print-timeout and --output-format, and a live
 * `agy -p` returned clean output with exit 0 in 10.9s. The rule was not just
 * stale but harmful — it redirected working agy calls onto a gemini CLI that
 * is frequently not installed at all, so the design lane failed outright.
 *
 * opts.isAvailable is injectable so this stays testable without touching PATH.
 */
export function resolvePreferredProvider(name, profiles = null, opts = {}) {
  const prof = profiles || loadProviderProfiles();
  const p = String(name || '').toLowerCase();
  const onPath = opts.isAvailable || ((bin) => binaryOnPath(bin));

  const design = (prof.defaults.design_provider || 'antigravity').toLowerCase();
  const fallback = (prof.defaults.design_fallback || 'gemini').toLowerCase();
  let sibling = null;
  if (p === design) sibling = fallback;
  else if (p === fallback) sibling = design;

  if (sibling && PROVIDER_BINARIES[p] && PROVIDER_BINARIES[sibling]) {
    if (!onPath(PROVIDER_BINARIES[p]) && onPath(PROVIDER_BINARIES[sibling])) {
      return {
        provider: sibling,
        substituted: true,
        from: p,
        reason: `${PROVIDER_BINARIES[p]} not on PATH; ${PROVIDER_BINARIES[sibling]} is`,
      };
    }
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

  // Design side: antigravity first, then gemini, then anything cloud.
  // `ready` already reflects which binaries exist, so no platform rule here.
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
  provider, model = null, prompt = '', env = process.env, options = {}
) {
  const profiles = options.profiles || loadProviderProfiles();
  const pconf = profiles.providers[provider] || {};
  const effort = options.effort || null;
  const allowMutation = !!options.allowMutation;
  const timeoutMs = options.timeoutMs || Number(env.XLLM_ADVISOR_TIMEOUT_MS)
    || pconf.timeout_ms || profiles.defaults.timeout_ms || 300000;
  const resolvedModel = model || pconf.default_model
    || (provider === 'ollama' ? env.OLLAMA_DEFAULT_MODEL : null)
    || (provider === 'lmstudio' ? env.LMSTUDIO_MODEL : null) || null;
  const cfg = {
    binary: PROVIDER_BINARIES[provider], args: [], usesStdin: false,
    timeoutMs, model: resolvedModel, effort, effectiveEffort: effort, mutation: allowMutation,
    safety: 'unverified', nativeSchema: false,
  };
  if (options.execution && provider !== 'codex') {
    return { ...cfg, unavailable: 'Isolated execution requires the verified Codex OS sandbox.' };
  }
  if (provider === 'codex') {
    if (options.execution) {
      const args = options.execution.providerArgs;
      if (!Array.isArray(args) || args.some((a) => /^--dangerously|^--bypass|^--sandbox(?:=|$)|^-s$|danger-full-access|(?:^|[\s{,])sandbox_mode\s*=/i.test(String(a)))) {
        return { ...cfg, unavailable: 'Execution requires a verified, non-bypass OS permission profile.' };
      }
      cfg.args = ['exec', ...args, '--json'];
    } else {
      cfg.args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
        '--sandbox', 'read-only', '-c', 'mcp_servers={}', '-c', 'features.hooks=false',
        '-c', 'features.multi_agent=false', '-c', 'approval_policy="never"'];
    }
    if (allowMutation && !options.execution) {
      return { ...cfg, unavailable: 'Use xllm exec for sandboxed changes; advisor sandbox bypass is not supported.' };
    }
    appendModelEffortFlags(provider, cfg.args, resolvedModel, effort, pconf);
    if (options.schemaPath) {
      cfg.args.push('--output-schema', options.schemaPath);
      cfg.nativeSchema = true;
    }
    cfg.args.push('-');
    cfg.usesStdin = true;
    cfg.safety = options.execution ? 'os-workspace' : 'os-read-only';
    return cfg;
  }
  if (provider === 'claude') {
    cfg.args = ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence',
      '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none', '--output-format', 'json'];
    if (allowMutation) return { ...cfg, unavailable: 'Claude advisors are read-only; isolated exec requires an OS sandbox.' };
    if (resolvedModel) cfg.args.push('--model', resolvedModel);
    if (effort) cfg.args.push('--effort', effort);
    if (options.schema) {
      cfg.args.push('--json-schema', JSON.stringify(options.schema));
      cfg.nativeSchema = true;
    }
    cfg.args.push('-p');
    cfg.usesStdin = true;
    cfg.safety = 'read-tools-only';
    return cfg;
  }
  if (provider === 'ollama' || provider === 'lmstudio') {
    if (!resolvedModel) return { ...cfg, unavailable: `Select an installed ${provider} model explicitly (no hard-coded model default).` };
    cfg.binary = IS_WINDOWS ? 'curl.exe' : 'curl';
    const base = provider === 'ollama' ? ollamaBaseUrl(env) : (env.LMSTUDIO_BASE || 'http://localhost:1234');
    const body = provider === 'ollama'
      ? { model: resolvedModel, prompt, stream: false }
      : { model: resolvedModel, messages: [{ role: 'user', content: prompt }], temperature: options.temperature ?? pconf.temperature ?? 0.7, stream: false };
    if (provider === 'ollama') {
      const think = ollamaThinkFromEffort(effort, resolvedModel);
      if (think !== undefined) body.think = think;
      cfg.effectiveEffort = typeof think === 'boolean' ? (think ? 'thinking' : 'off') : think || null;
      if (options.schema && executionLocation(provider, resolvedModel, { env, modelInfo: options.modelInfo }) === 'local') {
        body.format = options.schema;
        cfg.nativeSchema = true;
      }
    } else {
      cfg.effectiveEffort = null; // OpenAI-compatible servers do not guarantee effort support.
      if (options.schema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'xllm_response', strict: true, schema: options.schema } };
        cfg.nativeSchema = true;
      }
    }
    cfg.args = ['-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      `${base}${provider === 'ollama' ? '/api/generate' : '/v1/chat/completions'}`,
      '-H', 'Content-Type: application/json', '-d', '@-'];
    cfg.stdinPayload = JSON.stringify(body);
    cfg.usesStdin = true;
    cfg.safety = 'completion-only';
    return cfg;
  }
  // No permission-mode guess is a security boundary. Preserve explicit unsafe
  // opt-in for these adapters, but never advertise their defaults as read-only.
  if (!allowMutation) {
    return { ...cfg, unavailable: `${provider}: read-only enforcement is unverified; use a verified advisor (codex, claude, local HTTP), or explicitly opt in with --allow-write.` };
  }
  cfg.safety = 'unrestricted-opt-in';
  if (provider === 'antigravity') {
    cfg.binary = 'agy';
    cfg.args = ['--output-format', 'json', '--disable-slash-commands',
      '--dangerously-skip-permissions', '--print-timeout', `${timeoutMs}ms`];
    if (resolvedModel) cfg.args.push('--model', resolvedModel);
    cfg.effectiveEffort = agyEffortFromEffort(effort);
    if (cfg.effectiveEffort) cfg.args.push('--effort', cfg.effectiveEffort);
    if (options.schemaPath) { cfg.args.push('--json-schema', options.schemaPath); cfg.nativeSchema = true; }
    cfg.args.push('-p', prompt);
  } else if (provider === 'grok') {
    cfg.args = ['--output-format', 'json', '--always-approve'];
    if (resolvedModel) cfg.args.push('-m', resolvedModel);
    if (effort) cfg.args.push('--reasoning-effort', effort);
    if (options.schema) { cfg.args.push('--json-schema', JSON.stringify(options.schema)); cfg.nativeSchema = true; }
    cfg.args.push('-p', prompt);
  } else if (provider === 'gemini') {
    cfg.args = ['--output-format', 'json', '--approval-mode', 'yolo'];
    if (resolvedModel) cfg.args.push('--model', resolvedModel);
    cfg.args.push('-p', prompt);
    cfg.effectiveEffort = null;
  } else if (provider === 'cursor') {
    cfg.args = ['--print', '--output-format', 'json', '--force', '--trust', '--sandbox', 'disabled'];
    if (resolvedModel) cfg.args.push('--model', resolvedModel);
    cfg.args.push(prompt);
    cfg.effectiveEffort = null;
  } else if (provider === 'lemonade' && env.LEMONADE_BIN) {
    cfg.binary = env.LEMONADE_BIN;
    cfg.args = ['run', resolvedModel || 'default', prompt];
    cfg.effectiveEffort = null;
  } else cfg.unavailable = `${provider}: no executable adapter configured`;
  return cfg;
}

/**
 * Clamp xllm's effort vocabulary onto the three tiers agy accepts.
 * Returns null when there is nothing to pass.
 */
export function agyEffortFromEffort(effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return null;
  if (e === 'none' || e === 'minimal' || e === 'low') return 'low';
  if (e === 'medium') return 'medium';
  if (e === 'high' || e === 'xhigh' || e === 'max' || e === 'ultra') return 'high';
  return null;
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
    case 'antigravity': {
      // agy 1.1.9 does expose a dedicated flag: `--effort low|medium|high`
      // (measured 2026-08-02 — earlier xllm believed there was none and
      // dropped @effort silently). Model ids also embed a tier
      // (gemini-3.6-flash-high); the flag is accepted alongside one.
      const agy = agyEffortFromEffort(effort);
      if (agy) args.push('--effort', agy);
      break;
    }
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

export const ARTIFACT_SUBDIRS = ['ask', 'xllm', 'proposals', 'exec'];

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
    // A corrected name must not erase what was asked for: the evidence has to
    // show requested → transmitted and who decided, or a reader attributes the
    // run to a model the user never chose.
    meta.modelAliased ? `- Requested model: ${meta.modelAliased.from}` : null,
    meta.modelAliased ? `- Transmitted model: ${meta.modelAliased.to}` : null,
    meta.modelAliased
      ? `- Model correction source: ${meta.modelAliased.source || 'builtin'}`
      : null,
    effort ? `- Effort: ${effort}` : null,
    `- Exit code: ${exitCode}`,
    durationMs != null ? `- Duration ms: ${durationMs}` : null,
    `- Advisor version: ${VERSION}`,
    `- Created at: ${new Date().toISOString()}`,
    `- Host: ${process.platform}`,
    meta.multi ? `- Multi-run: yes` : null,
    meta.substituted ? `- Substituted from: ${meta.from}` : null,
    meta.attribution ? `- Execution evidence: ${JSON.stringify(meta.attribution)}` : null,
    meta.failure ? `- Failure: ${redactSecrets(JSON.stringify(meta.failure))}` : null,
    meta.usage ? `- Usage: ${JSON.stringify(meta.usage)}` : null,
    meta.cost_estimate != null ? `- Estimated cost USD: ${meta.cost_estimate}` : null,
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
  diffContext = null,
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
        // Epistemology firewall (umbrella-5): roles/multi output is coverage,
        // not measurement — no ledger, no pairwise agreement. Only `review
        // blind` / council phase-1 produce measured agreement.
        measurement: false,
        ...(diffContext ? { diff_context: diffContext } : {}),
        failures: failed,
        results: results.map((r) => ({
          spec: r.executedSpec || r.spec,
          requested_spec: r.requestedSpec || r.spec,
          exit_code: r.code,
          artifact: r.artifact || null,
          patch: r.patch || null,
          attribution: r.result?.attribution || null,
          failure: r.result?.failure || null,
          usage: r.result?.usage || null,
          cost_estimate: r.result?.cost_estimate ?? null,
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
      // `Providers` reads as "what ran", so it has to BE what ran. The request
      // is kept on its own clearly-named line, and only when it differs.
      `- Providers: ${results.map((r) => r.executedSpec || r.spec).join(', ')}`,
      results.some((r) => r.requestedSpec && r.executedSpec && r.requestedSpec !== r.executedSpec)
        ? `- Requested providers: ${results.map((r) => r.requestedSpec || r.spec).join(', ')}`
        : null,
      `- Failures: ${failed}`,
      `- Measurement: none — coverage mode; the consensus labels below are the host's synthesis, not measured agreement (use \`review blind\` for measured agreement)`,
      ...(diffContext ? [`- Code context: ${diffContext.source} (${diffContext.bytes} bytes${diffContext.truncated ? ', truncated' : ''}) — diff body not persisted`] : []),
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
  node scripts/xllm-advisor.js <provider[:model][@effort]> "<prompt>"
  node scripts/xllm-advisor.js --list-providers
  node scripts/xllm-advisor.js --doctor
  node scripts/xllm-advisor.js --which | --remember
  node scripts/xllm-advisor.js --dry-run <spec> "<prompt>"
  node scripts/xllm-advisor.js --multi p1,p2[,p3] "<prompt>"   (runs in parallel)
  node scripts/xllm-advisor.js <spec> --prompt-file <path>     (prompt from file —
                       escapes Windows' ~32KB argv limit; works with --multi/--dry-run too)
  node scripts/xllm-advisor.js --propose <spec> "<change request>"   (diff proposal)
  node scripts/xllm-advisor.js --inventory [--refresh]   (machine capability cache)
  node scripts/xllm-advisor.js --profile-show
  node scripts/xllm-advisor.js --set-role <role> <spec>   (project role pin)
  node scripts/xllm-advisor.js --set-default <key> <value>
  node scripts/xllm-advisor.js --clean-artifacts [--older-than=DAYS]
  node scripts/xllm-advisor.js --setup <pack> [--apply] [--role R=SPEC] [--json] [--sensitive auto|yes|no]
                       (posture packs: balanced|quality|frugal|local|skip; preview unless --apply)
  node scripts/xllm-advisor.js --discipline remove [--target <path>] (uninstall an old block)
  --json                 one execution-result envelope on stdout; diagnostics on stderr
  --schema-file <path>    native JSON schema where supported; callers validate fallback output

Safety (defaults):
  codex/claude enforce read-only; ollama/lmstudio use completion-only HTTP.
  Other adapters fail closed unless --allow-write explicitly opts into unrestricted operation.
  Codex/Claude advisors never bypass isolation; use xllm exec for verified sandboxed changes.
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


/** Locate an existing block (any version). Throws on an unterminated block. */
function findDisciplineSpan(content) {
  const s = String(content ?? '');
  const begin = s.match(/<!--\s*xllm:discipline\b[^>]*-->/);
  if (!begin) return null;
  const end = s.slice(begin.index).match(/<!--\s*\/xllm:discipline\s*-->/);
  if (!end) {
    throw new Error(
      'unterminated xllm:discipline block (begin marker without end marker) — fix the file manually'
    );
  }
  return { start: begin.index, end: begin.index + end.index + end[0].length };
}


/** Remove the block; collapses the seam to a single blank line. Pure. */
export function removeDisciplineBlock(content) {
  const s = String(content ?? '');
  const span = findDisciplineSpan(s);
  if (!span) return { content: s, removed: false };
  const before = s.slice(0, span.start).replace(/\n+$/, '');
  const after = s.slice(span.end).replace(/^\n+/, '');
  const joined = [before, after].filter(Boolean).join('\n\n');
  return { content: joined ? `${joined}\n` : '', removed: true };
}

/** Explicit --target wins; else prefer an existing CLAUDE.md, then AGENTS.md. */
export function resolveDisciplineTarget(projectRoot, explicitTarget = null) {
  if (explicitTarget) return path.resolve(projectRoot, explicitTarget);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(projectRoot, 'AGENTS.md');
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

import {
  classifyFailure,
  stalePinHint,
  MODEL_LIST_COMMANDS,
} from './xllm-failures.js';

// Re-exported: xllm-contracts.js and the tests import these from here.
export { classifyFailure, stalePinHint, MODEL_LIST_COMMANDS };

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
        if (cached.inventory_version === 2) return { ...cached, cached: true, path: file };
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
      advisor_eligible: ['codex', 'claude', 'ollama', 'lmstudio'].includes(p),
    };
    if (p === 'lmstudio') {
      entry.installed = binaryOnPath('curl') || binaryOnPath('curl.exe');
      entry.healthy = checkServerHealth('lmstudio');
      if (!entry.healthy) entry.notes.push(`server not responding at ${LMSTUDIO_BASE}`);
      if (entry.healthy) {
        entry.model_details = getLocalModelDetails(p, env);
        entry.models = Object.keys(entry.model_details);
      }
    } else if (p === 'lemonade') {
      entry.installed = !!env.LEMONADE_BIN && binaryOnPath(env.LEMONADE_BIN);
      entry.healthy = entry.installed;
      if (!env.LEMONADE_BIN) entry.notes.push('LEMONADE_BIN not set — unavailable');
    } else {
      entry.installed = binaryOnPath(PROVIDER_BINARIES[p]);
      if (LOCAL_PROVIDERS.includes(p)) {
        entry.healthy = entry.installed && checkServerHealth(p);
        if (p === 'ollama' && entry.healthy) {
          entry.model_details = getLocalModelDetails(p, env);
          entry.models = Object.keys(entry.model_details);
        }
      } else {
        entry.healthy = entry.installed;
        if (entry.installed) entry.notes.push('binary found; auth unverified (smoke --live)');
      }
    }
    if (!entry.advisor_eligible) entry.notes.push('Read-only enforcement unverified; excluded from automatic advising.');
    providers[p] = entry;
  }

  const inv = {
    inventory_version: 2,
    advisor_version: VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    host_cli: detectHostCli(env),
    execution_policy: profiles.defaults.execution_policy,
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

/**
 * Cheap availability probe for routing: binary present (plus server health
 * for local providers). Does NOT verify cloud auth — see doctor/smoke --live.
 */
/** Safe margin under Windows' 32,767-char CreateProcess command-line cap. */
export const WIN_ARGV_SAFE_CHARS = 30000;

/**
 * Whether a prompt of this composed argv length can be delivered via
 * command-line arguments on this platform. Pure; only Windows has the cap.
 */
export function promptTooLongForArgv(argvChars, platform = process.platform) {
  return platform === 'win32' && argvChars > WIN_ARGV_SAFE_CHARS;
}

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
    if (!binaryOnPath(PROVIDER_BINARIES[p])) continue;
    if (p === 'ollama' && !checkServerHealth('ollama')) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

const ADVISOR_BASENAME = 'xllm-advisor.js';

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
      if (/xllm|xllm|oh-my-grok|ohmygrok/i.test(name) || manifest) {
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
    process.env.XLLM_ADVISOR_PATH
  );
  if (fromEnvFile) return fromEnvFile;

  for (const key of [
    'GROK_PLUGIN_ROOT',
    'XLLM_PLUGIN_ROOT',
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
  provider, model = null, effort = null, prompt, originalTask = null,
  dryRun = false, multi = false, allowWrite = false, allowSelf = false,
  noArtifacts = false, propose = false, quiet = false, modelAliased = null,
  schema = null, execution = null, env: baseEnv = process.env,
  profiles: suppliedProfiles = null, modelInfo: suppliedModelInfo = null,
  spawnFn = spawnSync, isBinaryAvailable = binaryOnPath,
}) {
  const profiles = suppliedProfiles || loadProviderProfiles();
  const requestedProvider = provider;
  const requestedModel = modelAliased?.from || model;
  const meta = {};
  const pref = execution ? { provider, substituted: false } : resolvePreferredProvider(provider, profiles);
  if (pref.substituted) {
    console.error(`[xllm] ${pref.reason} → using ${pref.provider} instead of ${pref.from}`);
    Object.assign(meta, { substituted: true, from: pref.from });
    provider = pref.provider;
  }
  const alias = resolveModelAlias(provider, model, profiles);
  if (alias.aliased) model = alias.model;
  const correction = modelAliased || alias.aliased;
  if (correction) {
    console.error(`[xllm] ${provider}: '${correction.from}' → '${correction.to}' (${correction.source || 'builtin'})`);
    meta.modelAliased = correction;
  }
  const env = buildAdvisorEnv(provider, { ...baseEnv, ...(execution?.env || {}) });
  const allowMutation = !execution && mutationAllowed(env, { allowWrite });
  const pconf = profiles.providers[provider] || {};
  const resolvedEffort = effort || pconf.default_effort || null;
  const resolvedModel = model || pconf.default_model
    || (provider === 'ollama' ? env.OLLAMA_DEFAULT_MODEL : null)
    || (provider === 'lmstudio' ? env.LMSTUDIO_MODEL : null) || null;
  let modelInfo = suppliedModelInfo;
  let policy = executionPolicyDecision(provider, resolvedModel, { profiles, env, modelInfo });
  const attribution = {
    requested_provider: requestedProvider, requested_model: requestedModel,
    executed_provider: provider, transmitted_model: resolvedModel,
    substituted_from: pref.substituted ? pref.from : null,
    model_correction_source: correction?.source || (correction ? 'builtin' : null),
    requested_effort: resolvedEffort, effective_effort: null, cli_version: null,
    surface: ['ollama', 'lmstudio'].includes(provider) ? 'http-completion' : 'cli-agentic',
    execution_location: policy.location,
  };
  const fail = (kind, hint) => {
    console.error(`[${provider}] ${hint}`);
    return makeResult({ attribution, failure: { kind, retryable: false, hint } });
  };
  // A positively remote endpoint/model is refused before any network request.
  if (!policy.allowed && policy.location === 'remote') return fail('policy-denied', policy.reason);
  if (!modelInfo && ['ollama', 'lmstudio'].includes(provider) && spawnFn === spawnSync) {
    const details = getLocalModelDetails(provider, env);
    modelInfo = details[resolvedModel] || null;
  }
  policy = executionPolicyDecision(provider, resolvedModel, { profiles, env, modelInfo });
  attribution.execution_location = policy.location;
  if (!policy.allowed) return fail('policy-denied', policy.reason);
  if (execution && provider !== 'codex') return fail('permanent', 'exec requires the verified Codex OS sandbox');
  const original = originalTask || env.XLLM_ASK_ORIGINAL_TASK || env.OMC_ASK_ORIGINAL_TASK || prompt;
  const promptToSend = propose ? buildProposalPrompt(prompt) : prompt;
  let tempDir = null;
  try {
    let schemaPath = null;
    if (schema) {
      if (typeof schema !== 'object' || Array.isArray(schema)) return fail('permanent', 'schema must be a JSON object');
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-schema-'));
      schemaPath = path.join(tempDir, 'response.json');
      fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    }
    const cfg = resolveSpawnConfig(provider, resolvedModel, promptToSend, env, {
      profiles, effort: resolvedEffort, allowMutation, execution, schema, schemaPath, modelInfo,
      timeoutMs: execution?.timeoutMs,
    });
    attribution.transmitted_model = cfg.model;
    attribution.effective_effort = cfg.effectiveEffort;
    if (dryRun) {
      const preview = {
        provider, model: cfg.model, effort: cfg.effort, effective_effort: cfg.effectiveEffort,
        binary: cfg.binary, args: cfg.args.map((a) => String(a).length > 200 ? `${String(a).slice(0, 200)}…` : a),
        usesStdin: cfg.usesStdin, timeoutMs: cfg.timeoutMs, mutation: !!execution || allowMutation,
        safety: cfg.safety, execution_location: policy.location, native_schema: cfg.nativeSchema,
        unavailable: cfg.unavailable || false, substituted: !!pref.substituted, modelAliased: correction || null,
      };
      if (!quiet) console.log(JSON.stringify(preview, null, 2));
      return makeResult({ exitCode: cfg.unavailable ? 1 : 0, attribution, dryRun: true, preview,
        failure: cfg.unavailable ? { kind: 'safety-unverified', retryable: false, hint: cfg.unavailable } : null });
    }
    if (cfg.unavailable) return fail('safety-unverified', cfg.unavailable);
    const host = detectHostCli(baseEnv);
    if (host === provider && !allowSelf && env.XLLM_ALLOW_SELF !== '1') {
      return fail('permanent', `Refusing same-provider advising: host CLI is '${host}'. Pass --allow-self to override.`);
    }
    if (!cfg.binary || !isBinaryAvailable(cfg.binary)) return fail('missing-binary', `Install ${cfg.binary || provider} and ensure it is on PATH.`);
    const target = resolveSpawnTarget(cfg.binary);
    if (target.viaCmd) return fail('permanent', 'Unsafe cmd shim quoting is unsupported; install a directly executable CLI or Node shim.');
    let args = [...(target.argsPrefix || []), ...cfg.args];
    if (!cfg.usesStdin && promptTooLongForArgv([target.command, ...args].join(' ').length)) {
      if (provider === 'grok') {
        if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-prompt-'));
        const promptPath = path.join(tempDir, 'prompt.txt');
        fs.writeFileSync(promptPath, promptToSend, { mode: 0o600 });
        const at = args.lastIndexOf('-p');
        args.splice(at, 2, '--prompt-file', promptPath);
      } else return fail('prompt-too-long', 'Prompt exceeds Windows argv capacity; use codex, claude or local HTTP stdin delivery.');
    }
    // Version probes contain no model generation. Test transports do not probe the host.
    if (spawnFn === spawnSync) {
      const versionTarget = ['ollama', 'lmstudio'].includes(provider) ? resolveSpawnTarget('ollama') : target;
      if (provider !== 'lmstudio') {
        const v = spawnSync(versionTarget.command, [...(versionTarget.argsPrefix || []), '--version'], {
          env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384,
        });
        if (v.status === 0) attribution.cli_version = (v.stdout || v.stderr || '').trim().split(/\r?\n/)[0].slice(0, 120) || null;
      }
    }
    const runOpts = {
      encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, env, shell: false,
      timeout: cfg.timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
      ...(execution?.cwd ? { cwd: execution.cwd } : {}),
      ...(cfg.usesStdin ? { input: cfg.stdinPayload ?? promptToSend } : {}),
    };
    const started = Date.now();
    let run = withRetry(() => spawnFn(target.command, args, runOpts));
    let attempts = run.attempts;
    let decoded = parseProviderOutput(provider, run.stdout);
    if (provider === 'ollama' && decoded.error && /think/i.test(decoded.error) && cfg.stdinPayload?.includes('"think"')) {
      const body = JSON.parse(cfg.stdinPayload);
      delete body.think;
      attribution.effective_effort = null;
      console.error(`[ollama] ${cfg.model}: think rejected; one retry without it (effort unconfirmed)`);
      run = withRetry(() => spawnFn(target.command, args, { ...runOpts, input: JSON.stringify(body) }));
      attempts += run.attempts;
      decoded = parseProviderOutput(provider, run.stdout);
    }
    const durationMs = Date.now() - started;
    let code = typeof run.status === 'number' ? run.status : 1;
    if (run.error || run.signal || decoded.error || !decoded.raw.trim()) code = code || 1;
    const reported = decoded.reported_model;
    attribution.reported_model = reported;
    attribution.model_revision = provider === 'ollama' && reported === cfg.model ? modelInfo?.digest || null : null;
    attribution.identity_status = !reported ? 'unresolved'
      : isMutableModel(reported) && !attribution.model_revision ? 'mutable' : 'resolved';
    const failure = code === 0 ? null : classifyFailure({
      ...run, status: code, stdout: decoded.error || decoded.raw, stderr: run.stderr || '',
    });
    if (failure) {
      failure.message = redactSecrets([decoded.error, run.error?.message, run.stderr?.trim()].filter(Boolean).join('\n') || 'Provider returned no final response').slice(-4000);
      console.error(`[${provider}] ${failure.kind}: ${failure.message}\n${failure.hint || ''}`);
      if (['unknown-model', 'account-unsupported'].includes(failure.kind)) {
        const hint = stalePinHint(provider, cfg.model, profiles);
        if (hint) console.error(`[${provider}] ${hint}`);
        if (MODEL_LIST_COMMANDS[provider]) console.error(`[${provider}] model list: ${MODEL_LIST_COMMANDS[provider]}`);
      }
    }
    if (schema && cfg.nativeSchema && decoded.structured == null && code === 0) {
      try { decoded.structured = JSON.parse(decoded.raw); } catch { /* Caller validates fallback prose. */ }
    }
    const result = makeResult({
      raw: decoded.raw, exitCode: code, durationMs, attribution, failure,
      usage: decoded.usage, cost_estimate: attempts === 1 ? decoded.cost_estimate : null,
      structured: decoded.structured, attempts, safety: cfg.safety, native_schema: cfg.nativeSchema,
    });
    if (!noArtifacts && env.XLLM_NO_ARTIFACTS !== '1') {
      result.artifactPath = writeArtifact({
        provider, model: reported, effort: attribution.effective_effort,
        original, finalPrompt: promptToSend, raw: result.raw, exitCode: code, durationMs,
        meta: { multi, propose, ...meta, attribution, failure, usage: result.usage, cost_estimate: result.cost_estimate },
        kind: propose ? 'proposals' : 'ask',
      });
      if (propose && code === 0) {
        const patch = extractProposalPatch(result.raw);
        if (patch) {
          result.patchPath = result.artifactPath.replace(/\.md$/, '.patch');
          fs.writeFileSync(result.patchPath, redactSecrets(patch), 'utf8');
          console.error(`[${provider}] patch: ${result.patchPath}`);
        }
      }
    }
    if (spawnFn === spawnSync) recordProviderResult(result, { env: baseEnv });
    if (!quiet) console.log(result.artifactPath || result.raw || '(no output)');
    return result;
  } catch (error) {
    return fail('permanent', error.message || String(error));
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
      execution_policy: profiles.defaults.execution_policy,
      mutation_opt_in: '--allow-write explicitly opts into unrestricted adapters; exec never bypasses its sandbox',
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
      advisor_eligible: ['codex', 'claude', 'ollama', 'lmstudio'].includes(p),
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
    report.providers[p].binaryOk && report.providers[p].healthOk === true && report.providers[p].advisor_eligible;

  const readyCloud = CLOUD_PROVIDERS.filter(isReady);
  const readyLocal = LOCAL_PROVIDERS.filter(isReady);
  report.readyCloud = readyCloud;
  report.readyLocal = readyLocal;

  if (readyCloud.length === 0 && readyLocal.length === 0) {
    report.recommendations.push(
      'No verified advisors ready. Install codex/claude or start a local HTTP model server.'
    );
  } else {
    report.recommendations.push('Start with the host; use `pick` before requesting an independent advisor.');
  }
  report.recommendations.push('READY proves binary/server availability only; auth, model support and execution policy are separate.');
  report.recommendations.push(
    'Spec syntax: provider[:model][@effort]  e.g. codex@high  antigravity:model  ollama:qwen3.6:latest'
  );

  report.artifactsReady = fs.existsSync(path.join(resolveStateDir(), 'artifacts'));
  report.advisorPath = resolveAdvisorScriptPath();

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
    apply: false,
    json: false,
  };
  let olderThan = null;
  let promptFilePath = null;
  let expectPromptFile = false;
  let schemaFilePath = null;
  let expectSchemaFile = false;
  const args = [];
  for (const a of argv.slice(2)) {
    if (expectSchemaFile) {
      schemaFilePath = a;
      expectSchemaFile = false;
    } else if (a === '--schema-file') {
      expectSchemaFile = true;
    } else if (expectPromptFile) {
      promptFilePath = a;
      expectPromptFile = false;
    } else if (a === '--prompt-file') {
      expectPromptFile = true;
    } else if (a === '--allow-write') {
      flags.allowWrite = true;
    } else if (a === '--allow-self') {
      flags.allowSelf = true;
    } else if (a === '--no-artifacts') {
      flags.noArtifacts = true;
    } else if (a === '--propose') {
      flags.propose = true;
    } else if (a === '--refresh') {
      flags.refresh = true;
    } else if (a === '--apply') {
      flags.apply = true;
    } else if (a === '--json') {
      flags.json = true;
    } else if (/^--older-than=\d+$/.test(a)) {
      olderThan = Number(a.split('=')[1]);
    } else {
      args.push(a);
    }
  }
  // --prompt-file <path>: read the prompt from a file. This is the escape
  // hatch for Windows' ~32K CreateProcess command-line limit on the
  // caller→advisor hop; the file content wins over any positional prompt.
  let filePrompt = null;
  if (expectPromptFile) throw new Error('--prompt-file requires a path');
  if (expectSchemaFile) throw new Error('--schema-file requires a path');
  if (schemaFilePath) {
    flags.schema = JSON.parse(fs.readFileSync(schemaFilePath, 'utf8'));
    flags.schemaPath = path.resolve(schemaFilePath);
    if (!flags.schema || typeof flags.schema !== 'object' || Array.isArray(flags.schema)) throw new Error('schema must be a JSON object');
  }
  if (promptFilePath) {
    try {
      filePrompt = fs.readFileSync(promptFilePath, 'utf8').trim();
    } catch {
      throw new Error(`--prompt-file: cannot read ${promptFilePath}`);
    }
    if (!filePrompt) {
      throw new Error(`--prompt-file: ${promptFilePath} is empty`);
    }
  }

  if (args.length === 0) throw new Error('A provider spec and prompt are required; use --help.');

  if (args[0] === '--list-providers') return { mode: 'list', flags };
  if (args[0] === '--doctor') return { mode: 'doctor', flags };
  if (args[0] === '--which') return { mode: 'which', flags };
  if (args[0] === '--remember') return { mode: 'remember', flags };
  if (args[0] === '--inventory') return { mode: 'inventory', flags };
  if (args[0] === '--profile-show') return { mode: 'profile-show', flags };
  if (args[0] === '--set-role') {
    if (args.length < 3) {
      throw new Error('Usage: --set-role <role> <provider[:model][@effort]>');
    }
    return { mode: 'set-role', role: args[1], spec: args[2], flags };
  }
  if (args[0] === '--set-default') {
    if (args.length < 3) {
      throw new Error('Usage: --set-default <key> <value>');
    }
    return { mode: 'set-default', key: args[1], value: args[2], flags };
  }
  if (args[0] === '--clean-artifacts') {
    return { mode: 'clean-artifacts', flags, olderThan };
  }
  if (args[0] === '--discipline') {
    const action = args[1];
    if (action !== 'remove') {
      throw new Error('Discipline installation was removed; only --discipline remove is supported.');
    }
    const ti = args.indexOf('--target');
    if (ti !== -1 && !args[ti + 1]) {
      throw new Error('--target requires a path');
    }
    return { mode: 'discipline', action, target: ti !== -1 ? args[ti + 1] : null, flags };
  }
  if (args[0] === '--help' || args[0] === '-h') return { mode: 'help', flags };

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

  if (args[0] === '--dry-run') {
    const spec = parseProviderSpec(args[1]);
    const prompt = filePrompt ?? args.slice(2).join(' ').trim();
    if (!spec || !prompt) throw new Error('dry-run requires a valid provider and prompt');
    return { mode: 'dry-run', ...spec, prompt, flags };
  }
  if (args[0] === '--multi') {
    const dr = parseDiffFlags(args.slice(2));
    if (dr.error) {
      throw new Error(`[multi] ${dr.error}`);
    }
    const list = (args[1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const prompt = filePrompt ?? dr.rest.join(' ').trim();
    if (list.length < 2 || !prompt) {
      throw new Error('--multi requires at least two providers and a prompt');
    }
    const providers = list.map((s) => {
      const p = parseProviderSpec(s);
      if (!p) {
        throw new Error(`Unknown provider: ${s}`);
      }
      return { ...p, rawSpec: s };
    });
    return { mode: 'multi', providers, prompt, diffOpts: dr.diffOpts, flags };
  }

  const spec = parseProviderSpec(args[0]);
  const prompt = filePrompt ?? args.slice(1).join(' ').trim();
  if (!spec || !prompt) throw new Error('A valid provider spec and non-empty prompt are required');
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
  if (parsed.mode === 'discipline') {
    const target = resolveDisciplineTarget(process.cwd(), parsed.target);
    let existing = '';
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      /* new file */
    }
    try {
      const res = removeDisciplineBlock(existing);
      if (!res.removed) {
        console.error(`no discipline block in ${target}`);
        process.exit(2);
      }
      fs.writeFileSync(target, res.content);
      console.error(`discipline block removed: ${target}`);
      console.log(target);
      process.exit(0);
    } catch (e) {
      console.error(String(e?.message || e));
      process.exit(1);
    }
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
    if (parsed.key === 'execution_policy' && !['any', 'local-only'].includes(parsed.value)) {
      throw new Error('execution_policy must be any or local-only');
    }
    const file = setProfileValue('defaults', parsed.key, parsed.value);
    console.log(`${file}: defaults.${parsed.key} = "${parsed.value}"`);
    process.exit(0);
  }

  if (parsed.mode === 'setup') {
    try {
      const { resolveSetupPlan } = await import('./xllm-routing.js');
      const inv = buildInventory({});
      const sensitive = parsed.sensitive === 'auto' ? 'no' : parsed.sensitive; // bare CLI has no host skim
      const plan = resolveSetupPlan(inv, {
        pack: parsed.pack, host: inv.host_cli, overrides: parsed.overrides, sensitive,
        executionPolicy: loadProviderProfiles().defaults.execution_policy,
      });
      let applied = { written: [], deleted: [], errors: [] };
      if (parsed.flags.apply) {
        applied = applySetupPlan(plan, { inventory: inv, apply: true, sensitive });
      }
      if (parsed.flags.json) {
        console.log(JSON.stringify({ ...plan, applied, apply: !!parsed.flags.apply }, null, 2));
      } else {
        console.log(formatSetupPlanHuman(plan, { apply: !!parsed.flags.apply, applied }));
      }
      process.exit(plan.ok === false ? 2 : 0);
    } catch (e) {
      console.error(String(e?.message || e));
      process.exit(1);
    }
  }

  if (parsed.mode === 'dry-run') {
    const result = runAdvisor({
      provider: parsed.provider,
      model: parsed.model,
      effort: parsed.effort,
      prompt: parsed.prompt,
      dryRun: true,
      allowWrite: parsed.flags.allowWrite,
      propose: parsed.flags.propose,
      modelAliased: parsed.modelAliased,
      schema: parsed.flags.schema || null,
      quiet: parsed.flags.json,
    });
    if (parsed.flags.json) console.log(JSON.stringify(result));
    process.exit(result.exitCode);
  }

  if (parsed.mode === 'multi') {
    // Each provider runs as its own child process, concurrently.
    const self = fileURLToPath(import.meta.url);
    const childFlags = ['--json'];
    if (parsed.flags.schemaPath) childFlags.push('--schema-file', parsed.flags.schemaPath);
    if (parsed.flags.allowWrite) childFlags.push('--allow-write');
    if (parsed.flags.allowSelf) childFlags.push('--allow-self');
    if (parsed.flags.noArtifacts) childFlags.push('--no-artifacts');
    if (parsed.flags.propose) childFlags.push('--propose');

    let diffContext = null;
    let fullPrompt = parsed.prompt;
    if (hasDiffSource(parsed.diffOpts)) {
      const diff = collectReviewDiff(parsed.diffOpts);
      if (diff.error) {
        throw new Error(`[multi] ${diff.error}`);
      }
      fullPrompt = `${parsed.prompt}\n${buildReviewContext(diff)}`;
      diffContext = diffMeta(diff);
      console.error(`[multi] code context: ${diffContext.source} (${diffContext.bytes} bytes${diffContext.truncated ? ', truncated' : ''})`);
    }
    // Windows argv cap: a diff-laden prompt goes to children via a temp
    // --prompt-file instead of argv (shared threshold with the structured layer).
    let tmpPromptFile = null;
    let childPromptArgs = [fullPrompt];
    if (fullPrompt.length > PROMPT_FILE_THRESHOLD) {
      try {
        tmpPromptFile = path.join(
          os.tmpdir(),
          `xllm-multi-prompt-${process.pid}-${Date.now().toString(36)}.txt`
        );
        fs.writeFileSync(tmpPromptFile, fullPrompt, 'utf8');
        childPromptArgs = ['--prompt-file', tmpPromptFile];
      } catch (error) {
        throw new Error(`Cannot safely deliver multi prompt: ${error.message}`);
      }
    }

    // The string the user typed, for the audit line in the index.
    const s0 = (p) => p.rawSpec || p.spec;
    const runOne = (p) =>
      new Promise((resolve) => {
        console.error(`[multi] running ${p.spec}...`);
        const child = spawn(process.execPath,
          [self, ...childFlags, p.rawSpec || p.spec, ...childPromptArgs],
          { env: process.env, windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        const failedResult = (hint) => makeResult({ failure: { kind: 'permanent', retryable: false, hint } });
        child.on('error', (e) => resolve({ p, result: failedResult(e.message) }));
        child.on('close', (code) => {
          try {
            const result = JSON.parse(out.trim());
            if (result.schema_version !== 2 || typeof result.raw !== 'string') throw new Error('Invalid advisor result envelope');
            if (code !== 0 && result.exitCode === 0) result.exitCode = code || 1;
            resolve({ p, result });
          } catch (e) { resolve({ p, result: failedResult(e.message) }); }
        });
      });

    const raw = await Promise.all(parsed.providers.map(runOne));
    if (tmpPromptFile) {
      try {
        fs.unlinkSync(tmpPromptFile);
      } catch {
        /* best-effort */
      }
    }
    const results = raw.map(({ p, result }) => {
      const a = result.attribution;
      const executedSpec = a?.executed_provider
        ? `${a.executed_provider}${a.reported_model || a.transmitted_model ? ':' + (a.reported_model || a.transmitted_model) : ''}${a.effective_effort ? '@' + a.effective_effort : ''}`
        : null;
      return { spec: p.spec, executedSpec, requestedSpec: s0(p), code: result.exitCode,
        artifact: result.artifactPath, patch: result.patchPath, out: result.raw, result };
    });
    const failed = results.filter((r) => r.code !== 0).length;

    if (parsed.flags.noArtifacts || process.env.XLLM_NO_ARTIFACTS === '1') {
      if (parsed.flags.json) {
        console.log(JSON.stringify({ schema_version: 2, measurement: false, diff_context: diffContext, results }));
        process.exit(failed === results.length ? 1 : 0);
      }
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
      diffContext,
    });
    console.log(parsed.flags.json ? JSON.stringify({ schema_version: 2, measurement: false, ...index, diff_context: diffContext, results }) : index.mdPath);
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
    modelAliased: parsed.modelAliased,
    schema: parsed.flags.schema || null,
    quiet: parsed.flags.json,
  });
  if (parsed.flags.json) console.log(JSON.stringify(result));
  process.exit(result.exitCode === 0 ? 0 : result.exitCode || 1);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-advisor.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err.message || String(err));
    if (process.argv.includes('--json')) console.log(JSON.stringify(makeResult({
      failure: { kind: 'permanent', retryable: false, hint: err.message || String(err) },
    })));
    process.exit(1);
  });
}
