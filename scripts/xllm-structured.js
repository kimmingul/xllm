#!/usr/bin/env node
/**
 * xllm structured — shared structured-output layer for the review family
 * (panel / debate / council).
 *
 * Children are advisor processes invoked with `--json`: stdout is ONE
 * schema_version-2 result envelope (raw text, exit code, failure class,
 * attribution, usage, cost, native structured output). No Markdown artifact is
 * ever parsed, so `--no-artifacts` works and attribution/usage/cost flow
 * through unchanged. A child that does not return a valid envelope is a FAILED
 * call (never mistaken for model output).
 *
 * Contract strategy, in order:
 *   1. native schema: the contract's JSON schema is handed to the advisor via
 *      `--schema-file`; adapters that support constrained output return it in
 *      `envelope.structured`. This is claimed ONLY when the envelope actually
 *      carries `structured` — an adapter that ignored the schema is recorded
 *      as the prompt contract.
 *   2. prompt contract: the model ends with a fenced/bare JSON block, extracted
 *      by `extractJson` (fenced → bare; trailing-comma tolerant).
 *   3. one corrective retry before a model is counted non-compliant.
 * Per-provider CONTRACT ADHERENCE (first / retry / failed) is reported so you
 * can see which models are dependable for structured review.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

import { PROMPT_FILE_THRESHOLD } from './xllm-diff.js';
import { makeResult, RESULT_SCHEMA_VERSION } from './xllm-evidence.js';

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
// JSON extraction (fallback for adapters without native schema output)
// ---------------------------------------------------------------------------

function tryParse(text) {
  const t = String(text).trim();
  for (const v of [t, t.replace(/,(\s*[}\]])/g, '$1')]) {
    try {
      return JSON.parse(v);
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * Top-level brace/bracket-balanced substrings, string-aware (a `}` inside a
 * JSON string does not close anything). Quotes outside any structure (prose
 * apostrophes/quotes) are ignored.
 */
function balancedSpans(s) {
  const str = String(s || '');
  const spans = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inStr = true;
    } else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === '}' || ch === ']') && depth > 0) {
      depth--;
      if (depth === 0) spans.push(str.slice(start, i + 1));
    }
  }
  return spans;
}

/** Last balanced brace/bracket substring, for models that emit bare JSON. */
export function lastBalanced(s) {
  const spans = balancedSpans(s);
  return spans.length ? spans[spans.length - 1] : null;
}

/**
 * Extract a JSON object/array from model output. Tries, in order: the whole
 * text (what a native-schema adapter returns), every fenced ``` block (LAST
 * valid wins), then balanced spans from the end. Returns the parsed value or
 * null. Pure and deterministic.
 */
