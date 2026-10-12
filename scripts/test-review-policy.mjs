#!/usr/bin/env node
/**
 * Behavioral regressions for the review family (structured / panel / debate /
 * council / diff): provider failure is never evidence, the advisor --json
 * envelope is the only child protocol, diff budgeting never hides a hunk
 * silently. No live LLM calls: advisors are scripted fakes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-review-policy-'));
const suiteProfile = path.join(suiteHome, 'providers.toml');
fs.writeFileSync(suiteProfile, '[defaults]\nexecution_policy = "any"\n');
process.env.XLLM_HOME = suiteHome;
process.env.XLLM_PROVIDERS_PATH = suiteProfile;
delete process.env.XLLM_NO_ARTIFACTS;
delete process.env.XLLM_STATE_DIR;
process.on('exit', () => fs.rmSync(suiteHome, { recursive: true, force: true }));

const { makeResult, evidenceKey } = await import('./xllm-evidence.js');
const diff = await import('./xllm-diff.js');
const structured = await import('./xllm-structured.js');
const panel = await import('./xllm-panel.js');
const debate = await import('./xllm-debate.js');
const council = await import('./xllm-council.js');
const { resolveStateDir, parseProviderSpec } = await import('./xllm-advisor.js');

const enc = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-review-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function quiet(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

const attr = (provider, model, extra = {}) => ({
  requested_provider: provider,
  requested_model: model,
  executed_provider: provider,
  transmitted_model: model,
  substituted_from: null,
  model_correction_source: null,
  reported_model: model,
  identity_status: 'resolved',
  model_revision: `${model}-rev`,
  requested_effort: null,
  effective_effort: 'high',
  cli_version: '1.0.0',
  surface: 'cli-agentic',
  execution_location: 'remote',
  ...extra,
});

/** A successful advisor envelope. `structured` = native schema payload (adapter honored the schema). */
const okEnv = (provider, model, { raw, structured: s = null, usage, cost } = {}) =>
  makeResult({
    exitCode: 0,
    raw: raw ?? (s ? JSON.stringify(s) : ''),
    structured: s,
    attribution: attr(provider, model),
    usage: usage === undefined ? { input_tokens: 10, output_tokens: 5 } : usage,
    cost_estimate: cost === undefined ? 0.01 : cost,
    durationMs: 5,
  });

const failEnv = (provider, model, kind = 'timeout') =>
  makeResult({
    exitCode: 1,
    raw: '',
    failure: { kind, retryable: false, hint: 'scripted failure' },
    attribution: attr(provider, model, { identity_status: 'unresolved', reported_model: null, model_revision: null }),
  });

const phaseOf = (prompt) =>
  prompt.includes('PANEL PROTOCOL')
    ? 'panel'
    : prompt.includes('DEBATE R0')
      ? 'R0'
      : prompt.includes('HOSTILE reviewer')
        ? 'R1'
        : prompt.includes('You authored this claim')
          ? 'R2'
          : '?';

/** claim ids listed in an R1 prompt ("- C1-1: text"). */
const claimIdsIn = (prompt) => [...prompt.matchAll(/^- (C\d+-\d+):/gm)].map((m) => m[1]);

/** Scripted `ask`: handlers keyed by provider → (phase, prompt, callNumber, opts) → envelope. */
function scripted(handlers) {
  const log = [];
  const ask = async (spec, prompt, opts) => {
    const provider = spec.split(/[:@]/)[0];
    const phase = phaseOf(prompt);
    const n = log.filter((l) => l.provider === provider && l.phase === phase).length + 1;
    log.push({ spec, provider, phase, prompt, opts, n });
    return handlers[provider](phase, prompt, n, opts);
  };
  return { ask, log };
}

const verdictEnv = (provider, model, verdict, claims) =>
  okEnv(provider, model, { structured: { verdict, confidence: 0.8, key_claims: claims } });

const claimsEnv = (provider, model, text) => okEnv(provider, model, { structured: { claims: [{ text, evidence: 'e' }] } });

const attackEnv = (provider, model, prompt, { tier = 'decisive' } = {}) =>
  okEnv(provider, model, {
    structured: {
      attacks: claimIdsIn(prompt).map((id) => ({ claim_id: id, stance: 'refute', mechanism: 'm', falsifier: 'f', tier })),
    },
  });

const noObjectionEnv = (provider, model) => okEnv(provider, model, { structured: { attacks: [] } });

const holdsEnv = (provider, model) =>
  okEnv(provider, model, { structured: { response: 'holds', amended_claim: null, rebuttals: [] } });

const ledgerOf = (root, type) => panel.readLedger(root).filter((r) => r.type === type);

// ---------------------------------------------------------------------------
// diff budgeting
// ---------------------------------------------------------------------------

/** One hunk with consistent counts; ONLY its second line (the first added line) carries `marker`. */
function makeHunk(marker, start, lines = 24) {
  const body = [];
  let o = 0;
  let n = 0;
  for (let i = 0; i < lines; i++) {
    if (i === 1) {
      body.push(`+${marker} added é漢😀`);
      n++;
    } else if (i % 3 === 0) {
      body.push(`-removed line ${i} é漢`);
      o++;
    } else if (i % 3 === 1) {
      body.push(`+added line ${i} 😀`);
      n++;
    } else {
      body.push(` context ${i}`);
      o++;
      n++;
    }
  }
  return `@@ -${start},${o} +${start},${n} @@ fn\n${body.join('\n')}\n`;
}

