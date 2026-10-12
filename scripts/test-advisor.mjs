#!/usr/bin/env node
/**
 * Unit tests for xllm-advisor pure helpers (no live LLM required).
 */

import assert from 'assert';
import {
  getSupportedProviders,
  getProviderMeta,
  parseProviderSpec,
  runAdvisor,
  resolveModelAlias,
  resolveAliasTable,
  agyEffortFromEffort,
  stalePinHint,
  MODEL_LIST_COMMANDS,
  resolveSpawnConfig,
  slugify,
  writeArtifact,
  cleanModelText,
  extractSummary,
  resolveAdvisorScriptPath,
  resolveBinaryPath,
  resolveSpawnTarget,
  rememberAdvisorPath,
  parseSimpleToml,
  loadProviderProfiles,
  pickDefaultXllmPair,
  resolvePreferredProvider,
  isEffortToken,
  resolveStateDir,
  mutationAllowed,
  buildAdvisorEnv,
  detectHostCli,
  redactSecrets,
  cleanArtifacts,
  HOST_SESSION_ENV_VARS,
  getProviderCostMeta,
  upsertTomlKey,
  setProfileValue,
  deleteTomlKey,
  deleteProfileKey,
  buildInventory,
  buildProposalPrompt,
  extractProposalPatch,
  writeMultiIndex,
  ollamaBaseUrl,
  ollamaThinkFromEffort,
  validateSetupPin,
  applySetupPlan,
} from './xllm-advisor.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
process.chdir(root);
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-unit-'));
const suiteProfile = path.join(suiteHome, 'providers.toml');
fs.writeFileSync(suiteProfile, '[defaults]\nexecution_policy = "any"\n');
process.env.XLLM_HOME = suiteHome;
process.env.XLLM_PROVIDERS_PATH = suiteProfile;
process.env.OLLAMA_HOST = 'http://localhost:11434';
process.on('exit', () => fs.rmSync(suiteHome, { recursive: true, force: true }));

// Stubbed advisor calls must behave the same inside Codex/Claude/Grok and in CI.
// Host detection itself is tested below with explicit environment fixtures.
for (const key of HOST_SESSION_ENV_VARS) delete process.env[key];

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    failed += 1;
  }
}

console.log('test-advisor');



test('parseProviderSpec ollama:model', () => {
  const s = parseProviderSpec('ollama:llama3.2');
  assert.strictEqual(s.provider, 'ollama');
  assert.strictEqual(s.model, 'llama3.2');
});

test('parseProviderSpec keeps model tags with colons', () => {
  const s = parseProviderSpec('ollama:qwen3.6:latest');
  assert.strictEqual(s.provider, 'ollama');
  assert.strictEqual(s.model, 'qwen3.6:latest');
});

test('parseProviderSpec effort forms', () => {
  const a = parseProviderSpec('codex@high');
  assert.strictEqual(a.provider, 'codex');
  assert.strictEqual(a.model, null);
  assert.strictEqual(a.effort, 'high');
  assert.ok(a.spec.includes('@high'));

  const b = parseProviderSpec('claude:opus@medium');
  assert.strictEqual(b.provider, 'claude');
  assert.strictEqual(b.model, 'opus');
  assert.strictEqual(b.effort, 'medium');

  const c = parseProviderSpec('ollama:qwen3.6:latest@low');
  assert.strictEqual(c.provider, 'ollama');
  assert.strictEqual(c.model, 'qwen3.6:latest');
  assert.strictEqual(c.effort, 'low');
});

test('parseProviderSpec rejects unknown', () => {
  assert.strictEqual(parseProviderSpec('notreal'), null);
});

test('isEffortToken', () => {
  assert.ok(isEffortToken('high'));
  assert.ok(isEffortToken('xhigh'));
  assert.ok(!isEffortToken(''));
});

test('slugify truncates and sanitizes', () => {
  assert.strictEqual(slugify('Hello World!!'), 'hello-world');
  assert.ok(slugify('a'.repeat(100)).length <= 60);
});


test('resolveSpawnConfig lemonade without LEMONADE_BIN is unavailable', () => {
  const env = { ...process.env };
  delete env.LEMONADE_BIN;
  const c = resolveSpawnConfig('lemonade', null, 'hi', env, {});
  assert.ok(c.unavailable);
});


// ---------------------------------------------------------------------------
// runAdvisor orchestration (spawn injected — no live calls)
//
// Every defect found on 2026-08-02 lived here rather than in the pure helpers:
// the alias notice never fired, --multi swallowed the correction, and the
// documented timeout env var was unreachable. All three passed the unit suite
// because nothing exercised runAdvisor. These tests close that gap.
// ---------------------------------------------------------------------------

/** Run fn while capturing console.error output. */
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: fn(), stderr: lines.join(String.fromCharCode(10)) };
  } finally {
    console.error = orig;
  }
}

/** A spawnFn stub that records its call and returns a clean success. */
function recordingSpawn(calls, out = '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}') {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    return { status: 0, stdout: out, stderr: "", error: null };
  };
}


test('runAdvisor carries XLLM_ADVISOR_TIMEOUT_MS all the way to the spawn call', () => {
  // resolveSpawnConfig is unit-tested for precedence, but the value still has to
  // survive into spawnFn options — that gap is what killed codex@high at 300s
  // while the env var claimed 900s.
  const calls = [];
  const prev = process.env.XLLM_ADVISOR_TIMEOUT_MS;
  process.env.XLLM_ADVISOR_TIMEOUT_MS = "777000";
  try {
    loadProviderProfiles({ force: true });
    runAdvisor({
      provider: "codex",
      prompt: "hi",
      noArtifacts: true,
      quiet: true,
      spawnFn: recordingSpawn(calls),
      isBinaryAvailable: () => true,
    isBinaryAvailable: () => true,
    });
    assert.strictEqual(calls[0].opts.timeout, 777000);
  } finally {
    if (prev === undefined) delete process.env.XLLM_ADVISOR_TIMEOUT_MS;
    else process.env.XLLM_ADVISOR_TIMEOUT_MS = prev;
    loadProviderProfiles({ force: true });
  }
});

test('runAdvisor keeps advisors read-only unless mutation is opted into', () => {
  // The safety default the product rests on, asserted at the argv that actually
  // reaches the process rather than at the config layer.
  const calls = [];
  runAdvisor({
    provider: "codex",
    prompt: "hi",
    noArtifacts: true,
    quiet: true,
    spawnFn: recordingSpawn(calls),
    isBinaryAvailable: () => true,
  });
  const args = calls[0].args.join(" ");
  assert.ok(args.includes("--sandbox read-only"), args);
  assert.ok(!args.includes("bypass-approvals"), args);
});

test('runAdvisor returns attribution separating what was asked from what ran', () => {
  // The measured router keys off the executed identity. Recording the request
  // as if it were the executor splits one agy run across two keys and makes the
  // router decide on halves — the defect this release closes.
  const calls = [];
  const r = runAdvisor({
    provider: "codex",
    model: "gpt-5.6-sol",
    prompt: "hi",
    noArtifacts: true,
    quiet: true,
    modelAliased: { from: "gpt-5.6", to: "gpt-5.6-sol", source: "builtin" },
    spawnFn: (c, a, o) => { calls.push({ c, a, o }); return { status: 0, stdout: "OK", stderr: "" }; },
    isBinaryAvailable: () => true,
  });
  assert.strictEqual(r.attribution.requested_provider, "codex");
  assert.strictEqual(r.attribution.requested_model, "gpt-5.6");
  assert.strictEqual(r.attribution.executed_provider, "codex");
  assert.strictEqual(r.attribution.transmitted_model, "gpt-5.6-sol");
  assert.strictEqual(r.attribution.model_correction_source, "builtin");
});

test('runAdvisor attribution records a provider substitution as executed', () => {
  // gemini requested, agy on PATH: the run belongs to antigravity, and the
  // request survives only as audit metadata.
  const calls = [];
  const r = runAdvisor({
    provider: "gemini",
    prompt: "hi",
    noArtifacts: true,
    quiet: true,
    spawnFn: (c, a, o) => { calls.push({ c, a, o }); return { status: 0, stdout: "OK", stderr: "" }; },
    isBinaryAvailable: () => true,
  });
  assert.strictEqual(r.attribution.requested_provider, "gemini");
  if (r.attribution.executed_provider !== "gemini") {
    assert.strictEqual(r.attribution.executed_provider, "antigravity");
    assert.strictEqual(r.attribution.substituted_from, "gemini");
  }
});

test('writeMultiIndex labels Providers with what ran, not what was asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xllm-attr-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const idx = writeMultiIndex({
      prompt: "q",
      results: [
        { spec: "gemini:m@high", requestedSpec: "gemini:m@high", executedSpec: "antigravity:m@high", code: 0 },
        { spec: "codex", requestedSpec: "codex", executedSpec: "codex", code: 0 },
      ],
    });
    const md = fs.readFileSync(idx.mdPath || idx.path || idx, "utf8");
    assert.ok(md.includes("- Providers: antigravity:m@high, codex"), md.slice(0, 400));
    assert.ok(md.includes("Requested providers: gemini:m@high"), md.slice(0, 400));
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeArtifact records requested → transmitted model and who corrected it', () => {
  // Design F7: a corrected name must not erase what the user asked for. Before
  // this, the artifact showed only the corrected model and the stderr notice
  // was ephemeral, so evidence attributed the run to a model never chosen.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-f7-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const p = writeArtifact({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      original: 'task',
      finalPrompt: 'task',
      raw: 'done',
      exitCode: 0,
      meta: { modelAliased: { from: 'gpt-5.6', to: 'gpt-5.6-sol', source: 'builtin' } },
    });
    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /- Requested model: gpt-5\.6$/m);
    assert.match(text, /- Transmitted model: gpt-5\.6-sol$/m);
    assert.match(text, /- Model correction source: builtin$/m);

    // No correction → none of the three lines appear (no noise on the common case).
    const clean = writeArtifact({
      provider: 'codex',
      model: 'gpt-5.5',
      original: 'task2',
      finalPrompt: 'task2',
      raw: 'done',
      exitCode: 0,
      meta: {},
    });
    const cleanText = fs.readFileSync(clean, 'utf8');
    assert.ok(!/Requested model/.test(cleanText));
    assert.ok(!/Model correction source/.test(cleanText));
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSimpleToml reads quoted keys (model ids contain dots)', () => {
  const t = parseSimpleToml(`
[aliases.codex]
"gpt-5.6" = "gpt-5.6-terra"
'gpt-5.4' = "gpt-5.5"
bare_key = "still works"
`);
  assert.strictEqual(t.aliases.codex['gpt-5.6'], 'gpt-5.6-terra');
  assert.strictEqual(t.aliases.codex['gpt-5.4'], 'gpt-5.5');
  assert.strictEqual(t.aliases.codex.bare_key, 'still works');
});

