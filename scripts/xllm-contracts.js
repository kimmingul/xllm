#!/usr/bin/env node
/**
 * xllm contracts — minimal executable provider contract floor.
 *
 * Purpose (from docs/diversity-roadmap.md, improvement 1): make every later
 * diversity experiment trustworthy. Deliberately thin — a hygiene layer,
 * not a multi-month hardening project.
 *
 *  - Token-free capability probes: check the installed CLI's --help for the
 *    exact flags xllm depends on → detect silent flag drift across versions.
 *  - Structured failure taxonomy: classify spawn results into
 *    missing-binary / auth / timeout / transient / permanent / ok.
 *  - Bounded jittered retry: transient failures only, max 2 attempts.
 *  - Opt-in live auth mini-call (--live): READY means "binary responds";
 *    only a real call proves auth.
 *
 * Health cache (~/.xllm/contracts.json, schema 2) keeps three independent
 * facts, each with its OWN timestamp:
 *   providers[p]  flags/version, from the token-free probe
 *   auth[p]       auth observation (live mini-call or a real runtime call);
 *                 a token-free probe NEVER overwrites it, and it is dropped
 *                 only when the CLI version or the connection/account
 *                 context changes
 *   safety        per-provider read-only boundary class (derived from flags)
 * Only OBSERVED failures veto routing; "unknown" is never success.
 *
 *   node scripts/xllm-contracts.js [--live] [--json]
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import { stripVTControlCharacters } from 'node:util';
import process from 'process';
import {
  getSupportedProviders,
  resolveSpawnTarget,
  runAdvisor,
  detectHostCli,
  classifyFailure,
  withRetry,
} from './xllm-advisor.js';
import {
  CONTRACTS_VERSION,
  AUTH_TTL_MS,
  contractsCachePath,
  normalizeCliVersion,
  authContextHash,
  authObservationValidity,
  readHealthCache,
  writeHealthCache,
  preserveAuthObservations,
  authEntry,
  recordAuthObservation,
  recordProviderResult,
} from './xllm-health.js';

export { classifyFailure, withRetry };
// Health-cache persistence lives in the dependency-free leaf xllm-health.js
// (runAdvisor records auth outcomes through it without an import cycle).
export {
  CONTRACTS_VERSION,
  AUTH_TTL_MS,
  contractsCachePath,
  normalizeCliVersion,
  authContextHash,
  authObservationValidity,
  readHealthCache,
  preserveAuthObservations,
  recordAuthObservation,
  recordProviderResult,
};

const IS_WINDOWS = process.platform === 'win32';

/**
 * The exact CLI surface xllm depends on, per provider. `helpArgs` is probed
 * token-free; every `required` token must appear in the help text.
 * Versioned by whatever `--version` reports at probe time.
 *
 * `safety.boundary` classifies the read-only boundary the flags can provide:
 *   native-flags  the CLI exposes the vendor's own sandbox/tool-restriction
 *                 flags (necessary, NOT sufficient: flags present ≠ verified)
 *   unverified    no enforceable read-only boundary evidenced for this CLI
 *   prompt-only   HTTP completion; no client tools exist to restrict
 */