function makeFile(file, hunks) {
  return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n${hunks.join('')}`;
}

const hunkShown = (cov, file, idx) => {
  const f = cov.covered.find((c) => c.path === file);
  return !!f && f.hunks.includes(idx);
};
const hunkListedOmitted = (cov, file, idx) =>
  cov.omitted.some((o) => o.path === file && (o.scope === 'file' || (o.scope === 'hunk' && o.hunk === idx)));

test('a diff that fits is returned verbatim with complete coverage', () => {
  const text = makeFile('a.js', [makeHunk('M1', 1), makeHunk('M2', 100)]);
  const { body, coverage } = diff.budgetDiff(text);
  assert.equal(body, text.replace(/\n$/, ''));
  assert.equal(coverage.complete, true);
  assert.equal(coverage.hunks_total, 2);
  assert.deepEqual(coverage.omitted, []);
});

test('>40KB diff: every hunk is either shown or enumerated as omitted (central hunk cannot vanish silently)', () => {
  const files = [];
  for (let f = 0; f < 20; f++) {
    files.push(makeFile(`src/mod${String(f).padStart(2, '0')}.js`, [1, 2, 3].map((h) => makeHunk(`HUNK-${f}-${h}`, h * 100, 40))));
  }
  const text = files.join('');
  assert.ok(enc(text) > 40 * 1024, `fixture must exceed 40KB (got ${enc(text)})`);
  const { body, coverage } = diff.budgetDiff(text, diff.DIFF_MAX_BYTES);
  assert.ok(enc(body) <= diff.DIFF_MAX_BYTES);
  assert.equal(coverage.complete, false);
  assert.ok(!/TRUNCATED/.test(body), 'no silent head+tail truncation marker');
  let shown = 0;
  let omitted = 0;
  for (let f = 0; f < 20; f++) {
    const file = `src/mod${String(f).padStart(2, '0')}.js`;
    for (const h of [1, 2, 3]) {
      const inBody = body.includes(`HUNK-${f}-${h}`);
      const listed = hunkListedOmitted(coverage, file, h);
      assert.notEqual(inBody, listed, `${file} hunk ${h}: must be exactly one of shown / enumerated-omitted`);
      assert.equal(hunkShown(coverage, file, h), inBody, `${file} hunk ${h}: covered manifest agrees with body`);
      inBody ? shown++ : omitted++;
    }
  }
  assert.equal(coverage.hunks_shown, shown);
  assert.equal(coverage.hunks_omitted, omitted);
  assert.equal(shown + omitted, coverage.hunks_total);
  // the central file (index 10) is explicitly accounted for
  assert.ok(body.includes('HUNK-10-2') || hunkListedOmitted(coverage, 'src/mod10.js', 2));
});

test('budget is spread across files, not exhausted by the first ones', () => {
  const text = Array.from({ length: 30 }, (_, f) =>
    makeFile(`pkg/f${String(f).padStart(2, '0')}.js`, [1, 2, 3, 4].map((h) => makeHunk(`HUNK-${f}-${h}`, h * 50, 30)))
  ).join('');
  const { coverage } = diff.budgetDiff(text, 12 * 1024);
  const filesWithAnyShown = coverage.covered.filter((c) => c.hunks.length || c.partial.length).length;
  assert.ok(filesWithAnyShown >= 8, `expected broad file coverage, got ${filesWithAnyShown}`);
  assert.ok(coverage.files_omitted > 0, 'the rest is enumerated, not silently dropped');
});

test('a single huge hunk is split on line boundaries; shown parts are exact, omitted parts enumerated', () => {
  const rows = 4000;
  let text = 'diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n';
  text += `@@ -0,0 +1,${rows} @@\n`;
  for (let i = 1; i <= rows; i++) text += `+row ${i} lorem ipsum dolor sit amet\n`;
  const { body, coverage } = diff.budgetDiff(text, diff.DIFF_MAX_BYTES);
  assert.ok(enc(body) <= diff.DIFF_MAX_BYTES);
  assert.equal(coverage.hunks_partial, 1);
  const parts = coverage.omitted.filter((o) => o.scope === 'part');
  assert.ok(parts.length > 0 && parts.every((o) => o.new_lines && o.bytes > 0));
  // every shown part's rewritten header matches its own body and original line numbering
  const lines = body.split('\n');
  let shownRows = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -0,0 \+(\d+),(\d+) @@ \[part (\d+)\/(\d+) of hunk 1\]$/.exec(lines[i]);
    if (!m) continue;
    const [start, count] = [Number(m[1]), Number(m[2])];
    assert.equal(lines[i + 1], `+row ${start} lorem ipsum dolor sit amet`);
    for (let k = 0; k < count; k++) assert.equal(lines[i + 1 + k], `+row ${start + k} lorem ipsum dolor sit amet`);
    shownRows += count;
  }
  const omittedRows = parts.reduce((a, o) => {
    const [x, y] = o.new_lines.split('-').map(Number);
    return a + (y - x + 1);
  }, 0);
  assert.equal(shownRows + omittedRows, rows, 'shown + enumerated rows account for the whole hunk');
});

test('lockfiles are deprioritized so source hunks are shown first', () => {
  const lock = makeFile('package-lock.json', [makeHunk('LOCK', 1, 700)]);
  const src = makeFile('src/app.js', [makeHunk('SRC-HUNK', 10, 30)]);
  const { body, coverage } = diff.budgetDiff(lock + src, 10 * 1024);
  assert.ok(body.includes('SRC-HUNK'));
  assert.ok(coverage.omitted.some((o) => o.path === 'package-lock.json'));
  assert.ok(enc(body) <= 10 * 1024);
});

test('removed lines that look like file markers do not split a counted hunk; binary files are opaque', () => {
  const text = [
    'diff --git a/img.png b/img.png',
    'index 1111111..2222222 100644',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '--- a/not-a-file',
    '+++ b/also-not',
    ' tail',
    '',
  ].join('\n');
  const { coverage } = diff.budgetDiff(text);
  assert.equal(coverage.files_total, 2);
  assert.equal(coverage.hunks_total, 1);
  assert.deepEqual(coverage.opaque.map((o) => o.path), ['img.png']);
});

test('strict byte bound and codepoint-correct cuts (multibyte, surrogate pairs, very long line)', () => {
  const long = `+${'😀'.repeat(3000)}`; // 12KB single line
  const text = `diff --git a/u.txt b/u.txt\n--- a/u.txt\n+++ b/u.txt\n@@ -1,1 +1,2 @@\n ctx 日本語\n${long}\n`;
  const { body, coverage } = diff.budgetDiff(text, 2000);
  assert.ok(enc(body) <= 2000);
  assert.ok(!body.includes('\uFFFD'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), 'no lone surrogate');
  assert.equal(coverage.complete, false);
  assert.equal(coverage.truncated_lines.length, 1);
  assert.ok(coverage.truncated_lines[0].bytes_not_shown > 10000);
  assert.ok(body.includes('LINE CUT'));
});

test('byte bound and shown/omitted partition hold across budgets and shapes', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 25; round++) {
    const nFiles = 1 + rnd(14);
    const hunkOf = [];
    let text = '';
    for (let f = 0; f < nFiles; f++) {
      const nh = 1 + rnd(5);
      const hs = [];
      for (let h = 1; h <= nh; h++) hs.push(makeHunk(`M${f}x${h}`, h * 40, 3 + rnd(80)));
      hunkOf.push(nh);
      text += makeFile(`d${f}/file${f}.js`, hs);
    }
    for (const budget of [200, 1000, 5000, diff.DIFF_MAX_BYTES]) {
      const { body, coverage } = diff.budgetDiff(text, budget);
      assert.ok(enc(body) <= budget, `round ${round} budget ${budget}: body ${enc(body)}`);
      assert.ok(!body.includes('\uFFFD'));
      for (let f = 0; f < nFiles; f++) {
        const file = `d${f}/file${f}.js`;
        for (let h = 1; h <= hunkOf[f]; h++) {
          const marker = `M${f}x${h}`;
          const entry = coverage.covered.find((c) => c.path === file);
          const partial = entry && entry.partial.find((p) => p.hunk === h);
          if (entry && entry.hunks.includes(h)) assert.ok(body.includes(marker), `${marker} claimed shown`);
          else if (partial) assert.equal(body.includes(marker), partial.parts_shown.includes(1), `${marker} partial`);
          else assert.ok(!body.includes(marker) && hunkListedOmitted(coverage, file, h), `${marker} must be enumerated omitted`);
        }
      }
    }
  }
});

test('prompt manifest is bounded while the persisted manifest is complete', () => {
  let text = '';
  for (let f = 0; f < 3000; f++) text += makeFile(`gen/f${f}.js`, [makeHunk(`G${f}`, 1, 4)]);
  const d = { source: 'staged', ...diff.budgetDiff(text, diff.DIFF_MAX_BYTES), stat: null, bytes: enc(text) };
  d.truncated = !d.coverage.complete;
  const manifest = diff.renderCoverage(d.coverage);
  assert.ok(enc(manifest) <= diff.MANIFEST_MAX_BYTES);
  assert.match(manifest, /more manifest line\(s\) not listed/);
  const meta = diff.diffMeta(d);
  const listed = d.truncated ? manifest.split('\n').filter((l) => l.startsWith('- gen/')).length : 0;
  assert.ok(meta.coverage.files_omitted > 1000 && listed < meta.coverage.files_omitted, 'prompt lists fewer entries than the persisted manifest holds');
  assert.equal(meta.coverage.omitted.filter((o) => o.scope === 'file').length, meta.coverage.files_omitted);
  assert.equal(new Set(meta.coverage.omitted.filter((o) => o.scope === 'file').map((o) => o.path)).size, meta.coverage.files_omitted);
  assert.ok(!('body' in meta));
});

test('boundStat keeps the summary line and the byte bound', () => {
  const stat = [...Array.from({ length: 5000 }, (_, i) => ` src/file${i}.js | 3 ++-`), ' 5000 files changed, 15000 insertions(+), 5000 deletions(-)'].join('\n');
  const bounded = diff.boundStat(stat);
  assert.ok(enc(bounded) <= diff.STAT_MAX_BYTES);
  assert.ok(bounded.endsWith('5000 files changed, 15000 insertions(+), 5000 deletions(-)'));
  assert.match(bounded, /more file stat line\(s\) omitted/);
});

test('review context tells the reviewer what it was not given and fences safely', () => {
  const hunk = makeHunk('FENCE', 1, 6).replace('context 2', 'context ```inner``` 2');
  const filler = Array.from({ length: 40 }, (_, f) => makeFile(`z/f${f}.js`, [makeHunk(`Z${f}`, 1, 40)])).join('');
  const { body, coverage } = diff.budgetDiff(makeFile('md.md', [hunk]) + filler, 6 * 1024);
  const ctx = diff.buildReviewContext({ source: 'staged', body, stat: null, truncated: true, coverage });
  assert.match(ctx, /DIFF COVERAGE — PARTIAL/);
  assert.match(ctx, /NOT SHOWN:/);
  assert.match(ctx, /Do not assert facts about it/);
  const open = ctx.split('\n').find((l) => /^`{3,}diff$/.test(l));
  const fence = open.replace('diff', '');
  assert.ok(fence.length >= 3);
  assert.ok(!body.includes(fence) || fence.length > 3);
  assert.equal(ctx.trimEnd().split('\n').pop(), fence);
});

