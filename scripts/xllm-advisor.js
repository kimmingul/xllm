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

// Re-exported so the 8 modules that import these from here keep working.
export { PROVIDER_BINARIES, CLOUD_PROVIDERS, LOCAL_PROVIDERS, KNOWN_EFFORTS };

const VERSION = '0.35.2';
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

/** Parse /api/generate output: { response } on success, { error } from the server. */
export function parseOllamaHttpResponse(stdout) {
  try {
    const v = JSON.parse(String(stdout || '').trim());
    if (v && typeof v.error === 'string') return { error: v.error, response: null };
    if (v && typeof v.response === 'string') return { error: null, response: v.response };
  } catch {
    /* not JSON */
  }
  return { error: null, response: null };
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
  if (options.sensitive === 'yes') {
    const prov = inventory.providers?.[parsed.provider];
    const isLocal = prov && prov.kind === 'local';
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
  for (const role of SETUP_ROLE_KEYS) {
    const spec = plan.roles[role];
    if (spec == null) continue; // OPEN
    const v = validateSetupPin(spec, role, inventory, { sensitive });
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
  // Precedence: explicit call arg > XLLM_ADVISOR_TIMEOUT_MS > per-provider
  // profile > global default. The env var has to outrank pconf, otherwise the
  // built-in per-provider timeout_ms makes it unreachable (measured: with
  // XLLM_ADVISOR_TIMEOUT_MS=900000 a codex dry-run still reported 300000).
  const envTimeoutMs = Number(env.XLLM_ADVISOR_TIMEOUT_MS || 0) || null;
  const timeoutMs =
    options.timeoutMs ||
    envTimeoutMs ||
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
      // This case assembles argv directly (it does not route through
      // withModelEffort), so the --effort flag has to be pushed here too.
      const args = allowMutation ? ['--dangerously-skip-permissions'] : [];
      if (resolvedModel) args.push('--model', resolvedModel);
      const agyEffort = agyEffortFromEffort(effort);
      if (agyEffort) args.push('--effort', agyEffort);
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
      // HTTP API instead of `ollama run`: the CLI renders TTY-style (spinner,
      // wrap-redraw) even through a pipe — the source of the fragment
      // duplication that corrupted long JSON blocks — and argv delivery hits
      // Windows' ~32KB limit. The API returns clean JSON; the payload rides
      // stdin (`-d @-`), so prompt size is unbounded on every platform.
      const ollamaModel = resolvedModel || 'llama3.2';
      const curlBin = IS_WINDOWS ? 'curl.exe' : 'curl';
      const think = ollamaThinkFromEffort(effort, ollamaModel);
      return {
        binary: curlBin,
        args: [
          '-s',
          '--max-time',
          String(Math.floor(timeoutMs / 1000)),
          `${ollamaBaseUrl(env)}/api/generate`,
          '-H',
          'Content-Type: application/json',
          '-d',
          '@-',
        ],
        usesStdin: true,
        stdinPayload: JSON.stringify({
          model: ollamaModel,
          prompt,
          stream: false,
          ...(think !== undefined ? { think } : {}),
        }),
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
  node scripts/xllm-advisor.js --discipline show|install|remove [--target <path>]
                       (≤25-line process-discipline block for CLAUDE.md/AGENTS.md;
                        idempotent marker block, explicit opt-in — preview with show)

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
// Process-discipline block (setup-distillation — docs/superpowers-absorption-design.md)
// ---------------------------------------------------------------------------

const DISCIPLINE_VERSION = 'v2';
const DISCIPLINE_BEGIN = `<!-- xllm:discipline ${DISCIPLINE_VERSION} -->`;
const DISCIPLINE_END = '<!-- /xllm:discipline -->';
/** Hard cap, enforced in code: this block must never grow into an agent-OS. */
export const DISCIPLINE_MAX_LINES = 25;

const DISCIPLINE_BODY = [
  '## 작업 규율 (xllm setup 설치본 — `xllm discipline remove`로 제거)',
  '',
  '- 모호한 요구는 코드 전에 설계 문답으로 좁힌다; 로직 변경은 red→green(실패 테스트 먼저).',
  '- 실행 증거 없이 "done"이라 주장하지 않는다 — 테스트/빌드 출력을 확인하고 인용한다.',
  '- 버그는 고치기 전에 근본 원인부터 찾는다(증상 패치 금지).',
  '- 병렬 작업·플랜·워크트리는 호스트 네이티브 기능을 쓴다; xllm은 오케스트레이션하지 않는다.',
  '- 틀리면 비싼 결정만 크로스-벤더 심의로: `xllm review blind`(측정) · `review debate`(반박) · `review council`(둘 다).',
  '  review stats의 쌍별 일치율이 낮은 곳이 다양성이 배당을 내는 곳이다.',
  '- 리뷰 코멘트가 미심쩍으면 수용 전에 다른 벤더로 반박 검증(`xllm ask`/`review debate`).',
  '- 커밋/PR/릴리스 산문은 `xllm scribe`(최저가 모델); git 실행은 항상 사람이 한다.',
].join('\n');

export function disciplineBlock() {
  return `${DISCIPLINE_BEGIN}\n${DISCIPLINE_BODY}\n${DISCIPLINE_END}`;
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

/** Idempotent install: replace an existing block in place, else append. Pure. */
export function spliceDisciplineBlock(content, block = disciplineBlock()) {
  const lines = block.split('\n');
  if (lines.length > DISCIPLINE_MAX_LINES) {
    throw new Error(
      `discipline block is ${lines.length} lines; the cap is ${DISCIPLINE_MAX_LINES} — trim it, do not raise the cap`
    );
  }
  const s = String(content ?? '');
  const span = findDisciplineSpan(s);
  if (span) return s.slice(0, span.start) + block + s.slice(span.end);
  if (!s.trim()) return `${block}\n`;
  return `${s.replace(/\n+$/, '')}\n\n${block}\n`;
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

function ensureBinary(binary, { isLocal = false, optional = false, isAvailable = binaryOnPath } = {}) {
  if (isAvailable(binary)) return true;
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
  // Callers that went through parseProviderSpec have already had the name
  // corrected, so runAdvisor's own alias lookup sees nothing to do. Without
  // this hand-off the correction would be invisible on every real path.
  modelAliased = null,
  // Test seam. Everything above this line is decided before any process is
  // started, but until now the spawn itself was hard-wired to spawnSync, so the
  // whole orchestration layer — substitution notices, alias hand-off, timeout
  // precedence — could only be checked by making real LLM calls. That is why
  // three separate defects in it shipped silently. Injecting the spawn keeps CI
  // free of live calls (a project rule) while covering this code.
  spawnFn = spawnSync,
  // Paired with spawnFn: a stubbed spawn is useless if the PATH probe in front
  // of it calls process.exit(1) on a machine without the CLI installed, which
  // is exactly what CI is. Injecting the probe keeps the orchestration tests
  // honest without pretending the binaries exist.
  isBinaryAvailable = binaryOnPath,
}) {
  const profiles = loadProviderProfiles();
  let meta = {};
  // Snapshot the request before provider substitution or model correction
  // rewrite these locals.
  const requestedProvider = provider;
  const requestedModel = model;

  // Prefer antigravity (agy); fall back only when its binary is missing
  const pref = resolvePreferredProvider(provider, profiles);
  if (pref.substituted) {
    console.error(
      `[xllm] ${pref.reason} → using ${pref.provider} instead of ${pref.from}`
    );
    meta = { substituted: true, from: pref.from };
    provider = pref.provider;
  }

  // A retired model name reaching here (direct call, or a default_model pinned
  // in xllm-providers.toml) is corrected and announced — silent substitution
  // would misattribute the evidence.
  const modelAlias = resolveModelAlias(provider, model, profiles);
  if (modelAlias.aliased) model = modelAlias.model;
  // Either the caller corrected it (spec path) or we just did (direct call /
  // TOML pin). Announce exactly once, and carry it into the evidence.
  const correction = modelAliased || modelAlias.aliased;
  if (correction) {
    const origin =
      correction.source === 'toml'
        ? ' (from [aliases] in xllm-providers.toml)'
        : '';
    console.error(
      `[xllm] ${provider} no longer accepts '${correction.from}' → using '${correction.to}'${origin}`
    );
    meta.modelAliased = correction;
  }

  const allowMutation = mutationAllowed(process.env, { allowWrite });
  const env = buildAdvisorEnv(provider);
  const original =
    originalTask ||
    process.env.XLLM_ASK_ORIGINAL_TASK ||
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
          modelAliased: meta.modelAliased || null,
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

  // Windows caps the whole CreateProcess command line at ~32K chars. For
  // providers that receive the prompt via argv (usesStdin:false) an oversize
  // prompt cannot be delivered at all — fail fast with a real message instead
  // of a cryptic spawn error. codex/claude (stdin delivery) are unaffected.
  if (!cfg.usesStdin && promptTooLongForArgv([cfg.binary, ...cfg.args].join(' ').length)) {
    const msg =
      `[${provider}] prompt too long for argv delivery on Windows (~32KB CreateProcess limit). ` +
      `Use a stdin-based provider (codex, claude) or shorten the prompt.`;
    console.error(msg);
    return { artifactPath: null, exitCode: 1, raw: msg, durationMs: 0, error: 'prompt-too-long' };
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
    ensureBinary(cfg.binary, { isLocal, isAvailable: isBinaryAvailable });
  } else {
    ensureBinary(cfg.binary, { isLocal: true, optional: true, isAvailable: isBinaryAvailable });
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
    ...(cfg.usesStdin ? { input: cfg.stdinPayload ?? promptToSend } : {}),
  };

  const started = Date.now();
  // Contract floor: bounded jittered retry, transient failures only.
  const result = withRetry(() => spawnFn(finalCommand, finalArgs, runOpts));
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
    // Model-name failures are the ones a user can actually fix in the next
    // command, so spend two extra lines on them: where the bad name came from,
    // and how to ask this CLI what it accepts.
    if (
      result.failure.kind === 'unknown-model' ||
      result.failure.kind === 'account-unsupported'
    ) {
      const pinHint = stalePinHint(provider, cfg.model, profiles);
      if (pinHint) console.error(`[${provider}] ${pinHint}`);
      const listCmd = MODEL_LIST_COMMANDS[provider];
      if (listCmd) console.error(`[${provider}] list what this CLI accepts: ${listCmd}`);
    }
  }

  if (provider === 'lmstudio' && stdout) {
    raw = parseLMStudioResponse(stdout);
  }
  if (provider === 'ollama') {
    let parsed = parseOllamaHttpResponse(stdout);
    // Effort is best-effort for local models: a model that rejects the
    // `think` parameter gets one retry without it instead of a hard failure.
    if (
      parsed.error &&
      /think/i.test(parsed.error) &&
      (cfg.stdinPayload || '').includes('"think"')
    ) {
      console.error(`[ollama] ${cfg.model}: server rejected "think" — retrying without (effort ignored)`);
      const fallback = JSON.parse(cfg.stdinPayload);
      delete fallback.think;
      const retry = withRetry(() =>
        spawnSync(finalCommand, finalArgs, { ...runOpts, input: JSON.stringify(fallback) })
      );
      stdout = retry.stdout || '';
      code = typeof retry.status === 'number' ? retry.status : 1;
      raw = [stdout, retry.stderr || ''].filter(Boolean).join('\n\n');
      parsed = parseOllamaHttpResponse(stdout);
    }
    if (parsed.error) {
      code = code || 1;
      raw = `[ollama] ${parsed.error}`;
    } else if (parsed.response != null) {
      raw = parsed.response;
    } else {
      // not JSON (connection refused text, proxy page, …) — keep raw output
      raw = cleanOllamaOutput(raw);
      if (code === 0) code = 1;
    }
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

  // Attribution: what was asked for vs what actually ran. The index and the
  // ledger must key off the executed values — the same agy run recorded once
  // as `gemini:X` and once as `antigravity:X` splits the sample and makes the
  // measured router decide on halves. `requested_*` is audit/UX only.
  const attribution = {
    requested_provider: requestedProvider,
    requested_model: modelAliased ? modelAliased.from : requestedModel,
    executed_provider: provider,
    transmitted_model: cfg.model || null,
    substituted_from: meta.substituted ? meta.from : null,
    model_correction_source: meta.modelAliased ? meta.modelAliased.source : null,
  };

  return { artifactPath, patchPath, exitCode: code, raw, durationMs, attribution };
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
  report.recommendations.push(
    'Design side prefers antigravity (agy) on every platform; the standalone gemini CLI is used only when agy is absent'
  );
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
    apply: false,
    json: false,
  };
  let olderThan = null;
  let promptFilePath = null;
  let expectPromptFile = false;
  const args = [];
  for (const a of argv.slice(2)) {
    if (expectPromptFile) {
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
  if (expectPromptFile) {
    console.error('--prompt-file requires a path');
    process.exit(1);
  }
  if (promptFilePath) {
    try {
      filePrompt = fs.readFileSync(promptFilePath, 'utf8').trim();
    } catch {
      console.error(`--prompt-file: cannot read ${promptFilePath}`);
      process.exit(1);
    }
    if (!filePrompt) {
      console.error(`--prompt-file: ${promptFilePath} is empty`);
      process.exit(1);
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
  if (args[0] === '--discipline') {
    const action = args[1];
    if (!['show', 'install', 'remove'].includes(action || '')) {
      console.error('Usage: --discipline show|install|remove [--target <path>]');
      process.exit(1);
    }
    const ti = args.indexOf('--target');
    if (ti !== -1 && !args[ti + 1]) {
      console.error('--target requires a path');
      process.exit(1);
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
    if (!spec || !prompt) usage();
    return { mode: 'dry-run', ...spec, prompt, flags };
  }
  if (args[0] === '--multi') {
    const dr = parseDiffFlags(args.slice(2));
    if (dr.error) {
      console.error(`[multi] ${dr.error}`);
      process.exit(1);
    }
    const list = (args[1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const prompt = filePrompt ?? dr.rest.join(' ').trim();
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
      // Children re-parse and re-correct on their own. Hand them the string the
      // user typed, not p.spec — p.spec already carries the corrected name, so
      // passing it down would hide the correction from the child's evidence.
      //
      // The parent still needs to know what will actually run, because the
      // index it writes is the entry point every reader (and every aggregation)
      // starts from. Resolving here is deterministic: the child runs the same
      // pure functions against the same PATH a moment later.
      const executedProvider = resolvePreferredProvider(p.provider).provider;
      const executedSpec =
        (p.model ? executedProvider + ':' + p.model : executedProvider) +
        (p.effort ? '@' + p.effort : '');
      return { ...p, rawSpec: s, executedProvider, executedSpec };
    });
    return { mode: 'multi', providers, prompt, diffOpts: dr.diffOpts, flags };
  }

  const spec = parseProviderSpec(args[0]);
  const prompt = filePrompt ?? args.slice(1).join(' ').trim();
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
  if (parsed.mode === 'discipline') {
    if (parsed.action === 'show') {
      console.log(disciplineBlock());
      process.exit(0);
    }
    const target = resolveDisciplineTarget(process.cwd(), parsed.target);
    let existing = '';
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      /* new file */
    }
    try {
      if (parsed.action === 'install') {
        const had = /<!--\s*xllm:discipline\b/.test(existing);
        fs.writeFileSync(target, spliceDisciplineBlock(existing));
        console.error(`discipline ${DISCIPLINE_VERSION} ${had ? 'updated' : 'installed'}: ${target}`);
        console.log(target);
        process.exit(0);
      }
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
      process.exit(0);
    } catch (e) {
      console.error(String(e?.message || e));
      process.exit(1);
    }
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
      modelAliased: parsed.modelAliased,
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

    let diffContext = null;
    let fullPrompt = parsed.prompt;
    if (hasDiffSource(parsed.diffOpts)) {
      const diff = collectReviewDiff(parsed.diffOpts);
      if (diff.error) {
        console.error(`[multi] ${diff.error}`);
        process.exit(1);
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
      } catch {
        tmpPromptFile = null; // best-effort: fall back to argv
      }
    }

    // The string the user typed, for the audit line in the index.
    const s0 = (p) => p.rawSpec || p.spec;
    const runOne = (p) =>
      new Promise((resolve) => {
        console.error(`[multi] running ${p.spec}...`);
        const child = spawn(
          process.execPath,
          [self, ...childFlags, p.rawSpec || p.spec, ...childPromptArgs],
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
          resolve({ spec: p.spec, executedSpec: p.executedSpec, requestedSpec: s0(p), code: 1, out: `[spawn error] ${e.message}`, err: '' })
        );
        child.on('close', (code) =>
          resolve({ spec: p.spec, executedSpec: p.executedSpec, requestedSpec: s0(p), code: code ?? 1, out: out.trim(), err: errBuf })
        );
      });

    const raw = await Promise.all(parsed.providers.map(runOne));
    if (tmpPromptFile) {
      try {
        fs.unlinkSync(tmpPromptFile);
      } catch {
        /* best-effort */
      }
    }
    const results = raw.map((r) => {
      const artifact = r.code === 0 && r.out ? r.out.split(/\r?\n/).pop() : null;
      const patchMatch = (r.err || '').match(/patch: (.+\.patch)/);
      return { spec: r.spec, executedSpec: r.executedSpec, requestedSpec: r.requestedSpec, code: r.code, artifact, patch: patchMatch ? patchMatch[1].trim() : null, out: r.out };
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
      diffContext,
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
    modelAliased: parsed.modelAliased,
  });
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
    console.error(err);
    process.exit(1);
  });
}
