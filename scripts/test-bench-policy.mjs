// Behavioral regressions for the bench evaluation harness (node:test, offline, no live calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  planBench,
  runBench,
  extractClaims,
  buildWorksheet,
  validateAdjudication,
  applyAdjudication,
  loadReport,
  loadAdjudication,
  unitMetrics,
  compareArms,
  selectStrongestSingle,
  readBenchEvidence,
  importNative,
  importCases,
  resolveTasksFile,
  loadTasks,
  buildBenchPrompt,
  qualifies,
  bootstrapMeanCI,
  benchResultsDir,
  interpretEnvelope,
  gradeAnswer,
  reportRun,
} from './xllm-bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-bench-test-'));
  return { root, env: { ...process.env, XLLM_STATE_DIR: '.state' }, ctx: { root, env: { ...process.env, XLLM_STATE_DIR: '.state' } } };
}

function writeTasks(root, tasks, extra = {}) {
  const file = path.join(root, 'tasks.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, question: 'Review. List every defect.', tasks, ...extra }),
    'utf8'
  );
  return file;
}

const mkTask = (id, extra = {}) => ({
  id,
  code: `function ${id.replace(/\W/g, '_')}() {}`,
  defects: [
    { id: 'a', pattern: 'alpha', description: 'defect a' },
    { id: 'b', pattern: 'beta', description: 'defect b' },
  ],
  ...extra,
});

const attribution = (model, over = {}) => ({
  requested_provider: 'ollama',
  requested_model: model,
  executed_provider: 'ollama',
  transmitted_model: model,
  substituted_from: null,
  model_correction_source: null,
  reported_model: model,
  identity_status: 'resolved',
  model_revision: 'sha256:' + sha(model).slice(0, 12),
  requested_effort: null,
  effective_effort: null,
  cli_version: null,
  surface: 'http-completion',
  execution_location: 'local',
  ...over,
});

/** Fake advisor: reply(spec, prompt, callIndex) -> string | {fail:true} */
function fakeAsk(reply, { attr = (spec) => attribution(spec.replace(/^ollama:/, '')) } = {}) {
  const calls = [];
  const ask = async (spec, prompt) => {
    calls.push({ spec, prompt });
    const r = reply(spec, prompt, calls.length);
    if (r && r.fail) {
      return { ok: false, raw: '', ms: 5, envelope: null, error: { kind: 'timeout', message: 'x' } };
    }
    return {
      ok: true,
      raw: r,
      ms: 7,
      envelope: { schema_version: 2, raw: r, exitCode: 0, failure: null, attribution: attr(spec), usage: null, cost_estimate: null },
      error: null,
    };
  };
  ask.calls = calls;
  return ask;
}

const bullets = (...items) => items.map((i) => `- ${i}`).join('\n');

/** Plays the human: regex-candidate claims become TP (unless told otherwise); everything else FP. */
function adjudicateAll(report, ctx, { verdictFor = null, uncertainty = 'low' } = {}) {
  const ws = buildWorksheet(report, { blind: false });
  ws.adjudicator = { name: 'test-human', kind: 'human' };
  for (const j of ws.judgments) {
    const cell = ws.cells.find((c) => c.cell_id === j.cell_id);
    const claim = cell.claims.find((c) => c.claim_id === j.claim_id);
    const v = verdictFor ? verdictFor(j, claim, cell) : null;
    if (v) Object.assign(j, v);
    else if (claim.regex_candidates.length) Object.assign(j, { verdict: 'true_positive', matches_defects: claim.regex_candidates, uncertainty });
    else Object.assign(j, { verdict: 'false_positive', uncertainty });
  }
  const f = path.join(ctx.root, `ws-${report.run_id}.json`);
  fs.writeFileSync(f, JSON.stringify(ws), 'utf8');
  const r = applyAdjudication(f, { ...ctx, replace: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r;
}

const quiet = () => {};
async function live(ctx, opts) {
  return runBench({ ...ctx, live: true, maxCalls: 1000, deadlineMinutes: 60, log: quiet, ...opts });
}

// ---------------------------------------------------------------------------
// Plan / live opt-in / budget
// ---------------------------------------------------------------------------

test('without --live the bench plans only: zero calls, nothing written', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1'), mkTask('t2')]);
  const ask = fakeAsk(() => 'x');
  const r = await runBench({ ...sb.ctx, providers: ['ollama:a', 'ollama:b'], tasksFile, ask, log: quiet });
  assert.equal(r.exitCode, 0);
  assert.equal(r.dryRun, true);
  assert.equal(ask.calls.length, 0);
  assert.equal(r.plan.calls.total, 2 * 2 * 3); // default repeats = 3
  assert.equal(fs.existsSync(benchResultsDir(sb.root, sb.env)), false);
});

test('live evaluation requires explicit models, repeats>=3, finite budget and deadline', () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1')]);
  const base = { ...sb.ctx, tasksFile, providers: ['ollama:a'] };
  const errs = (o) => planBench({ ...base, ...o }).errors.join('\n');
  assert.match(errs({ providers: ['ollama'] }), /explicit model/);
  assert.match(errs({ repeats: 2 }), /repeats >= 3/);
  assert.match(errs({ live: true, deadlineMinutes: 5 }), /max-calls/);
  assert.match(errs({ live: true, maxCalls: 10 }), /deadline-minutes/);
  assert.match(errs({ live: true, maxCalls: 2, deadlineMinutes: 5 }), /exceed --max-calls/);
  assert.equal(planBench({ ...base, regression: true }).plan.repeats, 1);
  assert.match(errs({ regression: true, repeats: 3 }), /regression/);
  assert.equal(planBench({ ...base, live: true, maxCalls: 3, deadlineMinutes: 5 }).ok, true);
});