test('resolveAliasTable: TOML [aliases] overrides and disables the built-in seed', () => {
  const profiles = {
    providers: {},
    aliases: {
      codex: { 'gpt-5.6': 'gpt-5.6-terra' },
      grok: { 'grok-4': '' },
    },
  };
  // Retarget: user picks terra where the seed says sol.
  const retargeted = resolveModelAlias('codex', 'gpt-5.6', profiles);
  assert.strictEqual(retargeted.model, 'gpt-5.6-terra');
  assert.strictEqual(retargeted.aliased.source, 'toml');

  // Disable: empty value means "leave this name alone", so nothing is rewritten.
  const disabled = resolveModelAlias('grok', 'grok-4', profiles);
  assert.strictEqual(disabled.model, 'grok-4');
  assert.strictEqual(disabled.aliased, null);

  // Untouched seed entries still apply and are labelled as built-in.
  const seeded = resolveModelAlias('grok', 'grok-4-latest', profiles);
  assert.strictEqual(seeded.model, 'grok-4.6');
  assert.strictEqual(seeded.aliased.source, 'builtin');

  // Provenance follows who owns the key, not whether the value matches the
  // seed: a user who pins the same mapping still decided it, and the notice
  // must point at their file rather than blaming xllm's built-in table.
  const sameValue = {
    providers: {},
    aliases: { grok: { 'grok-4': 'grok-4.6' } },
  };
  assert.strictEqual(resolveModelAlias('grok', 'grok-4', sameValue).aliased.source, 'toml');

  // A provider with no seed and no TOML entry passes through untouched.
  assert.strictEqual(resolveModelAlias('claude', 'opus', profiles).model, 'opus');

  // Lookup is case-insensitive on the requested name.
  assert.strictEqual(resolveModelAlias('codex', 'GPT-5.6', profiles).model, 'gpt-5.6-terra');

  // With no TOML aliases at all the seed is the whole table.
  const bare = { providers: {} };
  assert.strictEqual(resolveModelAlias('codex', 'gpt-5.6', bare).model, 'gpt-5.6-sol');
  assert.strictEqual(resolveAliasTable('grok', bare)['grok-4'], 'grok-4.6');
});

test('parseProviderSpec honours TOML aliases over the built-in seed', () => {
  const profiles = {
    providers: {},
    aliases: { codex: { 'gpt-5.6': 'gpt-5.6-luna' } },
  };
  const s = parseProviderSpec('codex:gpt-5.6@high', profiles);
  assert.strictEqual(s.model, 'gpt-5.6-luna');
  assert.strictEqual(s.spec, 'codex:gpt-5.6-luna@high');
  assert.strictEqual(s.modelAliased.source, 'toml');
});

test('classifyFailure separates account-unsupported from unknown-model', () => {
  // Verbatim stderr captured from the live CLIs on 2026-08-02. Before this
  // split both collapsed to `permanent`, so a fixable model-name mistake was
  // indistinguishable from a real hard failure.
  const codexAccount = classifyFailure({
    status: 1,
    stderr:
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported when using Codex with a ChatGPT account."}}',
  });
  assert.strictEqual(codexAccount.kind, 'account-unsupported');
  assert.strictEqual(codexAccount.retryable, false);

  const grokUnknown = classifyFailure({
    status: 1,
    stderr: 'Couldn\'t set model \'grok-4\': Invalid params: "unknown model id". Run \'grok models\' to see available models.',
  });
  assert.strictEqual(grokUnknown.kind, 'unknown-model');
  assert.strictEqual(grokUnknown.retryable, false);

  // The account message also contains "model … is not supported"; if the
  // unknown-model test ran first it would swallow this case. Guard the order.
  assert.notStrictEqual(codexAccount.kind, 'unknown-model');

  // Neither may fire on success, and the existing taxonomy must be untouched.
  assert.strictEqual(classifyFailure({ status: 0, stderr: 'unknown model id' }).kind, 'ok');
  assert.strictEqual(classifyFailure({ status: 1, stderr: '429 rate limit' }).kind, 'transient');
  assert.strictEqual(classifyFailure({ status: 1, stderr: '401 unauthorized' }).kind, 'auth');
  assert.strictEqual(classifyFailure({ status: 1, stderr: 'segfault' }).kind, 'permanent');
});


test('XLLM_ADVISOR_TIMEOUT_MS outranks the per-provider profile timeout', () => {
  // Regression: the env var only set defaults.timeout_ms, but every built-in
  // provider pins its own timeout_ms and resolveSpawnConfig read pconf first,
  // so the documented override was unreachable. Measured before the fix:
  // XLLM_ADVISOR_TIMEOUT_MS=900000 still produced timeoutMs 300000.
  const env = { ...process.env, XLLM_ADVISOR_TIMEOUT_MS: '900000' };
  for (const p of ['codex', 'grok', 'antigravity', 'claude']) {
    const c = resolveSpawnConfig(p, null, 'hi', env, {});
    assert.strictEqual(c.timeoutMs, 900000, `${p} must honour the env timeout`);
  }
  // An explicit call-site timeout still wins over the env var.
  const explicit = resolveSpawnConfig('codex', null, 'hi', env, { timeoutMs: 1234 });
  assert.strictEqual(explicit.timeoutMs, 1234);
  // Unset/garbage env → fall back to the profile value, not NaN.
  const clean = { ...process.env };
  delete clean.XLLM_ADVISOR_TIMEOUT_MS;
  assert.strictEqual(resolveSpawnConfig('codex', null, 'hi', clean, {}).timeoutMs, 300000);
  const junk = { ...process.env, XLLM_ADVISOR_TIMEOUT_MS: 'abc' };
  assert.strictEqual(resolveSpawnConfig('codex', null, 'hi', junk, {}).timeoutMs, 300000);
});


test('ollamaThinkFromEffort maps effort to the API think parameter', () => {
  // no effort → undefined: the payload stays unchanged, so models that
  // reject `think` never see it unless effort was explicitly requested
  assert.strictEqual(ollamaThinkFromEffort(null, 'qwen3.6:latest'), undefined);
  assert.strictEqual(ollamaThinkFromEffort('', 'qwen3.6:latest'), undefined);
  assert.strictEqual(ollamaThinkFromEffort('low', 'qwen3.6:latest'), false);
  assert.strictEqual(ollamaThinkFromEffort('minimal', 'glm-5.2:cloud'), false);
  assert.strictEqual(ollamaThinkFromEffort('medium', 'qwen3.6:latest'), true);
  assert.strictEqual(ollamaThinkFromEffort('high', 'nemotron-3-super:cloud'), true);
  assert.strictEqual(ollamaThinkFromEffort('xhigh', 'gemma4:cloud'), true);
  // gpt-oss takes graded string levels instead of a boolean
  assert.strictEqual(ollamaThinkFromEffort('low', 'gpt-oss:120b-cloud'), 'low');
  assert.strictEqual(ollamaThinkFromEffort('medium', 'gpt-oss:120b-cloud'), 'medium');
  assert.strictEqual(ollamaThinkFromEffort('high', 'gpt-oss:120b-cloud'), 'high');
  assert.strictEqual(ollamaThinkFromEffort('max', 'gpt-oss:120b-cloud'), 'high');
});


test('ollamaBaseUrl normalizes scheme-less OLLAMA_HOST', () => {
  assert.strictEqual(ollamaBaseUrl({}), 'http://localhost:11434');
  assert.strictEqual(ollamaBaseUrl({ OLLAMA_HOST: '127.0.0.1:11434' }), 'http://127.0.0.1:11434');
  assert.strictEqual(ollamaBaseUrl({ OLLAMA_HOST: 'https://gpu-box:11434/' }), 'https://gpu-box:11434');
});







test('cleanModelText strips spinner CSI sequences (not just colors)', () => {
  const raw =
    '\x1b[?25l\x1b[1G⠙ \x1b[K\x1b[?25h\x1b[?2026lwriting manifest \x1b[Ksuccess\x1b[?2026l\n\nXLLM_SMOKE_OK';
  const cleaned = cleanModelText(raw);
  assert.ok(cleaned.includes('XLLM_SMOKE_OK'));
  assert.ok(!cleaned.includes('[K'));
  assert.ok(!cleaned.includes('[?25'));
  assert.ok(!cleaned.includes('\x1b'));
});

test('cleanOllamaOutput strips thinking blocks', () => {
  const raw = `Thinking...\nsecret chain\n...done thinking.\n\nXLLM_SMOKE_OK\n\n? ? ? `;
  const cleaned = cleanModelText(raw);
  assert.ok(cleaned.includes('XLLM_SMOKE_OK'));
  assert.ok(!/Thinking\.\.\./i.test(cleaned));
});


test('extractSummary prefers final answer', () => {
  const s = extractSummary(
    `Thinking...\nwaffle\n...done thinking.\n\nXLLM_SMOKE_OK`,
    0
  );
  assert.ok(s.includes('XLLM_SMOKE_OK'));
});



test('parseSimpleToml reads providers', () => {
  const t = parseSimpleToml(`
[defaults]
design_provider = "antigravity"
timeout_ms = 123

[providers.codex]
default_effort = "high"
`);
  assert.strictEqual(t.defaults.design_provider, 'antigravity');
  assert.strictEqual(t.defaults.timeout_ms, 123);
  assert.strictEqual(t.providers.codex.default_effort, 'high');
});


test('resolvePreferredProvider substitutes on missing binary, never on platform', () => {
  const has = (installed) => (bin) => installed.includes(bin);

  // Both installed → each name is honoured as typed, on any platform.
  const both = has(['agy', 'gemini']);
  assert.strictEqual(
    resolvePreferredProvider('antigravity', null, { isAvailable: both }).provider,
    'antigravity'
  );
  assert.strictEqual(
    resolvePreferredProvider('gemini', null, { isAvailable: both }).provider,
    'gemini'
  );

  // gemini CLI absent, agy present → gemini work routes to agy. This is the
  // case that was broken through v0.30.0: it substituted the other direction
  // on Windows and landed on a binary that was not installed.
  const agyOnly = resolvePreferredProvider('gemini', null, { isAvailable: has(['agy']) });
  assert.strictEqual(agyOnly.provider, 'antigravity');
  assert.ok(agyOnly.substituted);
  assert.strictEqual(agyOnly.from, 'gemini');

  // agy absent, gemini present → the standalone CLI still carries the lane.
  const geminiOnly = resolvePreferredProvider('antigravity', null, {
    isAvailable: has(['gemini']),
  });
  assert.strictEqual(geminiOnly.provider, 'gemini');
  assert.ok(geminiOnly.substituted);

  // Neither installed → nothing to substitute to; report the name as asked.
  const none = resolvePreferredProvider('antigravity', null, { isAvailable: () => false });
  assert.strictEqual(none.provider, 'antigravity');
  assert.ok(!none.substituted);
});

test('resolveModelAlias corrects retired names, passes unknown ones through', () => {
  // Measured 2026-08-02: bare gpt-5.6 is rejected with HTTP 400 by codex 0.146.0.
  assert.strictEqual(resolveModelAlias('codex', 'gpt-5.6').model, 'gpt-5.6-sol');
  assert.strictEqual(resolveModelAlias('codex', 'gpt-5.6').aliased.from, 'gpt-5.6');
  assert.strictEqual(resolveModelAlias('grok', 'grok-4').model, 'grok-4.6');

  // Shipping names and names xllm has no opinion about are untouched — xllm
  // keeps no roster, so unknown models must pass straight through.
  for (const [p, m] of [
    ['codex', 'gpt-5.6-sol'],
    ['codex', 'gpt-5.5'],
    ['grok', 'grok-4.5'],   // still accepted by the CLI — must pass through
    ['antigravity', 'gemini-3.6-flash-high'],
    ['claude', 'opus'],
    ['codex', 'some-future-model'],
  ]) {
    const r = resolveModelAlias(p, m);
    assert.strictEqual(r.model, m, `${p}:${m} must pass through`);
    assert.strictEqual(r.aliased, null);
  }
  assert.strictEqual(resolveModelAlias('codex', null).model, null);
});

