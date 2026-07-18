#!/usr/bin/env node
/**
 * xllm diff context — deterministic git-diff collector for the review family.
 *
 * Modeled on scribe's collectors: gathered with plain git, size-capped, and
 * NEVER persisted — the diff body goes only into the advisor prompt; ledgers
 * and indexes record metadata (source/stat/bytes/truncated), not the diff.
 * Standalone on purpose (no project imports) so it stays ESM-cycle-free:
 * xllm-advisor.js AND panel/debate/council all import this module.
 */

import fs from 'fs';
import { spawnSync } from 'child_process';

export const DIFF_MAX_BYTES = 24 * 1024;

/** Extract --staged / --base <ref> / --diff-file <path> from argv. Pure. */
export function parseDiffFlags(argv) {
  const rest = [];
  const diffOpts = { staged: false, base: null, diffFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') diffOpts.staged = true;
    else if (a === '--base') {
      if (!argv[i + 1]) return { error: '--base requires a ref' };
      diffOpts.base = argv[++i];
    } else if (a === '--diff-file') {
      if (!argv[i + 1]) return { error: '--diff-file requires a path' };
      diffOpts.diffFile = argv[++i];
    } else rest.push(a);
  }
  const sources = [diffOpts.staged, diffOpts.base, diffOpts.diffFile].filter(Boolean).length;
  if (sources > 1) {
    return { error: 'pick exactly one diff source: --staged | --base <ref> | --diff-file <path>' };
  }
  return { diffOpts, rest };
}

export function hasDiffSource(diffOpts) {
  return !!(diffOpts && (diffOpts.staged || diffOpts.base || diffOpts.diffFile));
}

function git(args, root) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Slice string by byte range, UTF-8-boundary-safe (strips replacement char artifacts). */
function byteSlice(s, start, end) {
  const buf = Buffer.from(s, 'utf8');
  return buf.subarray(start, end).toString('utf8').replace(/^�+|�+$/g, '');
}

/** Head+tail truncation at the byte cap, UTF-8-accurate. Pure. */
export function truncateDiff(text, max = DIFF_MAX_BYTES) {
  const s = String(text || '');
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= max) return { text: s, truncated: false };
  const headBytes = Math.floor(max * 0.7);
  const tailBytes = Math.floor(max * 0.2);
  const head = byteSlice(s, 0, headBytes);
  const tail = byteSlice(s, total - tailBytes, total);
  return {
    text: `${head}\n\n[... TRUNCATED ${total - headBytes - tailBytes} bytes ...]\n\n${tail}`,
    truncated: true,
  };
}

/**
 * Collect the diff for exactly one source. Deterministic (plain git / file
 * read). Returns { source, body, stat, bytes, truncated } or { error }.
 */
export function collectReviewDiff(diffOpts, root = process.cwd()) {
  if (diffOpts.diffFile) {
    let body;
    try {
      body = fs.readFileSync(diffOpts.diffFile, 'utf8');
    } catch {
      return { error: `cannot read diff file: ${diffOpts.diffFile}` };
    }
    if (!body.trim()) return { error: `diff file is empty: ${diffOpts.diffFile}` };
    const t = truncateDiff(body);
    return {
      source: `file:${diffOpts.diffFile}`,
      body: t.text,
      stat: null,
      bytes: Buffer.byteLength(body, 'utf8'),
      truncated: t.truncated,
    };
  }
  if (git(['rev-parse', '--git-dir'], root).status !== 0) {
    return { error: 'not a git repository' };
  }
  if (diffOpts.base && git(['rev-parse', '--verify', '--quiet', diffOpts.base], root).status !== 0) {
    return { error: `unknown ref: ${diffOpts.base}` };
  }
  const range = diffOpts.staged ? ['--staged'] : [diffOpts.base];
  const stat = git(['diff', '--stat', ...range], root).stdout.trim();
  const body = git(['diff', ...range], root).stdout;
  if (!body.trim()) {
    return {
      error: diffOpts.staged ? 'nothing staged (git add … first)' : `no changes vs ${diffOpts.base}`,
    };
  }
  const t = truncateDiff(body);
  return {
    source: diffOpts.staged ? 'staged' : `base:${diffOpts.base}`,
    body: t.text,
    stat,
    bytes: Buffer.byteLength(body, 'utf8'),
    truncated: t.truncated,
  };
}

/** Prompt block appended to the question — the ONLY place the body travels. Pure. */
export function buildReviewContext(diff) {
  return [
    '',
    '---',
    `CODE UNDER REVIEW (${diff.source}${diff.truncated ? ', truncated to 24KB' : ''}):`,
    ...(diff.stat ? ['', diff.stat] : []),
    '',
    '```diff',
    diff.body,
    '```',
  ].join('\n');
}

/** Persistable metadata — never the body. Pure. */
export function diffMeta(diff) {
  return { source: diff.source, stat: diff.stat, bytes: diff.bytes, truncated: diff.truncated };
}
