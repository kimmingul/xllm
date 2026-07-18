#!/usr/bin/env node
/**
 * Unified CLI for xllm.
 *
 *   node scripts/xllm.mjs which
 *   node scripts/xllm.mjs remember
 *   node scripts/xllm.mjs doctor
 *   node scripts/xllm.mjs ask <provider> "<prompt>"
 *   node scripts/xllm.mjs review roles p1,p2 "<prompt>"   (multi/panel/debate/council are aliases)
 *   node scripts/xllm.mjs smoke [--live]
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const advisor = path.join(__dirname, 'xllm-advisor.js');
const doctor = path.join(__dirname, 'xllm-doctor.js');
const smoke = path.join(__dirname, 'smoke.mjs');
const routing = path.join(__dirname, 'xllm-routing.js');
const exec = path.join(__dirname, 'xllm-exec.js');
const scribe = path.join(__dirname, 'xllm-scribe.js');
const contracts = path.join(__dirname, 'xllm-contracts.js');
const review = path.join(__dirname, 'xllm-review.js');
const panel = path.join(__dirname, 'xllm-panel.js');
const debate = path.join(__dirname, 'xllm-debate.js');
const council = path.join(__dirname, 'xllm-council.js');
const traits = path.join(__dirname, 'xllm-traits.js');

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
  console.log(`xllm CLI — multi-LLM orchestration for Grok Build

Commands:
  which              Print resolved advisor script path
  remember           Write xllm-advisor-path marker (.xllm/, legacy .grok/)
  doctor             Provider + path health (human)
  ask <p> <prompt>   Single advisor call (read-only by default; --allow-write to opt in)
  review roles p1,p2 <prompt>    Parallel advisors + host synthesis (coverage — NOT measured)
  review blind p1,p2 <q>         BLIND measured panel → ledger + agreement [--tiebreak] [--ready=]
  review debate p1,p2 <q>        ADVERSARIAL refutation → survived/killed/unresolved
  review council p1,p2 <q>       blind → debate pipeline (highest stakes)
  review stats [--json]          Pairwise agreement matrix (measured decorrelation)
  review outcome <id> …          Record what the host adopted
    diff input for any mode: --staged | --base <ref> | --diff-file <path>
    (old nouns multi/panel/debate/council remain aliases through v0.27.x)
  traits [--json]        Evidence-based provider trait profiles (measured, gated, never lore)
  propose <p> <change>   Read-only change proposal → artifact + .patch (host applies)
  exec <p> <task>        Isolated executor: ephemeral clone → verified ref + evidence
                         (capable providers only; user's checkout never touched)
  exec list | exec cleanup <id>|--all
  scribe commit|pr|release|notes   Cheap-model prose for git chores → stdout
                                   (advisor writes text; YOU run git/gh)
  inventory [--refresh]  Machine capability cache (installed CLIs, ollama models)
  contracts [--live]     Provider contract probes: flag drift, failure class,
                         auth (--live sends one tiny call per cloud provider)
  profile show           Resolved provider profile + state dir
  profile set-role <role> <spec>     Pin a role for THIS project (e.g. analysis codex@high)
  profile set-default <key> <value>  Set a [defaults] key in the project profile
  clean [--older-than=DAYS]   Delete persisted advisor artifacts
  discipline show|install|remove [--target <path>]
                     Process-discipline block for CLAUDE.md/AGENTS.md
                     (≤25 lines, idempotent marker block, opt-in via setup)
  setup [pack] [--apply]  Resolve inventory→role pins (posture packs); preview unless --apply
                          packs: balanced(default)|quality|frugal|local|skip; --role R=SPEC --json --sensitive
  smoke [--live]     Dry smoke or live READY provider
  list               List providers JSON
  pick <role> <task> Auto model/effort for a role (see xllm-routing)
  infer <task>       Infer intensity low|medium|high
  roles              List routing roles

Safety flags (ask/multi): --allow-write --allow-self --no-artifacts

Examples:
  node scripts/xllm.mjs remember
  node scripts/xllm.mjs ask codex@high "ping"
  node scripts/xllm.mjs pick security "auth token refresh"
  node scripts/xllm.mjs review roles ollama:qwen3.6:latest,codex "review risks"
  node scripts/xllm.mjs review blind codex,grok,gemini "이 캐시 설계가 안전한가?" --staged
  node scripts/xllm.mjs propose codex@high "add input validation to login()"
  node scripts/xllm.mjs profile set-role critic ollama:qwen3.6:latest@low
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
    console.error("[xllm] note: 'multi' is now 'review roles' (alias through v0.27.x)");
    run(advisor, ['--multi', ...rest]);
    break;
  case 'smoke':
    run(smoke, rest);
    break;
  case 'clean':
  case 'clean-artifacts':
    run(advisor, ['--clean-artifacts', ...rest]);
    break;
  case 'discipline':
    run(advisor, ['--discipline', ...rest]);
    break;
  case 'inventory':
    run(advisor, ['--inventory', ...rest]);
    break;
  case 'contracts':
    run(contracts, rest);
    break;
  case 'review':
    run(review, rest);
    break;
  case 'panel':
    console.error("[xllm] note: 'panel' is now 'review blind|stats|outcome' (alias through v0.27.x)");
    run(panel, rest);
    break;
  case 'debate':
    console.error("[xllm] note: 'debate' is now 'review debate' (alias through v0.27.x)");
    run(debate, rest);
    break;
  case 'council':
    console.error("[xllm] note: 'council' is now 'review council' (alias through v0.27.x)");
    run(council, rest);
    break;
  case 'traits':
    run(traits, rest);
    break;
  case 'propose':
    if (rest.length < 2) {
      console.error('Usage: xllm propose <provider> <change request>');
      process.exit(1);
    }
    run(advisor, ['--propose', ...rest]);
    break;
  case 'scribe':
    if (rest.length < 1) {
      console.error('Usage: xllm scribe commit|pr|release|notes [flags]');
      process.exit(1);
    }
    run(scribe, rest);
    break;
  case 'exec':
    if (rest[0] === 'list' || rest[0] === 'cleanup') {
      run(exec, rest);
    } else {
      if (rest.length < 2) {
        console.error('Usage: xllm exec <provider-spec> <task> [--test-cmd "npm test"]');
        process.exit(1);
      }
      run(exec, ['run', ...rest]);
    }
    break;
  case 'profile': {
    const [sub, ...pr] = rest;
    if (sub === 'show') run(advisor, ['--profile-show']);
    else if (sub === 'set-role' && pr.length >= 2) {
      run(advisor, ['--set-role', pr[0], pr[1]]);
    } else if (sub === 'set-default' && pr.length >= 2) {
      run(advisor, ['--set-default', pr[0], pr[1]]);
    } else {
      console.error(
        'Usage: xllm profile show | set-role <role> <spec> | set-default <key> <value>'
      );
      process.exit(1);
    }
    break;
  }
  case 'dry-run':
    run(advisor, ['--dry-run', ...rest]);
    break;
  case 'pick':
  case 'infer':
  case 'roles':
    run(routing, [cmd, ...rest]);
    break;
  case 'setup':
    run(advisor, ['--setup', ...rest]);
    break;
  default:
    if (rest.length >= 1) {
      run(advisor, [cmd, ...rest]);
    }
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
