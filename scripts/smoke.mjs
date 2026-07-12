#!/usr/bin/env node
/**
 * Optional live smoke for READY providers.
 * Safe defaults: only runs if XLLM_SMOKE=1 or --live is passed.
 * Without --live: dry-run + unit checks only.
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --live
 *   node scripts/smoke.mjs --live --provider ollama
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const advisor = path.join(root, 'scripts', 'xllm-advisor.js');
const live =
  process.argv.includes('--live') ||
  process.env.XLLM_SMOKE === '1';
const providerFilter = (() => {
  const i = process.argv.indexOf('--provider');
  return i >= 0 ? process.argv[i + 1] : null;
})();

function run(args, opts = {}) {
  return spawnSync(process.execPath, [advisor, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd: root,
    timeout: opts.timeout ?? 120000,
    maxBuffer: 12 * 1024 * 1024,
  });
}

console.log(`xllm smoke (live=${live})`);

const doc = run(['--doctor']);
if (doc.status !== 0 && doc.status !== 2) {
  console.error('doctor failed hard', doc.stderr || doc.stdout);
  process.exit(1);
}
let report;
try {
  report = JSON.parse((doc.stdout || '').trim());
} catch {
  console.error('doctor did not return JSON');
  process.exit(1);
}
const ready = [...(report.readyLocal || []), ...(report.readyCloud || [])];
console.log('ready:', ready.join(', ') || '(none)');

const probe = ready[0] || 'grok';
const dry = run(['--dry-run', probe, 'smoke dry-run']);
if (dry.status !== 0) {
  console.error('dry-run failed', dry.stderr);
  process.exit(1);
}
console.log('dry-run ok:', probe);

if (!live) {
  console.log('skip live calls (pass --live or XLLM_SMOKE=1)');
  process.exit(0);
}

const candidates = providerFilter
  ? ready.filter((p) => p === providerFilter || p.startsWith(providerFilter))
  : ready.filter((p) => ['ollama', 'grok', 'codex', 'claude'].includes(p));

if (candidates.length === 0) {
  console.error('no READY providers for live smoke');
  process.exit(2);
}

const order = ['ollama', 'grok', 'codex', 'claude'];
const pick = order.find((p) => candidates.includes(p)) || candidates[0];

let spec = pick;
if (pick === 'ollama') {
  const models = report.providers?.ollama?.models || [];
  const prefer =
    models.find((m) => /qwen3\.6|llama3\.2|gemma2|phi/i.test(m)) ||
    models[0] ||
    'llama3.2';
  spec = `ollama:${prefer}`;
}

console.log('live provider:', spec);
const prompt =
  'Reply with exactly one line containing the token XLLM_SMOKE_OK and nothing else important.';
const liveRes = run([spec, prompt], { timeout: 300000 });
const out = (liveRes.stdout || '') + '\n' + (liveRes.stderr || '');
const artifactLine = (liveRes.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .pop();

console.log('exit:', liveRes.status);
if (artifactLine && fs.existsSync(artifactLine)) {
  console.log('artifact:', artifactLine);
  const body = fs.readFileSync(artifactLine, 'utf8');
  const hasToken = /XLLM_SMOKE_OK/i.test(body);
  console.log('token in artifact:', hasToken ? 'yes' : 'no (model may have paraphrased)');
} else {
  console.log('stdout/stderr tail:\n', out.slice(-1500));
}

if (liveRes.status !== 0 && !(artifactLine && fs.existsSync(artifactLine))) {
  process.exit(liveRes.status || 1);
}
console.log('live smoke finished');
