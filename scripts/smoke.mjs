#!/usr/bin/env node
/** Offline by default. Live smoke verifies final assistant output, never prompt artifacts. */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildInventory, loadProviderProfiles } from './xllm-advisor.js';
import { pickAdvisorForRole } from './xllm-routing.js';
import { loadTraits } from './xllm-traits.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const advisor = path.join(root, 'scripts', 'xllm-advisor.js');
const live = process.argv.includes('--live') || process.env.XLLM_SMOKE === '1';
const filterAt = process.argv.indexOf('--provider');
const providerFilter = filterAt < 0 ? null : process.argv[filterAt + 1];
function run(args, env = process.env, timeout = 120000) {
  return spawnSync(process.execPath, [advisor, ...args], {
    encoding: 'utf8', shell: false, cwd: root, env, timeout, maxBuffer: 12 * 1024 * 1024,
  });
}
function resultOf(run) {
  let result;
  try { result = JSON.parse(run.stdout || ''); } catch {
    throw new Error(`Advisor returned no JSON envelope: ${run.stderr || run.error || ''}`);
  }
  if (run.status !== 0 || result.exitCode !== 0 || result.schema_version !== 2) {
    throw new Error(result.failure?.hint || run.stderr || 'Advisor failed');
  }
  return result;
}

console.log(`xllm smoke (live=${live})`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-smoke-'));
try {
  const profile = path.join(scratch, 'providers.toml');
  fs.writeFileSync(profile, '[defaults]\nexecution_policy = "any"\n');
  const dry = resultOf(run(['--dry-run', 'codex', 'offline smoke', '--json'],
    { ...process.env, XLLM_PROVIDERS_PATH: profile }));
  if (!dry.dryRun || dry.preview.safety !== 'os-read-only') throw new Error('Read-only dry-run failed');
  console.log('offline JSON/read-only CLI path: ok');
  if (live) {
    const inventory = buildInventory({ refresh: true });
    const ready = Object.entries(inventory.providers)
      .filter(([p, v]) => v.installed && v.healthy && v.advisor_eligible && (!providerFilter || p === providerFilter))
      .map(([p]) => p);
    const pick = pickAdvisorForRole('critic', {
      taskText: 'Return a smoke verification token', intensity: 'low', forceCli: true,
      readyProviders: ready, inventory, profiles: loadProviderProfiles(),
      traits: loadTraits(),
    });
    const marker = `XLLM_SMOKE_${randomBytes(8).toString('hex')}`;
    const result = resultOf(run([pick.spec, `Reply with exactly ${marker} and nothing else.`,
      '--json', '--no-artifacts'], process.env, 300000));
    if (result.raw.trim() !== marker) throw new Error('Final assistant response did not match the smoke token');
    console.log(`live final response: ok (${pick.spec}; identity=${result.attribution.identity_status}; ${result.durationMs}ms)`);
  } else console.log('no live model calls (use --live explicitly)');
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
