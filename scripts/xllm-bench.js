#!/usr/bin/env node
/**
 * xllm bench — seeded-defect diversity benchmark.
 *
 * Improvement 3 of docs/diversity-roadmap.md: the controlled experiment that
 * proves or refutes the diversity dividend. Compares, on tasks with KNOWN
 * planted defects:
 *   - single:  each provider reviews alone
 *   - panel:   blind same-prompt panel (union of detections)
 *   - debate:  adversarial refutation; grade the SURVIVING claims
 *   - council: panel -> debate; grade the SURVIVING claims
 * and reports incremental defects found, misses, duration, pairwise error
 * correlation (hit/miss agreement over task×defect cells), and — for the
 * deliberation modes — whether SURVIVED tracks real detections (grounded vs
 * surplus survival). Also tags each provider's measurement surface
 * (cli-agentic vs http-completion) so the model-vs-harness confound is visible.
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
} from './xllm-advisor.js';
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
 * Which delivery surface does xllm actually measure for a provider? The bench
 * unit is NOT the raw model — it is the advisor surface xllm calls. The vendor
 * CLIs (codex/claude/grok/…) may run their own agentic loop/tools we do not
 * control, so a strong CLI score can be model quality OR harness amplification;
 * the HTTP completion providers (ollama/lmstudio) are much closer to the raw
 * model. Recording this makes every result self-describing about that confound.
 */
export function providerSurface(spec) {
  const provider = String(spec || '').split(/[:@]/)[0].toLowerCase();
  if (provider === 'ollama' || provider === 'lmstudio') return 'http-completion';
  if (provider === 'lemonade') return 'binary-stub';
  return 'cli-agentic';
}

/**
 * Grade debate/council claims against a task's seeded defects. A claim is
 * "grounded" if its text maps to >=1 seeded defect; otherwise "surplus".
 *
 * IMPORTANT honesty caveat: surplus != false. A surplus claim can be a genuine
 * UNSEEDED defect (frontier models routinely find real issues outside the
 * planted set) OR a hallucinated one — the two are deliberately conflated here
 * because the grader cannot tell them apart. So surplus survival is a NOISY
 * proxy. The falsifiable signal is the DIFFERENTIAL: does deliberation preserve
 * grounded (real-defect) claims at a higher rate than surplus ones?
 */
export function gradeClaims(task, claims) {
  return (claims || []).map((c) => {
    const g = gradeAnswer(task, `${c.text || ''} ${c.evidence || ''}`);
    return {
      id: c.id,
      author: c.author || c.authorSpec || null,
      status: c.status,
      text: c.text || '',
      mapped_defects: g.hits,
      grounded: g.hits.length > 0,
    };
  });
}

/**
 * The deliberation quality signal, from graded claims:
 *  - grounded_survival_rate: does debate PRESERVE real detections? (should be
 *    high — if debate kills grounded claims, it is destroying signal)
 *  - quality_discrimination = grounded_rate - surplus_rate: does debate keep
 *    grounded claims MORE than surplus ones? (>0 = discriminates by quality;
 *    ~0 = deliberation theater — the SURVIVED label is not tracking truth).
 *    Confounded downward by real-unseeded surplus, so it is a LOWER bound.
 *  - seeded_defects_covered: distinct seeded defects with >=1 SURVIVING claim.
 */
