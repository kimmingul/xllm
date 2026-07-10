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

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import process from 'process';

const VERSION = '0.1.1';
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

/** Built-in defaults; overridden by xllm-providers.toml */
const BUILTIN_PROFILES = {
  defaults: {
    analysis_provider: 'codex',
    design_provider: 'antigravity',
    design_fallback: 'gemini',
    timeout_ms: 300000,
  },
  providers: {
    codex: {
      default_model: '',
      default_effort: '',
      effort_via: 'config',
      effort_config_key: 'model_reasoning_effort',
      timeout_ms: 300000,
    },
    claude: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
    },
    grok: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
    },
    antigravity: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
    },
    gemini: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
    },
    cursor: {
      default_model: '',
      default_effort: '',
      timeout_ms: 300000,
    },
    ollama: {
      default_model: 'llama3.2',
      default_effort: '',
      timeout_ms: 300000,
    },
    lmstudio: {
      default_model: 'local-model',
      default_effort: '',
      temperature: 0.7,
      timeout_ms: 300000,
    },
    lemonade: {
      default_model: 'default',
      default_effort: '',
      timeout_ms: 300000,
    },
  },
};

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
  paths.push(path.join(process.cwd(), '.grok', 'xllm-providers.toml'));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) paths.push(path.join(home, '.grok', 'xllm-providers.toml'));
  // plugin checkout relative to this file
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    paths.push(path.join(here, '..', '.grok', 'xllm-providers.toml'));
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
        args: withModelEffort(
          ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
          'stdin-dash'
        ),
        usesStdin: true,
        timeoutMs,
        model: resolvedModel,
        effort,
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
        args: withModelEffort(
          ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
          'arg'
        ),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
    case 'gemini': {
      const args = [];
      if (resolvedModel) args.push('--model', resolvedModel);
      args.push('-p', prompt, '--yolo');
      return {
        binary: 'gemini',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
    }
    case 'antigravity': {
      const args = ['--dangerously-skip-permissions'];
      if (resolvedModel) args.push('--model', resolvedModel);
      args.push('-p', prompt);
      return {
        binary: 'agy',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
    }
    case 'grok': {
      const args = [];
      if (resolvedModel) args.push('-m', resolvedModel);
      if (effort) args.push('--reasoning-effort', effort);
      args.push('-p', prompt, '--always-approve');
      return {
        binary: 'grok',
        args,
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
    }
    case 'cursor':
      return {
        binary: 'cursor-agent',
        args: withModelEffort(
          ['--print', '--force', '--trust', '--sandbox', 'disabled', prompt],
          'arg'
        ),
        usesStdin: false,
        timeoutMs,
        model: resolvedModel,
        effort,
      };
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
      if (env.LEMONADE_BIN) {
        return {
          binary: env.LEMONADE_BIN,
          args: ['run', lemonadeModel, prompt],
          usesStdin: false,
          timeoutMs,
          model: lemonadeModel,
          effort,
        };
      }
      return {
        binary: process.execPath,
        args: [
          '-e',
          `console.log("LEMONADE[${lemonadeModel}] (set LEMONADE_BIN): " + ${JSON.stringify(prompt.slice(0, 200))})`,
        ],
        usesStdin: false,
        timeoutMs,
        model: lemonadeModel,
        effort,
        synthetic: true,
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
    .replace(/\x1b\[[0-9;]*m/g, '')
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
}) {
  const root = process.cwd();
  const dir = path.join(root, '.grok', 'artifacts', 'ask');
  fs.mkdirSync(dir, { recursive: true });

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

function usage(exitCode = 1) {
  console.error(`${PRODUCT} advisor v${VERSION}
Usage:
  node scripts/grok-ask-advisor.js <provider[:model][@effort]> "<prompt>"
  node scripts/grok-ask-advisor.js --list-providers
  node scripts/grok-ask-advisor.js --doctor
  node scripts/grok-ask-advisor.js --which | --remember
  node scripts/grok-ask-advisor.js --dry-run <spec> "<prompt>"
  node scripts/grok-ask-advisor.js --multi p1,p2[,p3] "<prompt>"

Providers: ${getSupportedProviders().join(', ')}
Spec: provider | provider:model | provider@effort | provider:model@effort
  e.g. codex@high  claude:opus@medium  ollama:qwen3.6:latest  antigravity:…
Profiles: .grok/xllm-providers.toml  (design_provider=antigravity preferred over gemini)
Env: XLLM_ADVISOR_PATH, XLLM_PLUGIN_ROOT, XLLM_PROVIDERS_PATH, XLLM_ADVISOR_TIMEOUT_MS
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

function buildEnv(provider) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.GROK_SESSION_ID;
  if (provider === 'codex') {
    delete env.RUST_LOG;
    delete env.RUST_BACKTRACE;
  }
  return env;
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
  ]) {
    const hit = advisorUnderRoot(process.env[key]);
    if (hit) return hit;
  }

  for (const markerName of MARKER_NAMES) {
    const marker = path.join(process.cwd(), '.grok', markerName);
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
  const dir = path.join(projectRoot, '.grok');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'xllm-advisor-path');
  fs.writeFileSync(marker, `${advisor}\n`, 'utf8');
  for (const sub of ['ask', 'xllm', 'ralph', 'team', 'verify']) {
    fs.mkdirSync(path.join(dir, 'artifacts', sub), { recursive: true });
  }
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

  const env = buildEnv(provider);
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

  const cfg = resolveSpawnConfig(provider, resolvedModel, prompt, env, {
    effort: resolvedEffort || null,
    profiles,
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
          synthetic: !!cfg.synthetic,
          substituted: meta.substituted || false,
        },
        null,
        2
      )
    );
    return { artifactPath: null, exitCode: 0, raw: '', durationMs: 0, dryRun: true };
  }

  if (provider !== 'lmstudio' && !cfg.synthetic) {
    const isLocal = LOCAL_PROVIDERS.includes(provider);
    ensureBinary(cfg.binary, { isLocal });
  } else if (provider === 'lmstudio') {
    ensureBinary(cfg.binary, { isLocal: true, optional: true });
  }

  const target = cfg.synthetic
    ? { command: cfg.binary, argsPrefix: [] }
    : resolveSpawnTarget(cfg.binary);

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
    ...(cfg.usesStdin ? { input: prompt } : {}),
  };

  const started = Date.now();
  const result = spawnSync(finalCommand, finalArgs, runOpts);
  const durationMs = Date.now() - started;

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

  const artifactPath = writeArtifact({
    provider,
    model: finalModel,
    effort: finalEffort,
    original,
    finalPrompt: prompt,
    raw,
    exitCode: code,
    durationMs,
    meta: { multi, ...meta },
  });

  console.log(artifactPath);
  if (result.error) {
    console.error(`[${provider}] ${result.error.message}`);
  }

  return { artifactPath, exitCode: code, raw, durationMs };
}

export function runDoctor() {
  const profiles = loadProviderProfiles({ force: true });
  const report = {
    version: VERSION,
    product: PRODUCT,
    platform: process.platform,
    cwd: process.cwd(),
    profiles_loaded_from: profiles._loaded_from || '(built-in)',
    defaults: profiles.defaults,
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
        entry.notes.push('Set LEMONADE_BIN for a real runner (synthetic fallback only)');
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
        entry.healthOk = entry.binaryOk;
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

  for (const sub of ['ask', 'ralph', 'team', 'verify', 'xllm']) {
    fs.mkdirSync(path.join(process.cwd(), '.grok', 'artifacts', sub), { recursive: true });
  }
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
  const args = argv.slice(2);
  if (args.length === 0) usage();

  if (args[0] === '--list-providers') return { mode: 'list' };
  if (args[0] === '--doctor') return { mode: 'doctor' };
  if (args[0] === '--which') return { mode: 'which' };
  if (args[0] === '--remember') return { mode: 'remember' };
  if (args[0] === '--help' || args[0] === '-h') return { mode: 'help' };

  if (args[0] === '--dry-run') {
    const spec = parseProviderSpec(args[1]);
    const prompt = args.slice(2).join(' ').trim();
    if (!spec || !prompt) usage();
    return { mode: 'dry-run', ...spec, prompt };
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
    return { mode: 'multi', providers, prompt };
  }

  const spec = parseProviderSpec(args[0]);
  const prompt = args.slice(1).join(' ').trim();
  if (!spec || !prompt) usage();
  return { mode: 'run', ...spec, prompt };
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

  if (parsed.mode === 'dry-run') {
    runAdvisor({
      provider: parsed.provider,
      model: parsed.model,
      effort: parsed.effort,
      prompt: parsed.prompt,
      dryRun: true,
    });
    process.exit(0);
  }

  if (parsed.mode === 'multi') {
    const paths = [];
    let failed = 0;
    for (const p of parsed.providers) {
      console.error(`[multi] running ${p.spec}...`);
      const result = runAdvisor({
        provider: p.provider,
        model: p.model,
        effort: p.effort,
        prompt: parsed.prompt,
        multi: true,
      });
      if (result.artifactPath) paths.push(result.artifactPath);
      if (result.exitCode !== 0) failed += 1;
    }
    const dir = path.join(process.cwd(), '.grok', 'artifacts', 'xllm');
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, `multi-${slugify(parsed.prompt)}-${ts()}.md`);
    fs.writeFileSync(
      indexPath,
      [
        '# xllm multi-run index',
        '',
        `- Created at: ${new Date().toISOString()}`,
        `- Providers: ${parsed.providers.map((p) => p.spec).join(', ')}`,
        `- Failures: ${failed}`,
        '',
        '## Artifacts',
        '',
        ...paths.map((p) => `- ${p}`),
        '',
        '## Task',
        '',
        parsed.prompt,
        '',
      ].join('\n'),
      'utf8'
    );
    console.log(indexPath);
    process.exit(failed > 0 && failed === paths.length ? 1 : 0);
  }

  const result = runAdvisor({
    provider: parsed.provider,
    model: parsed.model,
    effort: parsed.effort,
    prompt: parsed.prompt,
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
