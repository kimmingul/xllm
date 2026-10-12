#!/usr/bin/env node
/**
 * xllm bench — repeated, paired, human-adjudicated review evaluation.
 *
 * What it measures (all external LLM calls go through `xllm-advisor.js --json`,
 * never a direct vendor CLI spawn):
 *   - single:        each provider reviews every task alone, R repeats (>=3)
 *   - panel:         VIRTUAL union of the SAME single responses (no extra calls)
 *   - anchor-review: an anchor's single response is handed to a reviewer who
 *                    returns a final list (1 extra call per task x repeat)
 *   - final:         a synthesizer merges the panel members' responses into the
 *                    adopted finding list (1 extra call per task x repeat);
 *                    scored separately from the union
 *   - native:        responses captured INSIDE a real host and imported with
 *                    hash-verified prompt/response (no emulation, ever)
 *
 * Truth model. A regex hit on a response is only a CANDIDATE. Findings are
 * split into claims with stable IDs; a human adjudicates each claim (true
 * positive / false positive / duplicate, with an uncertainty level) through
 * `adjudicate`. Precision and recall exist only for adjudicated cells; the
 * comparison reports a pessimistic and an optimistic bound for "high
 * uncertainty" verdicts and refuses a verdict when they disagree.
 *
 * Live runs are opt-in only: --live plus explicit provider:model specs plus a
 * finite --max-calls advisor-invocation budget and --deadline-minutes. The
 * budget counts advisor invocations (a CLI agent loop or transport retry
 * inside one invocation is not counted); it is NOT a spend cap.
 *
 * State lives under <resolveStateDir>/benchmarks/{results,adjudications,cases}.
 * Run `node scripts/xllm-bench.js help` for commands.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'process';
import { parseProviderSpec, resolveStateDir } from './xllm-advisor.js';
import { evidenceKey } from './xllm-evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVISOR = path.join(HERE, 'xllm-advisor.js');
const TASKS_DIR = path.join(HERE, '..', 'benchmarks', 'tasks');
const TASKS_PATH = path.join(TASKS_DIR, 'tasks.json');

export const REPORT_SCHEMA_VERSION = 3;
export const ADJUDICATION_SCHEMA = 'xllm-bench-adjudication/1';
export const NATIVE_SCHEMA = 'xllm-native-baseline/1';
export const CASES_SCHEMA = 'xllm-bench-cases/1';
export const CLAIM_EXTRACTOR = 'v1';
export const MIN_EVAL_REPEATS = 3;
export const MIN_TASKS_FOR_VERDICT = 5;
const SPLITS = ['dev', 'heldout'];
const VERDICTS = ['true_positive', 'false_positive', 'duplicate'];
const UNCERTAINTIES = ['low', 'medium', 'high'];
const SCENARIOS = ['pessimistic', 'optimistic'];

// ---------------------------------------------------------------------------
// Paths (shared with routing/traits: one stable per-project location)
// ---------------------------------------------------------------------------

export function benchDir(root = process.cwd(), env = process.env) {
  return path.join(resolveStateDir(root, env), 'benchmarks');
}
export const benchResultsDir = (root, env) => path.join(benchDir(root, env), 'results');
export const benchAdjudicationsDir = (root, env) => path.join(benchDir(root, env), 'adjudications');
export const benchCasesDir = (root, env) => path.join(benchDir(root, env), 'cases');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x) => typeof x === 'string' && x.trim().length > 0;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Task sets
// ---------------------------------------------------------------------------

/** Resolve a task set: path, a bare name in benchmarks/tasks, or an imported case set. */
export function resolveTasksFile(nameOrPath, { root = process.cwd(), env = process.env } = {}) {
  if (!nameOrPath) return TASKS_PATH;
  if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isFile()) return nameOrPath;
  const file = nameOrPath.endsWith('.json') ? nameOrPath : `${nameOrPath}.json`;
  for (const dir of [TASKS_DIR, benchCasesDir(root, env)]) {
    const named = path.join(dir, file);
    if (fs.existsSync(named)) return named;
  }
  throw new Error(`task file not found: ${nameOrPath}`);
}

/** provenance.kind is 'real-retrospective' (user-attested) or 'synthetic'; never inferred. */
export function validateProvenance(p, where) {
  const errs = [];
  if (!isObj(p)) return [`${where}: provenance object required`];
  if (p.kind === 'real-retrospective') {
    for (const k of ['repo', 'fix_ref', 'summary']) {
      if (!nonEmpty(p[k])) errs.push(`${where}: real-retrospective provenance needs non-empty ${k}`);
    }
    if (p.user_attested !== true) errs.push(`${where}: real-retrospective provenance needs user_attested: true`);
  } else if (p.kind === 'synthetic') {
    if (!nonEmpty(p.note)) errs.push(`${where}: synthetic provenance needs a note saying how it was authored`);
  } else {
    errs.push(`${where}: provenance.kind must be 'real-retrospective' or 'synthetic'`);
  }
  return errs;
}

export function validateTaskSet(spec) {
  const errs = [];
  if (!isObj(spec) || !Array.isArray(spec.tasks) || !spec.tasks.length) return ['tasks[] required'];
  if (!nonEmpty(spec.question)) errs.push('question required');
  if (spec.split != null && !SPLITS.includes(spec.split)) errs.push(`split must be ${SPLITS.join('|')}`);
  const ids = new Set();
  for (const t of spec.tasks) {
    const where = `task ${t && t.id}`;
    if (!isObj(t) || !nonEmpty(t.id)) {
      errs.push('task without id');
      continue;
    }
    if (ids.has(t.id)) errs.push(`${where}: duplicate id`);
    ids.add(t.id);
    if (t.split != null && !SPLITS.includes(t.split)) errs.push(`${where}: split must be ${SPLITS.join('|')}`);
    const material = [t.code, t.diff].some(nonEmpty) || (Array.isArray(t.files) && t.files.length);
    if (!material) errs.push(`${where}: needs code, diff or files`);
    for (const f of t.files || []) {
      if (!isObj(f) || !nonEmpty(f.path) || typeof f.content !== 'string') errs.push(`${where}: files[] need path+content`);
    }
    if (!Array.isArray(t.defects) || !t.defects.length) {
      errs.push(`${where}: defects[] required`);
      continue;
    }
    const dids = new Set();
    for (const d of t.defects) {
      if (!isObj(d) || !nonEmpty(d.id) || !nonEmpty(d.pattern) || !nonEmpty(d.description)) {
        errs.push(`${where}: defect needs id, pattern, description`);
        continue;
      }
      if (dids.has(d.id)) errs.push(`${where}: duplicate defect id ${d.id}`);
      dids.add(d.id);
      try {
        new RegExp(d.pattern, 'i');
      } catch (e) {
        errs.push(`${where}: defect ${d.id} pattern invalid: ${e.message}`);
      }
    }
    const prov = t.provenance || spec.provenance;
    if (prov != null) errs.push(...validateProvenance(prov, where));
    else if ((t.split || spec.split || 'dev') === 'heldout') errs.push(`${where}: held-out tasks must carry provenance`);
  }
  return errs;
}

export function loadTasks(file = TASKS_PATH) {
  const spec = readJson(file);
  const errs = validateTaskSet(spec);
  if (errs.length) throw new Error(`invalid task set ${file}:\n  ${errs.join('\n  ')}`);
  return spec;
}

export const taskSplit = (spec, t) => t.split || spec.split || 'dev';
export const taskProvenance = (spec, t) => t.provenance || spec.provenance || { kind: 'unlabeled' };

/** Deterministic regex candidates: which known defects does this text MENTION? Not truth. */
export function gradeAnswer(task, answerText) {
  const text = String(answerText || '');
  const hits = [];
  const misses = [];
  for (const d of task.defects) {
    if (new RegExp(d.pattern, 'i').test(text)) hits.push(d.id);
    else misses.push(d.id);
  }
  return { hits, misses };
}

/** Expected delivery surface from the spec alone; reports use the measured attribution.surface. */
export function providerSurface(spec) {
  const provider = String(spec || '').split(/[:@]/)[0].toLowerCase();
  if (provider === 'ollama' || provider === 'lmstudio') return 'http-completion';
  if (provider === 'lemonade') return 'binary-stub';
  return 'cli-agentic';
}

/**
 * Task-difficulty filter (moved from the retired calibrate tool): a task
 * qualifies as "hard" only when EVERY model's detection rate is <= threshold;
 * a model with no usable rate (null) disqualifies the task.
 */
export function qualifies(rates, threshold) {
  const vals = Object.values(rates);
  if (!vals.length || vals.some((r) => r == null)) return false;
  return vals.every((r) => r <= threshold);
}

/**
 * Pairwise error correlation over task×defect cells: fraction of cells where
 * two providers agree (both hit or both miss). Cells are intersected, so an
 * errored provider never contributes invented "both missed" cells.
 */
export function errorCorrelation(cellsA, cellsB) {
  const keys = Object.keys(cellsA).filter((k) => k in cellsB);
  if (!keys.length) return null;
  let agree = 0;
  let bothMiss = 0;
  for (const k of keys) {
    if (cellsA[k] === cellsB[k]) agree += 1;
    if (!cellsA[k] && !cellsB[k]) bothMiss += 1;
  }
  return {
    cells: keys.length,
    agreement_rate: +(agree / keys.length).toFixed(3),
    shared_blind_spots: bothMiss,
  };
}

function taskMaterial(task) {
  const parts = [];
  if (nonEmpty(task.code)) parts.push(`\`\`\`js\n${task.code}\n\`\`\``);
  if (nonEmpty(task.diff)) parts.push(`### Change under review (unified diff)\n\`\`\`diff\n${task.diff}\n\`\`\``);
  for (const f of task.files || []) {
    const ext = path.extname(f.path).slice(1) || 'text';
    parts.push(`### File: ${f.path}\n\`\`\`${f.lang || ext}\n${f.content}\n\`\`\``);
  }
  return parts.join('\n\n');
}

export function buildBenchPrompt(spec, task) {
  return `${spec.question}\n\n${taskMaterial(task)}`;
}

export function buildReviewPrompt(spec, task, anchorRaw) {
  return (
    `${buildBenchPrompt(spec, task)}\n\n---\nAnother reviewer already reviewed the material above and reported:\n\n` +
    `<<<ANCHOR REVIEW\n${anchorRaw}\nANCHOR REVIEW>>>\n\n` +
    `Verify each reported finding against the material. Output the FINAL list of defects, one per line: ` +
    `keep findings you confirm, drop ones you judge wrong, and add any defect the first reviewer missed. ` +
    `Briefly say why each is a problem.`
  );
}

export function buildSynthesisPrompt(spec, task, memberRaws) {
  const blocks = memberRaws
    .map((raw, i) => `<<<REVIEWER ${String.fromCharCode(65 + i)}\n${raw}\nREVIEWER ${String.fromCharCode(65 + i)}>>>`)
    .join('\n\n');
  return (
    `${buildBenchPrompt(spec, task)}\n\n---\nIndependent reviewers reported:\n\n${blocks}\n\n` +
    `Produce the FINAL adopted list of defects, one per line. Merge duplicates, drop findings you judge ` +
    `incorrect after checking them against the material, and keep the ones you verify. Briefly say why each is a problem.`
  );
}