test('parseProviderSpec applies the model alias and labels the corrected name', () => {
  const s = parseProviderSpec('codex:gpt-5.6@high');
  assert.strictEqual(s.model, 'gpt-5.6-sol');
  assert.strictEqual(s.spec, 'codex:gpt-5.6-sol@high');
  assert.strictEqual(s.modelAliased.from, 'gpt-5.6');
  const clean = parseProviderSpec('grok:grok-4.5@low');
  assert.strictEqual(clean.model, 'grok-4.5');
  assert.strictEqual(clean.modelAliased, null);
});

test('resolveAdvisorScriptPath finds scripts in cwd', () => {
  const p = resolveAdvisorScriptPath();
  assert.ok(fs.existsSync(p));
});


// ---------------------------------------------------------------------------
// Safety / namespace helpers
// ---------------------------------------------------------------------------


test('resolveStateDir honors XLLM_STATE_DIR and defaults to .xllm', () => {
  const forced = resolveStateDir(root, { XLLM_STATE_DIR: '.custom-state' });
  assert.ok(forced.endsWith('.custom-state'));
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-state-'));
  try {
    const fresh = resolveStateDir(tmp, {});
    assert.ok(fresh.endsWith('.xllm'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mutationAllowed requires explicit opt-in', () => {
  assert.strictEqual(mutationAllowed({}, {}), false);
  assert.strictEqual(mutationAllowed({ XLLM_ALLOW_MUTATION: '1' }, {}), true);
  assert.strictEqual(mutationAllowed({}, { allowWrite: true }), true);
});

test('buildAdvisorEnv strips host session variables', () => {
  const base = { PATH: 'x' };
  for (const k of HOST_SESSION_ENV_VARS) base[k] = 'leak';
  const env = buildAdvisorEnv('codex', base);
  for (const k of HOST_SESSION_ENV_VARS) {
    assert.strictEqual(env[k], undefined, `${k} must be stripped`);
  }
  assert.strictEqual(env.PATH, 'x');
});

test('detectHostCli identifies claude/codex/grok hosts', () => {
  assert.strictEqual(detectHostCli({ CLAUDECODE: '1' }), 'claude');
  assert.strictEqual(detectHostCli({ CODEX_THREAD_ID: 't' }), 'codex');
  assert.strictEqual(detectHostCli({ GROK_SESSION_ID: 's' }), 'grok');
  assert.strictEqual(detectHostCli({}), null);
});

test('redactSecrets masks well-known token formats', () => {
  const input =
    'key sk-abcdefghijklmnop1234 and ghp_ABCDEFGHIJKLMNOPQRSTuvwx and AKIAABCDEFGHIJKLMNOP end';
  const out = redactSecrets(input);
  assert.ok(!out.includes('sk-abcdefghijklmnop1234'));
  assert.ok(!out.includes('ghp_ABCDEFGHIJKLMNOPQRSTuvwx'));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.endsWith('end'));
});

test('writeArtifact redacts secrets before persisting', () => {
  const file = writeArtifact({
    provider: 'test',
    model: 'unit',
    effort: null,
    original: 'leak check',
    finalPrompt: 'use ghp_ABCDEFGHIJKLMNOPQRSTuvwx please',
    raw: 'token was sk-abcdefghijklmnop1234',
    exitCode: 0,
  });
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(!body.includes('ghp_ABCDEFGHIJKLMNOPQRSTuvwx'));
  assert.ok(!body.includes('sk-abcdefghijklmnop1234'));
  fs.unlinkSync(file);
});

test('cleanArtifacts removes artifact files but keeps placeholders', () => {
  // Isolate via XLLM_STATE_DIR: this test used to call cleanArtifacts against
  // the REAL repo state dir, wiping the user's live advisor artifacts on
  // every `npm test` run (observed 2026-07-12 — it destroyed diagnostic
  // artifacts mid-investigation). Tests must never touch real state.
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-artifacts-'));
  process.env.XLLM_STATE_DIR = tmp;
  try {
    const file = writeArtifact({
      provider: 'test',
      model: 'clean',
      effort: null,
      original: 'cleanup target',
      finalPrompt: 'cleanup target',
      raw: 'output',
      exitCode: 0,
    });
    assert.ok(file.startsWith(tmp)); // proves the isolation actually took effect
    assert.ok(fs.existsSync(file));
    const removed = cleanArtifacts(root);
    assert.ok(removed >= 1);
    assert.ok(!fs.existsSync(file));
    const askDir = path.dirname(file);
    assert.ok(fs.existsSync(askDir));
  } finally {
    delete process.env.XLLM_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cost metadata / profile writer / inventory (improvement 1)
// ---------------------------------------------------------------------------


test('upsertTomlKey appends section, replaces key, preserves comments', () => {
  const t0 = '# my comment\n[defaults]\ntimeout_ms = 5\n';
  const t1 = upsertTomlKey(t0, 'roles', 'analysis', 'codex@high');
  assert.ok(t1.includes('[roles]'));
  assert.ok(t1.includes('analysis = "codex@high"'));
  assert.ok(t1.includes('# my comment'));
  assert.ok(t1.includes('timeout_ms = 5'));
  const t2 = upsertTomlKey(t1, 'roles', 'analysis', 'gemini@low');
  assert.ok(t2.includes('analysis = "gemini@low"'));
  assert.ok(!t2.includes('codex@high'));
  const t3 = upsertTomlKey(t2, 'roles', 'design', 'grok');
  assert.ok(t3.includes('analysis = "gemini@low"'));
  assert.ok(t3.includes('design = "grok"'));
  // still exactly one [roles] header
  assert.strictEqual(t3.split('[roles]').length, 2);
});

test('setProfileValue creates template and round-trips through parser', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-profile-'));
  try {
    const file = setProfileValue('roles', 'critic', 'ollama:llama3.2@low', tmp);
    assert.ok(file.includes('.xllm'));
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes('critic = "ollama:llama3.2@low"'));
    const parsed = parseSimpleToml(body);
    assert.strictEqual(parsed.roles.critic, 'ollama:llama3.2@low');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    loadProviderProfiles({ force: true });
  }
});

test('deleteTomlKey removes only the target key in the section', () => {
  const src = '[roles]\nanalysis = "codex@high"\ncritic = "ollama:llama3.2@low"\n';
  const out = deleteTomlKey(src, 'roles', 'analysis');
  assert.ok(!/analysis\s*=/.test(out), 'analysis removed');
  assert.ok(/critic\s*=\s*"ollama:llama3.2@low"/.test(out), 'critic kept');
});

test('deleteTomlKey is a no-op when key or section absent', () => {
  const src = '[roles]\ncritic = "ollama@low"\n';
  assert.strictEqual(deleteTomlKey(src, 'roles', 'analysis'), src);
  assert.strictEqual(deleteTomlKey(src, 'defaults', 'critic'), src);
});

test('deleteProfileKey removes a pin and round-trips through the parser', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-del-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp);
    setProfileValue('roles', 'critic', 'ollama:llama3.2@low', tmp);
    deleteProfileKey('roles', 'analysis', tmp);
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/^analysis\s*=/m.test(body), 'analysis pin gone');
    assert.ok(/^critic\s*=/m.test(body), 'critic pin kept');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Multi index + consensus contract (improvement 2)
// ---------------------------------------------------------------------------

test('writeMultiIndex writes md with synthesis contract and json sidecar', () => {
  const idx = writeMultiIndex({
    prompt: 'unit test consensus',
    results: [
      { spec: 'codex@high', code: 0, artifact: 'a.md', patch: null },
      { spec: 'gemini', code: 1, artifact: null, patch: null },
    ],
    root,
  });
  try {
    const md = fs.readFileSync(idx.mdPath, 'utf8');
    assert.ok(md.includes('Synthesis contract'));
    assert.ok(md.includes('unanimous'));
    assert.ok(md.includes('single-source'));
    assert.ok(md.includes('confidence metadata, not truth'));
    const json = JSON.parse(fs.readFileSync(idx.jsonPath, 'utf8'));
    assert.strictEqual(json.failures, 1);
    assert.strictEqual(json.results.length, 2);
    assert.ok(json.consensus_labels.includes('majority'));
    assert.strictEqual(idx.failed, 1);
  } finally {
    fs.unlinkSync(idx.mdPath);
    fs.unlinkSync(idx.jsonPath);
  }
});

test('writeMultiIndex marks roles output non-measured and records diff meta only', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-multi-'));
  try {
    const r = writeMultiIndex({
      prompt: 'q',
      results: [
        { spec: 'a', code: 0, artifact: null },
        { spec: 'b', code: 0, artifact: null },
      ],
      diffContext: { source: 'staged', stat: '1 file', bytes: 10, truncated: false },
      root: tmp,
    });
    const j = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
    assert.strictEqual(j.measurement, false);
    assert.strictEqual(j.diff_context.source, 'staged');
    assert.strictEqual('body' in j.diff_context, false);
    const md = fs.readFileSync(r.mdPath, 'utf8');
    assert.ok(/Measurement: none/.test(md));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Proposal mode (improvement 3)
// ---------------------------------------------------------------------------


test('extractProposalPatch pulls diff block, null when absent', () => {
  const raw =
    'Rationale here.\n\n```diff\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n```\n';
  const patch = extractProposalPatch(raw);
  assert.ok(patch.startsWith('--- a/x.js'));
  assert.ok(patch.endsWith('\n'));
  assert.strictEqual(extractProposalPatch('no diff here'), null);
});

// ---------------------------------------------------------------------------
// Exec primitive (isolated executor)
// ---------------------------------------------------------------------------

import {
  EXEC_CAPABLE,
  execCapableProviders,
  resolveExecPlan,
  buildExecInstructions,
  execRootDir,
  readRegistry,
  writeRegistry,
  cleanupRun,
} from './xllm-exec.js';


test('resolveExecPlan refuses unsandboxed and same-provider', () => {
  const g = resolveExecPlan('gemini', { env: {} });
  assert.ok(g.error && /refused for exec/.test(g.error));
  const self = resolveExecPlan('codex', { env: { CODEX_THREAD_ID: 't' } });
  assert.ok(self.error && /same-provider/.test(self.error));
  const ok = resolveExecPlan('codex@high', { env: {} });
  assert.ok(!ok.error);
  assert.strictEqual(ok.parsed.provider, 'codex');
  const override = resolveExecPlan('codex', {
    env: { CODEX_THREAD_ID: 't' },
    allowSelf: true,
  });
  assert.ok(!override.error);
});


test('exec registry roundtrip and cleanup', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-exec-'));
  const oldExecRoot = process.env.XLLM_EXEC_ROOT;
  process.env.XLLM_EXEC_ROOT = tmp;
  try {
    const fakeClone = path.join(tmp, 'clone');
    fs.mkdirSync(fakeClone, { recursive: true });
    const reg = readRegistry(tmp);
    reg.runs['t1'] = { id: 't1', clone: fakeClone, status: 'green' };
    writeRegistry(reg, tmp);
    assert.ok(fs.existsSync(path.join(tmp, '.xllm', 'exec-registry.json')));
    const r = cleanupRun('t1', { root: tmp, force: true });
    assert.strictEqual(r.removed, true);
    assert.ok(!fs.existsSync(fakeClone));
    assert.strictEqual(Object.keys(readRegistry(tmp).runs).length, 0);
    assert.strictEqual(cleanupRun('nope', { root: tmp }).removed, false);
  } finally {
    if (oldExecRoot === undefined) delete process.env.XLLM_EXEC_ROOT;
    else process.env.XLLM_EXEC_ROOT = oldExecRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('execRootDir honors XLLM_EXEC_ROOT', () => {
  assert.strictEqual(execRootDir({ XLLM_EXEC_ROOT: 'X:/er' }), 'X:/er');
  assert.ok(execRootDir({}).includes('xllm-exec'));
});

// ---------------------------------------------------------------------------
// Contract floor (failure taxonomy, retry, capability probes)
// ---------------------------------------------------------------------------

import { classifyFailure, withRetry } from './xllm-advisor.js';
import {
  PROVIDER_CONTRACTS,
  probeProviderContract,
  helpHasToken,
} from './xllm-contracts.js';

test('classifyFailure: taxonomy over fixture results', () => {
  assert.strictEqual(classifyFailure({ status: 0 }).kind, 'ok');
  assert.strictEqual(
    classifyFailure({ error: { code: 'ENOENT', message: 'spawn x ENOENT' } }).kind,
    'missing-binary'
  );
  assert.strictEqual(classifyFailure({ status: 1, signal: 'SIGKILL' }).kind, 'timeout');
  const auth = classifyFailure({ status: 1, stderr: 'Error: 401 Unauthorized — please log in' });
  assert.strictEqual(auth.kind, 'auth');
  assert.strictEqual(auth.retryable, false);
  const transient = classifyFailure({ status: 1, stderr: 'HTTP 429 rate limit exceeded, try again' });
  assert.strictEqual(transient.kind, 'transient');
  assert.strictEqual(transient.retryable, true);
  assert.strictEqual(classifyFailure({ status: 2, stderr: 'syntax error' }).kind, 'permanent');
});

test('withRetry: retries transient only, bounded, no sleep in tests', () => {
  let calls = 0;
  const transientThenOk = () => {
    calls += 1;
    return calls === 1 ? { status: 1, stderr: 'rate limit' } : { status: 0, stdout: 'fine' };
  };
  const r = withRetry(transientThenOk, { maxAttempts: 2, sleep: () => {} });
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(r.failure.kind, 'ok');

  calls = 0;
  const alwaysAuth = () => {
    calls += 1;
    return { status: 1, stderr: 'invalid api key' };
  };
  const a = withRetry(alwaysAuth, { maxAttempts: 3, sleep: () => {} });
  assert.strictEqual(calls, 1); // auth is not retryable
  assert.strictEqual(a.failure.kind, 'auth');

  calls = 0;
  const alwaysTransient = () => {
    calls += 1;
    return { status: 1, stderr: '503 overloaded' };
  };
  const t = withRetry(alwaysTransient, { maxAttempts: 2, sleep: () => {} });
  assert.strictEqual(calls, 2); // bounded
  assert.strictEqual(t.failure.kind, 'transient');
});


test('contract tokens reject renamed flags and substrings, including ANSI-colored help', () => {
  assert.ok(helpHasToken('-m, --model <MODEL>\n--effort=high', '--model'));
  assert.ok(helpHasToken('\u001b[32m--model\u001b[0m', '--model'));
  assert.ok(!helpHasToken('--model-picker --models --default-model', '--model'));
  assert.ok(!helpHasToken('--print --permission-mode', '-p'));
  assert.ok(!helpHasToken('runner listing', 'run'));
});

test('contract probes fail on unsuccessful version/help even when output contains every flag', () => {
  const help = '-p --model --permission-mode --effort';
  for (const failureAt of ['--version', '--help']) {
    for (const failedStatus of [2, null]) {
      const result = probeProviderContract('claude', {}, {
        run: (_binary, args) => ({
          status: args[0] === failureAt ? failedStatus : 0,
          stdout: args[0] === '--help' ? help : '2.1.269',
          stderr: '',
        }),
      });
      assert.strictEqual(result.ok, false);
      assert.notStrictEqual(result.failure.kind, 'ok');
    }
  }
});


// ---------------------------------------------------------------------------
// Capability floor + measured tiebreaker + benchmark grader
// ---------------------------------------------------------------------------

import {
  modelCapability,
  passesCapabilityFloor,
  suggestTiebreaker,
  JUDGMENT_ROLES,
} from './xllm-routing.js';
import {
  gradeAnswer,
  errorCorrelation,
  loadTasks,
  resolveTasksFile,
  providerSurface,
} from './xllm-bench.js';

test('modelCapability parses size class and kind from model names', () => {
  assert.strictEqual(modelCapability('ollama:llama3.2').size_class, 'unknown'); // no B tag
  assert.strictEqual(modelCapability('ollama:qwen2.5-coder:7b').size_class, 'small');
  assert.strictEqual(modelCapability('ollama:qwen2.5-coder:7b').kind, 'code');
  assert.strictEqual(modelCapability('ollama:phi:3b').size_class, 'tiny');
  assert.strictEqual(modelCapability('ollama:llama3:70b').size_class, 'large');
  assert.strictEqual(modelCapability('codex').size_class, 'unknown'); // cloud, no signal
});

test('capability floor blocks tiny locals on judgment roles only', () => {
  assert.ok(JUDGMENT_ROLES.includes('security'));
  const blocked = passesCapabilityFloor('security', 'ollama:phi:3b', { tier: 'local' });
  assert.strictEqual(blocked.ok, false);
  const docsOk = passesCapabilityFloor('docs', 'ollama:phi:3b', { tier: 'local' });
  assert.strictEqual(docsOk.ok, true); // non-judgment role
  const cloudOk = passesCapabilityFloor('security', 'codex', { tier: 'strong' });
  assert.strictEqual(cloudOk.ok, true); // non-local
  const override = passesCapabilityFloor('security', 'ollama:phi:3b', { tier: 'local', allowBelowFloor: true });
  assert.strictEqual(override.ok, true);
});




test('bench --tasks-file resolves named sets; hard set regexes valid', () => {
  const easy = resolveTasksFile(null);
  assert.ok(easy.endsWith('tasks.json'));
  const hard = resolveTasksFile('hard-tasks');
  assert.ok(hard.endsWith('hard-tasks.json'));
  const spec = loadTasks(hard); // also validates every regex compiles
  assert.ok(spec.tasks.length >= 6);
  assert.throws(() => resolveTasksFile('does-not-exist'));
  // hard grader still deterministic
  const h2 = spec.tasks.find((t) => t.id === 'h2-retry-jitter');
  const g = gradeAnswer(h2, 'it swallows the last error and returns undefined; also no jitter causes thundering herd');
  assert.ok(g.hits.includes('swallow-last-error'));
  assert.ok(g.hits.includes('no-jitter'));
});

test('bench errorCorrelation flags shared blind spots', () => {
  const a = { 'x:1': true, 'x:2': false, 'x:3': false };
  const b = { 'x:1': true, 'x:2': false, 'x:3': true };
  const c = errorCorrelation(a, b);
  assert.strictEqual(c.cells, 3);
  assert.strictEqual(c.shared_blind_spots, 1); // both miss x:2
  assert.ok(c.agreement_rate > 0.6 && c.agreement_rate < 0.7);
});

test('bench errorCorrelation intersects keys — a crashed provider has no cells', () => {
  // A provider that errored produces no cells; correlation must be over the
  // intersection only, never inventing "both missed" from absent data.
  const worked = { 'x:1': true, 'x:2': false };
  const crashed = {}; // errored — contributed nothing
  assert.strictEqual(errorCorrelation(worked, crashed), null);
});

test('providerSurface splits harness vs raw-model measurement', () => {
  assert.strictEqual(providerSurface('ollama:gemma4:cloud'), 'http-completion');
  assert.strictEqual(providerSurface('lmstudio:phi3'), 'http-completion');
  assert.strictEqual(providerSurface('grok@high'), 'cli-agentic');
  assert.strictEqual(providerSurface('codex'), 'cli-agentic');
  assert.strictEqual(providerSurface('lemonade'), 'binary-stub');
});







// ---------------------------------------------------------------------------
// Panel (blind same-prompt + ledger)
// ---------------------------------------------------------------------------

import {
  buildPanelPrompt,
  extractPanelVerdict,
  computePairwise,
  consensusLabel,
  tiebreakPairwise,
  appendLedger,
  readLedger,
  ledgerStats,
  ledgerPath,
  parsePanelRunArgs,
} from './xllm-panel.js';

test('parsePanelRunArgs parses specs/question/flags incl. diff flags anywhere', () => {
  const p = parsePanelRunArgs(['a,b', 'is', 'it', 'safe?', '--tiebreak', '--staged', '--ready=x,y']);
  assert.deepStrictEqual(p.specs, ['a', 'b']);
  assert.strictEqual(p.question, 'is it safe?');
  assert.strictEqual(p.tiebreak, true);
  assert.deepStrictEqual(p.readyProviders, ['x', 'y']);
  assert.strictEqual(p.diffOpts.staged, true);
  assert.ok(parsePanelRunArgs(['a,b', 'q', '--staged', '--base', 'main']).error);
});


test('extractPanelVerdict: valid, clamped, invalid, missing', () => {
  const ok = extractPanelVerdict(
    'answer text\n```json\n{"verdict":"reject","confidence":0.9,"key_claims":["a","b"]}\n```\n'
  );
  assert.strictEqual(ok.verdict, 'reject');
  assert.strictEqual(ok.confidence, 0.9);
  assert.deepStrictEqual(ok.key_claims, ['a', 'b']);
  const clamped = extractPanelVerdict('```json\n{"verdict":"approve","confidence":7}\n```');
  assert.strictEqual(clamped.confidence, 1);
  assert.strictEqual(extractPanelVerdict('no block here'), null);
  assert.strictEqual(extractPanelVerdict('```json\n{"verdict":"maybe"}\n```'), null);
  // last block wins
  const last = extractPanelVerdict(
    '```json\n{"verdict":"approve"}\n```\ntext\n```json\n{"verdict":"mixed","key_claims":[]}\n```'
  );
  assert.strictEqual(last.verdict, 'mixed');
});

test('computePairwise + consensusLabel: abstentions never agree', () => {
  const v = (x) => ({ verdict: x, confidence: 1, key_claims: [] });
  const unanimous = [
    { spec: 'a', verdict: v('reject') },
    { spec: 'b', verdict: v('reject') },
  ];
  assert.strictEqual(consensusLabel(unanimous), 'unanimous');
  assert.strictEqual(computePairwise(unanimous)[0].agree, true);

  const withAbstain = [
    { spec: 'a', verdict: v('reject') },
    { spec: 'b', verdict: null },
  ];
  assert.strictEqual(computePairwise(withAbstain)[0].agree, null);
  assert.strictEqual(consensusLabel(withAbstain), 'single-source');

  const split = [
    { spec: 'a', verdict: v('approve') },
    { spec: 'b', verdict: v('reject') },
  ];
  assert.strictEqual(consensusLabel(split), 'split');

  const majority = [
    { spec: 'a', verdict: v('approve') },
    { spec: 'b', verdict: v('approve') },
    { spec: 'c', verdict: v('reject') },
  ];
  assert.strictEqual(consensusLabel(majority), 'majority');
  assert.strictEqual(consensusLabel([{ spec: 'a', verdict: null }]), 'no-verdicts');
});

test('ledger: append-only, outcome as separate record, stats matrix', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-panel-'));
  try {
    appendLedger(
      {
        type: 'panel',
        run_id: 'r1',
        pairwise: [
          { a: 'x', b: 'y', agree: true },
          { a: 'x', b: 'z', agree: null },
        ],
      },
      tmp
    );
    appendLedger(
      { type: 'panel', run_id: 'r2', pairwise: [{ a: 'x', b: 'y', agree: false }] },
      tmp
    );
    appendLedger({ type: 'outcome', run_id: 'r1', adopted: 'majority', helpful: true }, tmp);
    const records = readLedger(tmp);
    assert.strictEqual(records.length, 3);
    const stats = ledgerStats(records);
    assert.strictEqual(stats.runs, 2);
    assert.strictEqual(stats.outcomes_recorded, 1);
    assert.deepStrictEqual(stats.matrix, []);
    assert.equal(stats.excluded.legacy_rows, 2); // abstentions are not comparable opportunities
    assert.ok(ledgerPath(tmp).endsWith('panel-ledger.jsonl'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tiebreakPairwise: rows vs each original panelist; abstention → null', () => {
  const v = (x) => ({ verdict: x, confidence: 1, key_claims: [] });
  const panelists = [
    { spec: 'codex', verdict: v('approve') },
    { spec: 'grok', verdict: v('reject') },
    { spec: 'gemini', verdict: null }, // abstained
  ];
  const tb = { spec: 'claude', verdict: v('approve') };
  const rows = tiebreakPairwise(panelists, tb);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].agree, true);
  assert.strictEqual(rows[1].agree, false);
  assert.strictEqual(rows[0].a_evidence, null);
  assert.strictEqual(rows[2].agree, null);
  // a failed tiebreaker abstains everywhere and never shifts the label
  const failed = { spec: 'claude', verdict: null };
  assert.ok(tiebreakPairwise(panelists, failed).every((r) => r.agree === null));
  assert.strictEqual(consensusLabel([panelists[0], panelists[1], failed]), 'split');
});

test('ledgerStats: tiebreak pairwise feeds the matrix without counting as a run', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-tiebreak-'));
  try {
    appendLedger(
      { type: 'panel', run_id: 'p1', pairwise: [{ a: 'codex', b: 'grok', a_evidence: 'codex-v1', b_evidence: 'grok-v1', agree: false }] },
      tmp
    );
    appendLedger(
      { type: 'tiebreak_suggest', run_id: 's1', panel_run_id: 'p1', provider: 'claude', status: 'suggested', requested: true },
      tmp
    );
    appendLedger(
      {
        type: 'tiebreak',
        run_id: 't1',
        panel_run_id: 'p1',
        suggest_run_id: 's1',
        pairwise: [
          { a: 'codex', b: 'claude', a_evidence: 'codex-v1', b_evidence: 'claude-v1', agree: true },
          { a: 'grok', b: 'claude', a_evidence: 'grok-v1', b_evidence: 'claude-v1', agree: false },
        ],
        consensus_before: 'split',
        consensus_after: 'majority',
      },
      tmp
    );
    const stats = ledgerStats(readLedger(tmp));
    assert.strictEqual(stats.runs, 1); // neither suggest nor tiebreak counts as a run
    assert.strictEqual(stats.tiebreaks, 1);
    // tiebreak rows are in the matrix → tomorrow's suggestTiebreaker sees them
    const cc = stats.matrix.find((m) => m.pair === 'claude ↔ codex');
    assert.strictEqual(cc.agreement_rate, 1);
    assert.ok(stats.matrix.find((m) => m.pair === 'claude ↔ grok'));
    // suggest records contribute nothing to the matrix
    assert.strictEqual(stats.matrix.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});



// ---------------------------------------------------------------------------
// Structured-output layer (robust JSON extraction shared by the review family)
// ---------------------------------------------------------------------------

import { extractJson, lastBalanced, adherenceSummary } from './xllm-structured.js';


test('extractJson accepts bounded fallbacks but rejects corrupt string literals', () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  // bare JSON without a fence
  assert.deepStrictEqual(extractJson('here it is: {"a":2} done'), { a: 2 });
  // last valid fenced block wins
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":3}\n```'), { a: 3 });
  // trailing comma repair
  assert.deepStrictEqual(extractJson('```json\n{"a":1,}\n```'), { a: 1 });
  assert.strictEqual(extractJson('```json\n{"v":"reject","c":["a long\nclaim here"]}\n```'), null);
  // no json at all
  assert.strictEqual(extractJson('just prose, no json'), null);
});

test('extractJson: array payloads and unlabeled fences', () => {
  assert.deepStrictEqual(extractJson('```\n[1,2,3]\n```'), [1, 2, 3]);
  assert.deepStrictEqual(extractJson('{"claims":[{"text":"x"}]}').claims[0].text, 'x');
});

test('lastBalanced finds the last balanced object/array', () => {
  assert.strictEqual(lastBalanced('a {1} b {2}'), '{2}');
  assert.strictEqual(lastBalanced('no braces'), null);
});

test('adherenceSummary tallies per-provider first/retry/failed', () => {
  const s = adherenceSummary([
    { spec: 'codex', adherence: 'first' },
    { spec: 'codex', adherence: 'retry' },
    { spec: 'ollama:x', adherence: 'failed' },
  ]);
  assert.strictEqual(s.codex.first, 1);
  assert.strictEqual(s.codex.retry, 1);
  assert.strictEqual(s['ollama:x'].failed, 1);
});

test('extractClaims/extractAttacks return null on non-compliance (drives retry)', () => {
  assert.strictEqual(extractClaims('no json here'), null);
  assert.strictEqual(extractAttacks('no json here'), null);
  // valid-but-empty stays a (possibly empty) array, not null
  assert.deepStrictEqual(extractClaims('```json\n{"claims":[]}\n```'), []);
});

// ---------------------------------------------------------------------------
// Debate (adversarial review) — the mechanical resolution is the crux
// ---------------------------------------------------------------------------

import {
  classifyDebateClaim,
  extractClaims,
  extractAttacks,
  extractDefense,
  buildRefutePrompt,
  buildDefendPrompt,
  foreignClaims,
  claimAuthorKey,
  parseDebateRunArgs,
} from './xllm-debate.js';

const claim = { id: 'C0-1', author: 'claude:opus', authorSpec: 'claude:opus', text: 'X is unsafe' };
const atk = (o = {}) => ({ claim_id: 'C0-1', stance: 'refute', mechanism: 'm', falsifier: 'f', tier: 'soft', attacker: 'grok', ...o });
const completePhases = (attacks) => ({
  r1: [...new Set(attacks.map((a) => a.attacker || a.attackerVendor))].map((attacker) =>
    ({ spec: attacker, attacker, status: 'completed', coverage: 'refuted', failure: null })),
  r2: { spec: claim.authorSpec, status: 'completed', failure: null },
});


test('debate: author concede → KILLED; amend → KILLED with replacement', () => {
  assert.strictEqual(classifyDebateClaim(claim, [atk()], { response: 'concede', rebuttals: [] }, 2, completePhases([atk()])).status, 'KILLED');
  const am = classifyDebateClaim(claim, [atk()], { response: 'amend', amended_claim: 'X unsafe only if unset', rebuttals: [] }, 2, completePhases([atk()]));
  assert.strictEqual(am.status, 'KILLED');
  assert.strictEqual(am.amended, 'X unsafe only if unset');
});

test('debate N=2: decisive falsifier author does NOT defeat → KILLED', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'decisive' })], { response: 'holds', rebuttals: [] }, 2, completePhases([atk({ tier: 'decisive' })]));
  assert.strictEqual(r.status, 'KILLED');
  assert.ok(/decisive/.test(r.reason));
});

test('debate N=2: decisive falsifier the author DOES defeat (holds) → not killed', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'decisive' })], { response: 'holds', rebuttals: [{ attacker: 'grok', result: 'holds', counter: 'c' }] }, 2, completePhases([atk({ tier: 'decisive' })]));
  assert.notStrictEqual(r.status, 'KILLED');
  assert.strictEqual(r.status, 'SURVIVED'); // all standing attacks held
});

