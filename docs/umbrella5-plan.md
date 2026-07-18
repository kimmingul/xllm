# umbrella-5 (`review`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the full umbrella-5 design (docs/superpowers-absorption-design.md, user-ratified 전체판): one `review` product noun (`roles|blind|debate|council|stats|outcome`), deterministic diff input (`--staged|--base|--diff-file`) for review-over-code, the measured/non-measured epistemology firewall, skill collapse 7→5, Grok adapter mode recipes, discipline block v2 — released as v0.26.0.

**Architecture:** A new standalone diff collector (`scripts/xllm-diff.js`, zero project imports — ESM-cycle-safe) feeds a context block into panel/debate/council/advisor-multi *inside each target process* (argv-safe: the structured layer already auto-routes >24KB prompts via temp `--prompt-file`; only advisor `--multi`'s direct child spawn needs its own temp-file guard). A thin `scripts/xllm-review.js` dispatcher maps review modes onto the existing scripts. Diff bodies travel ONLY in prompts; ledgers/indexes record metadata only.

**Tech Stack:** Node ≥18 ESM, no new deps. Tests in `scripts/test-advisor.mjs` (sync `test(name, fn)` style, temp dirs via `fs.mkdtempSync` under repo root).

## Global Constraints

- `npm run ci` (check+test+smoke+bench:selftest) must stay green after every task — no live LLM required.
- Old nouns `multi|panel|debate|council` remain CLI aliases **through v0.27.x** (drop in v0.28.0) — every deprecation string uses exactly "alias through v0.27.x".
- Epistemology firewall: ledger writes + pairwise-agreement fields ONLY on blind/council-phase-1. `roles` (multi) index JSON must carry `measurement: false`. Never describe roles output as measured.
- Diff bodies are NEVER persisted (not in ledger, not in index JSON/md) — metadata only: `{source, stat, bytes, truncated}`.
- `skills/review/SKILL.md` ≤ 80 lines (enforced in check-plugin). Skill must contain `CLAUDE_PLUGIN_ROOT`, match `/read-only/i` and `/plugin.root|plugin-root/i` (existing check-plugin assertions).
- After editing any `scripts/*.js`: `sed -i 's/\r$//' <file>` (Windows CRLF).
- Commit per task. Conventional Commits. Do not push until the release task.
- 문서 언어: README/CHANGELOG는 한국어 기조 유지, 코드 주석은 영어.

---

### Task 1: `scripts/xllm-diff.js` — deterministic diff collector

**Files:**
- Create: `scripts/xllm-diff.js`
- Modify: `package.json` (add to `check` script)
- Test: `scripts/test-advisor.mjs` (append new section)

**Interfaces (Produces):**
- `parseDiffFlags(argv: string[]) → { diffOpts: {staged, base, diffFile}, rest: string[] } | { error }`
- `hasDiffSource(diffOpts) → boolean`
- `truncateDiff(text, max?) → { text, truncated }`
- `collectReviewDiff(diffOpts, root?) → { source, body, stat, bytes, truncated } | { error }`
- `buildReviewContext(diff) → string` (prompt block — the ONLY place the body travels)
- `diffMeta(diff) → { source, stat, bytes, truncated }` (persistable)
- `DIFF_MAX_BYTES = 24 * 1024`

- [ ] **Step 1: Write failing tests** — append to `scripts/test-advisor.mjs` (before the final summary lines, alongside the other import blocks):

```js
// ---------------------------------------------------------------------------
// xllm-diff (review-family diff collector)
// ---------------------------------------------------------------------------
import {
  parseDiffFlags,
  hasDiffSource,
  truncateDiff,
  collectReviewDiff,
  buildReviewContext,
  diffMeta,
  DIFF_MAX_BYTES,
} from './xllm-diff.js';

test('parseDiffFlags extracts each source and preserves rest', () => {
  const a = parseDiffFlags(['p1,p2', 'question', 'words', '--staged']);
  assert.strictEqual(a.diffOpts.staged, true);
  assert.deepStrictEqual(a.rest, ['p1,p2', 'question', 'words']);
  const b = parseDiffFlags(['--base', 'v0.25.0', 'x']);
  assert.strictEqual(b.diffOpts.base, 'v0.25.0');
  assert.deepStrictEqual(b.rest, ['x']);
  const c = parseDiffFlags(['--diff-file', 'a.patch']);
  assert.strictEqual(c.diffOpts.diffFile, 'a.patch');
});

test('parseDiffFlags rejects multiple sources and missing values', () => {
  assert.ok(parseDiffFlags(['--staged', '--base', 'main']).error);
  assert.ok(parseDiffFlags(['--base']).error);
  assert.ok(parseDiffFlags(['--diff-file']).error);
});

test('hasDiffSource false on empty opts, true per source', () => {
  assert.strictEqual(hasDiffSource(parseDiffFlags(['x']).diffOpts), false);
  assert.strictEqual(hasDiffSource(parseDiffFlags(['--staged']).diffOpts), true);
  assert.strictEqual(hasDiffSource(null), false);
});

test('truncateDiff caps at byte limit with marker', () => {
  const small = truncateDiff('abc');
  assert.strictEqual(small.truncated, false);
  const big = truncateDiff('x'.repeat(DIFF_MAX_BYTES + 1000));
  assert.strictEqual(big.truncated, true);
  assert.ok(big.text.includes('TRUNCATED'));
  assert.ok(Buffer.byteLength(big.text, 'utf8') < DIFF_MAX_BYTES + 200);
});

test('collectReviewDiff reads --diff-file fixture; errors on empty/missing', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-diff-'));
  try {
    const f = path.join(tmp, 'x.patch');
    fs.writeFileSync(f, 'diff --git a/a b/a\n+hello\n', 'utf8');
    const d = collectReviewDiff({ staged: false, base: null, diffFile: f });
    assert.strictEqual(d.source, `file:${f}`);
    assert.ok(d.body.includes('+hello'));
    assert.strictEqual(d.truncated, false);
    fs.writeFileSync(f, '', 'utf8');
    assert.ok(collectReviewDiff({ staged: false, base: null, diffFile: f }).error);
    assert.ok(collectReviewDiff({ staged: false, base: null, diffFile: path.join(tmp, 'nope') }).error);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildReviewContext fences the diff; diffMeta drops the body', () => {
  const d = { source: 'staged', body: '+line', stat: '1 file changed', bytes: 5, truncated: false };
  const ctx = buildReviewContext(d);
  assert.ok(ctx.includes('```diff'));
  assert.ok(ctx.includes('CODE UNDER REVIEW (staged)'));
  assert.ok(ctx.includes('+line'));
  const m = diffMeta(d);
  assert.deepStrictEqual(m, { source: 'staged', stat: '1 file changed', bytes: 5, truncated: false });
  assert.strictEqual('body' in m, false);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test` → expect `Cannot find module './xllm-diff.js'`.

- [ ] **Step 3: Create `scripts/xllm-diff.js`:**

```js
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

/** Head+tail truncation at the byte cap (same shape as scribe's). Pure. */
export function truncateDiff(text, max = DIFF_MAX_BYTES) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return {
    text: `${head}\n\n[... TRUNCATED ${s.length - head.length - tail.length} chars ...]\n\n${tail}`,
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
```

- [ ] **Step 4: Add to `package.json` `check` script** — insert `node --check scripts/xllm-diff.js && ` at the front of the existing chain (keep `node scripts/check-plugin.mjs` last).

- [ ] **Step 5: `sed -i 's/\r$//' scripts/xllm-diff.js scripts/test-advisor.mjs` then `npm run check && npm test`** — expect all tests pass (163 + 6 new).

- [ ] **Step 6: Commit** — `feat(review): xllm-diff.js deterministic diff collector (never-persisted body)`

---

### Task 2: panel — diff context plumbing + `parsePanelRunArgs`

**Files:**
- Modify: `scripts/xllm-panel.js` (imports, `runPanel` signature/body ~line 207–312, md contract line ~471, CLI `run` branch ~565–581, usage text ~583)
- Test: `scripts/test-advisor.mjs` (extend the existing xllm-panel import block ~line 928)

**Interfaces:**
- Consumes: Task 1 (`parseDiffFlags`, `hasDiffSource`, `collectReviewDiff`, `buildReviewContext`, `diffMeta`).
- Produces: `parsePanelRunArgs(argv) → { specs, question, tiebreak, readyProviders, diffOpts } | { error }` (exported; council reuses it in Task 4). `runPanel` gains optional `context` (string appended to the prompt only) and `contextMeta` (persisted as `diff_context`).

- [ ] **Step 1: Write failing test** (add `parsePanelRunArgs` to the existing `./xllm-panel.js` import block):

```js
test('parsePanelRunArgs parses specs/question/flags incl. diff flags anywhere', () => {
  const p = parsePanelRunArgs(['a,b', 'is', 'it', 'safe?', '--tiebreak', '--staged', '--ready=x,y']);
  assert.deepStrictEqual(p.specs, ['a', 'b']);
  assert.strictEqual(p.question, 'is it safe?');
  assert.strictEqual(p.tiebreak, true);
  assert.deepStrictEqual(p.readyProviders, ['x', 'y']);
  assert.strictEqual(p.diffOpts.staged, true);
  assert.ok(parsePanelRunArgs(['a,b', 'q', '--staged', '--base', 'main']).error);
});
```

- [ ] **Step 2: `npm test`** → FAIL (`parsePanelRunArgs` not exported).

- [ ] **Step 3: Implement in `scripts/xllm-panel.js`:**

Add import at top: `import { parseDiffFlags, hasDiffSource, collectReviewDiff, buildReviewContext, diffMeta } from './xllm-diff.js';`

Add exported parser (above the `runPanel` section):

```js
/** CLI arg parser for `run` — shared with council. Pure. */
export function parsePanelRunArgs(argv) {
  const d = parseDiffFlags(argv);
  if (d.error) return { error: d.error };
  const rest = d.rest;
  const tiebreak = rest.includes('--tiebreak');
  const readyArg = rest.find((a) => a.startsWith('--ready='));
  const readyProviders = readyArg
    ? readyArg.slice('--ready='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;
  const positional = rest.filter((a) => a !== '--tiebreak' && !a.startsWith('--ready='));
  const specs = (positional[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const question = positional.slice(1).join(' ').trim();
  return { specs, question, tiebreak, readyProviders, diffOpts: d.diffOpts };
}
```

`runPanel` changes (context never persisted, meta always persisted):
- Signature: `export async function runPanel({ specs, question, root = process.cwd(), tiebreak = false, readyProviders = null, context = null, contextMeta = null })`.
- Prompt: `const prompt = buildPanelPrompt(context ? `${question}\n${context}` : question);`
- Ledger record: after `question: redactSecrets(question),` add `...(contextMeta ? { diff_context: contextMeta } : {}),`
- md index: after the `- Question:` line add `...(contextMeta ? [`- Code context: ${contextMeta.source} (${contextMeta.bytes} bytes${contextMeta.truncated ? ', truncated' : ''}) — diff body not persisted`] : []),`
- md synthesis-contract line: change `xllm panel outcome ${id}` → `xllm review outcome ${id}`.

CLI `run` branch — replace the inline parsing with:

```js
  if (cmd === 'run') {
    const p = parsePanelRunArgs(argv.slice(1));
    if (p.error || p.specs.length < 2 || !p.question) {
      if (p.error) console.error(`[panel] ${p.error}`);
      console.error('Usage: xllm-panel run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>]');
      process.exit(1);
    }
    let context = null;
    let contextMeta = null;
    if (hasDiffSource(p.diffOpts)) {
      const diff = collectReviewDiff(p.diffOpts);
      if (diff.error) {
        console.error(`[panel] ${diff.error}`);
        process.exit(1);
      }
      context = buildReviewContext(diff);
      contextMeta = diffMeta(diff);
      console.error(`[panel] code context: ${contextMeta.source} (${contextMeta.bytes} bytes${contextMeta.truncated ? ', truncated' : ''})`);
    }
    const r = await runPanel({ specs: p.specs, question: p.question, tiebreak: p.tiebreak, readyProviders: p.readyProviders, context, contextMeta });
    process.exit(r.exitCode);
  }
```

Update the bottom usage text to include the diff flags line.

- [ ] **Step 4: `sed -i 's/\r$//' scripts/xllm-panel.js` then `npm run ci`** — expect green.

- [ ] **Step 5: Commit** — `feat(review): panel accepts --staged/--base/--diff-file; diff meta in ledger, body never persisted`

---

### Task 3: debate — diff context plumbing + `parseDebateRunArgs`

**Files:**
- Modify: `scripts/xllm-debate.js` (imports, `runDebate` ~282, `runDebateOnClaims` ~324, ledger record ~374–390, CLI main ~446, usage)
- Test: `scripts/test-advisor.mjs` (extend the existing `./xllm-debate.js` import block ~line 1216)

**Interfaces:**
- Produces: `parseDebateRunArgs(argv) → { specs, question, diffOpts } | { error }`. `runDebate`/`runDebateOnClaims` gain `context`/`contextMeta` (council passes them in Task 4). Debate ledger record gains `diff_context` when meta present.

- [ ] **Step 1: Write failing test:**

```js
test('parseDebateRunArgs extracts specs/question and diff flags', () => {
  const p = parseDebateRunArgs(['a,b', 'this', 'claim', '--base', 'v0.25.0']);
  assert.deepStrictEqual(p.specs, ['a', 'b']);
  assert.strictEqual(p.question, 'this claim');
  assert.strictEqual(p.diffOpts.base, 'v0.25.0');
  assert.ok(parseDebateRunArgs(['a,b', 'q', '--staged', '--diff-file', 'x']).error);
});
```

- [ ] **Step 2: `npm test`** → FAIL.

- [ ] **Step 3: Implement:**

Import from `./xllm-diff.js` (same five names as panel). Add:

```js
/** CLI arg parser for `run`. Pure. */
export function parseDebateRunArgs(argv) {
  const d = parseDiffFlags(argv);
  if (d.error) return { error: d.error };
  const specs = (d.rest[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const question = d.rest.slice(1).join(' ').trim();
  return { specs, question, diffOpts: d.diffOpts };
}
```

- `runDebate({ specs, question, root, context = null, contextMeta = null })`: compute `const promptQuestion = context ? `${question}\n${context}` : question;`; use `promptQuestion` in `buildClaimsPrompt(...)`; pass `context, contextMeta` through to `runDebateOnClaims`.
- `runDebateOnClaims({ question, parsed, capped, root, panelRunId = null, r0Adherence = [], context = null, contextMeta = null })`: use `promptQuestion` (same composition) in `buildRefutePrompt(...)`; ledger record: after `question: redactSecrets(question),` add `...(contextMeta ? { diff_context: contextMeta } : {}),`; md index: add the same `- Code context:` line as panel after `- Question:`.
- CLI `run` branch: use `parseDebateRunArgs` + the same collect/error/stderr pattern as panel Step 3 (message prefix `[debate]`), then `runDebate({ specs, question, context, contextMeta })`. Update both usage strings with the diff-flags line.

- [ ] **Step 4: `sed -i 's/\r$//' scripts/xllm-debate.js` then `npm run ci`** — green.

- [ ] **Step 5: Commit** — `feat(review): debate accepts diff input; context flows into claims+refute prompts`

---

### Task 4: council — diff context plumbing (reuses panel's parser)

**Files:**
- Modify: `scripts/xllm-council.js` (imports, `runCouncil` ~82, CLI main ~197, usage)

**Interfaces:**
- Consumes: `parsePanelRunArgs` (Task 2 — council's flags are a superset-identical shape), diff helpers (Task 1), `runDebateOnClaims` context params (Task 3).
- Produces: `runCouncil` gains `context`/`contextMeta`, forwarded to BOTH phases.

- [ ] **Step 1: Implement** (no new pure function — covered by Task 2/3 tests):
  - Import `parsePanelRunArgs` from `./xllm-panel.js` and the diff helpers from `./xllm-diff.js`.
  - `runCouncil({ specs, question, root, tiebreak, readyProviders, context = null, contextMeta = null })`: pass `context, contextMeta` into `runPanel(...)` and into `runDebateOnClaims(...)`.
  - CLI main: replace inline parsing with `parsePanelRunArgs(argv.slice(1))` + the same collect/error pattern (`[council]` prefix); pass context/meta. Council md: add the `- Code context:` line after `- Question:`.
  - Usage strings gain the diff-flags line.

- [ ] **Step 2: `sed -i 's/\r$//' scripts/xllm-council.js` then `npm run ci`** — green (council main was previously duplicating panel's parsing; behavior must be identical for existing flags).

- [ ] **Step 3: Commit** — `feat(review): council forwards diff context through both phases`

---

### Task 5: advisor `--multi` (roles) — diff flags, argv-safe children, `measurement: false`

**Files:**
- Modify: `scripts/xllm-advisor.js` (imports; `writeMultiIndex` ~1280; parseArgs `--multi` branch ~2455; multi run path ~2618)
- Test: `scripts/test-advisor.mjs` (extend the existing `writeMultiIndex` usage)

**Interfaces:**
- Consumes: Task 1 helpers. Note: `xllm-advisor.js` may import `xllm-diff.js` (standalone) but must NEVER import `xllm-scribe.js`/`xllm-structured.js` (cycle).
- Produces: `writeMultiIndex({ prompt, results, propose, root, diffContext = null })` — JSON gains `measurement: false` (always) and `diff_context` (when given); md gains a Measurement line.

- [ ] **Step 1: Write failing test** — locate the existing `writeMultiIndex` test (search `writeMultiIndex` in test-advisor.mjs); extend or add beside it:

```js
test('writeMultiIndex marks roles output non-measured and records diff meta only', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-multi-'));
  process.env.XLLM_STATE_DIR = tmp;
  try {
    const r = writeMultiIndex({
      prompt: 'q',
      results: [{ spec: 'a', code: 0, artifact: null }, { spec: 'b', code: 0, artifact: null }],
      diffContext: { source: 'staged', stat: '1 file', bytes: 10, truncated: false },
    });
    const j = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
    assert.strictEqual(j.measurement, false);
    assert.strictEqual(j.diff_context.source, 'staged');
    assert.strictEqual('body' in j.diff_context, false);
    const md = fs.readFileSync(r.mdPath, 'utf8');
    assert.ok(/Measurement: none/.test(md));
  } finally {
    delete process.env.XLLM_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

(If `writeMultiIndex` resolves its dir via `ensureArtifactDirs(root)` and ignores `XLLM_STATE_DIR`, follow whatever isolation the existing writeMultiIndex test uses — mirror it exactly.)

- [ ] **Step 2: `npm test`** → FAIL (`measurement` undefined).

- [ ] **Step 3: Implement:**

`writeMultiIndex` — add param `diffContext = null`; in the JSON object after `propose,` add:

```js
        // Epistemology firewall (umbrella-5): roles/multi output is coverage,
        // not measurement — no ledger, no pairwise agreement. Only `review
        // blind` / council phase-1 produce measured agreement.
        measurement: false,
        ...(diffContext ? { diff_context: diffContext } : {}),
```

md — after the `- Failures:` line add:

```js
      `- Measurement: none — coverage mode; the consensus labels below are the host's synthesis, not measured agreement (use \`review blind\` for measured agreement)`,
      ...(diffContext ? [`- Code context: ${diffContext.source} (${diffContext.bytes} bytes${diffContext.truncated ? ', truncated' : ''}) — diff body not persisted`] : []),
```

parseArgs `--multi` branch — parse diff flags out of the prompt words:

```js
  if (args[0] === '--multi') {
    const dr = parseDiffFlags(args.slice(2));
    if (dr.error) {
      console.error(`[multi] ${dr.error}`);
      process.exit(1);
    }
    const list = (args[1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const prompt = filePrompt ?? dr.rest.join(' ').trim();
    if (list.length < 2 || !prompt) {
      console.error('--multi requires at least two providers and a prompt');
      usage();
    }
    const providers = list.map((s) => {
      const p = parseProviderSpec(s);
      if (!p) {
        console.error(`Unknown provider: ${s}`);
        process.exit(1);
      }
      return p;
    });
    return { mode: 'multi', providers, prompt, diffOpts: dr.diffOpts, flags };
  }
```

Multi run path — before `runOne` is defined:

```js
    let diffContext = null;
    let fullPrompt = parsed.prompt;
    if (hasDiffSource(parsed.diffOpts)) {
      const diff = collectReviewDiff(parsed.diffOpts);
      if (diff.error) {
        console.error(`[multi] ${diff.error}`);
        process.exit(1);
      }
      fullPrompt = `${parsed.prompt}\n${buildReviewContext(diff)}`;
      diffContext = diffMeta(diff);
      console.error(`[multi] code context: ${diffContext.source} (${diffContext.bytes} bytes${diffContext.truncated ? ', truncated' : ''})`);
    }
    // Windows argv cap: a diff-laden prompt goes to children via a temp
    // --prompt-file instead of argv (same 24KB threshold as the structured layer).
    let tmpPromptFile = null;
    let childPromptArgs = [fullPrompt];
    if (fullPrompt.length > 24 * 1024) {
      try {
        tmpPromptFile = path.join(
          os.tmpdir(),
          `xllm-multi-prompt-${process.pid}-${Date.now().toString(36)}.txt`
        );
        fs.writeFileSync(tmpPromptFile, fullPrompt, 'utf8');
        childPromptArgs = ['--prompt-file', tmpPromptFile];
      } catch {
        tmpPromptFile = null; // best-effort: fall back to argv
      }
    }
```

In `runOne`, replace `[self, ...childFlags, p.spec, parsed.prompt]` with `[self, ...childFlags, p.spec, ...childPromptArgs]`. After `const raw = await Promise.all(...)` add:

```js
    if (tmpPromptFile) {
      try {
        fs.unlinkSync(tmpPromptFile);
      } catch {
        /* best-effort */
      }
    }
```

Pass `diffContext` into `writeMultiIndex({ prompt: parsed.prompt, results, propose: parsed.flags.propose, diffContext })`. Verify `os` is already imported in xllm-advisor.js (it is used for `os.homedir()`; if not, add `import os from 'os';`). Import the diff helpers at top: `import { parseDiffFlags, hasDiffSource, collectReviewDiff, buildReviewContext, diffMeta } from './xllm-diff.js';`

- [ ] **Step 4: `sed -i 's/\r$//' scripts/xllm-advisor.js` then `npm run ci`** — green.

- [ ] **Step 5: Commit** — `feat(review): advisor --multi takes diff input; index JSON carries measurement:false firewall`

---

### Task 6: `scripts/xllm-review.js` dispatcher + `xllm.mjs` wiring + alias deprecation notes

**Files:**
- Create: `scripts/xllm-review.js`
- Modify: `scripts/xllm.mjs` (help text, `review` case, alias stderr notes), `package.json` (`check` chain)
- Test: `scripts/test-advisor.mjs`

**Interfaces:**
- Produces: `resolveReviewTarget(argv) → { script: 'advisor'|'panel'|'debate'|'council', args: string[] } | { error?: string|null }` (pure), `REVIEW_USAGE` string.

- [ ] **Step 1: Write failing tests:**

```js
import { resolveReviewTarget } from './xllm-review.js';

test('resolveReviewTarget maps modes onto existing scripts', () => {
  assert.deepStrictEqual(resolveReviewTarget(['blind', 'a,b', 'q', '--staged']), {
    script: 'panel',
    args: ['run', 'a,b', 'q', '--staged'],
  });
  assert.deepStrictEqual(resolveReviewTarget(['roles', 'a,b', 'q']), {
    script: 'advisor',
    args: ['--multi', 'a,b', 'q'],
  });
  assert.strictEqual(resolveReviewTarget(['debate', 'a,b', 'q']).script, 'debate');
  assert.strictEqual(resolveReviewTarget(['council', 'a,b', 'q']).script, 'council');
  assert.deepStrictEqual(resolveReviewTarget(['stats', '--json']), {
    script: 'panel',
    args: ['stats', '--json'],
  });
  assert.strictEqual(resolveReviewTarget(['outcome', 'id1', '--adopted', 'none', '--helpful', 'yes']).script, 'panel');
});

test('resolveReviewTarget errors on unknown mode, usage on none', () => {
  assert.ok(resolveReviewTarget(['bogus']).error);
  assert.strictEqual(resolveReviewTarget([]).error, null);
  assert.strictEqual(resolveReviewTarget([]).script, undefined);
  assert.ok(resolveReviewTarget(['roles', 'a,b']).error); // roles needs a prompt
});
```

- [ ] **Step 2: `npm test`** → FAIL.

- [ ] **Step 3: Create `scripts/xllm-review.js`:**

```js
#!/usr/bin/env node
/**
 * xllm review — one entry point for the deliberation family (umbrella-5).
 *
 *   roles   → advisor --multi  (coverage; synthesis labels, NOT measured)
 *   blind   → panel run        (measured: identical prompt, ledger, agreement)
 *   debate  → debate run       (adversarial refutation)
 *   council → council run      (blind → debate pipeline)
 *   stats   → panel stats      · outcome → panel outcome
 *
 * Old top-level nouns (multi/panel/debate/council) stay CLI aliases through
 * v0.27.x. Epistemology firewall: only blind/council write the ledger and
 * speak measured agreement; roles output carries measurement: false.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REVIEW_USAGE = `xllm review — cross-vendor deliberation (one noun, four modes)
Usage:
  xllm review roles   p1,p2[,p3] "<prompt>"
  xllm review blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
  xllm review debate  p1,p2[,p3] "<claim>"
  xllm review council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
  xllm review stats [--json]
  xllm review outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no

Diff input (any deliberation mode; collected deterministically, never persisted):
  --staged | --base <ref> | --diff-file <path>

roles = coverage (synthesis labels, NOT measured) · blind = measured panel
(ledger + pairwise agreement) · debate = adversarial refutation · council =
blind→debate. Old nouns multi/panel/debate/council remain aliases through v0.27.x.`;

const MODE_TARGETS = {
  roles: { script: 'advisor', prefix: ['--multi'] },
  blind: { script: 'panel', prefix: ['run'] },
  debate: { script: 'debate', prefix: ['run'] },
  council: { script: 'council', prefix: ['run'] },
  stats: { script: 'panel', prefix: ['stats'] },
  outcome: { script: 'panel', prefix: ['outcome'] },
};

/** Map review argv → target script + args. Pure. */
export function resolveReviewTarget(argv) {
  const [mode, ...rest] = argv;
  const target = MODE_TARGETS[mode];
  if (!target) return { error: mode ? `unknown review mode: ${mode}` : null };
  if (mode === 'roles' && rest.length < 2) {
    return { error: 'roles needs a provider list and a prompt' };
  }
  return { script: target.script, args: [...target.prefix, ...rest] };
}

const SCRIPT_FILES = {
  advisor: 'xllm-advisor.js',
  panel: 'xllm-panel.js',
  debate: 'xllm-debate.js',
  council: 'xllm-council.js',
};

function main() {
  const target = resolveReviewTarget(process.argv.slice(2));
  if (!target.script) {
    if (target.error) console.error(`[review] ${target.error}`);
    console.error(REVIEW_USAGE);
    process.exit(target.error ? 1 : 0);
  }
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, SCRIPT_FILES[target.script]), ...target.args],
    { shell: false, cwd: process.cwd(), stdio: 'inherit', windowsHide: true }
  );
  process.exit(res.status ?? 1);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-review.js');
  }
}

if (isMain()) main();
```

- [ ] **Step 4: Wire `scripts/xllm.mjs`:**
  - Add `const review = path.join(__dirname, 'xllm-review.js');` beside the other script consts.
  - Add case before `panel`:

```js
  case 'review':
    run(review, rest);
    break;
```

  - Alias deprecation notes (stderr only — stdout stays machine-clean); replace the four existing cases:

```js
  case 'multi':
    if (rest.length < 2) {
      console.error('Usage: xllm multi p1,p2 <prompt>');
      process.exit(1);
    }
    console.error("[xllm] note: 'multi' is now 'review roles' (alias through v0.27.x)");
    run(advisor, ['--multi', ...rest]);
    break;
```

```js
  case 'panel':
    console.error("[xllm] note: 'panel' is now 'review blind|stats|outcome' (alias through v0.27.x)");
    run(panel, rest);
    break;
  case 'debate':
    console.error("[xllm] note: 'debate' is now 'review debate' (alias through v0.27.x)");
    run(debate, rest);
    break;
  case 'council':
    console.error("[xllm] note: 'council' is now 'review council' (alias through v0.27.x)");
    run(council, rest);
    break;
```

  - `help()`: replace the `multi`/`panel`/`debate`/`council`/`traits` block with:

```text
  review roles p1,p2 <prompt>    Parallel advisors + host synthesis (coverage — NOT measured)
  review blind p1,p2 <q>         BLIND measured panel → ledger + agreement [--tiebreak] [--ready=]
  review debate p1,p2 <q>        ADVERSARIAL refutation → survived/killed/unresolved
  review council p1,p2 <q>       blind → debate pipeline (highest stakes)
  review stats [--json]          Pairwise agreement matrix (measured decorrelation)
  review outcome <id> …          Record what the host adopted
    diff input for any mode: --staged | --base <ref> | --diff-file <path>
    (old nouns multi/panel/debate/council remain aliases through v0.27.x)
  traits [--json]        Evidence-based provider trait profiles (measured, gated, never lore)
```

  Also update the two `Examples:` lines that use `multi` → `review roles` / add `node scripts/xllm.mjs review blind codex,grok,gemini "이 캐시 설계가 안전한가?" --staged`.
  - `package.json` `check`: add `node --check scripts/xllm-review.js && ` next to the xllm-diff entry.

- [ ] **Step 5: `sed -i 's/\r$//' scripts/xllm-review.js scripts/xllm.mjs` then `npm run ci`; manual smoke: `node scripts/xllm.mjs review` prints usage (exit 0), `node scripts/xllm.mjs review stats` runs, `node scripts/xllm.mjs panel stats` still works + prints the alias note on stderr.**

- [ ] **Step 6: Commit** — `feat(review): review dispatcher (roles|blind|debate|council|stats|outcome) + alias deprecation notes`

---

### Task 7: discipline block v2 (command-rename propagation)

**Files:**
- Modify: `scripts/xllm-advisor.js` (~line 1401–1418)
- Test: `scripts/test-advisor.mjs` (existing discipline tests)

- [ ] **Step 1: Write/adjust failing test** — find existing discipline tests (search `disciplineBlock` in test-advisor.mjs). Add:

```js
test('discipline block v2 speaks review nouns', () => {
  const b = disciplineBlock();
  assert.ok(b.includes('xllm:discipline v2'));
  assert.ok(b.includes('review blind'));
  assert.ok(b.includes('review stats'));
  assert.ok(!/`xllm panel`/.test(b));
});
```

Fix any existing assertions that pin `v1`.

- [ ] **Step 2: `npm test`** → FAIL.

- [ ] **Step 3: Implement** — `DISCIPLINE_VERSION = 'v2'` and body lines 5–7 become:

```js
  '- 틀리면 비싼 결정만 크로스-벤더 심의로: `xllm review blind`(측정) · `review debate`(반박) · `review council`(둘 다).',
  '  review stats의 쌍별 일치율이 낮은 곳이 다양성이 배당을 내는 곳이다.',
  '- 리뷰 코멘트가 미심쩍으면 수용 전에 다른 벤더로 반박 검증(`xllm ask`/`review debate`).',
```

(`findDisciplineSpan` matches any version, so `discipline install` upgrades v1 blocks in place — note this in the CHANGELOG task.)

- [ ] **Step 4: `npm run ci`** — green. Commit — `feat(review): discipline block v2 — review-family nouns (v1 upgrades in place on reinstall)`

---

### Task 8: skills collapse 7→5 + check-plugin guards

**Files:**
- Create: `skills/review/SKILL.md` (≤80 lines)
- Delete: `skills/multi/`, `skills/debate/`, `skills/council/` (git rm -r)
- Modify: `.claude-plugin/plugin.json` (skills array → 5), `scripts/check-plugin.mjs`, `skills/setup/SKILL.md` (line ~8 "ask or multi skills" → "ask or review skills")

- [ ] **Step 1: Create `skills/review/SKILL.md`** (verbatim; 66 lines — check-plugin requires `CLAUDE_PLUGIN_ROOT`, `/read-only/i`, `/plugin.root|plugin-root/i`):

```markdown
---
name: review
description: >
  Cross-vendor deliberation over a question or a code diff, four modes in one
  noun: roles (parallel advisors + host synthesis), blind (measured
  independent panel), debate (adversarial refutation), council (blind→debate
  pipeline). Use for "get multiple opinions", cross-vendor design or security
  review, "review this diff/branch with other vendors", or when a decision is
  consequential and claims need stress-testing. Advisors run read-only by
  default; nothing is auto-applied.
---

# review — cross-vendor deliberation (xllm)

One entry point, four modes. Your host CLI synthesizes; external CLIs advise.

## Resolve the script

Claude Code: `"${CLAUDE_PLUGIN_ROOT}/scripts/xllm-review.js"`.
Other hosts: `<plugin-root>/scripts/xllm-review.js` (two dirs above this SKILL.md).

## Modes

```bash
node <xllm-review.js> roles   p1,p2[,p3] "<prompt>"      # parallel advisors, host synthesis — NOT measured
node <xllm-review.js> blind   p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <xllm-review.js> debate  p1,p2[,p3] "<claim>"       # SURVIVED / KILLED / UNRESOLVED
node <xllm-review.js> council p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
node <xllm-review.js> stats                              # pairwise agreement (measured decorrelation)
node <xllm-review.js> outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no
```

| mode | epistemology | cost | reach for it when |
|---|---|---|---|
| roles | coverage — synthesis labels, **not measured** | 1× | advisors need different prompts |
| blind | measurement — identical blind prompt, append-only ledger | ~1× | you want the measured spread |
| debate | adversarial — decisive falsifiers kill wrong claims | ~2–3× | being wrong is expensive |
| council | independent divergence → hostile convergence | ~3–4× | the highest-stakes calls |

## Reviewing code

Add exactly one diff source to any mode. The diff is collected
deterministically (plain git), size-capped, sent to advisors — and never
persisted (ledger/index record source/stat/bytes only):

```bash
--staged | --base <ref> | --diff-file <path>
```

## Contract

- Advisors are read-only; your own vendor is refused; nothing is auto-applied.
- blind/council write `<state>/panel-ledger.jsonl` BEFORE prose. The ledger is
  truth; your summary is UX; minority reports are findings; failures abstain.
- roles output is never "measured" — its labels are your synthesis, not
  agreement rates. Only blind/council/stats speak measured decorrelation.
- On a blind split the core suggests the measured tiebreaker for free — spend
  it with `--tiebreak`; never hand-pick by vendor pedigree.
- Afterwards record adoption: `outcome <run-id> …` — it feeds measured routing.
- SURVIVED = withstood refutation, not proven. Re-verify consequential claims.

## When NOT to use

Quick opinion → `ask`. Cheap git prose → `scribe`. Host-native agents already
cover same-model parallelism; reach here only when cross-vendor disagreement
(or a local-model perspective) is the point.
```

- [ ] **Step 2: Collapse** — `git rm -r skills/multi skills/debate skills/council`; edit `.claude-plugin/plugin.json` skills array to exactly:

```json
  "skills": [
    "./skills/ask/",
    "./skills/review/",
    "./skills/exec/",
    "./skills/scribe/",
    "./skills/setup/"
  ]
```

Edit `skills/setup/SKILL.md` line ~8: "when the ask or multi skills cannot find providers" → "when the ask or review skills cannot find providers".

- [ ] **Step 3: check-plugin guards** (`scripts/check-plugin.mjs`):
  - Codex shared-skill list (line ~141): `['ask', 'multi', 'setup']` → `['ask', 'review', 'setup']`.
  - After that block add:

```js
// umbrella-5: collapsed skills must not resurface; review skill stays ≤80 lines
for (const gone of ['multi', 'debate', 'council']) {
  ok(!fs.existsSync(path.join(root, 'skills', gone)), `collapsed skill dir absent (skills/${gone})`);
}
{
  const reviewLines = fs
    .readFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), 'utf8')
    .split('\n').length;
  ok(reviewLines <= 80, `review skill ≤ 80 lines (${reviewLines})`);
}
```

- [ ] **Step 4: `npm run ci`** — green (check-plugin validates the new manifest paths). Also run `claude plugin validate --strict .` if available locally.

- [ ] **Step 5: Commit** — `feat(review): collapse skills 7→5 (ask/review/exec/scribe/setup) + check-plugin guards`

---

### Task 9: Grok adapter — `/xllm` mode recipes (keep 3 skills)

**Files:**
- Modify: `.grok/skills/xllm/SKILL.md` (lines ~49–57, ~76, ~108: `--multi` recipes), possibly `.grok/skills/xllm-setup/SKILL.md` (grep first)

- [ ] **Step 1:** `grep -n "multi\|panel\|debate\|council" .grok/skills/*/SKILL.md` — update every command example to review-family forms (`node scripts/xllm.mjs review roles|blind|debate|council …`), and add a short "Deliberation modes" recipe section to `.grok/skills/xllm/SKILL.md` mirroring the mode table from `skills/review/SKILL.md` (map, don't mirror — recipes only, no 4th skill). Mention diff flags in one line. Keep `--multi` mentioned once as the underlying advisor flag (it still exists), but lead with `review roles`.

- [ ] **Step 2: `npm run ci`** — check-plugin's `.grok` skill assertions still pass. Commit — `docs(grok): /xllm gains review-family mode recipes`

---

### Task 10: docs sweep — README, docs/, examples, Pages, CHANGELOG, design-doc status

**Files:**
- Modify: `README.md`, `docs/getting-started.md`, `docs/architecture.md`, `docs/local-llms.md`, `examples/minimal-xllm.md` (grep hits only), `docs/index.html`, `CHANGELOG.md`, `docs/superpowers-absorption-design.md` (status line)

- [ ] **Step 1: README** —
  - 스킬↔스크립트 표 (~line 116–118): `/xllm:multi`·`/xllm:debate`·`/xllm:council` 행을 `/xllm:review` 한 행으로 통합 (`scripts/xllm-review.js` — roles/blind/debate/council 모드), 스킬 수 7→5 언급 갱신.
  - 명령 레퍼런스: `### 의견 — ask · multi` → ask만 남기고, `### 심의 — panel · debate · council` → `### 심의 — review (roles·blind·debate·council)`로 재작성: 새 usage 블록 + diff 입력 플래그 + "구 명칭은 v0.27.x까지 alias" 한 줄 + roles는 비측정(coverage)이라는 firewall 문장. 예시 명령 갱신 (`review blind codex,grok,gemini "…" --tiebreak`, `review debate ollama:llama3.2,ollama:gemma4 "…" --staged`).
  - 기능 표(~58–62): 명칭 갱신(개념 이름 panel/debate/council은 유지하되 명령 표기는 `review blind` 등).
  - "consensus-measured"라는 표현이 roles/multi 출력 설명에 없는지 grep으로 확인.
- [ ] **Step 2: docs/*.md + examples** — `grep -rn "xllm.mjs multi\|panel run\|debate run\|council run\|xllm multi\|xllm panel\|xllm debate\|xllm council" docs/*.md examples/ README.md` → 명령 예시를 review 형태로 갱신 (역사 기록물 `benchmarks/FINDINGS.md`, `docs/*-design.md`, `docs/diversity-roadmap.md`, `CHANGELOG.md`는 손대지 않음).
- [ ] **Step 3: docs/index.html (Pages)** — 기능 카드의 명령 표기를 review 형태로 갱신; 스킬 수/명령 수 문구 grep(`grep -n "7\|스킬\|multi\|panel\|debate\|council" docs/index.html` 후 해당 부분만); HTML 태그 균형 확인 one-liner (`div/section/table` open=close).
- [ ] **Step 4: CHANGELOG.md** — v0.26.0 엔트리 (Added: review 디스패처+diff 입력+measurement firewall+discipline v2, Changed: 스킬 7→5·구 명칭 alias 유예 v0.27.x·discipline 재설치 시 v1→v2 자동 교체, Removed: 없음 — alias 유지).
- [ ] **Step 5: design doc** — `docs/superpowers-absorption-design.md` 상단 Status 라인: "converged, not yet implemented" → "converged; umbrella-5 implemented in v0.26.0 (전체판, user-ratified 2026-07-18)".
- [ ] **Step 6: `npm run ci`** — check-plugin's residue guard scans shipped docs. Commit — `docs: README/docs/Pages를 review 패밀리로 정렬; CHANGELOG v0.26.0`

---

### Task 11: live e2e (transport rule: 프로토콜/전송 변경은 라이브 검증 후 출하)

Local models only (free). Prereq: `ollama serve` healthy (`ollama list`).

- [ ] **Step 1: blind + --staged** — create a scratch change and stage it (e.g. add a comment line to `examples/minimal-xllm.md`), then:
  `node scripts/xllm.mjs review blind ollama:llama3.2,ollama:gemma4 "이 스테이징된 변경은 안전한가?" --staged`
  Verify: stderr shows `code context: staged (N bytes)`; both panelists answer ABOUT the diff (read the artifacts); last ledger record has `diff_context.source === 'staged'`, `question` WITHOUT the diff body; md index has the Code context line. Unstage/revert the scratch change afterwards.
- [ ] **Step 2: roles + measurement flag** — `node scripts/xllm.mjs review roles ollama:llama3.2,ollama:gemma4 "한 문장으로: 이 diff의 위험은?" --diff-file <small .patch fixture>` → index `.json` has `measurement: false` + `diff_context`, no diff body.
- [ ] **Step 3: alias window** — `node scripts/xllm.mjs panel stats` prints the stats AND the stderr alias note; stdout unchanged (machine-clean).
- [ ] **Step 4: debate smoke** — `node scripts/xllm.mjs review debate ollama:llama3.2,ollama:gemma4 "<small claim about the staged diff>" --diff-file <same fixture>` completes and ledger debate record carries `diff_context`.
- [ ] If any step fails twice on BOTH models at the same stage — suspect the shared transport layer, not the models (프로젝트 함정 노트).

---

### Task 12: release v0.26.0

- [ ] **Step 1: version bump (7곳)** — `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (2 fields), `.codex-plugin/plugin.json`, `scripts/xllm-advisor.js` `VERSION` → `0.26.0`; README 테스트 배지/카운트와 `docs/index.html` 테스트 수치를 실측값으로 (`npm test` 출력의 passed 수).
- [ ] **Step 2: `npm run ci`** — green; `git status` clean except intended changes.
- [ ] **Step 3: commit** — `release: v0.26.0 — review umbrella (roles|blind|debate|council), diff input, skills 7→5`.
- [ ] **Step 4: tag + push** — `git tag -a v0.26.0 -m "v0.26.0 — review umbrella"` (bash가 fork 오류를 내면 PowerShell로 태그); push는 bash 도구로 `git push xllm work:master && git push xllm v0.26.0` (origin 금지 — legacy repo).
- [ ] **Step 5: GitHub Release** — CHANGELOG 발췌를 scratchpad notes 파일로 → `gh release create v0.26.0 -F <notes> -t "xllm v0.26.0 — review umbrella"`.
- [ ] **Step 6: 메모리 갱신** — auto-memory의 CURRENT STATE를 v0.26.0로, open item (a) umbrella-5를 DONE으로.
