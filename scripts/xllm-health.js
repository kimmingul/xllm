#!/usr/bin/env node
/**
 * Provider health cache — synchronous, dependency-free leaf (imports only
 * constants, never the advisor), so runAdvisor can record observed auth
 * outcomes without an import cycle.
 *
 * ~/.xllm/contracts.json (schema 2) keeps independent facts, each with its OWN
 * timestamp:
 *   providers[p]  flags/version/safety — written by the token-free probe
 *   auth[p]       auth observation — a live mini-call OR a real runtime call.
 *                 A token-free probe never overwrites it; it is dropped only
 *                 when the CLI version or the connection/account context
 *                 fingerprint changes. No secret value is ever persisted:
 *                 the context is a one-way hash.
 * Only OBSERVED failures veto routing; unknown is never success.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { CLOUD_PROVIDERS } from './xllm-constants.js';

export const CONTRACTS_VERSION = 2;
/** An observed auth result (failure OR success) is trusted this long. */
export const AUTH_TTL_MS = 12 * 60 * 60 * 1000;

/** Same resolution as xllmHomeDir() in the advisor (kept in sync by hand: leaf module). */
function homeDir(env) {
  if (env.XLLM_HOME) return env.XLLM_HOME;
  const home = env.USERPROFILE || env.HOME || process.cwd();
  return path.join(home, '.xllm');
}

export function contractsCachePath(env = process.env) {
  return path.join(homeDir(env), 'contracts.json');
}

/**
 * Comparable form of a CLI version string. Producers differ (`--version`
 * prints "codex-cli 0.146.0", an envelope may carry "0.146.0"), so compare the
 * numeric core. Returns null when nothing version-like is present.
 */
export function normalizeCliVersion(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/);
  return (m ? m[0] : s.split(/\r?\n/)[0]).toLowerCase().slice(0, 80);
}

/**
 * Env variables that define WHICH account/endpoint a provider CLI talks to.
 * Their values are hashed together (never stored): a rotated key, a changed
 * base URL/profile/home dir or OS user yields a different fingerprint, which
 * invalidates old auth observations. Presence of a variable alone also counts.
 */
const AUTH_CONTEXT_ENV = {
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CODEX_HOME'],
  claude: [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_PROFILE', 'AWS_REGION',
  ],
  gemini: [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY', 'XAI_BASE_URL'],
  cursor: ['CURSOR_API_KEY'],
};
const OS_ACCOUNT_ENV = ['USERPROFILE', 'HOME', 'USERNAME', 'USER'];

/** One-way fingerprint (16 hex). Raw values are never persisted. */
export function authContextHash(provider, env = process.env) {
  const names = [...(AUTH_CONTEXT_ENV[provider] || []), ...OS_ACCOUNT_ENV].sort();
  const material = names.map((n) => [n, env[n] == null ? null : String(env[n])]);
  return createHash('sha256')
    .update(`xllm-auth-context-v1\0${provider}\0${JSON.stringify(material)}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Is a stored auth observation still applicable? Returns {valid, reason}.
 * Invalid when the connection/account context changed, the CLI version
 * changed, or the entry predates context tracking (schema 1).
 */
export function authObservationValidity(entry, { provider, env = process.env, cliVersion = null }) {
  if (!entry || typeof entry !== 'object') return { valid: false, reason: 'none' };
  if (!entry.context) return { valid: false, reason: 'legacy-no-context' };
  if (entry.context !== authContextHash(provider, env)) return { valid: false, reason: 'context-changed' };
  const was = normalizeCliVersion(entry.cli_version);
  const now = normalizeCliVersion(cliVersion);
  if (was && now && was !== now) return { valid: false, reason: 'cli-version-changed' };
  return { valid: true, reason: null };
}

export function readHealthCache(env = process.env) {
  try {
    const v = JSON.parse(fs.readFileSync(contractsCachePath(env), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function writeHealthCache(report, env = process.env) {
  const file = contractsCachePath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; /* cache is best-effort */
  }
}

/**
 * Carry previous auth observations across a token-free probe. Each survives
 * with its ORIGINAL observed_at; it is dropped only when the CLI version or
 * the connection/account context changed (see authObservationValidity).
 */
export function preserveAuthObservations(previous, providers, env = process.env) {
  const out = {};
  for (const [p, entry] of Object.entries(previous?.auth || {})) {
    if (!entry || entry.skipped) continue;
    const v = authObservationValidity(entry, { provider: p, env, cliVersion: providers?.[p]?.version ?? null });
    if (v.valid) out[p] = entry;
  }
  return out;
}

export function authEntry(provider, { verified, failure = null, source, cliVersion = null, now = Date.now(), env = process.env }) {
  return {
    provider,
    auth_verified: verified,
    failure: verified ? null : failure,
    observed_at: new Date(now).toISOString(),
    source,
    context: authContextHash(provider, env),
    cli_version: normalizeCliVersion(cliVersion),
  };
}

/**
 * Record an OBSERVED auth outcome from a real call (sync read-modify-write,
 * atomic rename). Local runtimes have no auth and record nothing.
 */
export function recordAuthObservation(provider, { verified, failure = null, source = 'runtime', cliVersion = null }, { env = process.env, now = Date.now() } = {}) {
  if (!CLOUD_PROVIDERS.includes(provider)) return null;
  const cache = readHealthCache(env) || {
    contracts_version: CONTRACTS_VERSION, probed_at: null, host_cli: null, providers: {}, drift: [], auth: {},
  };
  cache.contracts_version = CONTRACTS_VERSION;
  cache.auth = cache.auth || {};
  const entry = authEntry(provider, {
    verified, failure, source, now, env,
    cliVersion: cliVersion ?? cache.providers?.[provider]?.version ?? null,
  });
  cache.auth[provider] = entry;
  writeHealthCache(cache, env);
  return entry;
}

/**
 * Map a runAdvisor envelope to an auth observation. Call after EVERY result:
 * an auth failure (failure.kind === 'auth') records a failed observation, a
 * clean exit records a verified one; every other outcome is unknown and
 * records nothing. Returns the entry or null.
 */
export function recordProviderResult(result, opts = {}) {
  const provider = result?.attribution?.executed_provider || result?.attribution?.requested_provider;
  if (!provider || !CLOUD_PROVIDERS.includes(provider)) return null;
  if (result.dryRun || result.preview) return null; // nothing was sent: not an observation
  const cliVersion = result.attribution?.cli_version ?? null;
  if (result.failure?.kind === 'auth') {
    return recordAuthObservation(
      provider,
      { verified: false, failure: { kind: 'auth', retryable: false, hint: result.failure.hint || null }, cliVersion },
      opts
    );
  }
  if (result.exitCode === 0 && !result.failure) {
    return recordAuthObservation(provider, { verified: true, cliVersion }, opts);
  }
  return null;
}