test('debate N=2: single SOFT attack + author holds → UNRESOLVED (mere disagreement never kills)', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'soft' })], { response: 'holds', rebuttals: [] }, 2, completePhases([atk({ tier: 'soft' })]));
  assert.strictEqual(r.status, 'UNRESOLVED');
});

test('debate: soft attack alone can never KILL even without defense', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'soft' })], null, 2, completePhases([atk({ tier: 'soft' })]));
  assert.notStrictEqual(r.status, 'KILLED'); // confabulated soft cannot kill
  assert.strictEqual(r.status, 'UNRESOLVED');
});

test('debate N=3: two distinct OPPONENTS (models) refute, author holds neither → KILLED; same model twice does not', () => {
  // v0.18.0: identity is the MODEL — two same-runtime models are two opponents
  const twoModelsSameRuntime = [atk({ attacker: 'ollama:llama3.2' }), atk({ attacker: 'ollama:gemma4' })];
  assert.strictEqual(
    classifyDebateClaim(claim, twoModelsSameRuntime, { response: 'holds', rebuttals: [] }, 3, completePhases(twoModelsSameRuntime)).status,
    'KILLED'
  );
  const sameModelTwice = [atk({ attacker: 'grok' }), atk({ attacker: 'grok' })];
  assert.notStrictEqual(classifyDebateClaim(claim, sameModelTwice, { response: 'holds', rebuttals: [] }, 3, completePhases(sameModelTwice)).status, 'KILLED');
  // legacy pre-v0.18 records carry attackerVendor — still matched for defense
  const legacy = [{ claim_id: 'C0-1', stance: 'refute', mechanism: 'm', falsifier: 'f', tier: 'decisive', attackerVendor: 'grok' }];
  const held = classifyDebateClaim(claim, legacy, { response: 'holds', rebuttals: [{ attacker: 'grok', result: 'holds', counter: 'c' }] }, 2, completePhases(legacy));
  assert.strictEqual(held.status, 'SURVIVED');
});

