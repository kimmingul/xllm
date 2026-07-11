#!/usr/bin/env node
/**
 * xllm bench — seeded-defect diversity benchmark.
 *
 * Improvement 3 of docs/diversity-roadmap.md: the controlled experiment that
 * proves or refutes the diversity dividend. Compares, on tasks with KNOWN
 * planted defects:
 *   - single:  each provider reviews alone
 *   - panel:   blind same-prompt panel (union of detections)
 * and reports incremental defects found, misses, duration, and pairwise
 * error correlation (hit/miss agreement over task×defect cells).
 *
 * Grading is deterministic regex matching against known defect labels —
 * imperfect but falsifiable and cheap. Live providers required; NOT part of
 * CI (`npm run bench:live`).
 *
 *   node scripts/xllm-bench.js run --providers p1,p2 [--tasks t1,t2] [--modes single,panel]
 *   node scripts/xllm-bench.js grade-selftest
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'process';
import {
  parseProviderSpec,
  ensureArtifactDirs,
  getProviderCostMeta,
  slugify,
} from './grok-ask-advisor.js';
import { rawFromArtifact } from './xllm-panel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, '..', 'benchmarks', 'tasks');
const TASKS_PATH = path.join(TASKS_DIR, 'tasks.json');

/** Resolve a task set: absolute/relative path, or a bare name in tasks dir. */
export function resolveTasksFile(nameOrPath) {
  if (!nameOrPath) return TASKS_PATH;
  if (fs.existsSync(nameOrPath)) return nameOrPath;
  const named = path.join(TASKS_DIR, nameOrPath.endsWith('.json') ? nameOrPath : `${nameOrPath}.json`);
  if (fs.existsSync(named)) return named;
  throw new Error(`task file not found: ${nameOrPath}`);
}

export function loadTasks(file = TASKS_PATH) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const t of spec.tasks) {
    for (const d of t.defects) new RegExp(d.pattern, 'i'); // validate regexes
  }
  return spec;
}

/** Deterministic grading: which known defects does this answer mention? */
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