// ---------------------------------------------------------------------------
// Claims: stable, adjudicable units of a response
// ---------------------------------------------------------------------------

/** Split a response into candidate finding items. Deterministic; version CLAIM_EXTRACTOR. */
export function extractClaims(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const bullet = /^\s*(?:[-*•]|\d+[.)]|\(\d+\))\s+/;
  const items = [];
  let cur = null;
  const flush = () => {
    if (cur !== null) items.push(cur.trim());
    cur = null;
  };
  for (const line of text.split('\n')) {
    if (bullet.test(line)) {
      flush();
      cur = line.replace(bullet, '');
    } else if (!line.trim()) {
      flush();
    } else if (cur !== null) {
      cur += ` ${line.trim()}`;
    } else {
      cur = line.trim();
    }
  }
  flush();
  let kept = items.filter((s) => s.length >= 8 && !/^#{1,6}\s/.test(s) && !(/:$/.test(s) && s.length < 120));
  if (!kept.length && text.trim()) kept = [text.trim()];
  return kept.slice(0, 200).map((t, i) => ({ id: `c${i + 1}`, text: t, sha256: sha256(t).slice(0, 12) }));
}

function annotateClaims(task, claims) {
  return claims.map((c) => ({ ...c, regex_candidates: gradeAnswer(task, c.text).hits }));
}

// ---------------------------------------------------------------------------
// Advisor child (single place that talks to a model)
// ---------------------------------------------------------------------------

/**
 * One advisor invocation via `xllm-advisor.js <spec> --json --prompt-file`.
 * Returns { ok, raw, ms, envelope, error }. A missing/invalid envelope is a
 * failed call, never an empty review.
 */
export function askAdvisorJson(spec, prompt, { timeoutMs = 600000, env = process.env, advisor = ADVISOR } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tmp = null;
    try {
      tmp = path.join(os.tmpdir(), `xllm-bench-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`);
      fs.writeFileSync(tmp, prompt, 'utf8');
    } catch (e) {
      resolve({ ok: false, raw: '', ms: 0, envelope: null, error: { kind: 'spawn-error', message: String(e.message || e) } });
      return;
    }
    const cleanup = () => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    };
    // Controlled measurement, not nested task advising: allow same-vendor calls.
    const child = spawn(process.execPath, [advisor, spec, '--json', '--prompt-file', tmp], {
      env: { ...env, XLLM_ALLOW_SELF: '1' },
      windowsHide: true,
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, raw: '', ms: Date.now() - started, envelope: null, error: { kind: 'spawn-error', message: String(e.message || e) } });
    });
    child.on('close', () => {
      clearTimeout(timer);
      cleanup();
      const ms = Date.now() - started;
      if (timedOut) {
        resolve({ ok: false, raw: '', ms, envelope: null, error: { kind: 'bench-timeout', message: `no result within ${timeoutMs}ms` } });
        return;
      }
      resolve(interpretEnvelope(out, ms));
    });
  });
}

export function interpretEnvelope(stdout, ms = 0) {
  let env = null;
  const text = String(stdout || '').trim();
  for (const candidate of [text, text.split(/\r?\n/).pop()]) {
    try {
      env = JSON.parse(candidate);
      break;
    } catch {
      /* try next */
    }
  }
  if (!isObj(env) || typeof env.raw !== 'string' || env.schema_version !== 2) {
    return { ok: false, raw: '', ms, envelope: null, error: { kind: 'bad-envelope', message: 'advisor --json did not return a schema_version 2 envelope' } };
  }
  const ok = env.exitCode === 0 && !env.failure && env.raw.trim().length > 0;
  return {
    ok,
    raw: ok ? env.raw : '',
    ms: Number.isFinite(env.durationMs) ? env.durationMs : ms,
    envelope: env,
    error: ok ? null : env.failure || { kind: env.exitCode === 0 ? 'empty-response' : 'nonzero-exit', message: `exitCode ${env.exitCode}` },
  };
}

// ---------------------------------------------------------------------------
// Plan + live run
// ---------------------------------------------------------------------------

const ARM_EXTRAS = ['anchor-review', 'final'];

function specHasModel(raw) {
  const noEffort = String(raw).replace(/@[A-Za-z0-9_-]+$/, '');
  const i = noEffort.indexOf(':');
  return i > 0 && noEffort.slice(i + 1).length > 0;
}

