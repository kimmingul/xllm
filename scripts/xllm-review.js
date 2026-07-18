#!/usr/bin/env node
/**
 * xllm review — one entry point for the deliberation family (umbrella-5).
 *
 *   roles   → advisor --multi  (coverage; synthesis labels, NOT measured)
 *   blind   → panel run        (measured: identical prompt, ledger, agreement)
 *   debate  → debate run       (adversarial refutation)
 *   council → council run      (blind → debate pipeline)
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

export const REVIEW_USAGE = `xllm review — cross-vendor deliberation (one noun, four modes)
Usage:
  xllm review roles   p1,p2[,p3] "<prompt>"
  xllm review blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
  xllm review debate  p1,p2[,p3] "<claim>"
  xllm review council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
  xllm review stats [--json]
  xllm review outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no

Diff input (any deliberation mode; collected deterministically, never persisted):
  --staged | --base <ref> | --diff-file <path>

roles = coverage (synthesis labels, NOT measured) · blind = measured panel
(ledger + pairwise agreement) · debate = adversarial refutation · council =
blind→debate.`;

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