test('live run: calls are only single x task x repeat; panel union reuses the same responses', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1'), mkTask('t2')]);
  const ask = fakeAsk((spec) => (spec === 'ollama:a' ? bullets('alpha is wrong here') : bullets('beta is wrong here')));
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask });
  assert.equal(r.exitCode, 0);
  assert.equal(ask.calls.length, 2 * 2 * 3);
  assert.equal(r.report.budget.calls_made, 12);
  assert.ok(fs.existsSync(r.reportPath));
  assert.ok(r.reportPath.startsWith(benchResultsDir(sb.root, sb.env)));
  const rep = loadReport(r.reportPath, sb.ctx);
  adjudicateAll(rep, sb.ctx);
  const runs = [{ report: rep, adj: new Map(), cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })) }];
  // reload adjudication into the run
  const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
  runs[0].adj = new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j]));
  const cmp = compareArms(runs, { baseline: 'single:ollama:a', arms: ['panel:ollama:a+ollama:b'], split: 'all' });
  const entry = cmp.comparisons[0].results.pessimistic.per_task[0];
  assert.equal(entry.metrics.recall.arm.mean, 1); // union found alpha and beta
  assert.equal(entry.metrics.recall.baseline.mean, 0.5);
  assert.equal(ask.calls.length, 12); // comparing never calls a model
});

test('failed advisor calls are failed cells, never zero-defect reviews; budget abort keeps partial data', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1')]);
  const ask = fakeAsk((spec, p, n) => (n === 1 ? { fail: true } : bullets('alpha and beta both wrong')));
  const r = await live(sb.ctx, { providers: ['ollama:a'], tasksFile, ask });
  const failed = r.report.cells.filter((c) => c.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].candidate, null);
  assert.equal(failed[0].claims.length, 0);

  // deadline: each call advances the injected clock by one minute
  let t = 0;
  const slow = fakeAsk(() => bullets('alpha'));
  const slowAsk = async (...a) => {
    t += 60000;
    return slow(...a);
  };
  const r2 = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask: slowAsk, now: () => t, deadlineMinutes: 2.5 });
  assert.equal(r2.exitCode, 3);
  assert.equal(r2.report.budget.aborted_reason, 'deadline');
  assert.equal(r2.report.budget.calls_made, 3);
  assert.equal(r2.report.cells.length, 3); // partial results persisted, repeat-major so still balanced
  assert.match(r2.report.budget.unit, /advisor-invocations/);
});

test('anchor-review and final synthesis are separate arms and cost extra advisor calls', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1')]);
  const ask = fakeAsk((spec, prompt) => {
    if (/Independent reviewers reported/.test(prompt)) return bullets('alpha verified', 'beta verified');
    if (/Another reviewer already reviewed/.test(prompt)) return bullets('alpha confirmed');
    return bullets('alpha found');
  });
  const r = await live(sb.ctx, {
    providers: ['ollama:a', 'ollama:b'],
    tasksFile,
    ask,
    arms: ['anchor-review', 'final'],
    anchor: 'ollama:a',
    reviewer: 'ollama:c',
    synthesizer: 'ollama:d',
  });
  assert.equal(ask.calls.length, 2 * 3 + 3 + 3);
  const final = r.report.cells.find((c) => c.arm === 'final');
  assert.equal(final.inputs.length, 2);
  assert.ok(final.inputs.every((id) => r.report.cells.some((c) => c.cell_id === id && c.arm === 'single')));
  // reviewer prompt carries the anchor's actual response
  assert.ok(ask.calls.some((c) => c.spec === 'ollama:c' && c.prompt.includes('alpha found')));
});

// ---------------------------------------------------------------------------
// Claims + adjudication
// ---------------------------------------------------------------------------

