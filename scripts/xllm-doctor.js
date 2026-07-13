#!/usr/bin/env node
/**
 * Thin wrapper: node scripts/xllm-doctor.js
 * Delegates to xllm-advisor --doctor and prints a human summary.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const advisor = path.join(__dirname, 'xllm-advisor.js');

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

console.log(`xllm doctor v${report.version}`);
console.log(`platform: ${report.platform}`);
console.log(`cwd: ${report.cwd}`);
if (report.advisorPath) {
  console.log(`advisor: ${report.advisorPath}`);
}
if (report.advisorMarker) {
  console.log(`marker:  ${report.advisorMarker}`);
}
console.log('');
console.log('Providers:');

for (const [name, p] of Object.entries(report.providers || {})) {
  let ready = 'MISSING';
  if (p.binaryOk && p.healthOk) ready = 'READY';
  else if (p.binaryOk || (p.notes && p.notes.length)) ready = 'PARTIAL';
  const extra = p.models?.length ? ` models=[${p.models.slice(0, 6).join(', ')}]` : '';
  const notes = p.notes?.length ? ` — ${p.notes.join('; ')}` : '';
  console.log(`  ${name.padEnd(12)} ${ready.padEnd(8)} (${p.kind})${extra}${notes}`);
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