test('debate: same-runtime models are mutually FOREIGN; same model at different effort is not', () => {
  const capped = [
    { id: 'C0-1', author: 'ollama:llama3.2', authorSpec: 'ollama:llama3.2', text: 'a' },
    { id: 'C1-1', author: 'ollama:gemma4', authorSpec: 'ollama:gemma4', text: 'b' },
    { id: 'C2-1', author: 'grok', authorSpec: 'grok', text: 'c' },
  ];
  // llama may now attack gemma's claim (and grok's) — not its own
  const llamaTargets = foreignClaims(capped, 'ollama:llama3.2').map((c) => c.id);
  assert.deepStrictEqual(llamaTargets, ['C1-1', 'C2-1']);
  // effort is session policy, not identity: grok@high does NOT attack grok's claim
  assert.deepStrictEqual(foreignClaims(capped, 'grok@high').map((c) => c.id), ['C0-1', 'C1-1']);
  // legacy claims without authorSpec fall back to author
  assert.strictEqual(claimAuthorKey({ author: 'ollama:gemma4' }), 'ollama:gemma4');
});

test('debate extractors reject malformed contracts', () => {
  assert.strictEqual(extractClaims('```json\n{"claims":[{"text":"a","evidence":"e"}]}\n```')[0].text, 'a');
  const a = extractAttacks('```json\n{"attacks":[{"claim_id":"C0-1","stance":"refute","mechanism":"m","tier":"decisive"}]}\n```');
  assert.strictEqual(a[0].tier, 'decisive');
  // a refute with empty mechanism is dropped as a freeloader
  assert.strictEqual(extractAttacks('```json\n{"attacks":[{"claim_id":"C0-1","stance":"refute","mechanism":""}]}\n```'), null);
  const d = extractDefense('```json\n{"response":"holds","rebuttals":[{"attacker":"grok","result":"holds"}]}\n```');
  assert.strictEqual(d.response, 'holds');
  assert.strictEqual(extractDefense('no block'), null);
});