test('extractClaims splits bullets/numbered/paragraph findings with stable ids and never drops a non-empty answer', () => {
  const list = extractClaims('Defects:\n1. SQL injection in query\n   built by concatenation\n2) Missing auth check\n- Race condition on update\n');
  assert.deepEqual(list.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.match(list[0].text, /concatenation/);
  assert.equal(extractClaims('x').length, 1); // too short to be an item, falls back to whole answer
  assert.equal(extractClaims('').length, 0);
  assert.deepEqual(extractClaims('- same finding text here').map((c) => c.sha256), extractClaims('- same finding text here').map((c) => c.sha256));
});

async function oneRun(sb, replyFn = () => bullets('alpha is wrong', 'unrelated nit about naming')) {
  const tasksFile = writeTasks(sb.root, [mkTask('t1')]);
  const r = await live(sb.ctx, { providers: ['ollama:a'], tasksFile, ask: fakeAsk(replyFn), regression: true });
  return loadReport(r.reportPath, sb.ctx);
}

test('adjudication input is validated against run/task/claim ids, defects and uncertainty', async () => {
  const sb = sandbox();
  const rep = await oneRun(sb);
  const ws = buildWorksheet(rep, { blind: false });
  const good = () => {
    const d = JSON.parse(JSON.stringify(ws));
    d.adjudicator.name = 'h';
    d.judgments[0] = { ...d.judgments[0], verdict: 'true_positive', matches_defects: ['a'], uncertainty: 'low' };
    d.judgments[1] = { ...d.judgments[1], verdict: 'false_positive', uncertainty: 'medium' };
    return d;
  };
  assert.deepEqual(validateAdjudication(rep, good()).errors, []);
  const bad = (mut, re) => {
    const d = good();
    mut(d);
    assert.match(validateAdjudication(rep, d).errors.join('\n'), re);
  };
  bad((d) => (d.run_id = 'other'), /run_id/);
  bad((d) => (d.judgments[0].claim_id = 'c99'), /claim_id c99/);
  bad((d) => (d.judgments[0].cell_id = 'run-x/mabc/t1/r9'), /cell_id/);
  bad((d) => (d.judgments[0].task_id = 'tX'), /task_id/);
  bad((d) => (d.judgments[0].matches_defects = ['nope']), /not seeded/);
  bad((d) => delete d.judgments[0].uncertainty, /uncertainty required/);
  bad((d) => (d.judgments[0].matches_defects = []), /needs matches_defects/);
  bad((d) => (d.judgments[1].matches_defects = ['a']), /cannot map defects/);
  bad((d) => (d.adjudicator = { name: 'gpt', kind: 'model' }), /must be 'human'/);
  bad((d) => (d.judgments[0].claim_sha256 = 'deadbeef0000'), /claim_sha256/);
  bad((d) => (d.judgments[0].extra = 1), /unknown field/);
  bad((d) => d.judgments.push({ ...d.judgments[0] }), /duplicate judgment/);
});

test('unjudged claims are skipped (partial adjudication) and a differing re-judgment needs --replace', async () => {
  const sb = sandbox();
  const rep = await oneRun(sb);
  const ws = buildWorksheet(rep, { blind: false });
  ws.adjudicator.name = 'h';
  ws.judgments[0] = { ...ws.judgments[0], verdict: 'true_positive', matches_defects: ['a'], uncertainty: 'low' };
  const f = path.join(sb.root, 'a.json');
  fs.writeFileSync(f, JSON.stringify(ws));
  const r = applyAdjudication(f, sb.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.skipped_unjudged, 1);
  ws.judgments[0] = { ...ws.judgments[0], verdict: 'false_positive', matches_defects: [], uncertainty: 'low' };
  fs.writeFileSync(f, JSON.stringify(ws));
  assert.equal(applyAdjudication(f, sb.ctx).ok, false);
  assert.equal(applyAdjudication(f, { ...sb.ctx, replace: true }).ok, true);
});

test('blind worksheet hides provider and arm', async () => {
  const sb = sandbox();
  const rep = await oneRun(sb);
  const blind = JSON.stringify(buildWorksheet(rep));
  assert.ok(!blind.includes('ollama:a'));
  assert.ok(!/"arm"/.test(blind));
});

test('regex candidates never assert truth: an adjudicated false positive is not a detection; uncertainty bounds the metrics', async () => {
  const sb = sandbox();
  const rep = await oneRun(sb, () => bullets('alpha is mentioned only to say it is fine', 'beta really is broken here'));
  const cell = { ...rep.cells[0], run_id: rep.run_id };
  assert.deepEqual(cell.candidate.hits.sort(), ['a', 'b']); // regex mentions both
  const task = { defects: ['a', 'b'].map((id) => ({ id })) };
  const adj = new Map([
    [`${cell.cell_id}|c1`, { verdict: 'false_positive', matches_defects: [], uncertainty: 'low' }],
    [`${cell.cell_id}|c2`, { verdict: 'true_positive', matches_defects: ['b'], unseeded_real: false, uncertainty: 'high' }],
  ]);
  const pess = unitMetrics(task, [cell], adj, 'pessimistic');
  const opt = unitMetrics(task, [cell], adj, 'optimistic');
  assert.equal(pess.recall, 0); // uncertain TP detects nothing; FP never detects
  assert.equal(opt.recall, 0.5);
  assert.equal(pess.precision, 0);
  assert.equal(opt.precision, 0.5);
  assert.equal(opt.fp, 1);
  assert.equal(opt.tp, 1);
  assert.equal(unitMetrics(task, [cell], new Map(), 'pessimistic'), null); // unadjudicated => no metric
  assert.equal(unitMetrics(task, [cell], new Map(), 'candidate').recall, 1);
});

// ---------------------------------------------------------------------------
// Compare: pairing, exclusions, variance, held-out discipline
// ---------------------------------------------------------------------------

async function twoProviderRuns(sb, { taskCount = 6, failB = null, reply } = {}) {
  const tasks = Array.from({ length: taskCount }, (_, i) => mkTask(`t${i + 1}`));
  const tasksFile = writeTasks(sb.root, tasks, { split: 'heldout', provenance: { kind: 'synthetic', note: 'test fixture' } });
  const counters = {};
  const ask = fakeAsk((spec, prompt) => {
    const task = tasks.find((t) => prompt.includes(`function ${t.id}()`)).id;
    const k = `${spec}|${task}`;
    counters[k] = (counters[k] || 0) + 1;
    if (failB && spec === 'ollama:b' && task === failB.task && counters[k] === failB.repeat) return { fail: true };
    if (reply) return reply(spec, task, counters[k]);
    if (spec === 'ollama:a') {
      // A varies: misses beta on t2 repeat 1
      if (task === 't2' && counters[k] === 1) return bullets('alpha is a problem here');
      return bullets('alpha is a problem here', 'beta is a problem too');
    }
    return bullets('alpha is a problem here', 'a made up unrelated claim');
  });
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask });
  const rep = loadReport(r.reportPath, sb.ctx);
  adjudicateAll(rep, sb.ctx);
  const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
  const runs = [
    {
      report: rep,
      cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })),
      adj: new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j])),
    },
  ];
  return { runs, rep, ask };
}

