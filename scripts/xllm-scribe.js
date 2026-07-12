#!/usr/bin/env node
/**
 * xllm scribe — cheap-prose lane for mechanical git chores.
 *
 * Split of labor (the whole point):
 *   [deterministic collectors]  gather diff/log context — no LLM
 *   [cheapest healthy advisor]  writes ONLY the prose (read-only)
 *   [host / user]               runs the actual git/gh command
 *
 * Nothing is executed and nothing is persisted here — the message goes to
 * stdout (diagnostics to stderr) so it pipes straight into git. The diff is
 * NOT written to any artifact: the git object itself is the record.
 *
 *   node scripts/xllm-scribe.js commit  [--style conventional] [--provider <spec>]
 *   node scripts/xllm-scribe.js pr      [--base <ref>] [--provider <spec>]
 *   node scripts/xllm-scribe.js release --from <ref> [--to <ref>] [--provider <spec>]
 *   node scripts/xllm-scribe.js notes   --from <ref> [--to <ref>] [--provider <spec>]
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import {
  runAdvisor,
  parseProviderSpec,
  detectAvailableProviders,
  getProviderCostMeta,
  loadProviderProfiles,
  cleanModelText,
} from './xllm-advisor.js';
import { pickAdvisorForRole } from './xllm-routing.js';

const MAX_CONTEXT_BYTES = 24 * 1024;

export const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

// ---------------------------------------------------------------------------
// Deterministic context collectors (no LLM)
// ---------------------------------------------------------------------------

function git(args, root = process.cwd()) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function truncateContext(text, max = MAX_CONTEXT_BYTES) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return {
    text: `${head}\n\n[... TRUNCATED ${s.length - head.length - tail.length} chars ...]\n\n${tail}`,
    truncated: true,
  };
}

export function defaultBaseRef(root = process.cwd()) {
  for (const ref of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], root).status === 0) return ref;
  }
  return 'HEAD~10';
}

export function collectChoreContext(chore, opts = {}, root = process.cwd()) {
  if (git(['rev-parse', '--git-dir'], root).status !== 0) {
    return { error: 'Not a git repository.' };
  }
  const branch = git(['branch', '--show-current'], root).stdout.trim();

  if (chore === 'commit') {
    const stat = git(['diff', '--staged', '--stat'], root).stdout.trim();
    if (!stat) {
      return { error: 'Nothing staged. Stage changes first (git add …).' };
    }
    const diff = git(['diff', '--staged'], root).stdout;
    const t = truncateContext(diff);
    return {
      branch,
      body: `# Branch\n${branch}\n\n# Staged diffstat\n${stat}\n\n# Staged diff\n${t.text}`,
      truncated: t.truncated,
    };
  }

  if (chore === 'pr') {
    const base = opts.base || defaultBaseRef(root);
    const log = git(['log', '--oneline', `${base}..HEAD`], root).stdout.trim();
    if (!log) return { error: `No commits ahead of ${base}.` };
    const stat = git(['diff', '--stat', `${base}..HEAD`], root).stdout.trim();
    const t = truncateContext(`# Branch\n${branch} (base: ${base})\n\n# Commits\n${log}\n\n# Diffstat\n${stat}`);
    return { branch, base, body: t.text, truncated: t.truncated };
  }

  if (chore === 'release' || chore === 'notes') {
    const from = opts.from;
    if (!from) return { error: `--from <tag/ref> is required for ${chore}.` };
    const to = opts.to || 'HEAD';
    const log = git(['log', '--oneline', `${from}..${to}`], root).stdout.trim();
    if (!log) return { error: `No commits in ${from}..${to}.` };
    const t = truncateContext(`# Range\n${from}..${to}\n\n# Commits\n${log}`);
    return { from, to, body: t.text, truncated: t.truncated };
  }

  return { error: `Unknown chore: ${chore}` };
}

// ---------------------------------------------------------------------------
// Prompt templates (strict output contracts)
// ---------------------------------------------------------------------------

const COMMON_RULES = `Rules (strict):
- Mention ONLY facts present in the input. Never invent issue IDs, test results, breaking changes, or file names.
- Output plain text only — no markdown code fences, no preamble, no explanation of what you did.`;

export const SCRIBE_TEMPLATES = {
  commit: (ctx) => `Write a git commit message for the staged changes below.

Format (Conventional Commits):
- Subject: \`type(scope): summary\` — type ∈ {${CONVENTIONAL_TYPES.join(', ')}}, subject ≤ 72 chars, imperative mood, no trailing period.
- Then a blank line, then 1–5 short bullet lines ("- …") describing WHAT changed, only if the diff warrants it.
${COMMON_RULES}
- Output ONLY the commit message.

${ctx.body}`,
  pr: (ctx) => `Write a pull request title and body for the branch below.

Format:
- Line 1: PR title (≤ 80 chars, imperative).
- Blank line, then markdown body with exactly these sections: ## Summary (2-3 sentences), ## Changes (bullets from the commits/diffstat).
${COMMON_RULES}

${ctx.body}`,
  release: (ctx) => `Write release notes for the commit range below.

Format:
- Group bullets under ### Added / ### Fixed / ### Changed (omit empty groups).
- One bullet per meaningful change, past tense, user-facing wording.
${COMMON_RULES}

${ctx.body}`,
  notes: (ctx) => `Write a CHANGELOG entry for the commit range below.

Format:
- Markdown bullets grouped under ### Added / ### Fixed / ### Changed (omit empty groups), terse and factual.
${COMMON_RULES}

${ctx.body}`,
};

// ---------------------------------------------------------------------------
// Deterministic validators
// ---------------------------------------------------------------------------

export function stripFences(text) {
  let s = cleanModelText(String(text || '')).trim();
  const fence = s.match(/^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (fence) s = fence[1].trim();
  return s.replace(/```/g, '').trim();
}

export function validateScribeOutput(chore, text) {
  const problems = [];
  const s = String(text || '').trim();
  if (!s) return { ok: false, problems: ['empty output'] };
  const lines = s.split(/\r?\n/);

  if (chore === 'commit') {
    const subject = lines[0].trim();
    if (subject.length > 72) problems.push(`subject ${subject.length} chars (max 72)`);
    const re = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(\\([^)]+\\))?!?: .+`);
    if (!re.test(subject)) problems.push('subject is not Conventional Commits format');
    if (/\.$/.test(subject)) problems.push('subject ends with a period');
    if (lines.length > 1 && lines[1].trim() !== '') problems.push('missing blank line after subject');
    if (lines.length > 12) problems.push('body too long (max ~10 lines)');
  } else if (chore === 'pr') {
    if (lines[0].trim().length > 80) problems.push('title > 80 chars');
    if (!/## Summary/.test(s)) problems.push('missing ## Summary section');
    if (!/## Changes/.test(s)) problems.push('missing ## Changes section');
  } else {
    if (!/^[-#]|^###/m.test(s)) problems.push('expected markdown bullets/sections');
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Provider selection (cost-routed, escalation for release-grade prose)
// ---------------------------------------------------------------------------

export function pickScribeProvider(chore, { providerSpec = null, ready = null, profiles = null } = {}) {
  if (providerSpec) {
    const parsed = parseProviderSpec(providerSpec);
    if (!parsed) return { error: `Unknown provider spec: ${providerSpec}` };
    return { spec: parsed.spec, parsed, source: 'explicit' };
  }
  const readySet = ready || detectAvailableProviders();
  const prof = profiles || loadProviderProfiles();
  const pick = pickAdvisorForRole('scribe', {
    taskText: `write ${chore} message`,
    forceCli: true,
    readyProviders: readySet,
    profiles: prof,
  });
  // Release/changelog narrative needs judgment — escalate off local models
  // when any cloud advisor is healthy.
  if (
    (chore === 'release' || chore === 'notes') &&
    getProviderCostMeta(pick.provider, prof).tier === 'local'
  ) {
    const nonLocal = readySet.filter(
      (p) => getProviderCostMeta(p, prof).tier !== 'local'
    );
    if (nonLocal.length) {
      const esc = pickAdvisorForRole('scribe', {
        taskText: `write ${chore} notes`,
        forceCli: true,
        readyProviders: nonLocal,
        profiles: prof,
      });
      return { spec: esc.spec, parsed: esc, source: 'escalated' };
    }
  }
  return { spec: pick.spec, parsed: pick, source: pick.pinned ? 'pinned' : 'routed' };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runScribe({ chore, opts = {}, root = process.cwd() }) {
  const ctx = collectChoreContext(chore, opts, root);
  if (ctx.error) {
    console.error(`[scribe] ${ctx.error}`);
    return { exitCode: 1, error: ctx.error };
  }
  if (ctx.truncated) console.error('[scribe] context truncated to size cap');

  const picked = pickScribeProvider(chore, { providerSpec: opts.provider });
  if (picked.error) {
    console.error(`[scribe] ${picked.error}`);
    return { exitCode: 1, error: picked.error };
  }
  console.error(`[scribe] ${chore} via ${picked.spec} (${picked.source})`);

  const basePrompt = SCRIBE_TEMPLATES[chore](ctx);
  let attempt = 0;
  let text = '';
  let verdict = { ok: false, problems: [] };

  while (attempt < 2) {
    attempt += 1;
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous output was rejected: ${verdict.problems.join('; ')}. Fix these problems and output ONLY the corrected text.`;
    const r = runAdvisor({
      provider: picked.parsed.provider,
      model: picked.parsed.model || null,
      effort: picked.parsed.effort || 'low',
      prompt,
      noArtifacts: true, // scribe never persists the diff
      quiet: true,
    });
    if (r.exitCode !== 0) {
      console.error(`[scribe] advisor failed (exit ${r.exitCode})`);
      return { exitCode: 1, error: 'advisor failed' };
    }
    text = stripFences(r.raw);
    verdict = validateScribeOutput(chore, text);
    if (verdict.ok) break;
    console.error(`[scribe] attempt ${attempt} rejected: ${verdict.problems.join('; ')}`);
  }

  if (!verdict.ok) {
    console.error('[scribe] validation failed after retry — raw output follows on stdout (review before use)');
    console.log(text);
    return { exitCode: 3, text };
  }

  console.log(text);
  console.error(
    chore === 'commit'
      ? `[scribe] apply: git commit -F <(…) or paste — xllm never runs git for you`
      : `[scribe] paste into your ${chore} tool — xllm never runs git/gh for you`
  );
  return { exitCode: 0, text };
}

async function main() {
  const argv = process.argv.slice(2);
  const chore = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--style') opts.style = argv[++i]; // reserved; conventional is the default
  }
  if (!chore || !SCRIBE_TEMPLATES[chore]) {
    console.error(`xllm scribe — cheap-prose lane for git chores (advisor writes prose; YOU run git)
Usage:
  node scripts/xllm-scribe.js commit  [--provider <spec>]
  node scripts/xllm-scribe.js pr      [--base <ref>] [--provider <spec>]
  node scripts/xllm-scribe.js release --from <ref> [--to <ref>] [--provider <spec>]
  node scripts/xllm-scribe.js notes   --from <ref> [--to <ref>] [--provider <spec>]

Message → stdout (pipe into git); diagnostics → stderr. The diff is sent to
the routed advisor (cheapest healthy, local-first; release/notes escalate to
cloud) and is never persisted by xllm. Exit 3 = validation failed, raw output
printed for review.`);
    process.exit(chore ? 1 : 0);
  }
  const res = await runScribe({ chore, opts });
  process.exit(res.exitCode);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-scribe.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
