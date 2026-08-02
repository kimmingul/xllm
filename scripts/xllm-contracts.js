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
 *   node scripts/xllm-contracts.js [--live] [--json]
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import {
  getSupportedProviders,
  resolveBinaryPath,
  resolveSpawnTarget,
  runAdvisor,
  xllmHomeDir,
  detectHostCli,
  classifyFailure,
  withRetry,
} from './xllm-advisor.js';

export { classifyFailure, withRetry };

const IS_WINDOWS = process.platform === 'win32';

/**
 * The exact CLI surface xllm depends on, per provider. `helpArgs` is probed
 * token-free; every `required` token must appear in the help text.
 * Versioned by whatever `--version` reports at probe time.
 */
export const PROVIDER_CONTRACTS = {
  codex: {
    binary: 'codex',
    versionArgs: ['--version'],
    probes: [
      { helpArgs: ['exec', '--help'], required: ['--sandbox', '--cd', '-c'] },
      { helpArgs: ['--help'], required: ['exec', 'sandbox'] },
    ],
  },
  claude: {
    binary: 'claude',
    versionArgs: ['--version'],
    probes: [
      { helpArgs: ['--help'], required: ['-p', '--model', '--permission-mode'] },
    ],
  },
  gemini: {
    binary: 'gemini',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['-p', '--model'] }],
  },
  antigravity: {
    binary: 'agy',
    versionArgs: ['--version'],
    // --effort landed in agy 1.1.9; xllm now spawns with it, so it is part of
    // the surface we depend on and must drift-detect.
    probes: [{ helpArgs: ['--help'], required: ['-p', '--model', '--effort'] }],
  },
  grok: {
    binary: 'grok',
    versionArgs: ['--version'],
    probes: [
      { helpArgs: ['--help'], required: ['-p', '-m', '--reasoning-effort'] },
    ],
  },
  cursor: {
    binary: 'cursor-agent',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['--print'] }],
  },
  ollama: {
    binary: 'ollama',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['run', 'list'] }],
  },
  lmstudio: {
    binary: IS_WINDOWS ? 'curl.exe' : 'curl',
    versionArgs: ['--version'],
    probes: [{ helpArgs: ['--help'], required: ['-d'] }],
  },
  lemonade: {
    binary: null, // resolved from LEMONADE_BIN at probe time
    versionArgs: ['--version'],
    probes: [],
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

export function probeProviderContract(provider, env = process.env) {
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
  };
  if (!binary) {
    report.failure = { kind: 'missing-binary', retryable: false, hint: 'Set LEMONADE_BIN.' };
    return report;
  }
  const resolved = resolveBinaryPath(binary);
  if (resolved === binary && !path.isAbsolute(resolved)) {
    // PATH scan failed; try help anyway — spawn error will classify it.
  }

  const ver = runHelp(binary, contract.versionArgs);
  if (ver.error || (ver.status !== 0 && !(ver.stdout || ver.stderr))) {
    report.failure = classifyFailure(ver);
    return report;
  }
  report.version = (ver.stdout || ver.stderr || '').trim().split(/\r?\n/)[0].slice(0, 80);

  for (const probe of contract.probes) {
    const res = runHelp(binary, probe.helpArgs);
    const help = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.error) {
      report.failure = classifyFailure(res);
      return report;
    }
    for (const flag of probe.required) {
      if (!help.includes(flag)) {
        report.missing_flags.push(`${probe.helpArgs.join(' ')} → ${flag}`);
      }
    }
  }
  report.ok = report.missing_flags.length === 0;
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
  };
}

// ---------------------------------------------------------------------------
// Report + cache
// ---------------------------------------------------------------------------

export function contractsCachePath(env = process.env) {
  return path.join(xllmHomeDir(env), 'contracts.json');
}

export function runContracts({ live = false, env = process.env } = {}) {
  const host = detectHostCli(env);
  const report = {
    contracts_version: 1,
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
  if (live) {
    for (const p of CLOUD_FOR_AUTH) {
      if (!report.providers[p]?.ok) continue;
      if (host && host === p) {
        report.auth[p] = { provider: p, auth_verified: null, skipped: 'same-vendor host' };
        continue;
      }
      console.error(`[contracts] live auth check: ${p}…`);
      report.auth[p] = liveAuthCheck(p);
    }
  }
  try {
    fs.mkdirSync(path.dirname(contractsCachePath(env)), { recursive: true });
    fs.writeFileSync(contractsCachePath(env), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* cache is best-effort */
  }
  return report;
}

function formatHuman(report) {
  const lines = [`xllm contracts — probed ${report.probed_at}`, ''];
  for (const [p, r] of Object.entries(report.providers)) {
    const state = r.ok
      ? 'OK'
      : r.failure?.kind === 'contract-drift'
        ? 'DRIFT'
        : (r.failure?.kind || 'FAIL').toUpperCase();
    const auth = report.auth[p]
      ? report.auth[p].auth_verified === true
        ? ' auth:verified'
        : report.auth[p].skipped
          ? ` auth:skipped(${report.auth[p].skipped})`
          : ` auth:FAILED(${report.auth[p].failure?.kind})`
      : '';
    lines.push(
      `  ${p.padEnd(12)} ${state.padEnd(15)} ${r.version || '-'}${auth}`
    );
    for (const m of r.missing_flags || []) lines.push(`      missing: ${m}`);
  }
  if (report.drift.length) {
    lines.push('', `⚠ contract drift on: ${report.drift.map((d) => d.provider).join(', ')}`);
  }
  if (!Object.keys(report.auth).length) {
    lines.push('', 'Note: auth unproven — run with --live for a real per-provider auth call.');
  }
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