test('buildDefendPrompt shows the author the question/diff context (R0/R1 symmetry)', () => {
  const q = 'Is this safe?\n```diff\n+const marker = unsafeParse(input);\n```';
  const dp = buildDefendPrompt({ text: 'x' }, [{ attacker: 'grok', tier: 'soft', mechanism: 'm' }], q);
  assert.ok(dp.includes('+const marker = unsafeParse(input);'), 'diff context missing from defend prompt');
  // without a question the prompt stays claim+attacks only (backward compatible)
  const bare = buildDefendPrompt({ text: 'x' }, [{ attacker: 'grok', tier: 'soft', mechanism: 'm' }]);
  assert.ok(!bare.includes('QUESTION'));
});

test('parseDebateRunArgs extracts specs/question and diff flags', () => {
  const p = parseDebateRunArgs(['a,b', 'this', 'claim', '--base', 'v0.25.0']);
  assert.deepStrictEqual(p.specs, ['a', 'b']);
  assert.strictEqual(p.question, 'this claim');
  assert.strictEqual(p.diffOpts.base, 'v0.25.0');
  assert.ok(parseDebateRunArgs(['a,b', 'q', '--staged', '--diff-file', 'x']).error);
});

// ---------------------------------------------------------------------------
// Council (panel → debate pipeline) — the bridge is the testable crux
// ---------------------------------------------------------------------------

import { claimsFromPanel, appendTiebreakClaims } from './xllm-council.js';

test('council: claimsFromPanel maps panel key_claims → author-attributed claims', () => {
  const parsed = [
    { spec: 'codex@high', provider: 'codex' },
    { spec: 'grok', provider: 'grok' },
  ];
  const panelists = [
    { spec: 'codex@high', verdict: { verdict: 'reject', key_claims: ['A is unsafe', 'B leaks'] } },
    { spec: 'grok', verdict: { verdict: 'reject', key_claims: ['C races'] } },
  ];
  const claims = claimsFromPanel(panelists, parsed);
  assert.strictEqual(claims.length, 3);
  assert.strictEqual(claims[0].id, 'C0-1');
  assert.strictEqual(claims[0].author, 'codex');
  assert.strictEqual(claims[0].text, 'A is unsafe');
  // grok's single claim is attributed to author index 1
  const grokClaim = claims.find((c) => c.author === 'grok');
  assert.strictEqual(grokClaim.id, 'C1-1');
  assert.strictEqual(grokClaim.text, 'C races');
});

test('council: abstained/invalid panelists contribute no claims', () => {
  const parsed = [
    { spec: 'codex', provider: 'codex' },
    { spec: 'grok', provider: 'grok' },
  ];
  const panelists = [
    { spec: 'codex', verdict: { verdict: 'approve', key_claims: ['ok'] } },
    { spec: 'grok', verdict: null }, // abstained
  ];
  const claims = claimsFromPanel(panelists, parsed);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].author, 'codex');
});

test('council: tiebreak claims join as AUTHOR with a new index, never displacing originals', () => {
  const capped = [
    { id: 'C0-1', author: 'codex', authorSpec: 'codex', text: 'a', evidence: '' },
    { id: 'C1-1', author: 'grok', authorSpec: 'grok', text: 'b', evidence: '' },
  ];
  const tb = {
    spec: 'claude:opus',
    provider: 'claude',
    verdict: { verdict: 'reject', key_claims: ['tb claim 1', 'tb claim 2'] },
  };
  const out = appendTiebreakClaims(capped, tb, 2);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[2].id, 'C2-1'); // author index after the originals
  assert.strictEqual(out[2].author, 'claude:opus'); // model-level identity (v0.18.0)
  assert.strictEqual(out[2].authorSpec, 'claude:opus');
  // originals untouched, in place
  assert.strictEqual(out[0].id, 'C0-1');
  assert.strictEqual(out[1].id, 'C1-1');
});

test('council: tiebreak claims fill leftover cap slots only; abstainer adds none', () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `C0-${i + 1}`, author: 'codex', authorSpec: 'codex', text: `t${i}`, evidence: '' }));
  const tb3 = { spec: 'claude', provider: 'claude', verdict: { verdict: 'approve', key_claims: ['x', 'y', 'z'] } };
  // cap already full → unchanged
  assert.strictEqual(appendTiebreakClaims(mk(8), tb3, 1).length, 8);
  // one leftover slot → exactly one tiebreak claim enters
  const out = appendTiebreakClaims(mk(7), tb3, 1);
  assert.strictEqual(out.length, 8);
  assert.strictEqual(out[7].text, 'x');
  assert.strictEqual(out[7].id, 'C1-1');
  // abstained tiebreaker (no verdict) adds nothing
  assert.strictEqual(appendTiebreakClaims(mk(7), { spec: 'claude', provider: 'claude', verdict: null }, 1).length, 7);
});

// ---------------------------------------------------------------------------
// Scribe lane (cheap-prose chores)
// ---------------------------------------------------------------------------

import {
  CONVENTIONAL_TYPES,
  truncateContext,
  collectChoreContext,
  SCRIBE_TEMPLATES,
  stripFences,
  validateScribeOutput,
  pickScribeProvider,
} from './xllm-scribe.js';
import { execSync } from 'child_process';

test('truncateContext caps oversized input with marker', () => {
  const small = truncateContext('abc', 100);
  assert.strictEqual(small.truncated, false);
  const big = truncateContext('x'.repeat(50000), 1000);
  assert.strictEqual(big.truncated, true);
  assert.ok(big.text.includes('TRUNCATED'));
  assert.ok(Buffer.byteLength(big.text) < 5000);
});

test('collectChoreContext: commit needs staged changes; pr/release need range', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-scribe-'));
  try {
    execSync('git init -q -b main', { cwd: tmp });
    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init', { cwd: tmp });
    const none = collectChoreContext('commit', {}, tmp);
    assert.ok(/Nothing staged/.test(none.error));
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello scribe\n');
    execSync('git add -A', { cwd: tmp });
    const ctx = collectChoreContext('commit', {}, tmp);
    assert.ok(!ctx.error);
    assert.ok(ctx.body.includes('hello scribe'));
    assert.ok(ctx.body.includes('Staged diffstat'));
    const rel = collectChoreContext('release', {}, tmp);
    assert.ok(/--from/.test(rel.error));
    const bad = collectChoreContext('nope', {}, tmp);
    assert.ok(bad.error);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('stripFences unwraps fenced output', () => {
  assert.strictEqual(stripFences('```text\nfeat: x\n```'), 'feat: x');
  assert.strictEqual(stripFences('feat: y'), 'feat: y');
});

test('validateScribeOutput enforces conventional commit contract', () => {
  const ok = validateScribeOutput('commit', 'feat(core): add scribe lane\n\n- adds templates');
  assert.strictEqual(ok.ok, true);
  const badType = validateScribeOutput('commit', 'added some stuff');
  assert.strictEqual(badType.ok, false);
  const longSubj = validateScribeOutput('commit', 'feat: ' + 'x'.repeat(80));
  assert.ok(longSubj.problems.some((p) => /72/.test(p)));
  const period = validateScribeOutput('commit', 'fix: something.');
  assert.ok(period.problems.some((p) => /period/.test(p)));
  assert.strictEqual(validateScribeOutput('commit', '').ok, false);
  const prBad = validateScribeOutput('pr', 'title only');
  assert.ok(prBad.problems.some((p) => /Summary/.test(p)));
  assert.ok(CONVENTIONAL_TYPES.includes('feat'));
});



// ---------------------------------------------------------------------------
// Role / intensity routing
// ---------------------------------------------------------------------------

import { inferIntensity, pickAdvisorForRole } from './xllm-routing.js';

test('inferIntensity high on security keywords', () => {
  const r = inferIntensity('Implement secure JWT auth and payment webhook');
  assert.strictEqual(r.intensity, 'high');
});

test('inferIntensity low on typo/docs', () => {
  const r = inferIntensity('Fix typo in README');
  assert.strictEqual(r.intensity, 'low');
});

test('inferIntensity respects explicit', () => {
  const r = inferIntensity('security rewrite', 'low');
  assert.strictEqual(r.intensity, 'low');
  assert.strictEqual(r.source, 'explicit');
});

// Routing tests must not read the developer's own .xllm/xllm-providers.toml:
// a role pin written by `--setup --apply` (or a stale cache from the TOML test
// below) would silently change what these assertions exercise. An empty profile
// yields the pure built-in routing table, which is what they mean to test.
const ROUTING_FIXTURE = { defaults: {}, providers: {}, roles: {}, routing: {} };


test('pickAdvisorForRole explore prefers native', () => {
  const p = pickAdvisorForRole('explore', {
    profiles: ROUTING_FIXTURE,
    taskText: 'map the auth module',
    readyProviders: ['ollama', 'grok'],
  });
  assert.strictEqual(p.role, 'explore');
  assert.ok(p.use_native);
  assert.ok(String(p.spec).startsWith('native:'));
});


// ---------------------------------------------------------------------------
// --- setup packs ---
// ---------------------------------------------------------------------------

import { resolveSetupPlan, SETUP_PACKS, recommendPacks } from './xllm-routing.js';

// Fixture inventories for setup packs
const LOCAL_DETAILS = Object.fromEntries(['qwen3.6:14b', 'llama3.2:3b'].map((name) =>
  [name, { name, digest: `sha256:${name}`, size: 1000000, details: { parameter_size: name.includes('14b') ? '14B' : '3B' } }]));
const INV_RICH = {
  host_cli: 'claude',
  providers: {
    codex:  { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    grok:   { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:6 },
    gemini: { kind:'cloud', installed:true, healthy:true, tier:'balanced', relative_cost:4 },
    claude: { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    ollama: { kind:'local', installed:true, healthy:true, tier:'local',    relative_cost:0,
              models:['qwen3.6:14b','llama3.2:3b'], model_details: LOCAL_DETAILS },
  },
};

test('setup balanced pins only a local critic; analysis/design OPEN; host excluded', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'balanced' });
  assert.strictEqual(plan.roles.analysis, null, 'analysis OPEN');
  assert.strictEqual(plan.roles.design, null, 'design OPEN');
  assert.ok(/^ollama:/.test(plan.roles.critic), 'critic pinned to a local');
  assert.ok(plan.roles.critic.endsWith('@low'), 'critic @low');
  assert.ok(!/claude/.test(JSON.stringify(plan.roles)), 'host vendor never recommended');
});

test('setup skip yields all-OPEN roles', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'skip' });
  assert.deepStrictEqual(plan.roles, { analysis:null, design:null, critic:null });
});