test('compare: per-task paired repeats, failed cells excluded pairwise, variance retained (not newest-only)', async () => {
  const sb = sandbox();
  const { runs } = await twoProviderRuns(sb, { failB: { task: 't1', repeat: 2 } });
  const c = compareArms(runs, { baseline: 'single:ollama:b', arms: ['single:ollama:a'], split: 'heldout' });
  const res = c.comparisons[0].results.pessimistic;
  const t1 = res.excluded_tasks.find((e) => e.task_id === 't1');
  assert.match(t1.reason, /insufficient valid repeats \(2 < 3\)/);
  assert.equal(t1.baseline.failed_cells, 1);
  const t2 = res.per_task.find((p) => p.task_id === 't2');
  assert.equal(t2.valid_repeats, 3);
  assert.deepEqual(t2.metrics.recall.arm.values, [0.5, 1, 1]); // every repeat kept, in order
  assert.ok(t2.metrics.recall.arm.sd > 0);
  assert.equal(t2.metrics.recall.baseline.mean, 0.5);
  // 5 comparable tasks remain: A (recall ~1) beats B (0.5) under both bounds
  assert.equal(res.summary.recall.n_tasks, 5);
  assert.match(c.comparisons[0].verdict, /BETTER/);
  assert.equal(c.evaluation_grade, true);
});

test('compare refuses a verdict when too few tasks are comparable', async () => {
  const sb = sandbox();
  const { runs } = await twoProviderRuns(sb, { taskCount: 3 });
  const c = compareArms(runs, { baseline: 'single:ollama:b', arms: ['single:ollama:a'], split: 'heldout' });
  assert.match(c.comparisons[0].verdict, /INCONCLUSIVE/);
});

test('one-run regression data is labelled regression, never evaluation grade', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1'), mkTask('t2'), mkTask('t3'), mkTask('t4'), mkTask('t5')]);
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, regression: true, ask: fakeAsk(() => bullets('alpha is bad here')) });
  const rep = loadReport(r.reportPath, sb.ctx);
  adjudicateAll(rep, sb.ctx);
  const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
  const runs = [{ report: rep, cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })), adj: new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j])) }];
  const c = compareArms(runs, { baseline: 'single:ollama:a', arms: ['single:ollama:b'], split: 'dev' });
  assert.equal(c.evaluation_grade, false);
  assert.match(c.comparisons[0].verdict, /REGRESSION CHECK/);
});

