#!/usr/bin/env node
/**
 * xllm structured — shared structured-output layer for the review family
 * (panel / debate / council).
 *
 * These commands depend on advisors emitting JSON contracts. Frontier models
 * comply; weaker and local models frequently do not (observed: ollama omits
 * or mangles the block, TTY line-wrapping breaks string literals). This module
 * consolidates the previously-scattered parsing into ONE robust extractor and
 * adds a uniform "ask → parse → one corrective retry" wrapper so every
 * provider — not just the strong ones — participates reliably. It also reports
 * per-provider CONTRACT ADHERENCE (first-try / after-retry / failed) so you
 * can see which models are dependable for structured review.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

import { PROMPT_FILE_THRESHOLD } from './xllm-diff.js';

const ADVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xllm-advisor.js');

/**
 * Re-exported from xllm-diff (single source of truth): prompts longer than
 * this are handed to the advisor via --prompt-file instead of argv — Windows
 * caps the whole CreateProcess command line at ~32K chars, and this
 * caller→advisor hop would otherwise fail before the advisor can even pick
 * stdin delivery for the provider. Cross-platform for determinism (a temp
 * file is also less exposed than a process list entry).
 */
export { PROMPT_FILE_THRESHOLD };

// ---------------------------------------------------------------------------
// Robust JSON extraction
// ---------------------------------------------------------------------------

/**
 * Collapse ollama TTY wrap-duplication. The ollama CLI redraws the tail of a
 * wrapped line; captured through a pipe the cursor-control codes do nothing,
 * so after CSI stripping BOTH the truncated fragment and its reprint survive:
 * `strict equ\nequality`, `"evidence":\n"evidence":` (observed live
 * 2026-07-12 — fatal when the wrap lands on a JSON key, which is why debate's
 * long claims blocks failed where panel's compact verdicts survived).
 * Rule: at each newline, if the last non-space run before it (≥3 chars) is a
 * prefix of the first non-space run after it, the fragment is the spurious
 * half — drop it. Used only as a LAST-RESORT parse variant: the first
 * successful variant wins in tryParse, so clean output (including legitimate
 * soft wraps like `the\ntheme`) is never collapsed.
 */
export function collapseWrapDuplicates(text) {
  return String(text).replace(/(\S{3,})[ \t]*\r?\n[ \t]*(\S+)/g, (match, tail, head) =>
    head.startsWith(tail) ? head : match
  );
}

function tryParse(text) {
  const t = String(text).trim();
  const collapsed = collapseWrapDuplicates(t);
  const variants = [
    t,
    t.replace(/\r?\n/g, ' '), // TTY newline-wrapping inside string literals
    t.replace(/,(\s*[}\]])/g, '$1'), // trailing commas
    t.replace(/\r?\n/g, ' ').replace(/,(\s*[}\]])/g, '$1'),
    // last resort: TTY wrap-duplication repair (see collapseWrapDuplicates)
    collapsed,
    collapsed.replace(/\r?\n/g, ' '),
    collapsed.replace(/\r?\n/g, ' ').replace(/,(\s*[}\]])/g, '$1'),
  ];
  for (const v of variants) {
    try {
      return JSON.parse(v);
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Last brace/bracket-balanced substring, for models that emit bare JSON. */
export function lastBalanced(s) {
  const str = String(s || '');
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const end = str.lastIndexOf(close);
    if (end === -1) continue;
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (str[i] === close) depth++;
      else if (str[i] === open) {
        depth--;
        if (depth === 0) return str.slice(i, end + 1);
      }
    }
  }
  return null;
}

/**
 * Extract a JSON value from arbitrary model output. Tries, in order:
 * every fenced ```json block (LAST valid wins), then the last balanced
 * brace/bracket substring — each through repair passes. Returns the parsed
 * value or null. Pure and deterministic.
 */