export const PROVIDER_CONTRACTS = {
  codex: {
    binary: 'codex',
    versionArgs: ['--version'],
    probes: [
      {
        helpArgs: ['exec', '--help'],
        required: [
          '--sandbox', '--cd', '-c', '--model', '--json', '--output-schema',
          '--ignore-user-config', '--ignore-rules', '--ephemeral',
        ],
      },
      { helpArgs: ['--help'], required: ['exec', 'sandbox'] },
    ],
    safety: { boundary: 'native-flags', note: 'exec --sandbox read-only + --ignore-user-config/--ignore-rules/--ephemeral' },
  },
  claude: {
    binary: 'claude',
    versionArgs: ['--version'],
    probes: [
      {
        helpArgs: ['--help'],
        required: [
          '-p', '--model', '--permission-mode', '--effort', '--output-format', '--json-schema',
          '--tools', '--strict-mcp-config', '--safe-mode', '--restricted', '--permission-prompts',
        ],
      },
    ],
    safety: { boundary: 'native-flags', note: '--safe-mode --restricted --tools Read,Glob,Grep --strict-mcp-config --permission-mode dontAsk' },
  },
  gemini: {
    binary: 'gemini',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['-p', '--model', '--approval-mode'] }],
    safety: { boundary: 'unverified', note: 'no enforceable read-only boundary evidenced' },
  },
  antigravity: {
    binary: 'agy',
    versionArgs: ['--version'],
    // --effort landed in agy 1.1.9; xllm now spawns with it, so it is part of
    // the surface we depend on and must drift-detect.
    probes: [
      {
        helpArgs: ['--help'],
        required: [
          '-p', '--model', '--effort', '--print-timeout', '--output-format', '--json-schema',
          '--mode', '--sandbox',
        ],
      },
    ],
    safety: { boundary: 'unverified', note: '--sandbox is read-WRITE workspace; no tool allowlist' },
  },
  grok: {
    binary: 'grok',
    versionArgs: ['--version'],
    probes: [
      {
        helpArgs: ['--help'],
        required: [
          '-p', '-m', '--reasoning-effort', '--prompt-file', '--tools', '--deny', '--no-subagents',
          '--permission-mode', '--output-format', '--json-schema',
        ],
      },
    ],
    safety: { boundary: 'unverified', note: 'tool controls exist but no config/hook isolation proven' },
  },
  cursor: {
    binary: 'cursor-agent',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['--print', '--model', '--mode'] }],
    safety: { boundary: 'unverified', note: 'no enforceable read-only boundary evidenced' },
  },
  ollama: {
    binary: 'ollama',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['run', 'list'] }],
    safety: { boundary: 'prompt-only', note: 'HTTP completion, no client tools' },
  },
  lmstudio: {
    binary: IS_WINDOWS ? 'curl.exe' : 'curl',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['-d'] }],
    safety: { boundary: 'prompt-only', note: 'HTTP completion, no client tools' },
  },
  lemonade: {
    binary: null, // resolved from LEMONADE_BIN at probe time
    versionArgs: ['--version'],
    probes: [],
    safety: { boundary: 'prompt-only', note: 'HTTP completion, no client tools' },
  },
};

// ---------------------------------------------------------------------------
// Capability probes (token-free)
// ---------------------------------------------------------------------------