// Fixture: no local models, cloud only
const INV_NOLOCAL = {
  host_cli: 'claude',
  providers: {
    codex:  { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
    gemini: { kind:'cloud', installed:true, healthy:true, tier:'balanced', relative_cost:4 },
    claude: { kind:'cloud', installed:true, healthy:true, tier:'strong',   relative_cost:7 },
  },
};


test('setup frugal never pins a paid critic; prefers local, else OPEN', () => {
  const rich = resolveSetupPlan(INV_RICH, { pack: 'frugal' });
  assert.ok(/^ollama:/.test(rich.roles.critic), 'critic local when present');
  const nolocal = resolveSetupPlan(INV_NOLOCAL, { pack: 'frugal' });
  assert.strictEqual(nolocal.roles.critic, null, 'critic OPEN when no local (never paid)');
  assert.ok(nolocal.warnings.some((w) => /critic/.test(w)));
});

test('setup sensitive=yes forbids paid critic and floors analysis effort', () => {
  const plan = resolveSetupPlan(INV_NOLOCAL, { pack: 'quality', sensitive: 'yes' });
  assert.ok(plan.roles.critic === null || /^ollama:/.test(plan.roles.critic), 'no paid critic pin');
  assert.ok(/@(high|xhigh)$/.test(plan.roles.analysis), 'analysis effort >= high');
});

test('setup sensitive=yes floors a @medium analysis pin up to @high', () => {
  // frugal pins analysis to cheapest strong/balanced cloud @medium; sensitive must bump it
  const plan = resolveSetupPlan(INV_NOLOCAL, { pack: 'frugal', sensitive: 'yes' });
  assert.ok(/@high$/.test(plan.roles.analysis), 'analysis floored to @high');
  assert.strictEqual(plan.roles.critic, null, 'no paid critic under sensitive');
});

test('setup quality with no non-host cloud still labels every role evidence', () => {
  const invHostOnly = { host_cli:'claude', providers:{
    claude:{ kind:'cloud', installed:true, healthy:true, tier:'strong', relative_cost:7 } } };
  const plan = resolveSetupPlan(invHostOnly, { pack: 'quality' });
  for (const r of ['analysis','design','critic']) {
    assert.ok(plan.evidence[r] && plan.evidence[r].routing_mode, `evidence.${r} present`);
  }
});

test('loadProviderProfiles propagates [roles] from TOML (CLI path)', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-roles-'));
  const file = path.join(tmp, 'p.toml');
  try {
    fs.writeFileSync(file, '[roles]\nanalysis = "gemini@low"\n', 'utf8');
    process.env.XLLM_PROVIDERS_PATH = file;
    const prof = loadProviderProfiles({ force: true });
    assert.strictEqual(prof.roles.analysis, 'gemini@low');
    const p = pickAdvisorForRole('analysis', {
      profiles: prof,
      taskText: 'security auth payment rewrite',
      forceCli: true,
      readyProviders: ['gemini', 'codex'],
    });
    assert.strictEqual(p.provider, 'gemini');
    assert.strictEqual(p.effort, 'low');
    assert.strictEqual(p.pinned, true);
  } finally {
    process.env.XLLM_PROVIDERS_PATH = suiteProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
    loadProviderProfiles({ force: true });
  }
});

test('profile [roles] string spec pins provider/model/effort', () => {
  const prof = JSON.parse(JSON.stringify(loadProviderProfiles({ force: true })));
  prof.roles = { analysis: 'gemini@low' };
  const p = pickAdvisorForRole('analysis', {
    profiles: prof,
    taskText: 'security auth payment breach rewrite', // high-intensity signals
    forceCli: true,
    readyProviders: ['gemini', 'codex', 'grok'],
  });
  assert.strictEqual(p.provider, 'gemini');
  assert.strictEqual(p.effort, 'low'); // pinned effort survives intensity bump
  assert.strictEqual(p.pinned, true);
});

test('pick includes cost metadata and low intensity prefers cheap', () => {
  const p = pickAdvisorForRole('docs', {
    profiles: ROUTING_FIXTURE,
    taskText: 'fix typo in README',
    forceCli: true,
    readyProviders: ['ollama', 'grok', 'antigravity'],
  });
  assert.strictEqual(p.provider, 'ollama'); // relative_cost 0 wins on low intensity
  assert.ok(p.cost);
  assert.strictEqual(p.cost.tier, 'local');
  assert.strictEqual(p.pinned, false);
});

// Fixture: two local models
const INV_LOCAL2 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b','llama3.2:3b'], model_details: LOCAL_DETAILS } } };
// Fixture: one local model
const INV_LOCAL1 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b'], model_details: { 'qwen3.6:14b': LOCAL_DETAILS['qwen3.6:14b'] } } } };
// Fixture: no local models (unhealthy)
const INV_LOCAL0 = { host_cli:'claude', providers:{
  ollama:{ kind:'local', installed:true, healthy:false, tier:'local', relative_cost:0, models:[] } } };

test('setup local spreads across models and pins all three', () => {
  const plan = resolveSetupPlan(INV_LOCAL2, { pack: 'local' });
  assert.ok(/^ollama:qwen3.6:14b@medium$/.test(plan.roles.analysis), 'most-capable → analysis');
  assert.ok(/^ollama:/.test(plan.roles.design) && plan.roles.design !== plan.roles.analysis, 'design a different local');
  assert.ok(/^ollama:llama3.2:3b@low$/.test(plan.roles.critic), 'smallest → critic');
});

test('setup local with one model pins only that verified model', () => {
  const plan = resolveSetupPlan(INV_LOCAL1, { pack: 'local' });
  assert.deepStrictEqual([...new Set(Object.values(plan.roles).map((spec) => parseProviderSpec(spec).model))], ['qwen3.6:14b']);
});

test('setup local with no local models is unsatisfiable → all OPEN + warn', () => {
  const plan = resolveSetupPlan(INV_LOCAL0, { pack: 'local' });
  assert.deepStrictEqual(plan.roles, { analysis:null, design:null, critic:null });
  assert.ok(plan.warnings.some((w) => /no local|pull/.test(w)));
});

test('recommendPacks demotes local when no local models', () => {
  const r = recommendPacks(INV_NOLOCAL);
  assert.ok(r.includes('skip'), 'skip always present');
  assert.ok(r.indexOf('local') === -1 || r.indexOf('local') > r.indexOf('balanced'), 'local not surfaced first');
  assert.strictEqual(r[0], 'balanced');
});

test('recommendPacks surfaces local first when no non-host cloud', () => {
  const r = recommendPacks(INV_LOCAL2);
  assert.strictEqual(r[0], 'local');
  assert.ok(r.includes('skip'));
});

test('recommendPacks keeps both local and skip for a rich inventory', () => {
  const r = recommendPacks(INV_RICH);
  assert.ok(r.includes('local'), 'local present for rich inventory');
  assert.ok(r.includes('skip'), 'skip present');
  assert.strictEqual(r[0], 'balanced', 'balanced first');
});

test('resolveSetupPlan includes recommended_packs', () => {
  const plan = resolveSetupPlan(INV_RICH, { pack: 'balanced' });
  assert.ok(Array.isArray(plan.recommended_packs) && plan.recommended_packs.includes('skip'));
});

// ---------------------------------------------------------------------------
// Process-discipline block (setup-distillation)
// ---------------------------------------------------------------------------

import {
  removeDisciplineBlock,
  resolveDisciplineTarget,
} from './xllm-advisor.js';


test('removeDisciplineBlock removes cleanly and reports absence', () => {
  const doc = '# P\n\nbody\n\n<!-- xllm:discipline v1 -->\nold instructions\n<!-- /xllm:discipline -->\n';
  const res = removeDisciplineBlock(doc);
  assert.ok(res.removed);
  assert.ok(!res.content.includes('xllm:discipline'));
  assert.ok(res.content.includes('# P'));
  assert.ok(res.content.includes('body'));
  const absent = removeDisciplineBlock('# P\n');
  assert.strictEqual(absent.removed, false);
});

test('discipline removal refuses an unterminated block', () => {
  const corrupt = '<!-- xllm:discipline v1 -->\nno end marker\n';
  assert.throws(() => removeDisciplineBlock(corrupt));
});