export function deliberationScore(graded) {
  const survived = (c) => c.status === 'SURVIVED';
  const grounded = graded.filter((c) => c.grounded);
  const surplus = graded.filter((c) => !c.grounded);
  const rate = (arr) => (arr.length ? +(arr.filter(survived).length / arr.length).toFixed(3) : null);
  const gr = rate(grounded);
  const sr = rate(surplus);
  return {
    total_claims: graded.length,
    grounded_claims: grounded.length,
    grounded_survived: grounded.filter(survived).length,
    grounded_survival_rate: gr,
    surplus_claims: surplus.length,
    surplus_survived: surplus.filter(survived).length,
    surplus_survival_rate: sr,
    quality_discrimination: gr !== null && sr !== null ? +(gr - sr).toFixed(3) : null,
    seeded_defects_covered: [...new Set(grounded.filter(survived).flatMap((c) => c.mapped_defects))],
  };
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
  const advisor = path.join(HERE, 'xllm-advisor.js');
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
    // Self-describing measurement surface (model-vs-harness confound): the
    // vendor CLIs may run their own agentic loop; http-completion is closer to
    // the raw model. A cross-surface panel mixes both — noted here, not hidden.
    surfaces: Object.fromEntries(parsed.map((p) => [p.spec, providerSurface(p.spec)])),
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

  // Deliberation modes — run the ACTUAL debate/council protocol over each
  // seeded task and grade the SURVIVING claims. This is the first measurement
  // of the quality claim ("plausible-but-wrong claims die, correct ones
  // survive"), which debate/council previously shipped on design + live e2e
  // only. Lazy-imported to keep single/panel runs free of the heavier deps.
  for (const mode of ['debate', 'council']) {
    if (!modes.includes(mode)) continue;
    const runner =
      mode === 'debate'
        ? (await import('./xllm-debate.js')).runDebate
        : (await import('./xllm-council.js')).runCouncil;
    const specs = parsed.map((p) => p.spec);
    const agg = {
      per_task: {},
      task_errors: 0,
      grounded_claims: 0,
      grounded_survived: 0,
      surplus_claims: 0,
      surplus_survived: 0,
      seeded_defects_covered: 0,
      duration_ms: 0,
      caveat:
        'surplus != false (a surplus claim may be a real UNSEEDED defect); ' +
        'quality_discrimination is a lower-bound signal, not a false-positive rate.',
    };
    const coveredAll = new Set();
    for (const t of tasks) {
      console.error(`[bench] ${mode} × ${t.id}…`);
      const started = Date.now();
      let res;
      try {
        res = await runner({ specs, question: buildBenchPrompt(spec, t), root: process.cwd() });
      } catch {
        res = { exitCode: 1 };
      }
      const claimResults = mode === 'debate' ? res.results : res.debate && res.debate.results;
      if (res.exitCode !== 0 || !Array.isArray(claimResults)) {
        agg.per_task[t.id] = { error: true };
        agg.task_errors += 1;
        agg.duration_ms += Date.now() - started;
        continue;
      }
      const graded = gradeClaims(t, claimResults);
      const score = deliberationScore(graded);
      // Coverage counted against THIS task's seeded defects only.
      const taskCovered = score.seeded_defects_covered.filter((d) =>
        t.defects.some((x) => x.id === d)
      );
      taskCovered.forEach((d) => coveredAll.add(`${t.id}:${d}`));
      agg.per_task[t.id] = {
        tally: (mode === 'debate' ? res.tally : res.debate.tally) || null,
        ...score,
        seeded_defects_covered: taskCovered,
        seeded_defects_total: t.defects.length,
      };
      agg.grounded_claims += score.grounded_claims;
      agg.grounded_survived += score.grounded_survived;
      agg.surplus_claims += score.surplus_claims;
      agg.surplus_survived += score.surplus_survived;
      agg.duration_ms += Date.now() - started;
    }
    agg.seeded_defects_covered = coveredAll.size;
    const gRate = agg.grounded_claims ? +(agg.grounded_survived / agg.grounded_claims).toFixed(3) : null;
    const sRate = agg.surplus_claims ? +(agg.surplus_survived / agg.surplus_claims).toFixed(3) : null;
    agg.grounded_survival_rate = gRate;
    agg.surplus_survival_rate = sRate;
    agg.quality_discrimination = gRate !== null && sRate !== null ? +(gRate - sRate).toFixed(3) : null;
    agg.verdict =
      agg.task_errors === tasks.length
        ? 'INCONCLUSIVE — every task errored'
        : gRate === null
          ? 'INCONCLUSIVE — no grounded claims surfaced'
          : agg.quality_discrimination === null
            ? `grounded claims survived ${(gRate * 100).toFixed(0)}% (no surplus claims to contrast)`
            : agg.quality_discrimination > 0
              ? `deliberation DISCRIMINATED by quality: grounded survived ${(gRate * 100).toFixed(0)}% vs surplus ${(sRate * 100).toFixed(0)}% (+${(agg.quality_discrimination * 100).toFixed(0)}pt)`
              : `NO quality discrimination on this run: grounded ${(gRate * 100).toFixed(0)}% vs surplus ${(sRate * 100).toFixed(0)}%`;
    report[mode] = agg;
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

  const summary = {};
  if (report.dividend) summary.dividend = report.dividend;
  for (const mode of ['debate', 'council']) {
    if (report[mode]) {
      summary[mode] = {
        verdict: report[mode].verdict,
        grounded_survival_rate: report[mode].grounded_survival_rate,
        surplus_survival_rate: report[mode].surplus_survival_rate,
        quality_discrimination: report[mode].quality_discrimination,
        seeded_defects_covered: report[mode].seeded_defects_covered,
        task_errors: report[mode].task_errors,
      };
    }
  }
  console.log(JSON.stringify(summary, null, 2));
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
  node scripts/xllm-bench.js run --providers p1,p2[,p3] [--tasks t1,t2] [--modes single,panel,debate,council]
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