/**
 * Pairwise error correlation over task×defect cells: fraction of cells where
 * two providers agree (both hit or both miss). High agreement on MISSES is
 * the correlated-blind-spot signal the debate warned about.
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

export function buildBenchPrompt(spec, task) {
  return `${spec.question}\n\n\`\`\`js\n${task.code}\n\`\`\``;
}

export function askChild(providerSpec, prompt) {
  const advisor = path.join(HERE, 'grok-ask-advisor.js');
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [advisor, providerSpec, prompt], {
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ raw: '', ok: false, ms: Date.now() - started }));
    child.on('close', (code) => {
      const artifact = code === 0 && out.trim() ? out.trim().split(/\r?\n/).pop() : null;
      resolve({
        raw: artifact ? rawFromArtifact(artifact) : '',
        ok: code === 0,
        ms: Date.now() - started,
      });
    });
  });
}

export async function runBench({ providers, taskIds = null, modes = ['single', 'panel'], tasksFile = null }) {
  const spec = loadTasks(resolveTasksFile(tasksFile));
  const tasks = spec.tasks.filter((t) => !taskIds || taskIds.includes(t.id));
  if (!tasks.length) {
    console.error('[bench] no tasks selected');
    return { exitCode: 1 };
  }
  const parsed = providers.map((s) => {
    const p = parseProviderSpec(s);
    if (!p) {
      console.error(`[bench] unknown provider: ${s}`);
      process.exit(1);
    }
    return p;
  });

  const report = {
    created_at: new Date().toISOString(),
    providers: parsed.map((p) => p.spec),
    tasks: tasks.map((t) => t.id),
    modes,
    single: {},
    panel: {},
    correlation: [],
  };

  // task×defect hit cells per provider (for correlation)
  const cells = Object.fromEntries(parsed.map((p) => [p.spec, {}]));

  // A provider that crashed on a task produced NO judgment — grading it as
  // "found 0 defects" would confound the dividend and error correlation
  // (a dead model is not a decorrelated reviewer). Track errors explicitly
  // and exclude erroring runs from cells / dividend / correlation.
  const errored = Object.fromEntries(parsed.map((p) => [p.spec, 0]));

  if (modes.includes('single')) {
    for (const p of parsed) {
      report.single[p.spec] = {
        detected: 0,
        total: 0,
        errors: 0,
        graded_tasks: 0,
        per_task: {},
        duration_ms: 0,
      };
      for (const t of tasks) {
        console.error(`[bench] single ${p.spec} × ${t.id}…`);
        const r = await askChild(p.spec, buildBenchPrompt(spec, t));
        if (!r.ok || !r.raw.trim()) {
          report.single[p.spec].per_task[t.id] = { error: true };
          report.single[p.spec].errors += 1;
          errored[p.spec] += 1;
          report.single[p.spec].duration_ms += r.ms;
          continue; // no cells — this run is not a data point
        }
        const grade = gradeAnswer(t, r.raw);
        report.single[p.spec].per_task[t.id] = grade;
        report.single[p.spec].detected += grade.hits.length;
        report.single[p.spec].total += t.defects.length;
        report.single[p.spec].graded_tasks += 1;
        report.single[p.spec].duration_ms += r.ms;
        for (const d of t.defects) {
          cells[p.spec][`${t.id}:${d.id}`] = grade.hits.includes(d.id);
        }
      }
    }
    // pairwise error correlation — only over cells both providers actually
    // produced (errorCorrelation already intersects keys).
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const corr = errorCorrelation(cells[parsed[i].spec], cells[parsed[j].spec]);
        if (corr && corr.cells > 0) {
          report.correlation.push({ pair: `${parsed[i].spec} ↔ ${parsed[j].spec}`, ...corr });
        }
      }
    }
  }

  if (modes.includes('panel')) {
    report.panel = { detected: 0, total: 0, per_task: {}, panelist_errors: 0, duration_ms: 0 };
    for (const t of tasks) {
      console.error(`[bench] panel × ${t.id}…`);
      const started = Date.now();
      // Union of detections across panelists that actually produced output.
      const union = new Set();
      let contributed = 0;
      for (const p of parsed) {
        const r = await askChild(p.spec, buildBenchPrompt(spec, t));
        if (r.ok && r.raw.trim()) {
          contributed += 1;
          for (const h of gradeAnswer(t, r.raw).hits) union.add(h);
        } else {
          report.panel.panelist_errors += 1;
        }
      }
      const hits = [...union];
      report.panel.per_task[t.id] = {
        hits,
        misses: t.defects.map((d) => d.id).filter((d) => !union.has(d)),
        panelists_contributing: contributed,
      };
      report.panel.detected += hits.length;
      report.panel.total += t.defects.length;
      report.panel.duration_ms += Date.now() - started;
    }
  }

  // Dividend summary — only over providers that actually ran (a crashed
  // model is not a data point). Flag validity so "no dividend" is never
  // read as proof when the comparison was confounded.
  if (modes.includes('single') && modes.includes('panel')) {
    const ran = parsed
      .map((p) => p.spec)
      .filter((s) => report.single[s] && report.single[s].graded_tasks > 0);
    const excluded = parsed.map((p) => p.spec).filter((s) => !ran.includes(s));
    const bestSingle = ran.length
      ? Math.max(...ran.map((s) => report.single[s].detected))
      : 0;
    const valid = ran.length >= 2; // need ≥2 working providers to test diversity
    report.dividend = {
      best_single_detected: bestSingle,
      panel_detected: report.panel.detected,
      incremental_defects: report.panel.detected - bestSingle,
      providers_that_ran: ran,
      providers_excluded_as_errored: excluded,
      valid_comparison: valid,
      verdict: !valid
        ? `INCONCLUSIVE — only ${ran.length} provider(s) produced output (excluded: ${excluded.join(', ') || 'none'}); cannot test diversity`
        : report.panel.detected > bestSingle
          ? 'diversity dividend OBSERVED on this run'
          : 'NO dividend over best single on this run',
    };
  }

  const dir = path.join(HERE, '..', 'benchmarks', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const base = `bench-${slugify(parsed.map((p) => p.spec).join('+'))}-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}`;
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify(report.dividend || {}, null, 2));
  console.log(jsonPath);
  return { exitCode: 0, report, jsonPath };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'grade-selftest') {
    // Deterministic self-test of the grader against canned answers.
    const spec = loadTasks();
    const t1 = spec.tasks[0];
    const g = gradeAnswer(
      t1,
      'This has SQL injection via string concatenation; also reflected XSS because output is not escaped.'
    );
    console.log(JSON.stringify(g));
    process.exit(g.hits.length === 2 ? 0 : 1);
  }

  if (cmd === 'run') {
    const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
    const providers = (get('--providers') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const taskIds = get('--tasks') ? get('--tasks').split(',').map((s) => s.trim()) : null;
    const modes = get('--modes') ? get('--modes').split(',').map((s) => s.trim()) : ['single', 'panel'];
    const tasksFile = get('--tasks-file');
    if (providers.length < 2) {
      console.error('Usage: xllm-bench run --providers p1,p2[,p3] [--tasks-file NAME] [--tasks t1,t2] [--modes single,panel]');
      process.exit(1);
    }
    const r = await runBench({ providers, taskIds, modes, tasksFile });
    process.exit(r.exitCode);
  }

  console.error(`xllm bench — seeded-defect diversity benchmark (live providers required)
Usage:
  node scripts/xllm-bench.js run --providers p1,p2[,p3] [--tasks t1,t2] [--modes single,panel]
  node scripts/xllm-bench.js grade-selftest`);
  process.exit(cmd ? 1 : 0);
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