export function extractJson(raw) {
  const s = String(raw || '');
  const whole = tryParse(s);
  if (whole !== null && typeof whole === 'object') return whole;
  const candidates = [];
  for (const m of s.matchAll(/```(?:json)?\s*\r?\n?([\s\S]*?)```/gi)) candidates.push(m[1]);
  candidates.reverse(); // last fenced block wins
  candidates.push(...balancedSpans(s).reverse());
  for (const c of candidates) {
    const v = tryParse(c);
    if (v !== undefined && v !== null && typeof v === 'object') return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ask an advisor (child process, --json envelope)
// ---------------------------------------------------------------------------

/**
 * Whether this run must leave no persisted artifacts: the explicit flag or
 * XLLM_NO_ARTIFACTS=1 (same switch the advisor honors). Pure given env.
 */
export function noArtifactsRequested(flag = false, env = process.env) {
  return !!flag || env.XLLM_NO_ARTIFACTS === '1';
}

function writeTemp(label, content) {
  const file = path.join(
    os.tmpdir(),
    `xllm-${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Envelope for a child that never produced one (spawn error, protocol violation). */
function childFailure(kind, hint, raw = '') {
  return makeResult({ raw, exitCode: 1, failure: { kind, retryable: false, hint } });
}

/**
 * Validate a child's stdout as exactly one result envelope. A child that
 * printed anything else (an old advisor, a crash banner) is a protocol
 * failure: its stdout is NEVER treated as model output.
 */
export function parseChildEnvelope(stdout, exitCode) {
  const text = String(stdout || '').trim();
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    // tolerate leading noise: the envelope is the last line that parses
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && !obj; i--) {
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  const ok =
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    obj.schema_version === RESULT_SCHEMA_VERSION &&
    typeof obj.raw === 'string' &&
    typeof obj.exitCode === 'number';
  if (!ok) {
    return childFailure(
      'protocol',
      `advisor did not return a schema_version ${RESULT_SCHEMA_VERSION} --json result (exit ${exitCode ?? '?'})`
    );
  }
  const code = obj.exitCode === 0 && typeof exitCode === 'number' && exitCode !== 0 ? exitCode : obj.exitCode;
  const result = makeResult({ ...obj, exitCode: code });
  if (code !== obj.exitCode) {
    result.failure = result.failure || { kind: 'child-exit', retryable: false, hint: `advisor exited ${exitCode} after reporting success` };
  }
  return result;
}

/**
 * Ask one advisor and return its result envelope (always resolves; failures are
 * envelopes with exitCode ≠ 0 and a `failure` class).
 *
 * @param schema       JSON schema → temp file → `--schema-file` (native structured output)
 * @param noArtifacts  `--no-artifacts`: the child writes no advisor artifact
 */
export function askAdvisor(spec, prompt, { advisor = ADVISOR, env = process.env, schema = null, noArtifacts = false } = {}) {
  return new Promise((resolve) => {
    const temps = [];
    const cleanup = () => {
      for (const f of temps) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* best-effort */
        }
      }
    };
    let args;
    try {
      args = [advisor, spec];
      if (String(prompt).length > PROMPT_FILE_THRESHOLD) {
        const f = writeTemp('prompt', prompt);
        temps.push(f);
        args.push('--prompt-file', f);
      } else {
        args.push(prompt);
      }
      args.push('--json');
      if (noArtifacts) args.push('--no-artifacts');
      if (schema) {
        const f = writeTemp('schema', JSON.stringify(schema));
        temps.push(f);
        args.push('--schema-file', f);
      }
    } catch (err) {
      cleanup();
      resolve(childFailure('spawn', `cannot stage advisor call: ${err.message}`));
      return;
    }
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (err) => {
      cleanup();
      resolve(childFailure('spawn', `cannot start advisor: ${err.message}`));
    });
    child.on('close', (code) => {
      cleanup();
      resolve(parseChildEnvelope(out, code));
    });
  });
}

// ---------------------------------------------------------------------------
// Usage / cost / attribution aggregation across calls
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function sumInto(acc, add) {
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'number' && Number.isFinite(v)) acc[k] = (typeof acc[k] === 'number' ? acc[k] : 0) + v;
    else if (isPlainObject(v)) acc[k] = sumInto(isPlainObject(acc[k]) ? acc[k] : {}, v);
    else if (!(k in acc)) acc[k] = v;
  }
  return acc;
}

/** Sum provider usage objects (numbers added recursively; other fields first-seen). null if none reported. */
export function sumUsage(list) {
  const parts = list.filter(isPlainObject);
  if (!parts.length) return null;
  return parts.reduce((acc, u) => sumInto(acc, u), {});
}

/** Sum reported cost estimates. null if none reported (never 0 for "unknown"). */
export function sumCost(list) {
  const nums = list.filter((c) => typeof c === 'number' && Number.isFinite(c));
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

const IDENTITY_FIELDS = [
  'executed_provider',
  'transmitted_model',
  'reported_model',
  'model_revision',
  'identity_status',
  'effective_effort',
  'surface',
  'cli_version',
];
const identityOf = (a) => JSON.stringify(IDENTITY_FIELDS.map((f) => a[f] ?? null));

/**
 * Per-spec attribution across every call in a run. `attributions[spec]` exists
 * only when ALL executed calls for the spec had the identical identity (so it
 * can be keyed as evidence); any divergence is listed in `conflicts[spec]` and
 * the spec gets no attribution. Calls that never executed (no executed_provider)
 * are ignored. Pure.
 *
 * @param entries [{ spec, attribution }]
 */
export function mergeAttributions(entries) {
  const seen = new Map(); // spec → Map(identity → attribution)
  for (const { spec, attribution } of entries) {
    if (!attribution || !attribution.executed_provider) continue;
    if (!seen.has(spec)) seen.set(spec, new Map());
    const m = seen.get(spec);
    const k = identityOf(attribution);
    if (!m.has(k)) m.set(k, attribution);
  }
  const attributions = {};
  const conflicts = {};
  for (const [spec, m] of seen) {
    const all = [...m.values()];
    if (all.length === 1) attributions[spec] = all[0];
    else conflicts[spec] = all;
  }
  return { attributions, conflicts };
}

// ---------------------------------------------------------------------------
// Ask for structured output with one corrective retry + adherence tracking
// ---------------------------------------------------------------------------

/**
 * Ask an advisor for a contract-bound answer; if the output is missing or
 * invalid, re-ask ONCE with a targeted reminder. Makes weak/local models usable
 * for structured review instead of silently abstaining.
 *
 * @param validate    (obj, raw) => value|null   validate a parsed JSON value;
 *                    null means non-compliant
 * @param schema      JSON schema for native structured output (optional)
 * @param repairHint  appended to the prompt on the retry
 * @param ask         call seam, defaults to askAdvisor (child process)
 * @returns {
 *   value, raw, artifact, code, attempts, adherence: 'first'|'retry'|'failed',
 *   result (last envelope), attribution, usage, cost_estimate (summed over attempts),
 *   failure (null when value), schema_mode: 'native'|'prompt'|null,
 *   attempt_log: [{ attempt, exit_code, failure, duration_ms, usage, cost_estimate,
 *                   attribution, artifact, schema_requested, schema_mode, valid }]
 * }
 */
export async function askStructured({
  spec,
  prompt,
  validate,
  schema = null,
  repairHint = 'Your previous output did not contain the required fenced ```json block. Output ONLY the valid json block now, matching the schema above.',
  maxAttempts = 2,
  noArtifacts = false,
  advisor = ADVISOR,
  env = process.env,
  ask = askAdvisor,
}) {
  const attemptLog = [];
  const results = [];
  let winner = null;
  let value = null;
  let mode = null;
  for (let attempt = 1; attempt <= maxAttempts && value == null; attempt++) {
    const p = attempt === 1 ? prompt : `${prompt}\n\nREMINDER: ${repairHint}`;
    const result = await ask(spec, p, { advisor, env, schema, noArtifacts });
    results.push(result);
    let v = null;
    let m = null;
    if (result.exitCode === 0) {
      if (result.structured != null) {
        v = validate(result.structured, result.raw);
        if (v != null) m = 'native';
      }
      if (v == null) {
        const j = extractJson(result.raw);
        v = j == null ? null : validate(j, result.raw);
        if (v != null) m = 'prompt';
      }
    }
    attemptLog.push({
      attempt,
      exit_code: result.exitCode,
      failure: result.failure || null,
      duration_ms: result.durationMs ?? null,
      usage: result.usage ?? null,
      cost_estimate: result.cost_estimate ?? null,
      attribution: result.attribution ?? null,
      artifact: result.artifactPath ?? null,
      schema_requested: !!schema,
      schema_mode: m,
      valid: v != null,
    });
    if (v != null) {
      value = v;
      mode = m;
      winner = result;
    } else if (result.exitCode !== 0 && result.failure && result.failure.retryable === false) {
      // auth / timeout / unknown-model / spawn / protocol failures are not a
      // contract problem: re-asking cannot fix them and would spend another call.
      break;
    }
  }
  const last = winner || results[results.length - 1];
  const attempts = attemptLog.length;
  return {
    value,
    raw: last.raw,
    artifact: last.artifactPath ?? null,
    code: last.exitCode,
    attempts,
    adherence: value == null ? 'failed' : attempts === 1 ? 'first' : 'retry',
    result: last,
    attribution: last.attribution ?? null,
    usage: sumUsage(results.map((r) => r.usage)),
    cost_estimate: sumCost(results.map((r) => r.cost_estimate)),
    failure:
      value != null
        ? null
        : last.exitCode !== 0
          ? last.failure || { kind: 'provider-error', retryable: false, hint: `advisor exited ${last.exitCode}` }
          : { kind: 'contract-violation', retryable: false, hint: `no valid structured output after ${attempts} attempt(s)` },
    schema_mode: mode,
    attempt_log: attemptLog,
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