test('uncertain adjudications that flip the sign yield a scenario-dependent verdict, not a winner', async () => {
  const sb = sandbox();
  const { runs } = await twoProviderRuns(sb);
  // Make every judgment on provider A high-uncertainty: pessimistic A detects nothing, optimistic A detects all.
  for (const run of runs) {
    const aCells = new Set(run.cells.filter((x) => x.spec === 'ollama:a').map((x) => x.cell_id));
    for (const [k, j] of run.adj) if (aCells.has(k.split('|')[0])) run.adj.set(k, { ...j, uncertainty: 'high' });
  }
  const c = compareArms(runs, { baseline: 'single:ollama:b', arms: ['single:ollama:a'], split: 'heldout' });
  assert.match(c.comparisons[0].verdict, /SCENARIO-DEPENDENT/);
});

test('strongest-single is chosen on non-held-out tasks only, never on the evaluation split', async () => {
  const sb = sandbox();
  const dev = ['d1', 'd2'].map((id) => mkTask(id, { split: 'dev' }));
  const held = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => mkTask(id, { split: 'heldout', provenance: { kind: 'synthetic', note: 'fixture' } }));
  const tasksFile = writeTasks(sb.root, [...dev, ...held]);
  const ask = fakeAsk((spec, prompt) => {
    const isDev = /function d\d\(\)/.test(prompt);
    // A is great on dev, poor on heldout; B is the reverse.
    const strong = (spec === 'ollama:a') === isDev;
    return strong ? bullets('alpha is bad', 'beta is bad too') : bullets('alpha is bad');
  });
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask });
  const rep = loadReport(r.reportPath, sb.ctx);
  adjudicateAll(rep, sb.ctx);
  const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
  const runs = [{ report: rep, cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })), adj: new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j])) }];
  const sel = selectStrongestSingle(runs, { evalSplit: 'heldout' });
  assert.equal(sel.spec, 'ollama:a'); // best on dev even though B is better on the held-out tasks
  assert.deepEqual(sel.selection_tasks.sort(), ['d1', 'd2']);
  const c = compareArms(runs, { baseline: 'strongest-single', arms: ['single:ollama:b'], split: 'heldout' });
  assert.equal(c.baseline.resolved.spec, 'ollama:a');
  assert.ok(c.comparisons[0].results.pessimistic.summary.recall.mean_diff > 0); // B beats the dev-chosen strongest on held-out
  // with nothing outside the evaluation split, selection must be explicit
  const onlyHeld = runs.map((run) => ({ ...run, report: { ...run.report, design: { ...run.report.design, tasks: run.report.design.tasks.filter((t) => t.split === 'heldout') } } }));
  assert.throws(() => selectStrongestSingle(onlyHeld, { evalSplit: 'heldout' }), /non-heldout tasks/);
  assert.equal(selectStrongestSingle(onlyHeld, { evalSplit: 'heldout', explicit: 'ollama:b' }).spec, 'ollama:b');
});

test('local-panel only accepts members whose attribution verified local; unknown location does not qualify', async () => {
  const sb = sandbox();
  const { runs } = await twoProviderRuns(sb);
  const c = compareArms(runs, { baseline: 'single:ollama:a', arms: ['local-panel'], split: 'heldout' });
  assert.deepEqual(c.comparisons[0].members, ['ollama:a', 'ollama:b']);
  assert.equal(c.comparisons[0].local_verified, true);
  const unknown = runs.map((run) => ({ ...run, cells: run.cells.map((x) => (x.spec === 'ollama:b' ? { ...x, attribution: { ...x.attribution, execution_location: 'unknown' } } : x)) }));
  assert.throws(() => compareArms(unknown, { baseline: 'single:ollama:a', arms: ['local-panel'], split: 'heldout' }), /local-panel needs/);
});

test('final synthesis is scored separately and reports true defects lost relative to the union of its inputs', async () => {
  const sb = sandbox();
  const tasks = Array.from({ length: 5 }, (_, i) => mkTask(`t${i + 1}`));
  const tasksFile = writeTasks(sb.root, tasks, { split: 'heldout', provenance: { kind: 'synthetic', note: 'fixture' } });
  const ask = fakeAsk((spec, prompt) => {
    if (/Independent reviewers reported/.test(prompt)) return bullets('alpha is bad'); // synthesis drops beta
    return spec === 'ollama:a' ? bullets('alpha is bad') : bullets('beta is bad');
  });
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask, arms: ['final'], synthesizer: 'ollama:s' });
  const rep = loadReport(r.reportPath, sb.ctx);
  adjudicateAll(rep, sb.ctx);
  const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
  const runs = [{ report: rep, cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })), adj: new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j])) }];
  const c = compareArms(runs, { baseline: 'panel:ollama:a+ollama:b', arms: ['final'], split: 'heldout' });
  const fa = c.comparisons[0].final_adoption.pessimistic;
  assert.equal(fa.units, 15);
  assert.equal(fa.mean_union_recall_defects, 2);
  assert.equal(fa.mean_final_recall_defects, 1);
  assert.equal(fa.units_losing_true_defects, 15);
  assert.ok(c.comparisons[0].results.pessimistic.summary.recall.mean_diff < 0); // final recall below the union baseline
});

