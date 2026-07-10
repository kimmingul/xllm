#!/usr/bin/env node
/**
 * Unified CLI for grok-xllm.
 *
 *   node scripts/xllm.mjs which
 *   node scripts/xllm.mjs remember
 *   node scripts/xllm.mjs doctor
 *   node scripts/xllm.mjs ask <provider> "<prompt>"
 *   node scripts/xllm.mjs multi p1,p2 "<prompt>"
 *   node scripts/xllm.mjs smoke [--live]
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const advisor = path.join(__dirname, 'grok-ask-advisor.js');
const doctor = path.join(__dirname, 'xllm-doctor.js');
const smoke = path.join(__dirname, 'smoke.mjs');
const routing = path.join(__dirname, 'xllm-routing.js');

const [cmd, ...rest] = process.argv.slice(2);

function run(script, args) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  process.exit(res.status ?? 1);
}

function help() {
  console.log(`grok-xllm CLI — multi-LLM orchestration for Grok Build

Commands:
  which              Print resolved advisor script path
  remember           Write xllm-advisor-path marker (.xllm/, legacy .grok/)
  doctor             Provider + path health (human)
  ask <p> <prompt>   Single advisor call (read-only by default; --allow-write to opt in)
  multi p1,p2 <prompt>   Parallel multi-advisor run
  clean [--older-than=DAYS]   Delete persisted advisor artifacts
  smoke [--live]     Dry smoke or live READY provider
  list               List providers JSON
  pick <role> <task> Auto model/effort for a role (see xllm-routing)
  pick-team <task>   Auto plan for /team roles
  infer <task>       Infer intensity low|medium|high
  roles              List routing roles

Safety flags (ask/multi): --allow-write --allow-self --no-artifacts

Examples:
  node scripts/xllm.mjs remember
  node scripts/xllm.mjs ask codex@high "ping"
  node scripts/xllm.mjs pick security "auth token refresh"
  node scripts/xllm.mjs pick-team "refactor payment webhooks" --json
  node scripts/xllm.mjs multi ollama:qwen3.6:latest,codex "review risks"
  node scripts/xllm.mjs clean --older-than=7
`);
}

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  help();
  process.exit(0);
}

switch (cmd) {
  case 'which':
    run(advisor, ['--which']);
    break;
  case 'remember':
    run(advisor, ['--remember']);
    break;
  case 'doctor':
    run(doctor, []);
    break;
  case 'list':
  case 'list-providers':
    run(advisor, ['--list-providers']);
    break;
  case 'ask':
    if (rest.length < 2) {
      console.error('Usage: xllm ask <provider> <prompt>');
      process.exit(1);
    }
    run(advisor, rest);
    break;
  case 'multi':
    if (rest.length < 2) {
      console.error('Usage: xllm multi p1,p2 <prompt>');
      process.exit(1);
    }
    run(advisor, ['--multi', ...rest]);
    break;
  case 'smoke':
    run(smoke, rest);
    break;
  case 'clean':
  case 'clean-artifacts':
    run(advisor, ['--clean-artifacts', ...rest]);
    break;
  case 'dry-run':
    run(advisor, ['--dry-run', ...rest]);
    break;
  case 'pick':
  case 'pick-team':
  case 'infer':
  case 'roles':
    run(routing, [cmd, ...rest]);
    break;
  default:
    if (rest.length >= 1) {
      run(advisor, [cmd, ...rest]);
    }
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