function parseSpecs(list, errors, label) {
  const out = [];
  for (const raw of list) {
    if (!specHasModel(raw)) {
      errors.push(`${label} spec '${raw}' must name an explicit model (provider:model[@effort])`);
      continue;
    }
    const p = parseProviderSpec(raw);
    if (!p) {
      errors.push(`${label} unknown provider: ${raw}`);
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Validate options and compute the call plan. Pure apart from provider-spec parsing. */
export function planBench(opts) {
  const {
    providers = [],
    taskIds = null,
    tasksFile = null,
    split = 'all',
    repeats = null,
    regression = false,
    arms = [],
    anchor = null,
    reviewer = null,
    synthesizer = null,
    panel = null,
    live = false,
    maxCalls = null,
    deadlineMinutes = null,
    root = process.cwd(),
    env = process.env,
  } = opts;
  const errors = [];
  const warnings = [];
  const parsed = parseSpecs(providers, errors, 'provider');
  if (!parsed.length) errors.push('--providers requires at least one provider:model spec');
  const specs = parsed.map((p) => p.spec);
  if (new Set(specs).size !== specs.length) errors.push('duplicate provider specs');

  let spec = null;
  let tasks = [];
  let file = null;
  try {
    file = resolveTasksFile(tasksFile, { root, env });
    spec = loadTasks(file);
    tasks = spec.tasks.filter(
      (t) => (!taskIds || taskIds.includes(t.id)) && (split === 'all' || taskSplit(spec, t) === split)
    );
    if (taskIds) {
      for (const id of taskIds) if (!spec.tasks.some((t) => t.id === id)) errors.push(`unknown task id: ${id}`);
    }
    if (!tasks.length) errors.push('no tasks selected');
  } catch (e) {
    errors.push(String(e.message || e));
  }
  if (split !== 'all' && !SPLITS.includes(split)) errors.push(`--split must be all|${SPLITS.join('|')}`);

  let R = repeats;
  if (regression) {
    if (R == null) R = 1;
    if (R !== 1) errors.push('--regression is the explicit one-run mode; use --repeats 1 (or omit)');
  } else {
    if (R == null) R = MIN_EVAL_REPEATS;
    if (!Number.isInteger(R) || R < MIN_EVAL_REPEATS) {
      errors.push(`evaluation needs --repeats >= ${MIN_EVAL_REPEATS} (use --regression for a one-run regression check)`);
    }
  }

  for (const a of arms) if (!ARM_EXTRAS.includes(a)) errors.push(`unknown arm '${a}' (single is always run; extras: ${ARM_EXTRAS.join(', ')})`);
  let anchorSpec = null;
  let reviewerSpec = null;
  let synthSpec = null;
  let panelSpecs = null;
  if (arms.includes('anchor-review')) {
    const a = parseSpecs(anchor ? [anchor] : [], errors, '--anchor')[0];
    const r = parseSpecs(reviewer ? [reviewer] : [], errors, '--reviewer')[0];
    if (!a) errors.push('anchor-review needs --anchor SPEC (one of --providers)');
    if (!r) errors.push('anchor-review needs --reviewer SPEC');
    anchorSpec = a ? a.spec : null;
    reviewerSpec = r ? r.spec : null;
    if (anchorSpec && !specs.includes(anchorSpec)) errors.push('--anchor must be one of --providers (its single response is reused)');
  }
  if (arms.includes('final')) {
    const s = parseSpecs(synthesizer ? [synthesizer] : [], errors, '--synthesizer')[0];
    if (!s) errors.push('final needs --synthesizer SPEC');
    synthSpec = s ? s.spec : null;
    panelSpecs = panel ? parseSpecs(panel, errors, '--panel').map((p) => p.spec) : specs;
    if (panelSpecs.length < 2) errors.push('final synthesis needs a panel of >=2 providers');
    for (const p of panelSpecs) if (!specs.includes(p)) errors.push(`--panel member ${p} must be one of --providers`);
  }

  const T = tasks.length;
  const singleCalls = specs.length * T * (R || 0);
  const reviewCalls = arms.includes('anchor-review') ? T * (R || 0) : 0;
  const finalCalls = arms.includes('final') ? T * (R || 0) : 0;
  const plannedCalls = singleCalls + reviewCalls + finalCalls;

  if (live) {
    if (!Number.isInteger(maxCalls) || maxCalls <= 0) errors.push('--live requires a finite --max-calls N (advisor invocation budget)');
    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) errors.push('--live requires a finite --deadline-minutes M');
    if (Number.isInteger(maxCalls) && plannedCalls > maxCalls) {
      errors.push(`planned ${plannedCalls} advisor invocations exceed --max-calls ${maxCalls}; reduce repeats/providers/tasks or raise the budget`);
    }
  }
  warnings.push('--max-calls counts advisor invocations; a CLI agent loop or transport retry inside one invocation is not counted, and it is not a spend cap.');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    plan: {
      mode: regression ? 'regression' : 'evaluation',
      live,
      tasks_file: file,
      task_ids: tasks.map((t) => t.id),
      repeats: R,
      providers: specs,
      expected_surfaces: Object.fromEntries(specs.map((s) => [s, providerSurface(s)])),
      arms: ['single', ...arms],
      panel_members: panelSpecs,
      anchor: anchorSpec,
      reviewer: reviewerSpec,
      synthesizer: synthSpec,
      calls: { single: singleCalls, anchor_review: reviewCalls, final: finalCalls, total: plannedCalls },
      max_calls: live ? maxCalls : null,
      deadline_minutes: live ? deadlineMinutes : null,
    },
    _spec: spec,
    _tasks: tasks,
    _parsed: { specs, anchorSpec, reviewerSpec, synthSpec, panelSpecs },
  };
}

function sumCost(cells) {
  let total = 0;
  let known = 0;
  for (const c of cells) {
    if (Number.isFinite(c.cost_estimate)) {
      total += c.cost_estimate;
      known += 1;
    }
  }
  return { total: known ? round(total, 6) : null, cells_with_cost: known, cells: cells.length };
}

/** Run-unique id; the provider part is hashed so blind adjudication cannot read the provider from it. */
export function cellId(runId, arm, key, taskId, repeat) {
  return `${runId}/m${sha256(`${arm}|${key}`).slice(0, 6)}/${taskId}/r${repeat}`;
}

function makeCell({ runId, arm, key, task, repeat, res, designKey = null, inputs = null, prompt, started }) {
  const env = res.envelope || null;
  const attribution = env && isObj(env.attribution) ? env.attribution : null;
  const ok = !!res.ok;
  const claims = ok ? annotateClaims(task, extractClaims(res.raw)) : [];
  const grade = ok ? gradeAnswer(task, res.raw) : null;
  return {
    cell_id: cellId(runId, arm, key, task.id, repeat),
    arm,
    spec: key,
    task_id: task.id,
    repeat,
    status: ok ? 'ok' : 'failed',
    error: ok ? null : res.error || { kind: 'unknown', message: 'no result' },
    source: 'advisor',
    started_at: new Date(started).toISOString(),
    duration_ms: res.ms,
    design_key: designKey,
    inputs,
    attribution,
    evidence_key: attribution ? evidenceKey(attribution) : null,
    usage: env ? env.usage ?? null : null,
    cost_estimate: env && Number.isFinite(env.cost_estimate) ? env.cost_estimate : null,
    raw_sha256: ok ? sha256(res.raw) : null,
    raw: ok ? res.raw : null,
    claims,
    candidate: grade ? { hits: grade.hits, misses: grade.misses } : null,
    prompt_sha256: sha256(prompt),
  };
}

function newRunId(now = new Date()) {
  return `bench-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${crypto.randomBytes(3).toString('hex')}`;
}

function designTaskMeta(spec, tasks) {
  return tasks.map((t) => ({
    id: t.id,
    split: taskSplit(spec, t),
    defects: t.defects.map((d) => d.id),
    provenance_kind: taskProvenance(spec, t).kind,
    prompt_sha256: sha256(buildBenchPrompt(spec, t)),
  }));
}

/**
 * Plan, and — only with live:true — run. Repeat-major ordering keeps a
 * budget-truncated run balanced across providers. Failed calls become failed
 * cells (never zero-defect reviews).
 */
export async function runBench(opts) {
  const { root = process.cwd(), env = process.env, live = false, write = true, ask = askAdvisorJson, now = Date.now, log = (m) => console.error(m) } = opts;
  const planned = planBench(opts);
  if (!planned.ok) return { exitCode: 1, errors: planned.errors, plan: planned.plan };
  const { _spec: spec, _tasks: tasks, _parsed: P, plan } = planned;
  if (!live) return { exitCode: 0, dryRun: true, plan, warnings: planned.warnings };

  const callTimeoutMs = Math.round((opts.callTimeoutSec || 600) * 1000);
  const startedAt = now();
  const deadlineAt = startedAt + plan.deadline_minutes * 60000;
  const runId = newRunId(new Date(startedAt));
  const cells = [];
  let calls = 0;
  let aborted = null;

  const canCall = () => {
    if (calls >= plan.max_calls) {
      aborted = aborted || 'max-calls';
      return false;
    }
    if (now() >= deadlineAt) {
      aborted = aborted || 'deadline';
      return false;
    }
    return true;
  };
  const call = async (label, spec_, prompt) => {
    calls += 1;
    log(`[bench] ${calls}/${plan.max_calls} ${label}…`);
    return ask(spec_, prompt, { timeoutMs: Math.max(1000, Math.min(callTimeoutMs, deadlineAt - now())), env });
  };

  const designKeyReview = plan.anchor ? `anchor=${plan.anchor};reviewer=${plan.reviewer}` : null;
  const designKeyFinal = plan.synthesizer ? `panel=${plan.panel_members.join('+')};synthesizer=${plan.synthesizer}` : null;

  outer: for (let r = 1; r <= plan.repeats; r++) {
    for (const t of tasks) {
      const byspec = {};
      for (const s of P.specs) {
        if (!canCall()) break outer;
        const started = now();
        const prompt = buildBenchPrompt(spec, t);
        const res = await call(`single ${s} × ${t.id} r${r}`, s, prompt);
        const cell = makeCell({ runId, arm: 'single', key: s, task: t, repeat: r, res, prompt, started });
        cells.push(cell);
        byspec[s] = cell;
      }
      if (plan.arms.includes('anchor-review')) {
        const a = byspec[P.anchorSpec];
        if (a && a.status === 'ok') {
          if (!canCall()) break outer;
          const started = now();
          const prompt = buildReviewPrompt(spec, t, a.raw);
          const res = await call(`anchor-review ${t.id} r${r}`, P.reviewerSpec, prompt);
          cells.push(makeCell({ runId, arm: 'anchor-review', key: 'anchor-review', task: t, repeat: r, res, designKey: designKeyReview, inputs: [a.cell_id], prompt, started }));
        } else {
          cells.push(skippedCell(runId, 'anchor-review', 'anchor-review', t, r, designKeyReview, 'anchor response failed', now()));
        }
      }
      if (plan.arms.includes('final')) {
        const members = P.panelSpecs.map((s) => byspec[s]);
        if (members.every((m) => m && m.status === 'ok')) {
          if (!canCall()) break outer;
          const started = now();
          const prompt = buildSynthesisPrompt(spec, t, members.map((m) => m.raw));
          const res = await call(`final ${t.id} r${r}`, P.synthSpec, prompt);
          cells.push(makeCell({ runId, arm: 'final', key: 'final', task: t, repeat: r, res, designKey: designKeyFinal, inputs: members.map((m) => m.cell_id), prompt, started }));
        } else {
          cells.push(skippedCell(runId, 'final', 'final', t, r, designKeyFinal, 'a panel member response failed', now()));
        }
      }
    }
  }

  const report = {
    kind: 'xllm-bench-report',
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runId,
    created_at: new Date(startedAt).toISOString(),
    finished_at: new Date(now()).toISOString(),
    source: 'live',
    design: {
      mode: plan.mode,
      regression: plan.mode === 'regression',
      repeats: plan.repeats,
      providers: plan.providers,
      arms: plan.arms,
      panel_members: plan.panel_members,
      anchor: plan.anchor,
      reviewer: plan.reviewer,
      synthesizer: plan.synthesizer,
      tasks_file: path.basename(plan.tasks_file),
      task_set_sha256: sha256(fs.readFileSync(plan.tasks_file, 'utf8')),
      tasks: designTaskMeta(spec, tasks),
      claim_extractor: CLAIM_EXTRACTOR,
    },
    budget: {
      unit: 'advisor-invocations',
      note: 'counts advisor invocations, not provider API requests; not a spend cap',
      max_calls: plan.max_calls,
      deadline_minutes: plan.deadline_minutes,
      calls_made: calls,
      planned_calls: plan.calls.total,
      aborted_reason: aborted,
    },
    cost: sumCost(cells),
    cells,
  };
  let reportPath = null;
  if (write) {
    reportPath = path.join(benchResultsDir(root, env), `${runId}.json`);
    writeJson(reportPath, report);
  }
  const failed = cells.filter((c) => c.status === 'failed').length;
  return { exitCode: aborted ? 3 : 0, report, reportPath, summary: runSummary(report), failed_cells: failed };
}

function skippedCell(runId, arm, key, task, repeat, designKey, reason, t) {
  return {
    cell_id: cellId(runId, arm, key, task.id, repeat),
    arm,
    spec: key,
    task_id: task.id,
    repeat,
    status: 'skipped',
    error: { kind: 'skipped', message: reason },
    source: 'advisor',
    started_at: new Date(t).toISOString(),
    duration_ms: 0,
    design_key: designKey,
    inputs: null,
    attribution: null,
    evidence_key: null,
    usage: null,
    cost_estimate: null,
    raw_sha256: null,
    raw: null,
    claims: [],
    candidate: null,
    prompt_sha256: null,
  };
}

// ---------------------------------------------------------------------------
// Import: native host baselines + user-supplied retrospective cases
// ---------------------------------------------------------------------------

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Prompts + sha256 manifest so a native host can run the exact same tasks. */
export function exportPrompts(tasksFile, outDir, { root = process.cwd(), env = process.env } = {}) {
  const file = resolveTasksFile(tasksFile, { root, env });
  const spec = loadTasks(file);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    schema: 'xllm-bench-prompts/1',
    tasks_file: path.basename(file),
    task_set_sha256: sha256(fs.readFileSync(file, 'utf8')),
    instructions:
      'Run each prompt unmodified in the native host, as a fresh session per repeat (>=3 repeats), and capture the final response text only. ' +
      `Return a ${NATIVE_SCHEMA} file for \`xllm-bench import-native\`.`,
    prompts: [],
  };
  for (const t of spec.tasks) {
    const prompt = buildBenchPrompt(spec, t);
    const f = `${t.id}.prompt.txt`;
    fs.writeFileSync(path.join(outDir, f), prompt, 'utf8');
    manifest.prompts.push({ task_id: t.id, file: f, prompt_sha256: sha256(prompt), split: taskSplit(spec, t) });
  }
  writeJson(path.join(outDir, 'manifest.json'), manifest);
  return manifest;
}

/**
 * Import REAL native-host baseline responses. Verified: prompt hash equals our
 * prompt for the task, response hash equals the response text, task-set hash
 * when given. Self-reported (unverifiable by xllm): host, model, effort, times.
 * Native cells carry no evidence_key (identity is not protocol-resolved), so
 * they can be compared but never feed routing.
 */
