#!/usr/bin/env node
/**
 * xllm calibrate — difficulty-filtered diversity benchmark.
 *
 * Motivation: on easy/well-known defects, strong models score ~100% and their
 * errors are perfectly correlated, so there is no room to observe a diversity
 * dividend. This tool first CALIBRATES: it runs each model on every task,
 * measures per-task detection rate, and keeps only the problems that are hard
 * for ALL models (every model ≤ threshold). Because a blind panel is just the
 * same prompt sent to each model independently, the single-run data IS the
 * panel data — one pass yields both the filter and the panel result.
 *
 *   node scripts/xllm-calibrate.js \
 *     --models claude:opus,codex:gpt-5.5,grok:grok-4.5,ollama:glm-5.2:cloud,ollama:gemma4:cloud \
 *     --panel  claude:opus,grok:grok-4.5,ollama:gemma4:cloud \
 *     --tasks-file hard-tasks --threshold 0.70
 *
 * Runs strictly sequentially (one model call at a time) to avoid the local/
 * cloud resource contention that stalls parallel runs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'process';
import {
  loadTasks,
  resolveTasksFile,
  gradeAnswer,
  errorCorrelation,
  buildBenchPrompt,
  askChild,
} from './xllm-bench.js';

// Allow same-vendor advising (e.g. claude from inside Claude Code) — this is a
// controlled measurement, not nested task advising.
process.env.XLLM_ALLOW_SELF = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pct(x) {
  return x == null ? ' err ' : (x * 100).toFixed(0).padStart(3) + '%';
}

export function qualifies(rates, threshold) {
  const vals = Object.values(rates);
  if (vals.some((r) => r == null)) return false; // incomplete → exclude
  return vals.every((r) => r <= threshold);
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
  const models = (get('--models') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const panel = (get('--panel') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const threshold = Number(get('--threshold', '0.70'));
  const tasksFile = get('--tasks-file', 'hard-tasks');
  if (models.length < 2) {
    console.error('Usage: xllm-calibrate --models a,b,c --panel a,b --tasks-file hard-tasks --threshold 0.70');
    process.exit(1);
  }

  const spec = loadTasks(resolveTasksFile(tasksFile));
  const tasks = spec.tasks;
  console.error(`[calibrate] ${models.length} models × ${tasks.length} tasks, threshold ≤${threshold}`);

  // One sequential pass: model × task → detection rate + hit cells.
  const rateByTask = {}; // taskId → { model → rate|null }
  const cells = Object.fromEntries(models.map((m) => [m, {}])); // model → {task:defect -> bool}
  const errorsByModel = Object.fromEntries(models.map((m) => [m, 0]));

  for (const t of tasks) {
    rateByTask[t.id] = {};
    for (const m of models) {
      process.stderr.write(`[calibrate] ${m} × ${t.id} … `);
      const r = await askChild(m, buildBenchPrompt(spec, t));
      if (!r.ok || !r.raw.trim()) {
        rateByTask[t.id][m] = null;
        errorsByModel[m] += 1;
        process.stderr.write('ERROR\n');
        continue;
      }
      const g = gradeAnswer(t, r.raw);
      const rate = g.hits.length / t.defects.length;
      rateByTask[t.id][m] = rate;
      for (const d of t.defects) cells[m][`${t.id}:${d.id}`] = g.hits.includes(d.id);
      process.stderr.write(`${(rate * 100).toFixed(0)}% (${r.ms}ms)\n`);
    }
  }

  // Filter: tasks hard for ALL models.
  const filtered = tasks.filter((t) => qualifies(rateByTask[t.id], threshold));

  // Panel result over filtered tasks (panel ⊆ models — reuse the same runs).
  const panelModels = panel.length ? panel : models.slice(0, 3);
  let panelDetected = 0;
  let bestSingle = 0;
  let totalDefects = 0;
  const perModelOnFiltered = Object.fromEntries(panelModels.map((m) => [m, 0]));
  const panelPerTask = {};
  for (const t of filtered) {
    const union = new Set();
    for (const m of panelModels) {
      for (const d of t.defects) {
        if (cells[m][`${t.id}:${d.id}`]) {
          union.add(d.id);
          perModelOnFiltered[m] += 1;
        }
      }
    }
    panelPerTask[t.id] = { hits: [...union], defects: t.defects.length };
    panelDetected += union.size;
    totalDefects += t.defects.length;
  }
  bestSingle = panelModels.length ? Math.max(...panelModels.map((m) => perModelOnFiltered[m])) : 0;

  // Pairwise error correlation among panel models over filtered cells only.
  const filteredCellKeys = new Set(filtered.flatMap((t) => t.defects.map((d) => `${t.id}:${d.id}`)));
  const restrict = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => filteredCellKeys.has(k)));
  const correlation = [];
  for (let i = 0; i < panelModels.length; i++) {
    for (let j = i + 1; j < panelModels.length; j++) {
      const corr = errorCorrelation(restrict(cells[panelModels[i]]), restrict(cells[panelModels[j]]));
      if (corr && corr.cells > 0) {
        correlation.push({ pair: `${panelModels[i]} ↔ ${panelModels[j]}`, ...corr });
      }
    }
  }

  const report = {
    created_at: new Date().toISOString(),
    models,
    panel: panelModels,
    threshold,
    tasks_file: tasksFile,
    rate_by_task: rateByTask,
    errors_by_model: errorsByModel,
    filtered_task_ids: filtered.map((t) => t.id),
    panel_on_filtered: {
      tasks: filtered.length,
      total_defects: totalDefects,
      per_model_detected: perModelOnFiltered,
      best_single_detected: bestSingle,
      panel_detected: panelDetected,
      incremental_defects: panelDetected - bestSingle,
      valid: filtered.length >= 1 && panelModels.length >= 2,
      verdict:
        filtered.length < 1
          ? 'NO qualifying problems — task set too easy for these models at this threshold'
          : panelDetected > bestSingle
            ? `diversity dividend OBSERVED: +${panelDetected - bestSingle} defects over best single`
            : 'NO dividend over best single, even on hard-filtered problems',
    },
    correlation,
    panel_per_task: panelPerTask,
  };

  const dir = path.join(HERE, '..', 'benchmarks', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `calibrate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Human summary
  console.log('\n=== Calibration (per-task detection rate) ===');
  console.log(['task'.padEnd(16), ...models.map((m) => m.slice(0, 14).padEnd(15))].join(''));
  for (const t of tasks) {
    const mark = filtered.includes(t) ? ' ✓hard' : '';
    console.log([t.id.padEnd(16), ...models.map((m) => pct(rateByTask[t.id][m]).padEnd(15))].join('') + mark);
  }
  console.log(`\nQualifying (all models ≤${threshold}): ${filtered.map((t) => t.id).join(', ') || '(none)'}`);
  console.log('\n=== Panel on filtered set ===');
  console.log(JSON.stringify(report.panel_on_filtered, null, 2));
  console.log('\n=== Pairwise error correlation (panel, filtered) ===');
  for (const c of correlation) console.log(`  ${c.pair}: agreement ${c.agreement_rate} · shared blind spots ${c.shared_blind_spots} · ${c.cells} cells`);
  console.log(`\n${jsonPath}`);
  process.exit(0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-calibrate.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