function runHelp(binary, args) {
  const target = resolveSpawnTarget(binary);
  return spawnSync(target.command, [...(target.argsPrefix || []), ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Match complete help tokens: --model-picker cannot satisfy --model. */
export function helpHasToken(help, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`, 'm').test(stripVTControlCharacters(help));
}

function safetyReport(contract, report) {
  const s = contract?.safety || { boundary: 'unverified', note: 'no safety contract defined' };
  return {
    boundary: s.boundary,
    // Flags present is necessary, never sufficient — parent policy decides eligibility.
    flags_present: s.boundary === 'native-flags' ? report.ok === true : null,
    note: s.note,
  };
}

export function probeProviderContract(provider, env = process.env, { run = runHelp } = {}) {
  const contract = PROVIDER_CONTRACTS[provider];
  if (!contract) return { provider, ok: false, error: 'no contract defined' };

  const binary = provider === 'lemonade' ? env.LEMONADE_BIN || null : contract.binary;
  const report = {
    provider,
    binary,
    version: null,
    ok: false,
    missing_flags: [],
    failure: null,
    probed_at: new Date().toISOString(),
    safety: null,
  };
  report.safety = safetyReport(contract, report);
  if (!binary) {
    report.failure = { kind: 'missing-binary', retryable: false, hint: 'Set LEMONADE_BIN.' };
    return report;
  }
  const ver = run(binary, contract.versionArgs);
  if (ver.error || ver.status !== 0) {
    report.failure = classifyFailure({ ...ver, status: ver.status ?? 1 });
    return report;
  }
  report.version = (ver.stdout || ver.stderr || '').trim().split(/\r?\n/)[0].slice(0, 80);

  for (const probe of contract.probes) {
    const res = run(binary, probe.helpArgs);
    const help = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.error || res.status !== 0) {
      report.failure = classifyFailure({ ...res, status: res.status ?? 1 });
      return report;
    }
    for (const flag of probe.required) {
      if (!helpHasToken(help, flag)) {
        report.missing_flags.push(`${probe.helpArgs.join(' ')} → ${flag}`);
      }
    }
  }
  report.ok = report.missing_flags.length === 0;
  report.safety = safetyReport(contract, report);
  if (!report.ok) {
    report.failure = {
      kind: 'contract-drift',
      retryable: false,
      hint:
        'The installed CLI no longer exposes flags xllm depends on — a CLI update likely changed its interface. Update xllm or pin the CLI version.',
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// Live auth mini-call (opt-in — costs a tiny amount of tokens per provider)
// ---------------------------------------------------------------------------

const CLOUD_FOR_AUTH = ['codex', 'claude', 'gemini', 'grok', 'cursor'];

export function liveAuthCheck(provider) {
  const started = Date.now();
  const r = runAdvisor({
    provider,
    prompt: 'Reply with exactly: XLLM_AUTH_OK',
    noArtifacts: true,
    quiet: true,
    allowSelf: false,
  });
  const cls =
    r.exitCode === 0 && /XLLM_AUTH_OK/.test(r.raw || '')
      ? { kind: 'ok', retryable: false, hint: null }
      : classifyFailure({ status: r.exitCode, stdout: r.raw, stderr: '' });
  return {
    provider,
    auth_verified: cls.kind === 'ok',
    failure: cls.kind === 'ok' ? null : cls,
    duration_ms: Date.now() - started,
    cli_version: r.attribution?.cli_version ?? null,
  };
}

// ---------------------------------------------------------------------------
// Report + cache
// ---------------------------------------------------------------------------

export function runContracts({ live = false, env = process.env } = {}) {
  const host = detectHostCli(env);
  const previous = readHealthCache(env);
  const report = {
    contracts_version: CONTRACTS_VERSION,
    probed_at: new Date().toISOString(),
    host_cli: host,
    providers: {},
    drift: [],
    auth: {},
  };
  for (const p of getSupportedProviders()) {
    const r = probeProviderContract(p, env);
    report.providers[p] = r;
    if (r.failure?.kind === 'contract-drift') {
      report.drift.push({ provider: p, missing: r.missing_flags });
    }
  }
  // Token-free probe: keep earlier auth observations (own timestamps).
  report.auth = preserveAuthObservations(previous, report.providers, env);
  if (live) {
    for (const p of CLOUD_FOR_AUTH) {
      if (!report.providers[p]?.ok) continue;
      if (host && host === p) {
        report.auth[p] = report.auth[p] || { provider: p, auth_verified: null, skipped: 'same-vendor host' };
        continue;
      }
      console.error(`[contracts] live auth check: ${p}…`);
      const r = liveAuthCheck(p);
      report.auth[p] = authEntry(p, {
        verified: r.auth_verified,
        failure: r.failure,
        source: 'live',
        cliVersion: r.cli_version ?? report.providers[p].version,
        env,
      });
      report.auth[p].duration_ms = r.duration_ms;
    }
  }
  writeHealthCache(report, env);
  return report;
}

function formatHuman(report) {
  const lines = [`xllm contracts — probed ${report.probed_at}`, ''];
  const now = Date.now();
  for (const [p, r] of Object.entries(report.providers)) {
    const state = r.ok
      ? 'OK'
      : r.failure?.kind === 'contract-drift'
        ? 'DRIFT'
        : (r.failure?.kind || 'FAIL').toUpperCase();
    const a = report.auth[p];
    let auth = '';
    if (a) {
      const age = a.observed_at ? Date.parse(a.observed_at) : NaN;
      const stale = Number.isFinite(age) && now - age > AUTH_TTL_MS ? ',stale' : '';
      const when = a.observed_at ? ` @${a.observed_at}` : '';
      auth = a.auth_verified === true
        ? ` auth:verified(${a.source || '?'}${stale})${when}`
        : a.skipped
          ? ` auth:skipped(${a.skipped})`
          : ` auth:FAILED(${a.failure?.kind}${stale})${when}`;
    }
    const safety = r.safety ? ` safety:${r.safety.boundary}${r.safety.flags_present === false ? '(flags missing)' : ''}` : '';
    lines.push(`  ${p.padEnd(12)} ${state.padEnd(15)} ${(r.version || '-').padEnd(24)}${auth}${safety}`);
    for (const m of r.missing_flags || []) lines.push(`      missing: ${m}`);
  }
  if (report.drift.length) {
    lines.push('', `⚠ contract drift on: ${report.drift.map((d) => d.provider).join(', ')}`);
  }
  if (!Object.keys(report.auth).length) {
    lines.push('', 'Note: auth unknown — a binary that responds is not proof of login. Run with --live (or make a real call).');
  }
  lines.push(
    '',
    'safety: native-flags = vendor sandbox/tool flags exist (necessary, not proof); unverified = no enforceable read-only boundary evidenced; prompt-only = HTTP, no client tools.'
  );
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(`xllm contracts — provider contract floor (flag drift, failure taxonomy, auth)
Usage: node scripts/xllm-contracts.js [--live] [--json]
  --live   also run a tiny authenticated call per healthy cloud provider
  --json   machine-readable report (also cached at ~/.xllm/contracts.json)`);
    process.exit(0);
  }
  const report = runContracts({ live });
  console.log(json ? JSON.stringify(report, null, 2) : formatHuman(report));
  process.exit(report.drift.length ? 2 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-contracts.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
