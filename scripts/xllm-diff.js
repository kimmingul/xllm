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

/**
 * Prompts longer than this (in CHARS — the unit of the Windows ~32K
 * CreateProcess command-line cap) are handed to the advisor via --prompt-file
 * instead of argv. Single source of truth for BOTH the structured layer and
 * advisor --multi; lives here because this module is import-cycle-free
 * (structured imports advisor's sibling path, advisor imports this).
 */
export const PROMPT_FILE_THRESHOLD = 24000;

/** Extract --staged / --base <ref> / --diff-file <path> from argv. Pure. */
export function parseDiffFlags(argv) {
  const rest = [];
  const diffOpts = { staged: false, base: null, diffFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') diffOpts.staged = true;
    else if (a === '--base') {
      // git refs cannot start with '-', so a flag-like token is a missing value
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--base requires a ref' };
      diffOpts.base = argv[++i];
    } else if (a === '--diff-file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--diff-file requires a path' };
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

/**
 * Head+tail truncation at the byte cap, UTF-8-accurate. Pure. Cut points are
 * retreated to codepoint boundaries (continuation bytes are 0b10xxxxxx), so no
 * partial character — and no replacement-char artifact — is ever emitted, and
 * a genuine U+FFFD in the source survives. The marker reports the exact byte
 * count removed, including any boundary retreat.
 */
export function truncateDiff(text, max = DIFF_MAX_BYTES) {
  const s = String(text || '');
  const buf = Buffer.from(s, 'utf8');
  const total = buf.length;
  if (total <= max) return { text: s, truncated: false };
  let headEnd = Math.floor(max * 0.7);
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
  let tailStart = total - Math.floor(max * 0.2);
  while (tailStart < total && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  return {
    text: `${head}\n\n[... TRUNCATED ${tailStart - headEnd} bytes ...]\n\n${tail}`,
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
  const probe = git(['rev-parse', '--git-dir'], root);
  if (probe.error) return { error: 'git binary not found on PATH' };
  if (probe.status !== 0) return { error: 'not a git repository' };
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

/** The question advisors actually see: question + optional diff context. Pure. */
export function questionWithContext(question, context) {
  return context ? `${question}\n${context}` : question;
}

/** Persistable metadata — never the body. Pure. */
export function diffMeta(diff) {
  return { source: diff.source, stat: diff.stat, bytes: diff.bytes, truncated: diff.truncated };
}