export function importNative(file, { root = process.cwd(), env = process.env, tasksFile = null, write = true } = {}) {
  const rawText = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(rawText);
  const errors = [];
  if (!isObj(doc) || doc.schema !== NATIVE_SCHEMA) errors.push(`schema must be ${NATIVE_SCHEMA}`);
  const host = (doc && doc.host) || {};
  if (!nonEmpty(host.name)) errors.push('host.name required (e.g. claude-code, codex-cli)');
  if (!nonEmpty(host.version)) errors.push('host.version required');
  if (!SAFE_LABEL.test(String(doc.label || ''))) errors.push('label required: [A-Za-z0-9._-], used as native:<label>');
  if (!nonEmpty(doc.captured_by)) errors.push('captured_by required (who ran it)');
  if (!Array.isArray(doc.responses) || !doc.responses.length) errors.push('responses[] required');
  let spec = null;
  let tasksPath = null;
  try {
    tasksPath = resolveTasksFile(tasksFile || doc.tasks_file, { root, env });
    spec = loadTasks(tasksPath);
  } catch (e) {
    errors.push(`task set: ${e.message}`);
  }
  if (errors.length) return { ok: false, errors };
  const setSha = sha256(fs.readFileSync(tasksPath, 'utf8'));
  if (doc.task_set_sha256 && doc.task_set_sha256 !== setSha) errors.push('task_set_sha256 does not match the local task set (different version?)');

  const byId = new Map(spec.tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const cells = [];
  const label = `native:${doc.label}`;
  const runId = newRunId();
  doc.responses.forEach((r, i) => {
    const where = `responses[${i}]`;
    const t = byId.get(r && r.task_id);
    if (!t) return errors.push(`${where}: unknown task_id ${r && r.task_id}`);
    if (!Number.isInteger(r.repeat) || r.repeat < 1) return errors.push(`${where}: repeat must be an integer >= 1`);
    const k = `${t.id}#${r.repeat}`;
    if (seen.has(k)) return errors.push(`${where}: duplicate ${k}`);
    seen.add(k);
    if (Number.isNaN(Date.parse(r.captured_at))) return errors.push(`${where}: captured_at must be ISO time`);
    if (r.prompt_sha256 !== sha256(buildBenchPrompt(spec, t))) return errors.push(`${where}: prompt_sha256 does not match xllm's prompt for ${t.id} (run export-prompts output unmodified)`);
    const failed = r.failed === true;
    if (!failed) {
      if (!nonEmpty(r.response)) return errors.push(`${where}: response required (or failed:true with error)`);
      if (r.response_sha256 !== sha256(r.response)) return errors.push(`${where}: response_sha256 does not match response text`);
    }
    const claims = failed ? [] : annotateClaims(t, extractClaims(r.response));
    const grade = failed ? null : gradeAnswer(t, r.response);
    cells.push({
      cell_id: cellId(runId, 'native', label, t.id, r.repeat),
      arm: 'native',
      spec: label,
      task_id: t.id,
      repeat: r.repeat,
      status: failed ? 'failed' : 'ok',
      error: failed ? { kind: 'host-failure', message: String(r.error || 'host reported failure') } : null,
      source: 'native-import',
      started_at: r.captured_at,
      duration_ms: Number.isFinite(r.duration_ms) ? r.duration_ms : null,
      design_key: null,
      inputs: null,
      attribution: {
        requested_provider: `native:${host.name}`,
        requested_model: null,
        executed_provider: `native:${host.name}`,
        transmitted_model: null,
        substituted_from: null,
        model_correction_source: null,
        reported_model: nonEmpty(r.model_reported) ? r.model_reported : null,
        identity_status: 'unresolved',
        model_revision: nonEmpty(r.model_revision) ? r.model_revision : null,
        requested_effort: null,
        effective_effort: nonEmpty(r.effort) ? r.effort : null,
        cli_version: host.version,
        surface: 'cli-agentic',
        execution_location: 'unknown',
      },
      evidence_key: null,
      usage: isObj(r.usage) ? r.usage : null,
      cost_estimate: null,
      raw_sha256: failed ? null : r.response_sha256,
      raw: failed ? null : r.response,
      claims,
      candidate: grade ? { hits: grade.hits, misses: grade.misses } : null,
      prompt_sha256: r.prompt_sha256,
      transcript_ref: nonEmpty(r.transcript_ref) ? r.transcript_ref : null,
    });
  });
  if (errors.length) return { ok: false, errors };

  const taskIds = [...new Set(cells.map((c) => c.task_id))];
  const importedAt = new Date().toISOString();
  const repeats = Math.max(...cells.map((c) => c.repeat));
  const report = {
    kind: 'xllm-bench-report',
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runId,
    created_at: importedAt,
    finished_at: importedAt,
    source: 'native-import',
    design: {
      mode: repeats >= MIN_EVAL_REPEATS ? 'evaluation' : 'regression',
      regression: repeats < MIN_EVAL_REPEATS,
      repeats,
      providers: [label],
      arms: ['native'],
      tasks_file: path.basename(tasksPath),
      task_set_sha256: setSha,
      tasks: designTaskMeta(spec, spec.tasks.filter((t) => taskIds.includes(t.id))),
      claim_extractor: CLAIM_EXTRACTOR,
    },
    provenance: {
      host: { name: host.name, version: host.version },
      captured_by: doc.captured_by,
      import_file_sha256: sha256(rawText),
      imported_at: importedAt,
      verified: ['prompt_sha256', 'response_sha256', ...(doc.task_set_sha256 ? ['task_set_sha256'] : [])],
      self_reported_unverified: ['host', 'model_reported', 'model_revision', 'effort', 'captured_at', 'transcript_ref'],
      note: 'Captured by a human/host outside xllm; xllm verified only that prompts and response bytes match. Identity is not protocol-resolved, so no evidence_key.',
    },
    budget: null,
    cost: sumCost(cells),
    cells,
  };
  let reportPath = null;
  if (write) {
    reportPath = path.join(benchResultsDir(root, env), `${runId}.json`);
    writeJson(reportPath, report);
  }
  return { ok: true, run_id: runId, reportPath, cells: cells.length, failed: cells.filter((c) => c.status === 'failed').length, label };
}

/** Import user-supplied retrospective real-bug cases as a named task set (benchmarks/cases). */
export function importCases(file, { root = process.cwd(), env = process.env, name = null, write = true, replace = false } = {}) {
  const rawText = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(rawText);
  const errors = [];
  if (!isObj(doc) || doc.schema !== CASES_SCHEMA) errors.push(`schema must be ${CASES_SCHEMA}`);
  const setName = name || (doc && doc.name);
  if (!SAFE_LABEL.test(String(setName || ''))) errors.push('name required: [A-Za-z0-9._-]');
  if (!nonEmpty(doc && doc.attested_by)) errors.push('attested_by required (who vouches for the provenance)');
  const spec = {
    version: 1,
    question:
      (doc && doc.question) ||
      'Review this change for defects. List EVERY defect you find, one per line, and briefly say why each is a problem.',
    note: `Imported from ${path.basename(file)} (sha256 ${sha256(rawText).slice(0, 16)}); provenance is user-attested and NOT verified by xllm.`,
    split: (doc && doc.split) || 'heldout',
    attested_by: doc && doc.attested_by,
    imported_at: new Date().toISOString(),
    tasks: (doc && doc.tasks) || [],
  };
  errors.push(...validateTaskSet(spec));
  for (const t of spec.tasks) {
    const p = t.provenance || spec.provenance;
    if (!p || p.kind !== 'real-retrospective') {
      errors.push(`task ${t.id}: imported cases must have provenance.kind 'real-retrospective' (synthetic belongs in a repo task file)`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const dest = path.join(benchCasesDir(root, env), `${setName}.json`);
  if (fs.existsSync(dest) && !replace) return { ok: false, errors: [`case set ${setName} already exists (use --replace)`] };
  if (write) writeJson(dest, spec);
  return { ok: true, name: setName, path: dest, tasks: spec.tasks.map((t) => t.id), split: spec.split };
}

// ---------------------------------------------------------------------------
// Reports + adjudication IO
// ---------------------------------------------------------------------------

function listReportFiles(root, env) {
  const dir = benchResultsDir(root, env);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Load v3 reports only; legacy repo/benchmarks files carry no attribution and are ignored. */
export function loadReport(ref, { root = process.cwd(), env = process.env } = {}) {
  let file = ref;
  if (!fs.existsSync(file)) file = path.join(benchResultsDir(root, env), ref.endsWith('.json') ? ref : `${ref}.json`);
  if (!fs.existsSync(file)) throw new Error(`run not found: ${ref}`);
  const rep = readJson(file);
  if (!isObj(rep) || rep.kind !== 'xllm-bench-report' || rep.schema_version !== REPORT_SCHEMA_VERSION) {
    throw new Error(`${file} is not a schema ${REPORT_SCHEMA_VERSION} xllm-bench-report`);
  }
  return rep;
}

export function loadAdjudication(runId, { root = process.cwd(), env = process.env } = {}) {
  const f = path.join(benchAdjudicationsDir(root, env), `${runId}.json`);
  if (!fs.existsSync(f)) return null;
  return readJson(f);
}

const claimKey = (cellId, claimId) => `${cellId}|${claimId}`;
function judgmentMap(adj) {
  const m = new Map();
  for (const j of (adj && adj.judgments) || []) m.set(claimKey(j.cell_id, j.claim_id), j);
  return m;
}

function loadRuns(refs, ctx) {
  const files = refs.length === 1 && refs[0] === 'all' ? listReportFiles(ctx.root, ctx.env) : refs;
  const runs = [];
  for (const ref of files) {
    let report;
    try {
      report = loadReport(ref, ctx);
    } catch (e) {
      if (refs.length === 1 && refs[0] === 'all') continue; // legacy/malformed files skipped in 'all'
      throw e;
    }
    const adj = judgmentMap(loadAdjudication(report.run_id, ctx));
    runs.push({ report, adj, cells: report.cells.map((c) => ({ ...c, run_id: report.run_id })) });
  }
  if (!runs.length) throw new Error('no schema-3 runs found');
  return runs;
}

/** Worksheet for human adjudication. Blind by default: no provider/arm, shuffled by hash. */
export function buildWorksheet(report, { blind = true } = {}) {
  const meta = new Map(report.design.tasks.map((t) => [t.id, t]));
  const cells = report.cells.filter((c) => c.status === 'ok');
  const ordered = blind ? [...cells].sort((a, b) => sha256(a.cell_id).localeCompare(sha256(b.cell_id))) : cells;
  return {
    schema: ADJUDICATION_SCHEMA,
    run_id: report.run_id,
    claim_extractor: report.design.claim_extractor,
    adjudicator: { name: '', kind: 'human' },
    adjudicated_at: '',
    instructions: [
      'Fill `adjudicator.name`, then for each judgment set verdict (true_positive|false_positive|duplicate) and uncertainty (low|medium|high).',
      'true_positive: list matches_defects (seeded defect ids of that task) and/or set unseeded_real:true with a note for a genuine unseeded bug.',
      'duplicate: set duplicate_of to another claim id in the SAME cell. false_positive: no matches.',
      'regex_candidates are a mechanical hint, NOT a verdict. Leave verdict null to skip a claim. Use uncertainty high when you cannot confirm; comparisons bound those verdicts.',
    ],
    cells: ordered.map((c) => ({
      cell_id: c.cell_id,
      task_id: c.task_id,
      ...(blind ? {} : { arm: c.arm, spec: c.spec }),
      seeded_defects: meta.get(c.task_id) ? meta.get(c.task_id).defects : [],
      claims: c.claims.map((cl) => ({ claim_id: cl.id, claim_sha256: cl.sha256, text: cl.text, regex_candidates: cl.regex_candidates })),
    })),
    judgments: ordered.flatMap((c) =>
      c.claims.map((cl) => ({
        cell_id: c.cell_id,
        task_id: c.task_id,
        claim_id: cl.id,
        claim_sha256: cl.sha256,
        verdict: null,
        matches_defects: [],
        unseeded_real: false,
        duplicate_of: null,
        uncertainty: null,
        note: '',
      }))
    ),
  };
}

const JUDGMENT_FIELDS = ['cell_id', 'task_id', 'claim_id', 'claim_sha256', 'verdict', 'matches_defects', 'unseeded_real', 'duplicate_of', 'uncertainty', 'note'];

/** Validate an adjudication document against a report's run/task/claim IDs. */
export function validateAdjudication(report, doc) {
  const errors = [];
  if (!isObj(doc) || doc.schema !== ADJUDICATION_SCHEMA) return { errors: [`schema must be ${ADJUDICATION_SCHEMA}`], judgments: [], skipped: 0 };
  if (doc.run_id !== report.run_id) errors.push(`run_id ${doc.run_id} does not match report ${report.run_id}`);
  if (!isObj(doc.adjudicator) || !nonEmpty(doc.adjudicator.name)) errors.push('adjudicator.name required');
  if (isObj(doc.adjudicator) && doc.adjudicator.kind !== 'human') errors.push("adjudicator.kind must be 'human' (a model verdict would be unverifiable precision)");
  if (!Array.isArray(doc.judgments)) return { errors: [...errors, 'judgments[] required'], judgments: [], skipped: 0 };
  const cells = new Map(report.cells.map((c) => [c.cell_id, c]));
  const meta = new Map(report.design.tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const out = [];
  let skipped = 0;
  doc.judgments.forEach((j, i) => {
    const where = `judgments[${i}]`;
    if (!isObj(j)) return errors.push(`${where}: object required`);
    for (const k of Object.keys(j)) if (!JUDGMENT_FIELDS.includes(k)) errors.push(`${where}: unknown field ${k}`);
    if (j.verdict == null) {
      skipped += 1;
      return;
    }
    const cell = cells.get(j.cell_id);
    if (!cell) return errors.push(`${where}: cell_id ${j.cell_id} not in run ${report.run_id}`);
    if (cell.status !== 'ok') return errors.push(`${where}: cell ${j.cell_id} did not produce a response`);
    if (j.task_id !== cell.task_id) return errors.push(`${where}: task_id ${j.task_id} != cell task ${cell.task_id}`);
    const claim = cell.claims.find((c) => c.id === j.claim_id);
    if (!claim) return errors.push(`${where}: claim_id ${j.claim_id} not in cell ${j.cell_id}`);
    if (j.claim_sha256 != null && j.claim_sha256 !== claim.sha256) errors.push(`${where}: claim_sha256 mismatch (claim text changed)`);
    const key = claimKey(j.cell_id, j.claim_id);
    if (seen.has(key)) return errors.push(`${where}: duplicate judgment for ${key}`);
    seen.add(key);
    if (!VERDICTS.includes(j.verdict)) return errors.push(`${where}: verdict must be ${VERDICTS.join('|')}`);
    if (!UNCERTAINTIES.includes(j.uncertainty)) return errors.push(`${where}: uncertainty required (${UNCERTAINTIES.join('|')})`);
    const matches = j.matches_defects == null ? [] : j.matches_defects;
    if (!Array.isArray(matches) || new Set(matches).size !== matches.length) return errors.push(`${where}: matches_defects must be a unique array`);
    const allowed = (meta.get(cell.task_id) || { defects: [] }).defects;
    for (const d of matches) if (!allowed.includes(d)) errors.push(`${where}: defect ${d} is not seeded in task ${cell.task_id}`);
    const unseeded = j.unseeded_real === true;
    if (j.verdict === 'true_positive') {
      if (!matches.length && !unseeded) errors.push(`${where}: true_positive needs matches_defects or unseeded_real:true`);
      if (matches.length && unseeded) errors.push(`${where}: matches_defects and unseeded_real are exclusive`);
      if (unseeded && !nonEmpty(j.note)) errors.push(`${where}: unseeded_real needs a note explaining the real defect`);
    } else if (matches.length || unseeded) {
      errors.push(`${where}: ${j.verdict} cannot map defects or be unseeded_real`);
    }
    if (j.verdict === 'duplicate') {
      const target = cell.claims.find((c) => c.id === j.duplicate_of);
      if (!target || target.id === j.claim_id) errors.push(`${where}: duplicate_of must be another claim id in the same cell`);
    } else if (j.duplicate_of != null) {
      errors.push(`${where}: duplicate_of only for verdict duplicate`);
    }
    out.push({
      cell_id: j.cell_id,
      task_id: j.task_id,
      claim_id: j.claim_id,
      claim_sha256: claim.sha256,
      verdict: j.verdict,
      matches_defects: matches,
      unseeded_real: unseeded,
      duplicate_of: j.verdict === 'duplicate' ? j.duplicate_of : null,
      uncertainty: j.uncertainty,
      note: typeof j.note === 'string' ? j.note : '',
    });
  });
  // duplicate_of must not point at another duplicate (no chains/cycles)
  const verdictByKey = new Map(out.map((j) => [claimKey(j.cell_id, j.claim_id), j]));
  for (const j of out) {
    if (j.verdict !== 'duplicate') continue;
    const t = verdictByKey.get(claimKey(j.cell_id, j.duplicate_of));
    if (t && t.verdict === 'duplicate') errors.push(`${j.cell_id}/${j.claim_id}: duplicate_of points at another duplicate`);
  }
  return { errors, judgments: out, skipped };
}

/** Validate + persist (merge). Existing differing judgments need replace:true. */
export function applyAdjudication(file, { root = process.cwd(), env = process.env, replace = false, write = true } = {}) {
  const doc = readJson(file);
  let report;
  try {
    report = loadReport(doc.run_id, { root, env });
  } catch (e) {
    return { ok: false, errors: [String(e.message || e)] };
  }
  const v = validateAdjudication(report, doc);
  if (v.errors.length) return { ok: false, errors: v.errors };
  const existing = loadAdjudication(report.run_id, { root, env });
  const merged = new Map(((existing && existing.judgments) || []).map((j) => [claimKey(j.cell_id, j.claim_id), j]));
  const conflicts = [];
  for (const j of v.judgments) {
    const k = claimKey(j.cell_id, j.claim_id);
    const prev = merged.get(k);
    if (prev && JSON.stringify(prev) !== JSON.stringify(j)) {
      if (!replace) conflicts.push(`${k} already judged differently (use --replace)`);
    }
    merged.set(k, j);
  }
  if (conflicts.length) return { ok: false, errors: conflicts };
  const out = {
    schema: ADJUDICATION_SCHEMA,
    run_id: report.run_id,
    claim_extractor: report.design.claim_extractor,
    adjudicator: doc.adjudicator,
    adjudicators: [
      ...(((existing && existing.adjudicators) || (existing ? [existing.adjudicator] : [])).filter(Boolean)),
      ...(existing && existing.adjudicator && existing.adjudicator.name === doc.adjudicator.name ? [] : [doc.adjudicator]),
    ].filter((a, i, arr) => arr.findIndex((b) => b.name === a.name) === i),
    adjudicated_at: new Date().toISOString(),
    judgments: [...merged.values()],
  };
  let dest = null;
  if (write) {
    dest = path.join(benchAdjudicationsDir(root, env), `${report.run_id}.json`);
    writeJson(dest, out);
  }
  return { ok: true, path: dest, applied: v.judgments.length, skipped_unjudged: v.skipped, total_judgments: out.judgments.length };
}

export function adjudicationStatus(report, adjMap) {
  const byArm = {};
  for (const c of report.cells) {
    if (c.status !== 'ok') continue;
    const a = (byArm[c.arm] = byArm[c.arm] || { cells: 0, cells_complete: 0, claims: 0, claims_judged: 0 });
    a.cells += 1;
    let judged = 0;
    for (const cl of c.claims) if (adjMap.has(claimKey(c.cell_id, cl.id))) judged += 1;
    a.claims += c.claims.length;
    a.claims_judged += judged;
    if (judged === c.claims.length) a.cells_complete += 1;
  }
  return { run_id: report.run_id, by_arm: byArm };
}

// ---------------------------------------------------------------------------
// Metrics (adjudicated; candidate-only is explicit and weaker)
// ---------------------------------------------------------------------------

/**
 * Metrics for ONE unit (a single response, or the union of panel members').
 * scenario: 'pessimistic' | 'optimistic' bound high-uncertainty verdicts
 * (pessimistic: uncertain TP counts as FP and detects nothing; optimistic:
 * uncertain TP counts as TP, uncertain FP is dropped). 'candidate' uses regex
 * hits only: recall candidates, no precision. Returns null if any claim of
 * the unit is not adjudicated.
 */
export function unitMetrics(task, cells, adjMap, scenario) {
  const detected = new Set();
  let tp = 0;
  let fp = 0;
  let unseeded = 0;
  let duplicates = 0;
  let uncertain = 0;
  let claims = 0;
  for (const cell of cells) {
    if (scenario === 'candidate') {
      for (const h of (cell.candidate && cell.candidate.hits) || []) detected.add(h);
      claims += cell.claims.length;
      continue;
    }
    for (const c of cell.claims) {
      const j = adjMap.get(claimKey(cell.cell_id, c.id));
      if (!j) return null;
      claims += 1;
      if (j.verdict === 'duplicate') {
        duplicates += 1;
        continue;
      }
      const unc = j.uncertainty === 'high';
      if (unc) uncertain += 1;
      if (j.verdict === 'true_positive') {
        if (unc && scenario === 'pessimistic') {
          fp += 1;
          continue;
        }
        tp += 1;
        for (const d of j.matches_defects) detected.add(d);
        if (j.unseeded_real) unseeded += 1;
      } else if (!(unc && scenario === 'optimistic')) {
        fp += 1;
      }
    }
  }
  const total = task.defects.length;
  return {
    detected: [...detected].sort(),
    recall: total ? detected.size / total : null,
    precision: scenario === 'candidate' || tp + fp === 0 ? null : tp / (tp + fp),
    tp,
    fp,
    unseeded_tp: unseeded,
    duplicates,
    uncertain,
    claims,
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
const dist = (a) => ({ n: a.length, values: a.map((x) => round(x)), mean: round(mean(a)), sd: round(sd(a)), min: a.length ? round(Math.min(...a)) : null, max: a.length ? round(Math.max(...a)) : null });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Task-clustered bootstrap CI of the mean per-task difference (seeded: reproducible). */
export function bootstrapMeanCI(diffs, { iterations = 2000, seed = 1 } = {}) {
  if (!diffs.length) return null;
  const rnd = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let k = 0; k < diffs.length; k++) s += diffs[Math.floor(rnd() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: round(means[Math.floor(0.025 * iterations)]), hi: round(means[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)]) };
}

// ---------------------------------------------------------------------------
// Arms: resolve a named arm to units per task/repeat
// ---------------------------------------------------------------------------

function allTasksMeta(runs) {
  const m = new Map();
  for (const { report } of runs) {
    for (const t of report.design.tasks) {
      const prev = m.get(t.id);
      if (prev && (prev.defects.join() !== t.defects.join() || prev.prompt_sha256 !== t.prompt_sha256)) {
        throw new Error(`task ${t.id} differs between loaded runs (different task-set version); compare runs of one task set`);
      }
      m.set(t.id, t);
    }
  }
  return m;
}

function singleSpecs(runs) {
  return [...new Set(runs.flatMap((r) => r.cells.filter((c) => c.arm === 'single').map((c) => c.spec)))].sort();
}

function isLocalSpec(runs, spec) {
  const cs = runs.flatMap((r) => r.cells.filter((c) => c.arm === 'single' && c.spec === spec && c.status === 'ok'));
  return cs.length > 0 && cs.every((c) => c.attribution && c.attribution.execution_location === 'local');
}

const unitKey = (c) => `${c.run_id}#${c.repeat}`;

function unitsFromCells(cells) {
  const units = new Map(); // taskId -> Map(repeatKey -> {cells, ok})
  for (const c of cells) {
    if (!units.has(c.task_id)) units.set(c.task_id, new Map());
    units.get(c.task_id).set(unitKey(c), { cells: [c], ok: c.status === 'ok' });
  }
  return units;
}

function panelUnits(runs, members) {
  const units = new Map();
  for (const run of runs) {
    const byTaskRep = new Map();
    for (const c of run.cells) {
      if (c.arm !== 'single' || !members.includes(c.spec)) continue;
      const k = `${c.task_id}|${c.repeat}`;
      if (!byTaskRep.has(k)) byTaskRep.set(k, new Map());
      byTaskRep.get(k).set(c.spec, c);
    }
    for (const [k, m] of byTaskRep) {
      if (m.size !== members.length) continue; // member never ran in this run: not this panel
      const [taskId, rep] = k.split('|');
      if (!units.has(taskId)) units.set(taskId, new Map());
      const cells = members.map((s) => m.get(s));
      units.get(taskId).set(`${run.report.run_id}#${rep}`, { cells, ok: cells.every((c) => c.status === 'ok') });
    }
  }
  return units;
}

/**
 * ARM grammar: single:SPEC | strongest-single | panel:SPEC+SPEC | local-panel |
 * anchor-review | final | native:LABEL. Panel/union units are built from the
 * SAME single cells (no extra calls); one failed member fails the unit.
 */
export function buildArm(runs, armSpec, { strongest = null } = {}) {
  const [head, ...rest] = armSpec.split(':');
  const arg = rest.join(':');
  const allCells = runs.flatMap((r) => r.cells);
  if (armSpec === 'strongest-single') {
    if (!strongest) throw new Error('strongest-single needs a selection (resolved by compare)');
    return { ...buildArm(runs, `single:${strongest.spec}`), label: 'strongest-single', resolved: strongest };
  }
  if (head === 'single') {
    const cells = allCells.filter((c) => c.arm === 'single' && c.spec === arg);
    if (!cells.length) throw new Error(`no single cells for ${arg}; have: ${singleSpecs(runs).join(', ') || '(none)'}`);
    return { label: armSpec, kind: 'single', units: unitsFromCells(cells), cellsFlat: cells };
  }
  if (head === 'native') {
    const cells = allCells.filter((c) => c.arm === 'native' && c.spec === armSpec);
    if (!cells.length) throw new Error(`no native cells for ${armSpec}`);
    return { label: armSpec, kind: 'native', units: unitsFromCells(cells), cellsFlat: cells };
  }
  if (head === 'panel' || armSpec === 'local-panel') {
    let members;
    let localNote = null;
    if (armSpec === 'local-panel') {
      members = singleSpecs(runs).filter((s) => isLocalSpec(runs, s));
      if (members.length < 2) throw new Error('local-panel needs >=2 single specs whose every ok cell has attribution.execution_location==="local" (unknown does not qualify)');
      localNote = 'members verified local from per-cell attribution';
    } else {
      members = arg.split('+').filter(Boolean);
      if (members.length < 2) throw new Error('panel:A+B needs >=2 members');
      for (const m of members) if (!singleSpecs(runs).includes(m)) throw new Error(`panel member ${m} has no single cells`);
    }
    const units = panelUnits(runs, members);
    if (!units.size) throw new Error(`panel ${members.join('+')} never ran together in one run`);
    return {
      label: armSpec === 'local-panel' ? `local-panel(${members.join('+')})` : armSpec,
      kind: 'panel',
      members,
      all_members_local: members.every((s) => isLocalSpec(runs, s)),
      note: localNote,
      units,
    };
  }
  if (armSpec === 'anchor-review' || armSpec === 'final') {
    const cells = allCells.filter((c) => c.arm === armSpec);
    if (!cells.length) throw new Error(`no ${armSpec} cells in the loaded runs`);
    const designs = [...new Set(cells.map((c) => c.design_key))];
    if (designs.length > 1) throw new Error(`${armSpec} has several designs (${designs.join(' | ')}); narrow --run`);
    return { label: armSpec, kind: armSpec, design: designs[0], units: unitsFromCells(cells), cellsFlat: cells };
  }
  throw new Error(`unknown arm '${armSpec}'`);
}

function evalUnit(unit, task, adjByRun, scenario) {
  if (!unit.ok) return { reason: 'failed' };
  const m = unitMetrics(task, unit.cells, adjByRun, scenario);
  return m ? { m } : { reason: 'unadjudicated' };
}

function adjUnion(runs) {
  const m = new Map();
  for (const r of runs) for (const [k, v] of r.adj) m.set(k, v);
  return m;
}

/** Choose the strongest single on tasks OUTSIDE the evaluation split (or explicit). */
export function selectStrongestSingle(runs, { evalSplit = 'heldout', explicit = null, candidateOnly = false } = {}) {
  const meta = allTasksMeta(runs);
  const specs = singleSpecs(runs);
  if (explicit) {
    if (!specs.includes(explicit)) throw new Error(`--strongest ${explicit} has no single cells`);
    return { spec: explicit, selection: 'explicit', selection_tasks: null };
  }
  const selTasks = [...meta.values()].filter((t) => evalSplit === 'all' || t.split !== evalSplit);
  if (!selTasks.length) throw new Error(`strongest-single needs non-${evalSplit} tasks to select on (held-out data must not pick the baseline); pass --strongest SPEC to choose explicitly`);
  const adj = adjUnion(runs);
  const scenario = candidateOnly ? 'candidate' : 'pessimistic';
  const scores = [];
  for (const spec of specs) {
    const arm = buildArm(runs, `single:${spec}`);
    const per = [];
    const prec = [];
    for (const t of selTasks) {
      const us = arm.units.get(t.id);
      if (!us) continue;
      const vals = [];
      for (const u of us.values()) {
        const r = evalUnit(u, { defects: t.defects }, adj, scenario);
        if (r.m) {
          vals.push(r.m.recall);
          if (r.m.precision != null) prec.push(r.m.precision);
        }
      }
      if (vals.length) per.push(mean(vals));
    }
    if (per.length) scores.push({ spec, n_tasks: per.length, recall: mean(per), precision: mean(prec) });
  }
  if (!scores.length) throw new Error('no adjudicated single data on selection tasks; adjudicate dev runs or pass --strongest SPEC');
  const maxN = Math.max(...scores.map((s) => s.n_tasks));
  const best = scores
    .filter((s) => s.n_tasks === maxN)
    .sort((a, b) => b.recall - a.recall || (b.precision ?? -1) - (a.precision ?? -1) || a.spec.localeCompare(b.spec))[0];
  return {
    spec: best.spec,
    selection: evalSplit === 'all' ? 'same-data (optimistic: selected on the evaluation tasks)' : `selected on non-${evalSplit} tasks`,
    selection_tasks: selTasks.map((t) => t.id),
    scores: scores.map((s) => ({ ...s, recall: round(s.recall), precision: round(s.precision) })),
  };
}

function seedFor(...parts) {
  return parseInt(sha256(parts.join('|')).slice(0, 8), 16);
}

function pairedForScenario(baseArm, arm, taskMeta, adj, scenario, minRepeats) {
  const perTask = [];
  const excluded = [];
  const metricNames = ['recall', 'precision', 'fp_claims'];
  for (const t of taskMeta) {
    const bu = baseArm.units.get(t.id);
    const au = arm.units.get(t.id);
    if (!bu || !au) {
      excluded.push({ task_id: t.id, reason: 'arm has no cells for this task' });
      continue;
    }
    const task = { defects: t.defects };
    const evalAll = (units) => {
      const o = new Map();
      let failed = 0;
      let unadj = 0;
      for (const [k, u] of units) {
        const r = evalUnit(u, task, adj, scenario);
        if (r.m) o.set(k, r.m);
        else if (r.reason === 'failed') failed += 1;
        else unadj += 1;
      }
      return { o, failed, unadj };
    };
    const B = evalAll(bu);
    const A = evalAll(au);
    const overlap = [...bu.keys()].some((k) => au.has(k));
    let matched;
    if (overlap) matched = [...B.o.keys()].filter((k) => A.o.has(k));
    else matched = null; // different runs (e.g. native import): unmatched means
    const bm = matched ? matched.map((k) => B.o.get(k)) : [...B.o.values()];
    const am = matched ? matched.map((k) => A.o.get(k)) : [...A.o.values()];
    const nValid = matched ? matched.length : Math.min(bm.length, am.length);
    if (nValid < minRepeats) {
      excluded.push({
        task_id: t.id,
        reason: `insufficient valid repeats (${nValid} < ${minRepeats})`,
        baseline: { failed_cells: B.failed, unadjudicated_cells: B.unadj },
        arm: { failed_cells: A.failed, unadjudicated_cells: A.unadj },
      });
      continue;
    }
    const val = {};
    for (const name of metricNames) {
      const pick = (m) => (name === 'fp_claims' ? m.fp : m[name]);
      const bv = bm.map(pick).filter((x) => x != null);
      const av = am.map(pick).filter((x) => x != null);
      let diffValues = null;
      let diff = null;
      if (matched) {
        const pairs = matched.map((k) => [pick(B.o.get(k)), pick(A.o.get(k))]).filter(([x, y]) => x != null && y != null);
        diffValues = pairs.map(([x, y]) => y - x);
        diff = mean(diffValues);
      } else if (bv.length && av.length) {
        diff = mean(av) - mean(bv);
      }
      val[name] = { baseline: dist(bv), arm: dist(av), diff_mean: round(diff), diff_values: diffValues ? diffValues.map((x) => round(x)) : null };
    }
    perTask.push({
      task_id: t.id,
      valid_repeats: nValid,
      repeat_matched: !!matched,
      excluded_cells: { baseline: { failed: B.failed, unadjudicated: B.unadj }, arm: { failed: A.failed, unadjudicated: A.unadj } },
      metrics: val,
    });
  }
  const summary = {};
  for (const name of metricNames) {
    const diffs = perTask.map((p) => p.metrics[name].diff_mean).filter((x) => x != null);
    summary[name] = {
      n_tasks: diffs.length,
      mean_diff: round(mean(diffs)),
      ci95: diffs.length ? bootstrapMeanCI(diffs, { seed: seedFor(baseArm.label, arm.label, scenario, name) }) : null,
    };
  }
  return { per_task: perTask, excluded_tasks: excluded, summary };
}

function verdictFrom(results, { regression, candidate }) {
  if (candidate) return 'CANDIDATE-ONLY — regex mentions are not adjudicated findings; this is not evidence of detection quality';
  const rs = SCENARIOS.map((s) => results[s].summary.recall);
  const n = Math.min(...rs.map((r) => r.n_tasks));
  if (regression) return 'REGRESSION CHECK — single run per cell, no variance estimate; not evidence of improvement';
  if (n < MIN_TASKS_FOR_VERDICT) return `INCONCLUSIVE — only ${n} task(s) with >=${MIN_EVAL_REPEATS} valid paired repeats (need >=${MIN_TASKS_FOR_VERDICT})`;
  const dir = rs.map((r) => (r.ci95 && r.ci95.lo > 0 ? 'better' : r.ci95 && r.ci95.hi < 0 ? 'worse' : 'none'));
  if (dir[0] !== dir[1]) return 'SCENARIO-DEPENDENT — high-uncertainty adjudications flip the conclusion; adjudicate them or collect more data';
  return dir[0] === 'better' ? 'arm recall BETTER than baseline (CI excludes 0 under both uncertainty bounds)' : dir[0] === 'worse' ? 'arm recall WORSE than baseline (CI excludes 0 under both uncertainty bounds)' : 'NO detectable recall difference (CI includes 0)';
}

/** Final-adoption block: what synthesis kept/lost/added relative to the union of its own inputs. */
function finalAdoption(runs, finalArm, adj, taskMetaById, scenario) {
  const cellById = new Map(runs.flatMap((r) => r.cells.map((c) => [c.cell_id, c])));
  const rows = [];
  for (const [taskId, units] of finalArm.units) {
    const meta = taskMetaById.get(taskId);
    if (!meta) continue;
    for (const [k, u] of units) {
      if (!u.ok) continue;
      const fc = u.cells[0];
      const members = (fc.inputs || []).map((id) => cellById.get(id)).filter(Boolean);
      if (members.length !== (fc.inputs || []).length || members.some((m) => m.status !== 'ok')) continue;
      const task = { defects: meta.defects };
      const fm = unitMetrics(task, [fc], adj, scenario);
      const um = unitMetrics(task, members, adj, scenario);
      if (!fm || !um) continue;
      const lost = um.detected.filter((d) => !fm.detected.includes(d));
      rows.push({
        task_id: taskId,
        unit: k,
        union_detected: um.detected.length,
        final_detected: fm.detected.length,
        lost_true_defects: lost,
        union_precision: round(um.precision),
        final_precision: round(fm.precision),
        union_fp: um.fp,
        final_fp: fm.fp,
        final_unseeded_tp: fm.unseeded_tp,
      });
    }
  }
  if (!rows.length) return { scenario, units: 0, note: 'no fully adjudicated final cells with adjudicated member responses' };
  return {
    scenario,
    units: rows.length,
    mean_union_recall_defects: round(mean(rows.map((r) => r.union_detected))),
    mean_final_recall_defects: round(mean(rows.map((r) => r.final_detected))),
    units_losing_true_defects: rows.filter((r) => r.lost_true_defects.length).length,
    mean_union_fp: round(mean(rows.map((r) => r.union_fp))),
    mean_final_fp: round(mean(rows.map((r) => r.final_fp))),
    note: 'union precision pools claims of the member responses (cross-model duplicates are not collapsed)',
    rows,
  };
}

/**
 * Compare arms against a baseline over a task split, paired per task and
 * repeat, failed/unadjudicated cells excluded pairwise, per-repeat variance
 * retained. Difficulty filter (from the retired calibrate tool) restricts
 * tasks to those where every single model's detection rate <= threshold.
 */
export function compareArms(runs, { baseline, arms, split = 'heldout', difficultyThreshold = null, difficultyRuns = null, strongest = null, candidateOnly = false }) {
  const meta = allTasksMeta(runs);
  let taskMeta = [...meta.values()].filter((t) => split === 'all' || t.split === split);
  const adj = adjUnion(runs);
  const regression = runs.every((r) => r.report.design.regression);
  const minRepeats = regression ? 1 : MIN_EVAL_REPEATS;
  const scenarios = candidateOnly ? ['candidate'] : SCENARIOS;

  let difficulty = null;
  if (difficultyThreshold != null) {
    const dRuns = difficultyRuns || runs;
    const dAdj = adjUnion(dRuns);
    const rates = {};
    for (const t of taskMeta) rates[t.id] = {};
    for (const spec of singleSpecs(dRuns)) {
      const arm = buildArm(dRuns, `single:${spec}`);
      for (const t of taskMeta) {
        const us = arm.units.get(t.id);
        const vals = us ? [...us.values()].map((u) => evalUnit(u, { defects: t.defects }, dAdj, candidateOnly ? 'candidate' : 'optimistic')).filter((r) => r.m).map((r) => r.m.recall) : [];
        rates[t.id][spec] = vals.length ? mean(vals) : null;
      }
    }
    const keep = taskMeta.filter((t) => qualifies(rates[t.id], difficultyThreshold));
    difficulty = {
      threshold: difficultyThreshold,
      rule: 'task kept only if EVERY single model detection rate (optimistic bound) <= threshold; a model without usable data disqualifies it',
      rates: Object.fromEntries(Object.entries(rates).map(([t, r]) => [t, Object.fromEntries(Object.entries(r).map(([s, v]) => [s, round(v)]))])),
      kept: keep.map((t) => t.id),
      filter_and_evaluation_same_data: !difficultyRuns,
      caveat: difficultyRuns ? null : 'difficulty filtered on the same responses it then evaluates: results are optimistic/selection-biased; pass --difficulty-from <other runs> for an honest filter',
    };
    taskMeta = keep;
  }

  const strongestSel = [baseline, ...arms].includes('strongest-single')
    ? selectStrongestSingle(runs, { evalSplit: split, explicit: strongest, candidateOnly })
    : null;
  const baseArm = buildArm(runs, baseline, { strongest: strongestSel });
  const out = {
    split,
    evaluation_grade: !regression && !candidateOnly,
    mode: regression ? 'regression (one run per cell)' : 'evaluation',
    min_repeats: minRepeats,
    tasks_evaluated: taskMeta.map((t) => t.id),
    task_provenance: Object.fromEntries(taskMeta.map((t) => [t.id, t.provenance_kind])),
    baseline: { label: baseArm.label, resolved: baseArm.resolved || null, members: baseArm.members || null, design: baseArm.design || null },
    strongest_single: strongestSel,
    difficulty,
    comparisons: [],
  };
  for (const a of arms) {
    const arm = buildArm(runs, a, { strongest: strongestSel });
    const results = {};
    for (const s of scenarios) results[s] = pairedForScenario(baseArm, arm, taskMeta, adj, s, minRepeats);
    const entry = {
      arm: arm.label,
      resolved: arm.resolved || null,
      members: arm.members || null,
      design: arm.design || null,
      note: arm.note || null,
      local_verified: arm.kind === 'panel' && /local/.test(a) ? !!arm.all_members_local : undefined,
      results,
      verdict: candidateOnly ? verdictFrom(results, { candidate: true }) : verdictFrom(results, { regression }),
    };
    if (arm.kind === 'final' && !candidateOnly) {
      entry.final_adoption = Object.fromEntries(
        SCENARIOS.map((s) => [s, finalAdoption(runs, arm, adj, new Map(taskMeta.map((t) => [t.id, t])), s)])
      );
    }
    out.comparisons.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function runSummary(report) {
  const byArm = {};
  for (const c of report.cells) {
    const a = (byArm[`${c.arm}:${c.spec}`] = byArm[`${c.arm}:${c.spec}`] || { ok: 0, failed: 0, skipped: 0, duration_ms: 0 });
    a[c.status] += 1;
    a.duration_ms += c.duration_ms || 0;
  }
  return { run_id: report.run_id, calls_made: report.budget && report.budget.calls_made, aborted_reason: report.budget && report.budget.aborted_reason, cells: byArm, cost: report.cost };
}

/** Per-run report: variance per arm x task (candidate recall + adjudicated when present), no newest-only collapse. */
export function reportRun(report, adjMap) {
  const status = adjudicationStatus(report, adjMap);
  const meta = new Map(report.design.tasks.map((t) => [t.id, t]));
  const arms = {};
  for (const c of report.cells) {
    const key = `${c.arm}:${c.spec}`;
    const a = (arms[key] = arms[key] || { arm: c.arm, spec: c.spec, attribution: {}, tasks: {}, failures: {} });
    const t = (a.tasks[c.task_id] = a.tasks[c.task_id] || { repeats: [], candidate_recall: [], adjudicated: { pessimistic: [], optimistic: [] }, failed: 0 });
    if (c.status !== 'ok') {
      t.failed += 1;
      const k = (c.error && c.error.kind) || 'unknown';
      a.failures[k] = (a.failures[k] || 0) + 1;
      continue;
    }
    const id = c.attribution ? `${c.attribution.identity_status}/${c.attribution.surface}/${c.attribution.execution_location}` : 'no-attribution';
    a.attribution[id] = (a.attribution[id] || 0) + 1;
    t.repeats.push(c.repeat);
    const total = (meta.get(c.task_id) || { defects: [] }).defects.length;
    if (total && c.candidate) t.candidate_recall.push(c.candidate.hits.length / total);
    for (const s of SCENARIOS) {
      const m = unitMetrics({ defects: (meta.get(c.task_id) || { defects: [] }).defects }, [c], adjMap, s);
      if (m) t.adjudicated[s].push(m.recall);
    }
  }
  for (const a of Object.values(arms)) {
    for (const t of Object.values(a.tasks)) {
      t.candidate_recall = { ...dist(t.candidate_recall), note: 'regex candidates, not truth' };
      t.adjudicated = Object.fromEntries(SCENARIOS.map((s) => [s, t.adjudicated[s].length ? dist(t.adjudicated[s]) : null]));
    }
  }
  return {
    run_id: report.run_id,
    created_at: report.created_at,
    source: report.source,
    design: { ...report.design, tasks: report.design.tasks.map((t) => `${t.id} [${t.split}, ${t.provenance_kind}]`) },
    budget: report.budget,
    provenance: report.provenance || null,
    cost: report.cost,
    adjudication: status,
    arms,
  };
}

/**
 * Adjudicated per-run per-task single-arm evidence for routing: one entry per
 * {run, evidence_key, task, defect}. Only arm 'single', ok cells, fully
 * adjudicated, non-null evidence_key. Candidate-only data is never returned.
 */
export function readBenchEvidence(root = process.cwd(), env = process.env) {
  const out = [];
  for (const file of listReportFiles(root, env)) {
    let report;
    try {
      report = loadReport(file, { root, env });
    } catch {
      continue;
    }
    const adj = judgmentMap(loadAdjudication(report.run_id, { root, env }));
    if (!adj.size) continue;
    const meta = new Map(report.design.tasks.map((t) => [t.id, t]));
    const groups = new Map();
    for (const c of report.cells) {
      if (c.arm !== 'single' || c.status !== 'ok' || !c.evidence_key) continue;
      const t = meta.get(c.task_id);
      if (!t) continue;
      const pess = unitMetrics({ defects: t.defects }, [c], adj, 'pessimistic');
      const opt = unitMetrics({ defects: t.defects }, [c], adj, 'optimistic');
      if (!pess || !opt) continue;
      const k = `${c.evidence_key}\u0000${c.task_id}`;
      if (!groups.has(k)) groups.set(k, { evidence_key: c.evidence_key, spec: c.spec, task: t, runs: [] });
      groups.get(k).runs.push({ pess, opt, ms: c.duration_ms });
    }
    for (const g of groups.values()) {
      for (const d of g.task.defects) {
        const ms = g.runs.map((r) => r.ms).filter(Number.isFinite);
        out.push({
          run_id: report.run_id,
          created_at: report.created_at,
          evidence_key: g.evidence_key,
          spec: g.spec,
          task_id: g.task.id,
          defect_id: d,
          runs_n: g.runs.length,
          hits_n: g.runs.filter((r) => r.pess.detected.includes(d)).length,
          hits_upper_n: g.runs.filter((r) => r.opt.detected.includes(d)).length,
          uncertain_runs: g.runs.filter((r) => r.pess.uncertain > 0).length,
          mean_duration_ms: ms.length ? Math.round(mean(ms)) : null,
        });
      }
    }
  }
  return out;
}

export function listRuns(root = process.cwd(), env = process.env) {
  const rows = [];
  for (const file of listReportFiles(root, env)) {
    try {
      const r = loadReport(file, { root, env });
      const adj = loadAdjudication(r.run_id, { root, env });
      rows.push({
        run_id: r.run_id,
        created_at: r.created_at,
        source: r.source,
        mode: r.design.mode,
        arms: r.design.arms,
        providers: r.design.providers,
        cells: r.cells.length,
        adjudicated_claims: adj ? adj.judgments.length : 0,
      });
    } catch {
      /* legacy / malformed: not listed */
    }
  }
  return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv, { values = [], bools = [] }) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq > 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (bools.includes(key)) {
      out[key] = true;
    } else if (values.includes(key)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) throw new Error(`--${key} requires a value`);
      }
      out[key] = val;
    } else {
      throw new Error(`unknown flag --${key}`);
    }
  }
  return out;
}

const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);
function intFlag(v, name) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function textCompare(c) {
  const lines = [`baseline: ${c.baseline.label}${c.baseline.resolved ? ` (${c.baseline.resolved.spec}, ${c.baseline.resolved.selection})` : ''}`, `split: ${c.split} · ${c.mode} · tasks: ${c.tasks_evaluated.join(', ') || '(none)'}`];
  for (const e of c.comparisons) {
    lines.push('', `== ${e.arm} ==`, `verdict: ${e.verdict}`);
    for (const [s, r] of Object.entries(e.results)) {
      const m = r.summary.recall;
      lines.push(`  [${s}] recall diff ${m.mean_diff} CI ${m.ci95 ? `${m.ci95.lo}..${m.ci95.hi}` : 'n/a'} over ${m.n_tasks} task(s); excluded: ${r.excluded_tasks.length}`);
    }
  }
  return lines.join('\n');
}

const HELP = `xllm bench — repeated, paired, human-adjudicated review evaluation (live calls opt-in)
Results: <state dir>/benchmarks/{results,adjudications,cases}

  run  --providers p:model[,..] [--tasks-file NAME] [--tasks id,..] [--split dev|heldout|all]
       [--repeats N (>=3; omit with --regression for 1)] [--regression]
       [--arms anchor-review,final] [--anchor SPEC --reviewer SPEC] [--synthesizer SPEC --panel SPEC,..]
       [--call-timeout-sec S] [--live --max-calls N --deadline-minutes M]
       Without --live: prints the call plan, makes no calls, writes nothing.
  export-prompts --tasks-file NAME --out DIR
  import-native FILE [--tasks-file NAME]        (${NATIVE_SCHEMA})
  import-cases FILE [--name N] [--replace]      (${CASES_SCHEMA}; real retrospective cases)
  adjudicate export RUN [--out FILE] [--unblind]
  adjudicate apply FILE [--replace]
  adjudicate status RUN
  compare --run RUN[,RUN..]|all --baseline ARM --arms ARM,.. [--split heldout|dev|all] [--strongest SPEC]
          [--difficulty-threshold 0.70 [--difficulty-from RUN,..]] [--candidate-only] [--text]
          ARM: single:SPEC | strongest-single | panel:A+B | local-panel | anchor-review | final | native:LABEL
  report RUN [--text] | list | grade-selftest`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const ctx = { root: process.cwd(), env: process.env };
  const emit = (v) => console.log(JSON.stringify(v, null, 2));
  const fail = (errors) => {
    for (const e of [].concat(errors)) console.error(`[bench] ${e}`);
    process.exit(1);
  };

  try {
    if (cmd === 'grade-selftest') {
      const t1 = loadTasks().tasks[0];
      const g = gradeAnswer(t1, 'This has SQL injection via string concatenation; also reflected XSS because output is not escaped.');
      console.log(JSON.stringify(g));
      process.exit(g.hits.length === 2 ? 0 : 1);
    }

    if (cmd === 'run') {
      const f = parseFlags(rest, {
        values: ['providers', 'tasks-file', 'tasks', 'split', 'repeats', 'arms', 'anchor', 'reviewer', 'synthesizer', 'panel', 'call-timeout-sec', 'max-calls', 'deadline-minutes'],
        bools: ['live', 'regression'],
      });
      const r = await runBench({
        ...ctx,
        providers: csv(f.providers) || [],
        taskIds: csv(f.tasks),
        tasksFile: f['tasks-file'] || null,
        split: f.split || 'all',
        repeats: intFlag(f.repeats, 'repeats'),
        regression: !!f.regression,
        arms: csv(f.arms) || [],
        anchor: f.anchor || null,
        reviewer: f.reviewer || null,
        synthesizer: f.synthesizer || null,
        panel: csv(f.panel),
        live: !!f.live,
        maxCalls: intFlag(f['max-calls'], 'max-calls'),
        deadlineMinutes: intFlag(f['deadline-minutes'], 'deadline-minutes'),
        callTimeoutSec: intFlag(f['call-timeout-sec'], 'call-timeout-sec'),
      });
      if (r.errors) fail(r.errors);
      if (r.dryRun) emit({ dry_run: true, note: 'no --live: zero advisor calls made, nothing written', plan: r.plan, warnings: r.warnings });
      else emit({ run_id: r.report.run_id, report: r.reportPath, budget: r.report.budget, summary: r.summary });
      process.exit(r.exitCode);
    }

    if (cmd === 'export-prompts') {
      const f = parseFlags(rest, { values: ['tasks-file', 'out'] });
      if (!f.out) fail('--out DIR required');
      const m = exportPrompts(f['tasks-file'] || null, f.out, ctx);
      emit({ out: path.resolve(f.out), prompts: m.prompts.length, task_set_sha256: m.task_set_sha256 });
      process.exit(0);
    }

    if (cmd === 'import-native') {
      const f = parseFlags(rest, { values: ['tasks-file'] });
      if (!f._[0]) fail('usage: import-native FILE');
      const r = importNative(f._[0], { ...ctx, tasksFile: f['tasks-file'] || null });
      if (!r.ok) fail(r.errors);
      emit(r);
      process.exit(0);
    }

    if (cmd === 'import-cases') {
      const f = parseFlags(rest, { values: ['name'], bools: ['replace'] });
      if (!f._[0]) fail('usage: import-cases FILE');
      const r = importCases(f._[0], { ...ctx, name: f.name || null, replace: !!f.replace });
      if (!r.ok) fail(r.errors);
      emit(r);
      process.exit(0);
    }

    if (cmd === 'adjudicate') {
      const sub = rest[0];
      if (sub === 'export') {
        const f = parseFlags(rest.slice(1), { values: ['out'], bools: ['unblind'] });
        if (!f._[0]) fail('usage: adjudicate export RUN [--out FILE] [--unblind]');
        const report = loadReport(f._[0], ctx);
        const ws = buildWorksheet(report, { blind: !f.unblind });
        const out = f.out || path.join(benchAdjudicationsDir(ctx.root, ctx.env), `${report.run_id}.worksheet.json`);
        writeJson(out, ws);
        emit({ worksheet: path.resolve(out), cells: ws.cells.length, claims: ws.judgments.length, blind: !f.unblind });
        process.exit(0);
      }
      if (sub === 'apply') {
        const f = parseFlags(rest.slice(1), { bools: ['replace'] });
        if (!f._[0]) fail('usage: adjudicate apply FILE [--replace]');
        const r = applyAdjudication(f._[0], { ...ctx, replace: !!f.replace });
        if (!r.ok) fail(r.errors);
        emit(r);
        process.exit(0);
      }
      if (sub === 'status') {
        const f = parseFlags(rest.slice(1), {});
        if (!f._[0]) fail('usage: adjudicate status RUN');
        const report = loadReport(f._[0], ctx);
        emit(adjudicationStatus(report, judgmentMap(loadAdjudication(report.run_id, ctx))));
        process.exit(0);
      }
      fail('usage: adjudicate export|apply|status');
    }

    if (cmd === 'compare') {
      const f = parseFlags(rest, {
        values: ['run', 'baseline', 'arms', 'split', 'strongest', 'difficulty-threshold', 'difficulty-from'],
        bools: ['candidate-only', 'text'],
      });
      if (!f.run || !f.baseline || !f.arms) fail('usage: compare --run RUN[,..] --baseline ARM --arms ARM,.. [--split heldout]');
      const runs = loadRuns(csv(f.run), ctx);
      const dRuns = f['difficulty-from'] ? loadRuns(csv(f['difficulty-from']), ctx) : null;
      const split = f.split || 'heldout';
      if (split !== 'all' && !SPLITS.includes(split)) fail('--split must be dev|heldout|all');
      const c = compareArms(runs, {
        baseline: f.baseline,
        arms: csv(f.arms),
        split,
        difficultyThreshold: intFlag(f['difficulty-threshold'], 'difficulty-threshold'),
        difficultyRuns: dRuns,
        strongest: f.strongest || null,
        candidateOnly: !!f['candidate-only'],
      });
      if (f.text) console.log(textCompare(c));
      else emit(c);
      process.exit(0);
    }

    if (cmd === 'report') {
      const f = parseFlags(rest, { bools: ['text'] });
      if (!f._[0]) fail('usage: report RUN');
      const report = loadReport(f._[0], ctx);
      const r = reportRun(report, judgmentMap(loadAdjudication(report.run_id, ctx)));
      if (f.text) {
        console.log(`${r.run_id} (${r.source}) ${r.design.mode}, repeats ${r.design.repeats}`);
        for (const [k, a] of Object.entries(r.arms)) {
          console.log(`\n${k}  attribution: ${JSON.stringify(a.attribution)}  failures: ${JSON.stringify(a.failures)}`);
          for (const [t, v] of Object.entries(a.tasks)) {
            const c = v.candidate_recall;
            console.log(`  ${t}: candidate recall mean ${c.mean} sd ${c.sd} n ${c.n}; failed ${v.failed}`);
          }
        }
      } else emit(r);
      process.exit(0);
    }

    if (cmd === 'list') {
      emit(listRuns(ctx.root, ctx.env));
      process.exit(0);
    }
  } catch (e) {
    console.error(`[bench] ${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  console.error(HELP);
  process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-bench.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