test('difficulty filter keeps only tasks hard for EVERY model; missing data disqualifies', () => {
  assert.equal(qualifies({ a: 0.5, b: 0.7 }, 0.7), true);
  assert.equal(qualifies({ a: 0.5, b: 0.9 }, 0.7), false);
  assert.equal(qualifies({ a: 0.5, b: null }, 0.7), false);
  assert.equal(qualifies({}, 0.7), false);
});

test('compare --difficulty-threshold restricts evaluation to hard tasks and flags same-data selection', async () => {
  const sb = sandbox();
  const { runs } = await twoProviderRuns(sb, {
    reply: (spec, task) => (task === 't1' ? bullets('alpha is bad', 'beta is bad') : bullets('alpha is bad')),
  });
  const c = compareArms(runs, { baseline: 'single:ollama:a', arms: ['single:ollama:b'], split: 'heldout', difficultyThreshold: 0.5 });
  assert.ok(!c.tasks_evaluated.includes('t1')); // both models solved t1 fully
  assert.equal(c.tasks_evaluated.length, 5);
  assert.equal(c.difficulty.filter_and_evaluation_same_data, true);
  assert.match(c.difficulty.caveat, /selection-biased/);
});

test('bootstrap CI is deterministic for a seed and brackets the mean', () => {
  const d = [0.5, 0.25, 0.5, 0.75, 0.5];
  const a = bootstrapMeanCI(d, { seed: 7 });
  assert.deepEqual(a, bootstrapMeanCI(d, { seed: 7 }));
  assert.ok(a.lo <= 0.5 && a.hi >= 0.5);
  assert.equal(bootstrapMeanCI([], {}), null);
});

// ---------------------------------------------------------------------------
// Routing evidence read path
// ---------------------------------------------------------------------------

test('readBenchEvidence returns only adjudicated single cells with a resolved evidence key', async () => {
  const sb = sandbox();
  const tasksFile = writeTasks(sb.root, [mkTask('t1')]);
  const ask = fakeAsk(() => bullets('alpha is bad'), {
    attr: (spec) => (spec === 'ollama:a' ? attribution('a-model') : attribution('b-model', { identity_status: 'unresolved' })),
  });
  const r = await live(sb.ctx, { providers: ['ollama:a', 'ollama:b'], tasksFile, ask });
  assert.deepEqual(readBenchEvidence(sb.root, sb.env), []); // nothing adjudicated yet: regex hits are not evidence
  adjudicateAll(loadReport(r.reportPath, sb.ctx), sb.ctx);
  const ev = readBenchEvidence(sb.root, sb.env);
  assert.ok(ev.length > 0);
  assert.ok(ev.every((e) => e.spec === 'ollama:a' && e.evidence_key && e.runs_n === 3));
  const a = ev.find((e) => e.defect_id === 'a');
  const b = ev.find((e) => e.defect_id === 'b');
  assert.equal(a.hits_n, 3);
  assert.equal(b.hits_n, 0);
});

// ---------------------------------------------------------------------------
// Native baselines + retrospective cases
// ---------------------------------------------------------------------------

function nativeDoc(spec, tasks, over = {}, respOver = {}) {
  return {
    schema: 'xllm-native-baseline/1',
    label: 'claude-code-native',
    host: { name: 'claude-code', version: '9.9.9' },
    captured_by: 'tester',
    responses: tasks.flatMap((t) =>
      [1, 2, 3].map((repeat) => {
        const response = bullets('alpha is bad here');
        return {
          task_id: t.id,
          repeat,
          prompt_sha256: sha(buildBenchPrompt(spec, t)),
          response,
          response_sha256: sha(response),
          captured_at: '2026-01-01T00:00:00Z',
          model_reported: 'whatever the host claims',
          ...respOver,
        };
      })
    ),
    ...over,
  };
}

