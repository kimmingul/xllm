#!/usr/bin/env node
/**
 * xllm review — one entry point for the review family.
 *
 *   blind   → panel run        (measured: identical prompt, ledger, agreement) — default
 *   roles   → advisor --multi  (coverage; synthesis labels, NOT measured)
 *   debate  → debate run       (EXPERIMENTAL adversarial refutation)
 *   council → council run      (EXPERIMENTAL blind → debate pipeline)
 *   stats   → panel stats      · outcome → panel outcome
 *
 * Old top-level nouns (multi/panel/debate/council) were removed in v0.28.0.
 * Epistemology firewall: only blind/council write the ledger and
 * speak measured agreement; roles output carries measurement: false.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REVIEW_USAGE = `xllm review — cross-vendor review (blind is the default; debate/council are EXPERIMENTAL)
Usage:
  xllm review blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--json] [--no-artifacts]
  xllm review roles   p1,p2[,p3] "<prompt>"
  xllm review debate  p1,p2[,p3] "<claim>"                                  [--json] [--no-artifacts]   (experimental)
  xllm review council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]  [--json] [--no-artifacts]   (experimental)
  xllm review stats [--json]
  xllm review outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no

Diff input (any mode): --staged | --base <ref> | --diff-file <path>
  Collected deterministically and cut to a 24KB budget; omitted files/hunks are listed in a
  DIFF COVERAGE manifest. The diff body is NOT written to the ledger or md index, but the
  default per-advisor artifacts DO contain the prompt (diff included, secrets redacted);
  --no-artifacts suppresses them. --json prints one result object on stdout.

blind = measured panel (ledger + pairwise agreement; strict-identity evidence only) ·
roles = coverage (synthesis labels, NOT measured) · debate/council = experimental, benefit
unproven (re-evaluation pending): not a basis for high-stakes recommendations.
Local-only execution_policy and read-only eligibility apply to every advisor call.`;

const MODE_TARGETS = {
  roles: { script: 'advisor', prefix: ['--multi'] },
  blind: { script: 'panel', prefix: ['run'] },
  debate: { script: 'debate', prefix: ['run'] },
  council: { script: 'council', prefix: ['run'] },
  stats: { script: 'panel', prefix: ['stats'] },
  outcome: { script: 'panel', prefix: ['outcome'] },
};

/** Map review argv → target script + args. Pure. */
export function resolveReviewTarget(argv) {
  const [mode, ...rest] = argv;
  const target = MODE_TARGETS[mode];
  if (!target) return { error: mode ? `unknown review mode: ${mode}` : null };
  if (mode === 'roles' && rest.length < 2) {
    return { error: 'roles needs a provider list and a prompt' };
  }
  return { script: target.script, args: [...target.prefix, ...rest] };
}

const SCRIPT_FILES = {
  advisor: 'xllm-advisor.js',
  panel: 'xllm-panel.js',
  debate: 'xllm-debate.js',
  council: 'xllm-council.js',
};

function main() {
  const target = resolveReviewTarget(process.argv.slice(2));
  if (!target.script) {
    if (target.error) console.error(`[review] ${target.error}`);
    console.error(REVIEW_USAGE);
    process.exit(target.error ? 1 : 0);
  }
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, SCRIPT_FILES[target.script]), ...target.args],
    { shell: false, cwd: process.cwd(), stdio: 'inherit', windowsHide: true }
  );
  process.exit(res.status ?? 1);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-review.js');
  }
}

if (isMain()) main();