export function extractJson(raw) {
  const s = String(raw || '');
  const candidates = [];
  for (const m of s.matchAll(/```(?:json)?\s*\r?\n?([\s\S]*?)```/gi)) candidates.push(m[1]);
  candidates.reverse(); // last fenced block wins
  const bare = lastBalanced(s);
  if (bare) candidates.push(bare);
  for (const c of candidates) {
    const v = tryParse(c);
    if (v !== undefined) return v;
  }
  return null;
}

/** Read the raw model output back out of an advisor artifact (format we own). */
export function rawFromArtifact(artifactPath) {
  try {
    const body = fs.readFileSync(artifactPath, 'utf8');
    const m = body.match(
      /## Raw output\r?\n\r?\n```text\r?\n([\s\S]*?)\r?\n```\r?\n\r?\n## Summary/
    );
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Ask an advisor, get raw output (consolidates panel spawnOnce / debate askOnce)
// ---------------------------------------------------------------------------

export function askAdvisorRaw(spec, prompt, { advisor = ADVISOR, env = process.env } = {}) {
  return new Promise((resolve) => {
    let promptArgs = [spec, prompt];
    let tmpFile = null;
    if (String(prompt).length > PROMPT_FILE_THRESHOLD) {
      try {
        tmpFile = path.join(
          os.tmpdir(),
          `xllm-prompt-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`
        );
        fs.writeFileSync(tmpFile, prompt, 'utf8');
        promptArgs = [spec, '--prompt-file', tmpFile];
      } catch {
        tmpFile = null; // best-effort: fall back to argv (may hit the OS limit)
        promptArgs = [spec, prompt];
      }
    }
    const cleanup = () => {
      if (tmpFile) {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* best-effort */
        }
      }
    };
    const child = spawn(process.execPath, [advisor, ...promptArgs], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', () => {
      cleanup();
      resolve({ code: 1, raw: '', artifact: null });
    });
    child.on('close', (code) => {
      cleanup();
      const artifact = code === 0 && out.trim() ? out.trim().split(/\r?\n/).pop() : null;
      resolve({ code: code ?? 1, raw: artifact ? rawFromArtifact(artifact) : '', artifact });
    });
  });
}

// ---------------------------------------------------------------------------
// Ask for structured output with one corrective retry + adherence tracking
// ---------------------------------------------------------------------------

/**
 * Spawn the advisor, parse its structured output, and — if the parse/validate
 * fails — re-ask ONCE with a targeted reminder. This is what makes weak/local
 * models usable for structured review instead of silently abstaining.
 *
 * @param parse    (raw) => value|null   parse+validate; null means non-compliant
 * @param repairHint  appended to the prompt on the retry
 * @returns { value, raw, attempts, adherence: 'first'|'retry'|'failed', code }
 */
export async function askStructured({
  spec,
  prompt,
  parse,
  repairHint = 'Your previous output did not contain the required fenced ```json block. Output ONLY the valid json block now, matching the schema above.',
  maxAttempts = 2,
  advisor = ADVISOR,
  env = process.env,
}) {
  let last = { code: 1, raw: '', artifact: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const p = attempt === 1 ? prompt : `${prompt}\n\nREMINDER: ${repairHint}`;
    last = await askAdvisorRaw(spec, p, { advisor, env });
    if (last.code === 0) {
      const value = parse(last.raw);
      if (value != null) {
        return {
          value,
          raw: last.raw,
          artifact: last.artifact,
          attempts: attempt,
          adherence: attempt === 1 ? 'first' : 'retry',
          code: 0,
        };
      }
    }
  }
  return {
    value: null,
    raw: last.raw,
    artifact: last.artifact,
    attempts: maxAttempts,
    adherence: 'failed',
    code: last.code,
  };
}

/** Summarize adherence records into a per-provider health table. */
export function adherenceSummary(records) {
  const by = {};
  for (const r of records) {
    const k = r.spec;
    by[k] = by[k] || { first: 0, retry: 0, failed: 0 };
    by[k][r.adherence] = (by[k][r.adherence] || 0) + 1;
  }
  return by;
}