test('resolveDisciplineTarget prefers CLAUDE.md, falls back to AGENTS.md', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-discipline-'));
  try {
    assert.ok(resolveDisciplineTarget(tmp).endsWith('AGENTS.md'));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '');
    assert.ok(resolveDisciplineTarget(tmp).endsWith('AGENTS.md'));
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '');
    assert.ok(resolveDisciplineTarget(tmp).endsWith('CLAUDE.md'));
    assert.ok(resolveDisciplineTarget(tmp, 'X.md').endsWith('X.md'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Traits (evidence-based provider profiles → measured routing)
// ---------------------------------------------------------------------------

import {
  canonicalSpecKey,
  wilson95Lower,
  deriveTraitProfiles,
  healthDecision,
  adherenceVeto,
  sharedBenchComparison,
  TRAIT_GATES,
} from './xllm-traits.js';


test('wilson95Lower exposes small-n uncertainty (6/6 raw=1.0 → LCB≈0.61)', () => {
  assert.ok(Math.abs(wilson95Lower(6, 6) - 0.6097) < 0.001);
  assert.ok(wilson95Lower(12, 12) > wilson95Lower(6, 6)); // more evidence → tighter bound
  assert.strictEqual(wilson95Lower(0, 0), null);
});

const T_NOW = Date.parse('2026-07-12T00:00:00Z');
const tIso = (msAgo) => new Date(T_NOW - msAgo).toISOString();


test('healthDecision: explicit authority, stale ignored, detection contradiction ignored', () => {
  const health = {
    gemini: { kind: 'auth', retryable: false, fresh: true },
    cursor: { kind: 'missing-binary', retryable: false, fresh: true },
    codex: { kind: 'transient', retryable: true, fresh: true },
    grok: { kind: 'auth', retryable: false, fresh: false }, // stale
  };
  assert.strictEqual(healthDecision('gemini', health, { readySource: 'explicit' }), 'ignore');
  assert.strictEqual(healthDecision('gemini', health, { readySource: 'detected' }), 'veto');
  assert.strictEqual(
    healthDecision('cursor', health, { readySource: 'detected', detectedReady: ['cursor'] }),
    'ignore'
  );
  assert.strictEqual(healthDecision('cursor', health, { readySource: 'detected', detectedReady: [] }), 'veto');
  assert.strictEqual(healthDecision('codex', health, { readySource: 'detected' }), 'demote');
  assert.strictEqual(healthDecision('grok', health, { readySource: 'detected' }), 'ignore');
  assert.strictEqual(healthDecision('claude', health, { readySource: 'detected' }), 'ignore');
});


/** Bench trait over taskCount tasks × 3 defects, hitsPerTask of them detected. */
function benchFixture(taskCount, hitsPerTask) {
  const cells = {};
  let detected = 0;
  let n = 0;
  for (let ti = 1; ti <= taskCount; ti++) {
    for (let d = 1; d <= 3; d++) {
      const hit = d <= hitsPerTask;
      cells[`t${ti}::d${d}`] = hit;
      if (hit) detected += 1;
      n += 1;
    }
  }
  return {
    cells,
    detected,
    n,
    tasks: taskCount,
    rate: +(detected / n).toFixed(3),
    wilson95_lower: wilson95Lower(detected, n),
    gated: n >= TRAIT_GATES.bench_min_cells,
  };
}

test('sharedBenchComparison uses exact shared {task, defect} opportunities', () => {
  const a = benchFixture(4, 3); // 12/12
  const b = benchFixture(5, 1); // 5/15 — extra task t5 is NOT shared
  const cmp = sharedBenchComparison(a, b);
  assert.strictEqual(cmp.shared_opportunities, 12);
  assert.strictEqual(cmp.shared_tasks, 4);
  assert.ok(cmp.candidate_lcb > cmp.baseline_lcb);
  assert.strictEqual(sharedBenchComparison(a, null), null);
});

test('pickAdvisorForRole: cold-start identity — empty traits change nothing', () => {
  const opts = { profiles: ROUTING_FIXTURE, taskText: 'find bugs', intensity: 'high', forceCli: true, readyProviders: ['codex', 'grok'] };
  const before = pickAdvisorForRole('critic', opts);
  const after = pickAdvisorForRole('critic', {
    ...opts,
    readySource: 'detected',
    traits: { version: 1, specs: {}, health: {} },
  });
  assert.strictEqual(after.provider, before.provider);
  assert.strictEqual(after.spec, before.spec);
  assert.strictEqual(after.trait_decisions, undefined);
});


// ---------------------------------------------------------------------------
// Long prompts (Windows argv limit) — --prompt-file + delivery guards
// ---------------------------------------------------------------------------

import { promptTooLongForArgv, WIN_ARGV_SAFE_CHARS } from './xllm-advisor.js';
import { PROMPT_FILE_THRESHOLD } from './xllm-structured.js';
import { spawnSync } from 'child_process';

test('promptTooLongForArgv: only Windows, only past the safe margin', () => {
  assert.strictEqual(promptTooLongForArgv(WIN_ARGV_SAFE_CHARS + 1, 'win32'), true);
  assert.strictEqual(promptTooLongForArgv(WIN_ARGV_SAFE_CHARS - 1, 'win32'), false);
  assert.strictEqual(promptTooLongForArgv(500000, 'linux'), false);
  // the structured layer routes to a file BEFORE the OS limit would bite
  assert.ok(PROMPT_FILE_THRESHOLD < WIN_ARGV_SAFE_CHARS);
});

test('--prompt-file: a 40KB prompt round-trips through the advisor (dry-run)', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-promptfile-'));
  const f = path.join(tmp, 'big-prompt.txt');
  try {
    fs.writeFileSync(f, `reply with OK\n${'x'.repeat(40000)}`, 'utf8');
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'xllm-advisor.js'), '--dry-run', 'codex', '--prompt-file', f],
      { encoding: 'utf8', shell: false, timeout: 30000 }
    );
    assert.strictEqual(r.status, 0); // argv delivery of the same prompt could not even spawn
    const cfg = JSON.parse(r.stdout);
    assert.strictEqual(cfg.provider, 'codex');
    // missing file fails loudly, not silently
    const bad = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'xllm-advisor.js'), '--dry-run', 'grok', '--prompt-file', path.join(tmp, 'nope.txt')],
      { encoding: 'utf8', shell: false, timeout: 30000 }
    );
    assert.notStrictEqual(bad.status, 0);
    assert.ok(/cannot read/.test(bad.stderr));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Setup plan validation + atomic apply (Task 6)
// ---------------------------------------------------------------------------

const APPLY_INV = {
  host_cli:'claude',
  providers:{
    codex:{ kind:'cloud', installed:true, healthy:true, tier:'strong', relative_cost:7 },
    ollama:{ kind:'local', installed:true, healthy:true, tier:'local', relative_cost:0, models:['qwen3.6:14b'], model_details: LOCAL_DETAILS },
    gemini:{ kind:'cloud', installed:false, healthy:false, tier:'balanced', relative_cost:4 },
  },
};

test('applySetupPlan writes pins and deletes OPEN keys atomically', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp); // pre-existing pin
    const plan = { pack:'balanced', roles:{ analysis:null, design:null, critic:'ollama:qwen3.6:14b@low' } };
    const res = applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp });
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/^analysis\s*=/m.test(body), 'OPEN analysis key deleted');
    assert.ok(/^critic\s*=\s*"ollama:qwen3.6:14b@low"/m.test(body), 'critic pinned');
    assert.ok(res.deleted.includes('analysis') && res.written.includes('critic'));
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan rejects a pin to a non-READY provider with zero writes', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply2-'));
  try {
    const plan = { pack:'balanced', roles:{ analysis:'gemini@high', design:null, critic:null } };
    assert.throws(() => applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp }), /not READY|gemini/);
    assert.ok(!fs.existsSync(path.join(tmp, '.xllm', 'xllm-providers.toml')), 'no file written on validation failure');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan skip clears all posture role keys', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-apply3-'));
  try {
    setProfileValue('roles', 'analysis', 'codex@high', tmp);
    setProfileValue('roles', 'critic', 'ollama:qwen3.6:14b@low', tmp);
    const plan = { pack:'skip', roles:{ analysis:null, design:null, critic:null } };
    applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp });
    const body = fs.readFileSync(path.join(tmp, '.xllm', 'xllm-providers.toml'), 'utf8');
    assert.ok(!/^analysis\s*=/m.test(body) && !/^critic\s*=/m.test(body), 'posture pins cleared');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan under sensitive=yes rejects a paid critic override with zero writes', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-sens1-'));
  try {
    const plan = { pack:'frugal', roles:{ analysis:null, design:null, critic:'codex@high' } };
    assert.throws(() => applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp, sensitive: 'yes' }), /paid critic|sensitive/);
    assert.ok(!fs.existsSync(path.join(tmp, '.xllm', 'xllm-providers.toml')), 'no write on rejection');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan under sensitive=yes rejects a below-high analysis override', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-sens2-'));
  try {
    const plan = { pack:'frugal', roles:{ analysis:'codex@low', design:null, critic:null } };
    assert.throws(() => applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp, sensitive: 'yes' }), /at least high|sensitive/);
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('applySetupPlan under sensitive=yes still allows a local critic override', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-sens3-'));
  try {
    const plan = { pack:'frugal', roles:{ analysis:null, design:null, critic:'ollama:qwen3.6:14b@low' } };
    const res = applySetupPlan(plan, { inventory: APPLY_INV, apply: true, root: tmp, sensitive: 'yes' });
    assert.ok(res.written.includes('critic'), 'local critic allowed under sensitive');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

// ---------------------------------------------------------------------------
// CLI dispatch: --setup (Task 7)
// ---------------------------------------------------------------------------

test('--setup balanced --json previews without writing', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-cli-'));
  try {
    const res = spawnSync(process.execPath,
      [path.join(root, 'scripts', 'xllm-advisor.js'), '--setup', 'skip', '--json'],
      { encoding:'utf8', env:{ ...process.env, XLLM_STATE_DIR: tmp } });
    assert.strictEqual(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.strictEqual(plan.pack, 'skip');
    assert.ok(!fs.existsSync(path.join(tmp, 'xllm-providers.toml')), 'preview writes nothing');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

// ---------------------------------------------------------------------------
// xllm.mjs setup subcommand (Task 8)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// xllm-diff (review-family diff collector)
// ---------------------------------------------------------------------------
import {
  parseDiffFlags,
  hasDiffSource,
  collectReviewDiff,
  budgetDiff,
  buildReviewContext,
  diffMeta,
  DIFF_MAX_BYTES,
  PROMPT_FILE_THRESHOLD as DIFF_PROMPT_FILE_THRESHOLD,
  questionWithContext,
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

test('parseDiffFlags treats a flag-like token after --base/--diff-file as a missing value', () => {
  const a = parseDiffFlags(['--base', '--tiebreak']);
  assert.ok(a.error && a.error.includes('--base requires a ref'), `got: ${a.error}`);
  const b = parseDiffFlags(['--diff-file', '--staged']);
  assert.ok(b.error && b.error.includes('--diff-file requires a path'), `got: ${b.error}`);
});

test('hasDiffSource false on empty opts, true per source', () => {
  assert.strictEqual(hasDiffSource(parseDiffFlags(['x']).diffOpts), false);
  assert.strictEqual(hasDiffSource(parseDiffFlags(['--staged']).diffOpts), true);
  assert.strictEqual(hasDiffSource(null), false);
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

test('collectReviewDiff distinguishes missing git binary from not-a-repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-norepo-'));
  const savedPath = process.env.PATH;
  try {
    const noRepo = collectReviewDiff({ staged: true, base: null, diffFile: null }, tmp);
    assert.strictEqual(noRepo.error, 'not a git repository');
    process.env.PATH = '';
    const noGit = collectReviewDiff({ staged: true, base: null, diffFile: null }, tmp);
    assert.ok(noGit.error && noGit.error !== 'not a git repository', `got: ${noGit.error}`);
    assert.ok(/git/i.test(noGit.error) && /found|PATH/i.test(noGit.error), `got: ${noGit.error}`);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('review context contains code while metadata excludes its body', () => {
  const body = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+privateImplementation();\n';
  const d = { source: 'staged', ...budgetDiff(body), stat: '1 file changed', bytes: Buffer.byteLength(body), truncated: false };
  const ctx = buildReviewContext(d);
  assert.ok(ctx.includes('+privateImplementation();'));
  const m = diffMeta(d);
  assert.strictEqual('body' in m, false);
  assert.ok(!JSON.stringify(m).includes('privateImplementation'));
});

// ---------------------------------------------------------------------------
// review dispatcher — one noun, four modes onto existing scripts (umbrella-5)
// ---------------------------------------------------------------------------

import { resolveReviewTarget } from './xllm-review.js';


test('resolveReviewTarget errors on unknown mode, usage on none', () => {
  assert.ok(resolveReviewTarget(['bogus']).error);
  assert.strictEqual(resolveReviewTarget([]).error, null);
  assert.strictEqual(resolveReviewTarget([]).script, undefined);
  assert.ok(resolveReviewTarget(['roles', 'a,b']).error); // roles needs a prompt
});

console.log(`\n${passed} tests passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