test('collectReviewDiff(--diff-file) reports partial coverage and never persists the body in metadata', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'change.patch');
  fs.writeFileSync(file, makeFile('a.js', [1, 2, 3, 4, 5, 6].map((h) => makeHunk(`PAYLOAD-SECRET-${h}`, h * 60, 40))));
  const d = diff.collectReviewDiff({ diffFile: file }, dir, { budget: 1500 });
  assert.equal(d.truncated, true);
  assert.equal(d.coverage.complete, false);
  assert.equal(d.bytes, fs.statSync(file).size);
  assert.ok(enc(d.body) <= 1500);
  assert.ok(!JSON.stringify(diff.diffMeta(d)).includes('PAYLOAD-SECRET'));
  const empty = path.join(dir, 'empty.patch');
  fs.writeFileSync(empty, '\n');
  assert.match(diff.collectReviewDiff({ diffFile: empty }, dir).error, /empty/);
});

// ---------------------------------------------------------------------------
// structured layer
// ---------------------------------------------------------------------------

test('extractJson: native/pure JSON, last fenced block, string-aware bare JSON, non-objects ignored', () => {
  assert.deepEqual(structured.extractJson('{"a":"}"}'), { a: '}' });
  assert.deepEqual(structured.extractJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":3,}\n```'), { a: 3 });
  assert.deepEqual(
    structured.extractJson('use {x} first. Final: {"verdict":"approve","k":"a}b"} thanks'),
    { verdict: 'approve', k: 'a}b' }
  );
  assert.equal(structured.extractJson('the answer is 42'), null);
  assert.equal(structured.extractJson('42'), null);
});

test('parseChildEnvelope preserves attribution/usage/cost and never treats stdout text as model output', () => {
  const env = okEnv('codex', 'gpt-x', { raw: 'hello', usage: { input_tokens: 3 }, cost: 0.25 });
  const r = structured.parseChildEnvelope(JSON.stringify(env), 0);
  assert.equal(r.raw, 'hello');
  assert.equal(r.attribution.reported_model, 'gpt-x');
  assert.deepEqual(r.usage, { input_tokens: 3 });
  assert.equal(r.cost_estimate, 0.25);

  // old human-mode advisor stdout (an artifact path) is a protocol failure, not an answer
  const md = structured.parseChildEnvelope('C:\\proj\\.xllm\\artifacts\\xllm\\a.md\n', 0);
  assert.equal(md.exitCode, 1);
  assert.equal(md.raw, '');
  assert.equal(md.failure.kind, 'protocol');
  assert.equal(structured.parseChildEnvelope(JSON.stringify({ ...env, schema_version: 1 }), 0).failure.kind, 'protocol');

  // a child that exits non-zero cannot be reported as success
  const crashed = structured.parseChildEnvelope(JSON.stringify(env), 7);
  assert.equal(crashed.exitCode, 7);
  assert.equal(crashed.failure.kind, 'child-exit');

  // progress noise before the envelope is tolerated
  assert.equal(structured.parseChildEnvelope(`warming up\n${JSON.stringify(env)}\n`, 0).raw, 'hello');
});

const FAKE_ADVISOR = `
import fs from 'fs';
const a = process.argv.slice(2);
const pf = a.indexOf('--prompt-file');
const sf = a.indexOf('--schema-file');
const info = {
  spec: a[0],
  json: a.includes('--json'),
  noArtifacts: a.includes('--no-artifacts'),
  viaFile: pf >= 0,
  prompt: pf >= 0 ? fs.readFileSync(a[pf + 1], 'utf8') : a[1],
  promptPath: pf >= 0 ? a[pf + 1] : null,
  schemaPath: sf >= 0 ? a[sf + 1] : null,
  schema: sf >= 0 ? JSON.parse(fs.readFileSync(a[sf + 1], 'utf8')) : null,
};
if (process.env.FAKE_MODE === 'markdown') { process.stdout.write('C:/x/artifact.md\\n'); process.exit(0); }
process.stdout.write(JSON.stringify({
  schema_version: 2, raw: JSON.stringify(info), exitCode: 0, durationMs: 1, artifactPath: null, patchPath: null,
  failure: null,
  attribution: { executed_provider: 'fake', reported_model: 'm1', identity_status: 'resolved', model_revision: 'r1', surface: 'cli-agentic' },
  usage: { input_tokens: 7 }, cost_estimate: 0.5, structured: sf >= 0 ? { echoed: true } : null,
}));
`;

test('askAdvisor drives a real child over --json: flags, prompt-file for big prompts, schema file lifecycle, no Markdown parsing', async (t) => {
  const dir = tmpDir(t);
  const fake = path.join(dir, 'fake-advisor.mjs');
  fs.writeFileSync(fake, FAKE_ADVISOR);

  const small = await structured.askAdvisor('codex', 'short question', { advisor: fake, noArtifacts: true, schema: { type: 'object' } });
  const info = JSON.parse(small.raw);
  assert.equal(info.json, true);
  assert.equal(info.noArtifacts, true);
  assert.equal(info.viaFile, false);
  assert.deepEqual(info.schema, { type: 'object' });
  assert.deepEqual(small.structured, { echoed: true });
  assert.equal(small.attribution.reported_model, 'm1');
  assert.deepEqual(small.usage, { input_tokens: 7 });
  assert.equal(small.cost_estimate, 0.5);
  assert.equal(fs.existsSync(info.schemaPath), false, 'schema temp file is cleaned up');

  const bigPrompt = 'x'.repeat(structured.PROMPT_FILE_THRESHOLD + 500);
  const big = await structured.askAdvisor('codex', bigPrompt, { advisor: fake });
  const bigInfo = JSON.parse(big.raw);
  assert.equal(bigInfo.viaFile, true);
  assert.equal(bigInfo.prompt, bigPrompt);
  assert.equal(bigInfo.noArtifacts, false);
  assert.equal(big.structured, null);
  assert.equal(fs.existsSync(bigInfo.promptPath), false, 'prompt temp file is cleaned up');

  const md = await structured.askAdvisor('codex', 'q', { advisor: fake, env: { ...process.env, FAKE_MODE: 'markdown' } });
  assert.equal(md.exitCode, 1);
  assert.equal(md.raw, '');
  assert.equal(md.failure.kind, 'protocol');
});

const validateOk = (v) => (v && v.ok === true ? { ok: true } : null);

test('askStructured: native schema payload is used and labelled native; absent payload falls back to prompt contract', async () => {
  const seen = [];
  const native = await structured.askStructured({
    spec: 'codex',
    prompt: 'p',
    validate: validateOk,
    schema: { type: 'object' },
    ask: async (spec, prompt, opts) => (seen.push(opts), okEnv('codex', 'm', { structured: { ok: true } })),
  });
  assert.equal(native.adherence, 'first');
  assert.equal(native.schema_mode, 'native');
  assert.deepEqual(seen[0].schema, { type: 'object' });

  const prose = await structured.askStructured({
    spec: 'codex',
    prompt: 'p',
    validate: validateOk,
    schema: { type: 'object' },
    ask: async () => okEnv('codex', 'm', { raw: 'reasoning...\n```json\n{"ok": true}\n```' }),
  });
  assert.equal(prose.adherence, 'first');
  assert.equal(prose.schema_mode, 'prompt', 'an adapter that ignored the schema is not credited with constrained output');
});

test('askStructured: one corrective retry sums usage/cost; attempts are logged', async () => {
  const prompts = [];
  const r = await structured.askStructured({
    spec: 'codex',
    prompt: 'base',
    validate: validateOk,
    repairHint: 'FIX IT',
    ask: async (spec, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? okEnv('codex', 'm', { raw: 'no json here', usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.01 })
        : okEnv('codex', 'm', { raw: '{"ok":true}', usage: { input_tokens: 12, output_tokens: 4 }, cost: 0.02 });
    },
  });
  assert.equal(r.adherence, 'retry');
  assert.equal(r.attempts, 2);
  assert.match(prompts[1], /REMINDER: FIX IT/);
  assert.deepEqual(r.usage, { input_tokens: 22, output_tokens: 9 });
  assert.ok(Math.abs(r.cost_estimate - 0.03) < 1e-9);
  assert.deepEqual(r.attempt_log.map((a) => a.valid), [false, true]);
});

test('askStructured: provider failures abstain without a wasted retry; contract violations get exactly one', async () => {
  let calls = 0;
  const failed = await structured.askStructured({
    spec: 'codex',
    prompt: 'p',
    validate: validateOk,
    ask: async () => (calls++, failEnv('codex', 'm', 'timeout')),
  });
  assert.equal(calls, 1, 'a non-retryable provider failure is not re-asked');
  assert.equal(failed.adherence, 'failed');
  assert.equal(failed.value, null);
  assert.equal(failed.failure.kind, 'timeout');

  calls = 0;
  const bad = await structured.askStructured({
    spec: 'codex',
    prompt: 'p',
    validate: validateOk,
    ask: async () => (calls++, okEnv('codex', 'm', { raw: 'still prose', usage: null, cost: null })),
  });
  assert.equal(calls, 2);
  assert.equal(bad.failure.kind, 'contract-violation');
  assert.equal(bad.usage, null, 'unreported usage stays null, never 0');
  assert.equal(bad.cost_estimate, null);
});

test('sumUsage / mergeAttributions: sums recursively; divergent identity yields no attribution', () => {
  assert.deepEqual(structured.sumUsage([{ a: 1, n: { x: 2 } }, null, { a: 2, n: { x: 3 }, s: 't' }]), { a: 3, n: { x: 5 }, s: 't' });
  assert.equal(structured.sumUsage([null, undefined]), null);
  assert.equal(structured.sumCost([null]), null);

  const merged = structured.mergeAttributions([
    { spec: 'a', attribution: attr('codex', 'm1') },
    { spec: 'a', attribution: attr('codex', 'm1') },
    { spec: 'b', attribution: attr('claude', 'm2') },
    { spec: 'b', attribution: attr('claude', 'm3') }, // the same spec resolved to a different model mid-run
    { spec: 'c', attribution: makeResult({}).attribution }, // never executed
  ]);
  assert.deepEqual(Object.keys(merged.attributions), ['a']);
  assert.equal(merged.conflicts.b.length, 2);
  assert.ok(!('c' in merged.attributions) && !('c' in merged.conflicts));
});

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

test('panel CLI args: control flags never leak into the question', () => {
  const p = panel.parsePanelRunArgs(['codex,claude', 'is', 'it', 'ok?', '--json', '--no-artifacts', '--tiebreak', '--ready=a,b']);
  assert.equal(p.question, 'is it ok?');
  assert.deepEqual([p.json, p.noArtifacts, p.tiebreak, p.readyProviders], [true, true, true, ['a', 'b']]);
  const d = debate.parseDebateRunArgs(['codex,claude', 'claim', '--no-artifacts', '--json']);
  assert.equal(d.question, 'claim');
  assert.deepEqual([d.json, d.noArtifacts], [true, true]);
});

test('panel: a failed panelist abstains, label covers reporters only, attribution/evidence is recorded', async (t) => {
  const root = tmpDir(t);
  const { ask, log } = scripted({
    codex: () => verdictEnv('codex', 'gpt-x', 'approve', ['c1']),
    claude: () => verdictEnv('claude', 'opus-x', 'approve', ['c2']),
    gemini: () => failEnv('gemini', 'g', 'auth'),
  });
  const r = await quiet(() => panel.runPanel({ specs: ['codex', 'claude', 'gemini'], question: 'Is X safe?', root, ask, env: {} }));
  assert.equal(r.exitCode, 0);
  assert.equal(r.label, 'unanimous');
  assert.equal(r.completion.complete, false);
  assert.equal(r.completion.abstained, 1);
  assert.equal(r.completion.abstentions[0].failure, 'auth');
  assert.equal(log.filter((l) => l.provider === 'gemini').length, 1, 'auth failure is not retried');
  assert.ok(log.every((l) => l.opts.schema === panel.PANEL_SCHEMA), 'native schema is requested for the real panel contract');

  const rec = ledgerOf(root, 'panel')[0];
  assert.equal(rec.schema_version, 2);
  assert.equal(rec.panelists[2].verdict, null);
  assert.equal(rec.panelists[2].failure.kind, 'auth');
  assert.equal(rec.panelists[0].schema_mode, 'native');
  assert.deepEqual(rec.panelists[0].usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(rec.panelists[0].cost_estimate, 0.01);
  assert.equal(rec.panelists[0].evidence_key, evidenceKey(attr('codex', 'gpt-x')));
  const specKeys = ['codex', 'claude', 'gemini'].map((s) => parseProviderSpec(s).spec);
  assert.deepEqual(Object.keys(rec.attributions).sort(), [...specKeys].sort());
  assert.equal(evidenceKey(rec.attributions[specKeys[2]]), null, 'a failed call executed but has no resolved identity: never evidence');
  const [ab, ag, bg] = rec.pairwise;
  assert.equal(ab.agree, true);
  assert.ok(ab.a_evidence && ab.b_evidence);
  assert.equal(ag.agree, null, 'an abstention is never agreement');
  assert.equal(bg.agree, null);
  assert.ok(fs.existsSync(r.mdPath));
  assert.match(fs.readFileSync(r.mdPath, 'utf8'), /2\/3 panelists reported/);
});

test('panel total failure returns nonzero without dropping abstention evidence', async (t) => {
  const root = tmpDir(t);
  const r = await quiet(() => panel.runPanel({
    specs: ['codex', 'claude'], question: 'Is X safe?', root, env: {}, noArtifacts: true,
    ask: async (spec) => failEnv(spec, 'unresolved', 'auth'),
  }));
  assert.equal(r.exitCode, 1);
  const result = panel.panelJson(r);
  assert.equal(result.completion.valid, 0);
  assert.equal(result.completion.complete, false);
  assert.deepEqual(result.completion.abstentions.map((p) => p.failure), ['auth', 'auth']);
  assert.ok(result.pairwise.every((p) => p.agree === null));
  assert.deepEqual(panel.ledgerStats(ledgerOf(root, 'panel')).matrix, []);
});

test('panel --no-artifacts: children run without artifacts, no index, ledger keeps metadata only, JSON carries the answers', async (t) => {
  const root = tmpDir(t);
  const { ask, log } = scripted({
    codex: () => okEnv('codex', 'gpt-x', { raw: 'full answer text', structured: { verdict: 'approve', confidence: 1, key_claims: ['secret-claim'] } }),
    claude: () => verdictEnv('claude', 'opus-x', 'approve', ['other']),
  });
  const r = await quiet(() =>
    panel.runPanel({ specs: ['codex', 'claude'], question: 'private question', root, ask, env: {}, noArtifacts: true })
  );
  assert.ok(log.every((l) => l.opts.noArtifacts === true));
  assert.equal(r.mdPath, null);
  assert.match(r.markdown, /private question/, 'printed output still carries the content');
  assert.equal(fs.existsSync(path.join(resolveStateDir(root), 'artifacts')), false);
  const rec = ledgerOf(root, 'panel')[0];
  assert.equal(rec.content_persisted, false);
  assert.equal(rec.question, null);
  assert.deepEqual(rec.panelists[0].key_claims, []);
  assert.equal(rec.panelists[0].verdict, 'approve', 'measurement data survives');
  const j = panel.panelJson(r);
  assert.equal(j.index_path, null);
  assert.equal(j.panelists[0].answer, 'full answer text');
  assert.deepEqual(j.panelists[0].key_claims, ['secret-claim']);
});

test('panel lanes: cloud panelists overlap, same-machine local panelists are serialized, proven-remote local runtimes are not', async (t) => {
  assert.equal(panel.laneKeyFor({ provider: 'codex', model: null, spec: 'codex' }, {}), 'cloud:codex');
  assert.equal(panel.laneKeyFor({ provider: 'ollama', model: 'llama3', spec: 'ollama:llama3' }, {}), 'local:ollama');
  assert.match(panel.laneKeyFor({ provider: 'ollama', model: 'gpt-oss:120b-cloud', spec: 'ollama:gpt-oss:120b-cloud' }, {}), /^remote:/);

  const root = tmpDir(t);
  const spans = {};
  const specs = ['codex', 'claude', 'ollama:llama3', 'ollama:llama3@high'].map((s) => parseProviderSpec(s).spec);
  const ask = async (spec, prompt) => {
    spans[spec] = { start: Date.now() };
    await new Promise((res) => setTimeout(res, 60));
    spans[spec].end = Date.now();
    const provider = spec.split(/[:@]/)[0];
    return verdictEnv(provider, `${spec}-model`, 'approve', ['c']);
  };
  await quiet(() => panel.runPanel({ specs, question: 'q', root, ask, env: {} }));
  const [codex, claude, l1, l2] = specs.map((s) => spans[s]);
  assert.ok(claude.start < codex.end, 'cloud panelists run in parallel');
  assert.ok(l2.start >= l1.end, 'local panelists on one runtime run one at a time');
});

test('ledgerStats counts only rows whose both sides carry an evidence key; legacy/unresolved rows are excluded, not matched by spec', () => {
  const row = (a, b, agree, ka, kb) => ({ a, b, agree, a_evidence: ka, b_evidence: kb });
  const stats = panel.ledgerStats([
    { type: 'panel', pairwise: [{ a: 'x', b: 'y', agree: true }] }, // legacy: no evidence fields
    { type: 'panel', pairwise: [row('x', 'y', true, null, 'K2')] }, // identity did not resolve
    { type: 'panel', pairwise: [row('x', 'y', true, 'K1', 'K2'), row('x', 'z', null, 'K1', 'K3')] },
    { type: 'tiebreak', pairwise: [row('y', 'x', false, 'K2', 'K1')] },
    { type: 'panel', pairwise: [row('x', 'y', true, 'K9', 'K2')] }, // same spec text, different executed identity
    { type: 'outcome' },
  ]);
  assert.equal(stats.runs, 4);
  assert.equal(stats.tiebreaks, 1);
  assert.deepEqual(stats.excluded, { legacy_rows: 1, unresolved_rows: 1 });
  assert.equal(stats.outcomes_recorded, 1);
  assert.equal(stats.matrix.length, 2, 'rows are keyed by evidence pair, not by spec text');
  const k12 = stats.matrix.find((m) => m.evidence.join() === 'K1,K2');
  assert.equal(k12.comparable_runs, 2);
  assert.equal(k12.agreement_rate, 0.5);
  assert.equal(k12.pair, 'x ↔ y');
});

test('pairwise rows carry each side evidence key; abstention yields null agreement', () => {
  const rows = panel.computePairwise([
    { spec: 'a', verdict: { verdict: 'approve' }, evidence_key: 'KA' },
    { spec: 'b', verdict: { verdict: 'reject' }, evidence_key: null },
    { spec: 'c', verdict: null, evidence_key: 'KC' },
  ]);
  assert.deepEqual(rows[0], { a: 'a', b: 'b', agree: false, a_evidence: 'KA', b_evidence: null });
  assert.equal(rows[1].agree, null);
});

// ---------------------------------------------------------------------------
// debate: failed providers are never survival or kill
// ---------------------------------------------------------------------------

const rel = (spec, attacker, status, coverage, failure = null) => ({ spec, attacker, status, coverage, failure });
const completedR2 = { spec: 'claude:opus', status: 'completed', failure: null };
const refute = (attacker, tier = 'decisive', falsifier = 'f') => ({ claim_id: 'C0-1', stance: 'refute', mechanism: 'm', falsifier, tier, attacker });
const claimC = { id: 'C0-1', author: 'claude:opus', authorSpec: 'claude:opus', text: 'X' };

test('classify: SURVIVED needs every eligible opponent to have completed; a valid empty list is a distinct no-objection', () => {
  const noObj = rel('codex', 'codex', 'completed', 'no-objection');
  assert.equal(debate.classifyDebateClaim(claimC, [], null, 2, { r1: [noObj], r2: null }).status, 'SURVIVED');
  assert.equal(debate.classifyDebateClaim(claimC, [], null, 2, { r1: [rel('codex', 'codex', 'completed', 'passed')], r2: null }).status, 'SURVIVED');

  const failed = rel('codex', 'codex', 'failed', null, 'timeout');
  const total = debate.classifyDebateClaim(claimC, [], null, 2, { r1: [failed], r2: null });
  assert.equal(total.status, 'UNRESOLVED');
  assert.equal(total.incomplete, true);
  assert.match(total.reason, /codex did not complete R1 \(timeout\)/);

  // partial failure at N=3: one opponent reported no objection, the other failed
  const partial = debate.classifyDebateClaim(claimC, [], null, 3, { r1: [noObj, rel('grok', 'grok', 'failed', null, 'auth')], r2: null });
  assert.equal(partial.status, 'UNRESOLVED');

  // silence on this claim is not review
  const silent = debate.classifyDebateClaim(claimC, [], null, 2, { r1: [rel('codex', 'codex', 'completed', 'unaddressed')], r2: null });
  assert.equal(silent.status, 'UNRESOLVED');
  assert.match(silent.reason, /did not address this claim/);

  assert.equal(debate.classifyDebateClaim(claimC, [], null, 2, { r1: [], r2: null }).status, 'UNRESOLVED', 'nobody eligible');
  assert.equal(debate.classifyDebateClaim(claimC, [], null, 2).status, 'UNRESOLVED', 'phase completion is required');
});

test('classify: a missing/failed defense is never a kill; evidence from completed phases still kills', () => {
  const refuted = rel('codex', 'codex', 'completed', 'refuted');
  const attacks = [refute('codex')];
  const noDefense = debate.classifyDebateClaim(claimC, attacks, null, 2, {
    r1: [refuted],
    r2: { spec: 'claude:opus', status: 'failed', failure: 'timeout' },
  });
  assert.equal(noDefense.status, 'UNRESOLVED');
  assert.match(noDefense.reason, /defense did not complete/);

  const hold = { response: 'holds', amended_claim: null, rebuttals: [] };
  const killed = debate.classifyDebateClaim(claimC, attacks, hold, 3, {
    r1: [refuted, rel('grok', 'grok', 'failed', null, 'auth')],
    r2: completedR2,
  });
  assert.equal(killed.status, 'KILLED', 'a standing decisive falsifier kills even when another opponent failed');
  assert.equal(killed.incomplete, true, '...but the incompleteness is recorded');
  assert.equal(killed.decisive_refutation.falsifier, 'f');

  assert.equal(debate.classifyDebateClaim(claimC, attacks, { response: 'concede', amended_claim: null, rebuttals: [] }, 2, { r1: [refuted], r2: completedR2 }).status, 'KILLED');

  const defeated = { response: 'holds', amended_claim: null, rebuttals: [{ attacker: 'codex', result: 'holds', counter: 'c' }] };
  assert.equal(debate.classifyDebateClaim(claimC, attacks, defeated, 2, { r1: [refuted], r2: completedR2 }).status, 'SURVIVED');
  // author defeated every refutation received, but another opponent never reviewed
  const limbo = debate.classifyDebateClaim(claimC, attacks, defeated, 3, {
    r1: [refuted, rel('grok', 'grok', 'failed', null, 'auth')],
    r2: completedR2,
  });
  assert.equal(limbo.status, 'UNRESOLVED');
  // soft dispute stays unresolved; two unrebutted distinct opponents kill at N>=3
  assert.equal(debate.classifyDebateClaim(claimC, [refute('codex', 'soft', '')], hold, 2, { r1: [refuted], r2: completedR2 }).status, 'UNRESOLVED');
  const two = [refute('codex', 'soft', ''), refute('grok', 'soft', '')];
  assert.equal(
    debate.classifyDebateClaim(claimC, two, hold, 3, { r1: [refuted, rel('grok', 'grok', 'completed', 'refuted')], r2: completedR2 }).status,
    'KILLED'
  );
});

test('validateAttacks: empty list is no-objection; a list of only invalid entries is non-compliant', () => {
  assert.deepEqual(debate.validateAttacks({ attacks: [] }), { attacks: [], declared: 0, dropped: 0, no_objection: true });
  assert.equal(debate.validateAttacks({ attacks: [{ claim_id: 'C0-1', stance: 'refute', mechanism: '' }] }), null);
  assert.equal(debate.validateAttacks({ attacks: [{ claim_id: 'C0-1', stance: 'maybe', mechanism: 'm' }] }), null);
  const mixed = debate.validateAttacks({
    attacks: [{ claim_id: 'C0-1', stance: 'refute', mechanism: '' }, { claim_id: 'C0-2', stance: 'pass', mechanism: 'why' }],
  });
  assert.equal(mixed.attacks.length, 1);
  assert.equal(mixed.dropped, 1);
  assert.equal(mixed.no_objection, false);
  assert.equal(debate.validateAttacks({ nope: 1 }), null);
});

async function runDebateWith(t, handlers, opts = {}) {
  const root = tmpDir(t);
  const { ask, log } = scripted(handlers);
  const r = await quiet(() => debate.runDebate({ specs: ['codex', 'claude'], question: 'Is the cache safe?', root, ask, env: {}, ...opts }));
  return { r, log, root };
}

test('debate: one opponent fails R1 — its claim is UNRESOLVED (not SURVIVED); evidence-backed kill elsewhere still stands', async (t) => {
  const { r, root } = await runDebateWith(t, {
    codex: (phase, prompt) => (phase === 'R0' ? claimsEnv('codex', 'gpt-x', 'codex claim') : attackEnv('codex', 'gpt-x', prompt)),
    claude: (phase) => (phase === 'R0' ? claimsEnv('claude', 'opus-x', 'claude claim') : phase === 'R1' ? failEnv('claude', 'opus-x', 'timeout') : holdsEnv('claude', 'opus-x')),
  });
  assert.equal(r.exitCode, 0);
  const byId = Object.fromEntries(r.results.map((c) => [c.id, c]));
  // C0-1 (codex's claim): its only opponent, claude, failed R1 → nobody tested it
  assert.equal(byId['C0-1'].status, 'UNRESOLVED');
  assert.equal(byId['C0-1'].incomplete, true);
  assert.equal(byId['C0-1'].phases.r1[0].status, 'failed');
  // C1-1 (claude's claim): codex refuted decisively, claude defended without rebutting → real kill
  assert.equal(byId['C1-1'].status, 'KILLED');
  assert.deepEqual(r.tally, { SURVIVED: 0, KILLED: 1, UNRESOLVED: 1 });
  assert.equal(r.completion.complete, false);
  assert.equal(r.completion.r1.failed.length, 1);
  const rec = ledgerOf(root, 'debate')[0];
  assert.equal(rec.schema_version, 2);
  assert.equal(rec.claims[0].phases.r1[0].failure, 'timeout');
  assert.equal(rec.completion.r1.failed[0].failure, 'timeout');
});

test('debate: total R1 provider failure leaves every claim UNRESOLVED — no blanket survival', async (t) => {
  const { r, log } = await runDebateWith(t, {
    codex: (phase) => (phase === 'R0' ? claimsEnv('codex', 'gpt-x', 'codex claim') : okEnv('codex', 'gpt-x', { raw: 'I refuse to use JSON' })),
    claude: (phase) => (phase === 'R0' ? claimsEnv('claude', 'opus-x', 'claude claim') : failEnv('claude', 'opus-x', 'auth')),
  });
  assert.deepEqual(r.tally, { SURVIVED: 0, KILLED: 0, UNRESOLVED: 2 });
  assert.ok(r.results.every((c) => c.incomplete));
  assert.equal(log.filter((l) => l.provider === 'codex' && l.phase === 'R1').length, 2, 'non-compliant (exit 0) output gets one corrective retry');
  assert.equal(log.filter((l) => l.provider === 'claude' && l.phase === 'R1').length, 1, 'auth failure is not retried');
  assert.ok(log.filter((l) => l.phase === 'R2').length === 0);
});

test('debate: a valid empty attacks list is a real no-objection and can survive; no R2 is spent', async (t) => {
  const { r, log, root } = await runDebateWith(t, {
    codex: (phase) => (phase === 'R0' ? claimsEnv('codex', 'gpt-x', 'codex claim') : noObjectionEnv('codex', 'gpt-x')),
    claude: (phase) => (phase === 'R0' ? claimsEnv('claude', 'opus-x', 'claude claim') : noObjectionEnv('claude', 'opus-x')),
  });
  assert.deepEqual(r.tally, { SURVIVED: 2, KILLED: 0, UNRESOLVED: 0 });
  assert.equal(r.results[0].phases.r1[0].coverage, 'no-objection');
  assert.equal(r.completion.complete, true);
  assert.equal(log.filter((l) => l.phase === 'R2').length, 0);
  assert.ok(log.filter((l) => l.phase === 'R1').every((l) => l.opts.schema === debate.ATTACKS_SCHEMA));
  assert.ok(ledgerOf(root, 'debate')[0].completion.complete);
});

test('debate: a failed defender leaves a refuted claim UNRESOLVED, not KILLED', async (t) => {
  const { r } = await runDebateWith(t, {
    codex: (phase, prompt) => (phase === 'R0' ? claimsEnv('codex', 'gpt-x', 'codex claim') : attackEnv('codex', 'gpt-x', prompt)),
    claude: (phase) => (phase === 'R0' ? claimsEnv('claude', 'opus-x', 'claude claim') : phase === 'R1' ? noObjectionEnv('claude', 'opus-x') : failEnv('claude', 'opus-x', 'timeout')),
  });
  const byId = Object.fromEntries(r.results.map((c) => [c.id, c]));
  assert.equal(byId['C0-1'].status, 'SURVIVED');
  assert.equal(byId['C1-1'].status, 'UNRESOLVED');
  assert.match(byId['C1-1'].reason, /defense did not complete \(timeout\)/);
  assert.equal(byId['C1-1'].phases.r2.status, 'failed');
});

test('debate --no-artifacts: no index, children run artifact-free, ledger omits claim/mechanism text', async (t) => {
  const { r, log, root } = await runDebateWith(
    t,
    {
      codex: (phase, prompt) => (phase === 'R0' ? claimsEnv('codex', 'gpt-x', 'sensitive codex claim') : attackEnv('codex', 'gpt-x', prompt)),
      claude: (phase) => (phase === 'R0' ? claimsEnv('claude', 'opus-x', 'sensitive claude claim') : phase === 'R1' ? noObjectionEnv('claude', 'opus-x') : holdsEnv('claude', 'opus-x')),
    },
    { noArtifacts: true }
  );
  assert.equal(r.mdPath, null);
  assert.match(r.markdown, /sensitive codex claim/);
  assert.ok(log.every((l) => l.opts.noArtifacts === true));
  const rec = ledgerOf(root, 'debate')[0];
  assert.equal(rec.content_persisted, false);
  assert.equal(rec.question, null);
  assert.ok(rec.claims.every((c) => c.text === null && c.attacks.every((a) => a.mechanism === null)));
  assert.ok(!JSON.stringify(rec).includes('sensitive'));
  assert.ok(debate.debateJson(r).claims.every((c) => c.text.startsWith('sensitive')), 'JSON stdout still carries the content');
});

test('debate: no valid claims from anyone is a failure with phase detail, not an empty success', async (t) => {
  const { r, root } = await runDebateWith(t, {
    codex: () => failEnv('codex', 'gpt-x', 'auth'),
    claude: () => failEnv('claude', 'opus-x', 'auth'),
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.completion.r0.failed.length, 2);
  assert.equal(ledgerOf(root, 'debate').length, 0);
});

// ---------------------------------------------------------------------------
// council
// ---------------------------------------------------------------------------

function makeContextMeta(dir) {
  const file = path.join(dir, 'review.patch');
  fs.writeFileSync(file, Array.from({ length: 8 }, (_, f) => makeFile(`svc/f${f}.js`, [1, 2, 3].map((h) => makeHunk(`CTX-${f}-${h}`, h * 40, 40)))).join(''));
  const d = diff.collectReviewDiff({ diffFile: file }, dir, { budget: 3000 });
  return { context: diff.buildReviewContext(d), contextMeta: diff.diffMeta(d) };
}

test('council: partial diff coverage reaches prompts, both ledger records, the index and the JSON result', async (t) => {
  const root = tmpDir(t);
  const { context, contextMeta } = makeContextMeta(root);
  assert.equal(contextMeta.coverage.complete, false);
  const { ask, log } = scripted({
    codex: (phase) => (phase === 'panel' ? verdictEnv('codex', 'gpt-x', 'approve', ['codex finding']) : noObjectionEnv('codex', 'gpt-x')),
    claude: (phase) => (phase === 'panel' ? verdictEnv('claude', 'opus-x', 'approve', ['claude finding']) : noObjectionEnv('claude', 'opus-x')),
  });
  const r = await quiet(() => council.runCouncil({ specs: ['codex', 'claude'], question: 'Review this change', root, ask, env: {}, context, contextMeta }));
  assert.equal(r.exitCode, 0);
  assert.ok(log.every((l) => l.prompt.includes('DIFF COVERAGE — PARTIAL')), 'every phase prompt carries the coverage manifest');
  assert.equal(r.panel.context.coverage.complete, false);
  assert.equal(r.debate.context.coverage.complete, false);
  for (const type of ['panel', 'debate']) {
    const rec = ledgerOf(root, type)[0];
    assert.equal(rec.diff_context.coverage.complete, false, `${type} record carries coverage`);
    assert.ok(rec.diff_context.coverage.omitted.length > 0);
    assert.ok(!JSON.stringify(rec).includes('CTX-'), 'diff body is never persisted in the ledger');
  }
  assert.equal(ledgerOf(root, 'debate')[0].panel_run_id, r.panel.id);
  assert.match(fs.readFileSync(r.mdPath, 'utf8'), /## Code coverage/);
  const j = council.councilJson(r);
  assert.equal(j.context.coverage.complete, false);
  assert.equal(j.panel.context, undefined);
  assert.deepEqual(j.debate.tally, { SURVIVED: 2, KILLED: 0, UNRESOLVED: 0 });
});

const localInfo = (digest) => ({ digest, size: 4_000_000_000, details: { parameter_size: '8B' } });
const ollamaInventory = () => ({
  providers: {
    ollama: {
      installed: true,
      healthy: true,
      advisor_eligible: true,
      model_details: {
        'a:latest': localInfo('sha-a'),
        'b:latest': localInfo('sha-b'),
        'c:latest': localInfo('sha-c'),
        'big-cloud:cloud': { remote_model: true, digest: 'sha-cloud', size: 1 },
      },
    },
    codex: { installed: true, healthy: true, advisor_eligible: true },
  },
});

test('split panel under execution_policy=local-only: tiebreaker is a verified-local model from injected inventory, never cloud', async (t) => {
  const root = tmpDir(t);
  const localOnly = path.join(root, 'local-only.toml');
  fs.writeFileSync(localOnly, '[defaults]\nexecution_policy = "local-only"\n');
  const prevPath = process.env.XLLM_PROVIDERS_PATH;
  process.env.XLLM_PROVIDERS_PATH = localOnly;
  const { loadProviderProfiles } = await import('./xllm-advisor.js');
  loadProviderProfiles({ force: true });
  t.after(() => {
    if (prevPath === undefined) delete process.env.XLLM_PROVIDERS_PATH;
    else process.env.XLLM_PROVIDERS_PATH = prevPath;
    loadProviderProfiles({ force: true });
  });

  const ask = async (spec) => {
    const model = parseProviderSpec(spec).model;
    return makeResult({
      exitCode: 0,
      structured: { verdict: model.startsWith('a:') ? 'approve' : 'reject', confidence: 0.8, key_claims: ['local claim'] },
      attribution: attr('ollama', model, { execution_location: 'local', surface: 'http', model_revision: `sha-${model[0]}` }),
    });
  };
  const r = await quiet(() =>
    panel.runPanel({
      specs: ['ollama:a:latest', 'ollama:b:latest'],
      question: 'Is X safe?',
      root,
      ask,
      env: {},
      tiebreak: true,
      readyProviders: ['ollama', 'codex'],
      inventory: ollamaInventory(),
    })
  );
  assert.equal(r.label, 'split');
  const s = r.tiebreakSuggestion;
  assert.equal(s.provider, 'ollama:c:latest');
  assert.ok((s.refusals || []).some((x) => x.provider === 'codex'), 'cloud CLI refused under local-only');
  assert.ok((s.refusals || []).some((x) => /cloud/.test(x.model || '')), 'remote-marked local model refused');
  for (const model of ['a:latest', 'b:latest']) {
    assert.ok((s.refusals || []).some((x) => x.model === model && x.kind === 'same-identity'), `${model} is not counted twice`);
  }
});

test('council: when every panelist fails there is nothing to debate and no debate record', async (t) => {
  const root = tmpDir(t);
  const { ask } = scripted({
    codex: () => failEnv('codex', 'gpt-x', 'auth'),
    claude: () => failEnv('claude', 'opus-x', 'timeout'),
  });
  const r = await quiet(() => council.runCouncil({ specs: ['codex', 'claude'], question: 'q', root, ask, env: {} }));
  assert.equal(r.exitCode, 1);
  assert.equal(r.panel.label, 'no-verdicts');
  assert.equal(ledgerOf(root, 'panel')[0].completion.valid, 0);
  assert.equal(ledgerOf(root, 'debate').length, 0);
  assert.equal(council.councilJson(r).exitCode, 1);
});

test('council --no-artifacts writes no index for either phase', async (t) => {
  const root = tmpDir(t);
  const { ask } = scripted({
    codex: (phase) => (phase === 'panel' ? verdictEnv('codex', 'gpt-x', 'approve', ['a']) : noObjectionEnv('codex', 'gpt-x')),
    claude: (phase) => (phase === 'panel' ? verdictEnv('claude', 'opus-x', 'approve', ['b']) : noObjectionEnv('claude', 'opus-x')),
  });
  const r = await quiet(() => council.runCouncil({ specs: ['codex', 'claude'], question: 'q', root, ask, env: {}, noArtifacts: true }));
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.mdPath, r.panel.mdPath, r.debate.mdPath], [null, null, null]);
  assert.equal(fs.existsSync(path.join(resolveStateDir(root), 'artifacts')), false);
});