test('native import verifies prompt and response hashes and never fabricates resolved identity', () => {
  const sb = sandbox();
  const tasks = [mkTask('t1'), mkTask('t2')];
  const tasksFile = writeTasks(sb.root, tasks);
  const spec = loadTasks(tasksFile);
  const write = (doc) => {
    const f = path.join(sb.root, 'native.json');
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  const bad1 = importNative(write(nativeDoc(spec, tasks, {}, { prompt_sha256: 'abc' })), { ...sb.ctx, tasksFile });
  assert.equal(bad1.ok, false);
  assert.match(bad1.errors.join('\n'), /prompt_sha256 does not match/);
  const bad2 = importNative(write(nativeDoc(spec, tasks, {}, { response_sha256: 'abc' })), { ...sb.ctx, tasksFile });
  assert.match(bad2.errors.join('\n'), /response_sha256 does not match/);
  const bad3 = importNative(write(nativeDoc(spec, tasks, { host: { name: 'x' } })), { ...sb.ctx, tasksFile });
  assert.match(bad3.errors.join('\n'), /host\.version/);

  const ok = importNative(write(nativeDoc(spec, tasks)), { ...sb.ctx, tasksFile });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const rep = loadReport(ok.reportPath, sb.ctx);
  assert.equal(rep.source, 'native-import');
  assert.ok(rep.provenance.verified.includes('prompt_sha256'));
  assert.ok(rep.provenance.self_reported_unverified.includes('model_reported'));
  assert.ok(rep.cells.every((c) => c.arm === 'native' && c.evidence_key === null && c.attribution.identity_status === 'unresolved'));
  assert.equal(rep.cells.length, 6);
});

test('native baseline compares against advisor singles across runs (unmatched repeats, per-task means)', async () => {
  const sb = sandbox();
  const tasks = Array.from({ length: 5 }, (_, i) => mkTask(`t${i + 1}`));
  const tasksFile = writeTasks(sb.root, tasks, { split: 'heldout', provenance: { kind: 'synthetic', note: 'fixture' } });
  const spec = loadTasks(tasksFile);
  const nf = path.join(sb.root, 'native.json');
  fs.writeFileSync(nf, JSON.stringify(nativeDoc(spec, tasks)));
  const imp = importNative(nf, { ...sb.ctx, tasksFile });
  assert.equal(imp.ok, true, JSON.stringify(imp.errors));
  const r = await live(sb.ctx, { providers: ['ollama:a'], tasksFile, ask: fakeAsk(() => bullets('alpha is bad here', 'beta is bad here')) });
  const load = (rep) => {
    adjudicateAll(rep, sb.ctx);
    const adjDoc = loadAdjudication(rep.run_id, sb.ctx);
    return { report: rep, cells: rep.cells.map((c) => ({ ...c, run_id: rep.run_id })), adj: new Map(adjDoc.judgments.map((j) => [`${j.cell_id}|${j.claim_id}`, j])) };
  };
  const runs = [load(loadReport(imp.reportPath, sb.ctx)), load(loadReport(r.reportPath, sb.ctx))];
  const c = compareArms(runs, { baseline: 'native:claude-code-native', arms: ['single:ollama:a'], split: 'heldout' });
  const pt = c.comparisons[0].results.pessimistic.per_task[0];
  assert.equal(pt.repeat_matched, false);
  assert.equal(pt.metrics.recall.baseline.mean, 0.5);
  assert.equal(pt.metrics.recall.arm.mean, 1);
});

test('imported retrospective cases must be attested real provenance and become a named held-out task set', () => {
  const sb = sandbox();
  const doc = (prov) => ({
    schema: 'xllm-bench-cases/1',
    name: 'my-retro',
    attested_by: 'me',
    tasks: [
      {
        id: 'r1',
        diff: '--- a/x\n+++ b/x\n@@\n-old\n+new\n',
        defects: [{ id: 'd', pattern: 'null deref', description: 'fixed later' }],
        provenance: prov,
      },
    ],
  });
  const write = (d) => {
    const f = path.join(sb.root, 'cases.json');
    fs.writeFileSync(f, JSON.stringify(d));
    return f;
  };
  const real = { kind: 'real-retrospective', repo: 'github.com/me/app', fix_ref: 'abc1234', summary: 'NPE on empty cart', user_attested: true };
  assert.equal(importCases(write(doc({ ...real, user_attested: false })), sb.ctx).ok, false);
  assert.match(importCases(write(doc({ kind: 'synthetic', note: 'n' })), sb.ctx).errors.join('\n'), /real-retrospective/);
  assert.equal(importCases(write(doc({ ...real, fix_ref: '' })), sb.ctx).ok, false);
  const ok = importCases(write(doc(real)), sb.ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.split, 'heldout');
  const spec = loadTasks(resolveTasksFile('my-retro', sb.ctx));
  assert.equal(spec.tasks[0].provenance.kind, 'real-retrospective');
  assert.match(spec.note, /NOT verified/);
  assert.equal(importCases(write(doc(real)), sb.ctx).ok, false); // no silent overwrite
});

// ---------------------------------------------------------------------------
// Fixtures + envelope parsing + CLI
// ---------------------------------------------------------------------------

test('held-out fixtures are multi-file, labelled synthetic (no invented provenance) and carry compiling candidate patterns', () => {
  const spec = loadTasks(resolveTasksFile('heldout-tasks'));
  assert.equal(spec.split, 'heldout');
  assert.ok(spec.tasks.length >= 5);
  for (const t of spec.tasks) {
    assert.equal(t.provenance.kind, 'synthetic', t.id);
    assert.ok(t.files.length >= 3 && t.diff.includes('@@'), t.id);
    assert.ok(t.defects.length >= 4, t.id);
    // candidate patterns should mention-match their own description, otherwise the fixture cannot ever produce a candidate
    for (const d of t.defects) assert.ok(gradeAnswer({ defects: [d] }, d.description).hits.includes(d.id), `${t.id}:${d.id}`);
    const prompt = buildBenchPrompt(spec, t);
    assert.ok(prompt.includes('### File: ') && prompt.includes('```diff'));
  }
  assert.ok(Math.max(...spec.tasks.map((t) => t.diff.split('\n').length)) > 200); // a genuinely long diff
});

test('interpretEnvelope treats malformed or failed advisor output as a failed call', () => {
  assert.equal(interpretEnvelope('not json').ok, false);
  assert.equal(interpretEnvelope(JSON.stringify({ schema_version: 1, raw: 'x', exitCode: 0 })).ok, false);
  const fail = interpretEnvelope(JSON.stringify({ schema_version: 2, raw: 'x', exitCode: 1, failure: { kind: 'auth', retryable: false } }));
  assert.equal(fail.ok, false);
  assert.equal(fail.raw, '');
  assert.equal(fail.error.kind, 'auth');
  assert.equal(interpretEnvelope(JSON.stringify({ schema_version: 2, raw: '  ', exitCode: 0, failure: null })).ok, false);
  const ok = interpretEnvelope('progress noise\n' + JSON.stringify({ schema_version: 2, raw: 'review', exitCode: 0, failure: null, durationMs: 12 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.ms, 12);
});

test('reportRun keeps per-repeat variance per arm and task', async () => {
  const sb = sandbox();
  const { rep } = await twoProviderRuns(sb, { taskCount: 3 });
  const r = reportRun(rep, new Map());
  const t2 = r.arms['single:ollama:a'].tasks.t2;
  assert.equal(t2.candidate_recall.n, 3);
  assert.deepEqual(t2.candidate_recall.values, [0.5, 1, 1]);
});

test('CLI: run without --live is a dry plan; --live without budget fails; no state written', () => {
  const sb = sandbox();
  const bench = path.join(HERE, 'xllm-bench.js');
  const run = (...args) => spawnSync(process.execPath, [bench, ...args], { cwd: sb.root, env: sb.env, encoding: 'utf8' });
  const plan = run('run', '--providers', 'ollama:a,ollama:b', '--tasks-file', 'heldout-tasks');
  assert.equal(plan.status, 0, plan.stderr);
  const out = JSON.parse(plan.stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.plan.repeats, 3);
  assert.equal(out.plan.calls.total, 2 * 6 * 3);
  const noBudget = run('run', '--providers', 'ollama:a', '--tasks-file', 'heldout-tasks', '--live');
  assert.equal(noBudget.status, 1);
  assert.match(noBudget.stderr, /max-calls/);
  const noModel = run('run', '--providers', 'ollama', '--tasks-file', 'heldout-tasks');
  assert.equal(noModel.status, 1);
  assert.equal(fs.existsSync(path.join(sb.root, '.state')), false);
  assert.equal(run('list').status, 0);
});

test('askAdvisorJson spawns the advisor as `SPEC --json --prompt-file`, parses its envelope and kills a hung call', async () => {
  const sb = sandbox();
  const fake = path.join(sb.root, 'fake-advisor.js');
  fs.writeFileSync(
    fake,
    `const fs = require('fs');
const a = process.argv.slice(2);
if (process.env.HANG) setTimeout(() => {}, 60000);
else {
  const prompt = fs.readFileSync(a[a.indexOf('--prompt-file') + 1], 'utf8');
  process.stderr.write('progress noise\\n');
  console.log(JSON.stringify({ schema_version: 2, raw: '- echo ' + prompt.length + ' ' + a[0] + ' ' + a.includes('--json') + ' self=' + process.env.XLLM_ALLOW_SELF, exitCode: 0, failure: null, durationMs: 3, attribution: null }));
}`,
    'utf8'
  );
  const { askAdvisorJson } = await import('./xllm-bench.js');
  const long = 'x'.repeat(50000); // far beyond a Windows argv limit: must travel via the prompt file
  const ok = await askAdvisorJson('ollama:a', long, { advisor: fake, timeoutMs: 20000 });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.raw, '- echo 50000 ollama:a true self=1');
  const hung = await askAdvisorJson('ollama:a', 'hi', { advisor: fake, timeoutMs: 300, env: { ...process.env, HANG: '1' } });
  assert.equal(hung.ok, false);
  assert.equal(hung.error.kind, 'bench-timeout');
});
