#!/usr/bin/env node
/**
 * Thin wrapper: node scripts/xllm-doctor.js
 * Delegates to xllm-advisor --doctor and prints a human summary.
 *
 * READY (binary + server respond) is not the same as ELIGIBLE (read-only
 * boundary verified) or AUTHENTICATED (an observed login). The three are
 * reported separately; unknown is never shown as success.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { readHealthCache, authObservationValidity, AUTH_TTL_MS } from './xllm-health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const advisor = path.join(__dirname, 'xllm-advisor.js');

/** One-line auth state from the health cache (observed facts only). */
export function authStatusLine(provider, cache, { now = Date.now(), env = process.env } = {}) {
  const a = cache && cache.auth && cache.auth[provider];
  if (!a || a.skipped || !a.observed_at) return 'auth unknown (no observed login — run xllm-contracts --live)';
  const v = authObservationValidity(a, {
    provider,
    env,
    cliVersion: cache.providers?.[provider]?.version ?? null,
  });
  if (!v.valid) return `auth unknown (earlier observation invalidated: ${v.reason})`;
  const t = Date.parse(a.observed_at);
  const stale = !Number.isFinite(t) || now - t > AUTH_TTL_MS ? ', past TTL' : '';
  if (a.auth_verified === true) return `auth verified @${a.observed_at}${stale}`;
  if (a.auth_verified === false) return `auth FAILED (${a.failure?.kind || 'auth'}) @${a.observed_at}${stale}`;
  return 'auth unknown';
}

/** READY / PARTIAL / MISSING plus the eligibility verdict. */
export function providerState(p) {
  let ready = 'MISSING';
  if (p.binaryOk && p.healthOk) ready = 'READY';
  else if (p.binaryOk || (p.notes && p.notes.length)) ready = 'PARTIAL';
  // Only an explicit false is "safety unverified"; a missing field is unknown.
  const eligible = p.advisor_eligible === false ? false : p.advisor_eligible === true ? true : null;
  return { ready, eligible };
}

function main() {
  const res = spawnSync(process.execPath, [advisor, '--doctor'], {
    encoding: 'utf8',
    shell: false,
    cwd: process.cwd(),
  });

  const out = (res.stdout || '').trim();
  if (!out) {
    console.error(res.stderr || 'doctor failed');
    process.exit(res.status || 1);
  }

  let report;
  try {
    report = JSON.parse(out);
  } catch {
    console.log(out);
    process.exit(res.status || 0);
  }

  const cache = readHealthCache();
  const policy = report.safety?.execution_policy || report.defaults?.execution_policy || 'any';

  console.log(`xllm doctor v${report.version}`);
  console.log(`platform: ${report.platform}`);
  console.log(`cwd: ${report.cwd}`);
  if (report.advisorPath) {
    console.log(`advisor: ${report.advisorPath}`);
  }
  if (report.advisorMarker) {
    console.log(`marker:  ${report.advisorMarker}`);
  }
  console.log(`execution policy: ${policy}${policy === 'any' ? '' : ' (only verified-local models are routable)'}`);
  console.log('');
  console.log('Providers:');

  for (const [name, p] of Object.entries(report.providers || {})) {
    const { ready, eligible } = providerState(p);
    const extra = p.models?.length ? ` models=[${p.models.slice(0, 6).join(', ')}]` : '';
    const notes = p.notes?.length ? ` — ${p.notes.join('; ')}` : '';
    const elig =
      eligible === false
        ? ' · ADVISOR-INELIGIBLE (read-only enforcement unverified; safety unverified)'
        : eligible === true
          ? ' · eligible'
          : '';
    const auth = p.kind === 'cloud' ? ` · ${authStatusLine(name, cache)}` : '';
    console.log(`  ${name.padEnd(12)} ${ready.padEnd(8)} (${p.kind})${extra}${elig}${auth}${notes}`);
  }

  console.log('');
  console.log('Artifacts dir:', report.artifactsReady ? 'ok' : 'missing');
  for (const r of report.recommendations || []) {
    console.log('•', r);
  }

  const skills = ['ask', 'xllm', 'xllm-setup'];
  const skillRoot = path.join(process.cwd(), '.grok', 'skills');
  if (fs.existsSync(skillRoot)) {
    console.log('');
    console.log('Skills:');
    for (const s of skills) {
      const ok = fs.existsSync(path.join(skillRoot, s, 'SKILL.md'));
      console.log(`  ${s.padEnd(12)} ${ok ? 'ok' : 'MISSING'}`);
    }
  }

  process.exit(res.status === 0 ? 0 : res.status || 1);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) main();
