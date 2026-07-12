#!/usr/bin/env node
/**
 * Unit tests for grok-ask-advisor pure helpers (no live LLM required).
 */

import assert from 'assert';
import {
  getSupportedProviders,
  getProviderMeta,
  parseProviderSpec,
  resolveSpawnConfig,
  slugify,
  parseLMStudioResponse,
  writeArtifact,
  cleanOllamaOutput,
  cleanCodexOutput,
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
  buildInventory,
  buildProposalPrompt,
  extractProposalPatch,
  writeMultiIndex,
} from './grok-ask-advisor.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
process.chdir(root);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    process.exit(1);
  }
}

console.log('test-advisor');

test('getSupportedProviders includes cloud + local', () => {
  const p = getSupportedProviders();
  assert.ok(p.includes('grok'));
  assert.ok(p.includes('codex'));
  assert.ok(p.includes('antigravity'));
  assert.ok(p.includes('ollama'));
});

test('getProviderMeta has defaults and antigravity preference', () => {
  const m = getProviderMeta();
  assert.ok(m.version);
  assert.strictEqual(m.defaults.design_provider, 'antigravity');
  assert.ok(m.cloud.indexOf('antigravity') < m.cloud.indexOf('gemini'));
});

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

test('resolveSpawnConfig grok model+effort (read-only default)', () => {
  const c = resolveSpawnConfig('grok', 'grok-4', 'hi', process.env, {
    effort: 'high',
  });
  assert.strictEqual(c.binary, 'grok');
  assert.ok(c.args.includes('-m'));
  assert.ok(c.args.includes('grok-4'));
  assert.ok(c.args.includes('--reasoning-effort'));
  assert.ok(c.args.includes('high'));
  assert.ok(!c.args.includes('--always-approve'));
});

test('resolveSpawnConfig grok mutation opt-in restores approval flag', () => {
  const c = resolveSpawnConfig('grok', null, 'hi', process.env, {
    allowMutation: true,
  });
  assert.ok(c.args.includes('--always-approve'));
  assert.strictEqual(c.mutation, true);
});

test('resolveSpawnConfig codex model+effort (read-only sandbox default)', () => {
  const c = resolveSpawnConfig('codex', 'o3', 'short', process.env, {
    effort: 'xhigh',
  });
  assert.strictEqual(c.binary, 'codex');
  assert.ok(c.args.includes('-m'));
  assert.ok(c.args.includes('o3'));
  assert.ok(c.args.includes('-c'));
  assert.ok(c.args.some((a) => String(a).includes('model_reasoning_effort=xhigh')));
  assert.ok(c.args.includes('--sandbox'));
  assert.ok(c.args.includes('read-only'));
  assert.ok(!c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('resolveSpawnConfig codex mutation opt-in uses dangerous flag', () => {
  const c = resolveSpawnConfig('codex', null, 'short', process.env, {
    allowMutation: true,
  });
  assert.ok(c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!c.args.includes('read-only'));
});

test('resolveSpawnConfig gemini has no --yolo by default', () => {
  const c = resolveSpawnConfig('gemini', null, 'hi', process.env, {});
  assert.ok(!c.args.includes('--yolo'));
  const m = resolveSpawnConfig('gemini', null, 'hi', process.env, {
    allowMutation: true,
  });
  assert.ok(m.args.includes('--yolo'));
});

test('resolveSpawnConfig antigravity has no permission bypass by default', () => {
  const c = resolveSpawnConfig('antigravity', null, 'hi', process.env, {});
  assert.ok(!c.args.includes('--dangerously-skip-permissions'));
});

test('resolveSpawnConfig cursor keeps sandbox by default', () => {
  const c = resolveSpawnConfig('cursor', null, 'hi', process.env, {});
  assert.ok(!c.args.includes('disabled'));
  assert.ok(!c.args.includes('--force'));
  assert.ok(c.args.includes('--print'));
});

test('resolveSpawnConfig lemonade without LEMONADE_BIN is unavailable', () => {
  const env = { ...process.env };
  delete env.LEMONADE_BIN;
  const c = resolveSpawnConfig('lemonade', null, 'hi', env, {});
  assert.ok(c.unavailable);
  assert.strictEqual(c.binary, null);
});

test('resolveSpawnConfig claude model+effort', () => {
  const c = resolveSpawnConfig('claude', 'opus', 'hi', process.env, {
    effort: 'medium',
  });
  assert.ok(c.args.includes('--model'));
  assert.ok(c.args.includes('opus'));
  assert.ok(c.args.includes('--effort'));
  assert.ok(c.args.includes('medium'));
});

test('resolveSpawnConfig antigravity model', () => {
  const c = resolveSpawnConfig('antigravity', 'Gemini 3.5 Flash', 'hi');
  assert.strictEqual(c.binary, 'agy');
  assert.ok(c.args.includes('--model'));
  assert.ok(c.args.includes('Gemini 3.5 Flash'));
  assert.ok(c.args.includes('-p'));
});

test('resolveSpawnConfig ollama model', () => {
  const c = resolveSpawnConfig('ollama', 'codellama', 'review this');
  assert.strictEqual(c.binary, 'ollama');
  assert.deepStrictEqual(c.args.slice(0, 3), ['run', 'codellama', 'review this']);
});

test('resolveSpawnConfig codex stdin on long prompt', () => {
  const long = 'x'.repeat(500);
  const c = resolveSpawnConfig('codex', null, long);
  assert.ok(c.usesStdin);
  assert.ok(c.args.includes('-'));
});

test('parseLMStudioResponse extracts content', () => {
  const raw = JSON.stringify({
    choices: [{ message: { content: 'hello advisor' } }],
  });
  assert.strictEqual(parseLMStudioResponse(raw), 'hello advisor');
});

test('writeArtifact includes effort', () => {
  const file = writeArtifact({
    provider: 'test',
    model: 'unit',
    effort: 'high',
    original: 'unit test task',
    finalPrompt: 'unit test task',
    raw: '- do the thing\n- ship it',
    exitCode: 0,
    durationMs: 12,
  });
  assert.ok(fs.existsSync(file));
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.includes('Effort: high'));
  assert.ok(body.includes('Advisor version'));
});

test('cleanModelText strips spinner CSI sequences (not just colors)', () => {
  const raw =
    '\x1b[?25l\x1b[1G⠙ \x1b[K\x1b[?25h\x1b[?2026lwriting manifest \x1b[Ksuccess\x1b[?2026l\n\nXLLM_SMOKE_OK';
  const cleaned = cleanOllamaOutput(raw);
  assert.ok(cleaned.includes('XLLM_SMOKE_OK'));
  assert.ok(!cleaned.includes('[K'));
  assert.ok(!cleaned.includes('[?25'));
  assert.ok(!cleaned.includes('\x1b'));
});

test('cleanOllamaOutput strips thinking blocks', () => {
  const raw = `Thinking...\nsecret chain\n...done thinking.\n\nXLLM_SMOKE_OK\n\n? ? ? `;
  const cleaned = cleanOllamaOutput(raw);
  assert.ok(cleaned.includes('XLLM_SMOKE_OK'));
  assert.ok(!/Thinking\.\.\./i.test(cleaned));
});

test('resolveBinaryPath returns string', () => {
  assert.ok(resolveBinaryPath('node').length > 0);
});

test('resolveSpawnTarget for node-like is passthrough', () => {
  const t = resolveSpawnTarget(process.execPath);
  assert.ok(t.command);
});

test('extractSummary prefers final answer', () => {
  const s = extractSummary(
    `Thinking...\nwaffle\n...done thinking.\n\nXLLM_SMOKE_OK`,
    0
  );
  assert.ok(s.includes('XLLM_SMOKE_OK'));
});

test('cleanCodexOutput drops session banner', () => {
  const raw =
    '- Secret leakage through prompt injection.\n\nOpenAI Codex v0.143.0\n--------\nworkdir: D:\\repo\nsession id: abc';
  const cleaned = cleanCodexOutput(raw);
  assert.ok(cleaned.includes('Secret leakage'));
  assert.ok(!/OpenAI Codex/i.test(cleaned));
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

test('loadProviderProfiles prefers antigravity design', () => {
  const p = loadProviderProfiles({ force: true });
  assert.strictEqual(p.defaults.design_provider, 'antigravity');
  assert.strictEqual(p.defaults.design_fallback, 'gemini');
});

test('pickDefaultXllmPair prefers antigravity when ready', () => {
  const pair = pickDefaultXllmPair(
    ['codex', 'antigravity', 'gemini', 'grok'],
    ['ollama']
  );
  assert.ok(pair.includes('codex') || pair.includes('ollama'));
  // design side should prefer antigravity over gemini when not Windows-blocked
  if (process.platform !== 'win32') {
    assert.ok(pair.includes('antigravity'));
  }
});

test('resolvePreferredProvider windows antigravity fallback', () => {
  const r = resolvePreferredProvider('antigravity');
  if (process.platform === 'win32') {
    assert.strictEqual(r.provider, 'gemini');
    assert.ok(r.substituted);
  } else {
    assert.strictEqual(r.provider, 'antigravity');
  }
});

test('resolveAdvisorScriptPath finds scripts in cwd', () => {
  const p = resolveAdvisorScriptPath();
  assert.ok(fs.existsSync(p));
});

test('rememberAdvisorPath writes marker', () => {
  const r = rememberAdvisorPath(root);
  assert.ok(fs.existsSync(r.marker));
  assert.ok(r.marker.endsWith('xllm-advisor-path'));
});

// ---------------------------------------------------------------------------
// Safety / namespace helpers
// ---------------------------------------------------------------------------

test('resolveStateDir prefers existing legacy .grok in this repo', () => {
  const dir = resolveStateDir(root, {});
  assert.ok(dir.endsWith('.grok') || dir.endsWith('.xllm'));
  assert.ok(fs.existsSync(dir));
});

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
  const file = writeArtifact({
    provider: 'test',
    model: 'clean',
    effort: null,
    original: 'cleanup target',
    finalPrompt: 'cleanup target',
    raw: 'output',
    exitCode: 0,
  });
  assert.ok(fs.existsSync(file));
  const removed = cleanArtifacts(root);
  assert.ok(removed >= 1);
  assert.ok(!fs.existsSync(file));
  const askDir = path.dirname(file);
  assert.ok(fs.existsSync(askDir));
});

// ---------------------------------------------------------------------------
// Cost metadata / profile writer / inventory (improvement 1)
// ---------------------------------------------------------------------------

test('getProviderCostMeta: local free, codex strong, profile-overridable', () => {
  const ollama = getProviderCostMeta('ollama');
  assert.strictEqual(ollama.tier, 'local');
  assert.strictEqual(ollama.relative_cost, 0);
  const codex = getProviderCostMeta('codex');
  assert.strictEqual(codex.tier, 'strong');
  assert.ok(codex.relative_cost > 0);
  const overridden = getProviderCostMeta('codex', {
    providers: { codex: { tier: 'local', relative_cost: 1 } },
  });
  assert.strictEqual(overridden.tier, 'local');
  assert.strictEqual(overridden.relative_cost, 1);
});

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

test('buildInventory probes providers and caches at XLLM_HOME', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-inv-'));
  try {
    const env = { ...process.env, XLLM_HOME: tmp };
    const inv = buildInventory({ refresh: true, env });
    assert.strictEqual(inv.cached, false);
    assert.ok(inv.providers.ollama);
    assert.strictEqual(inv.providers.ollama.kind, 'local');
    assert.ok('installed' in inv.providers.codex);
    assert.ok(inv.providers.codex.tier);
    assert.ok(fs.existsSync(path.join(tmp, 'inventory.json')));
    const again = buildInventory({ env });
    assert.strictEqual(again.cached, true);
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

// ---------------------------------------------------------------------------
// Proposal mode (improvement 3)
// ---------------------------------------------------------------------------

test('buildProposalPrompt wraps task with no-apply contract', () => {
  const p = buildProposalPrompt('add validation');
  assert.ok(p.includes('CHANGE PROPOSAL'));
  assert.ok(p.includes('unified diff'));
  assert.ok(p.includes('add validation'));
});

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

test('execCapableProviders: sandboxed CLIs only', () => {
  const caps = execCapableProviders();
  assert.ok(caps.includes('codex'));
  assert.ok(caps.includes('claude'));
  assert.ok(!caps.includes('gemini'));
  assert.ok(!caps.includes('grok'));
  assert.ok(!caps.includes('ollama'));
  assert.strictEqual(EXEC_CAPABLE.codex.sandbox, 'os-workspace');
});

test('codex exec args: sandbox default, bypass only on explicit mode', () => {
  const sandboxed = EXEC_CAPABLE.codex.args('/c', 'sandbox');
  assert.ok(sandboxed.includes('--sandbox'));
  assert.ok(sandboxed.includes('workspace-write'));
  assert.ok(!sandboxed.includes('--dangerously-bypass-approvals-and-sandbox'));
  const bypass = EXEC_CAPABLE.codex.args('/c', 'bypass');
  assert.ok(bypass.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(bypass.includes('--cd'));
});

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

test('buildExecInstructions embeds task, branch, no-push contract', () => {
  const s = buildExecInstructions({
    task: 'implement X',
    branch: 'xllm/exec/abc',
    testCmd: 'npm test',
  });
  assert.ok(s.includes('implement X'));
  assert.ok(s.includes('xllm/exec/abc'));
  assert.ok(s.includes('Do NOT push'));
  assert.ok(s.includes('npm test'));
});

test('exec registry roundtrip and cleanup', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-exec-'));
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

import { classifyFailure, withRetry } from './grok-ask-advisor.js';
import {
  PROVIDER_CONTRACTS,
  probeProviderContract,
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

test('provider contracts: every provider has a contract; flags match spawn configs', () => {
  for (const p of getSupportedProviders()) {
    assert.ok(PROVIDER_CONTRACTS[p], `contract for ${p}`);
  }
  // The flags xllm actually spawns with must be in the probed contract.
  assert.ok(PROVIDER_CONTRACTS.codex.probes[0].required.includes('--sandbox'));
  assert.ok(PROVIDER_CONTRACTS.claude.probes[0].required.includes('--permission-mode'));
  assert.ok(PROVIDER_CONTRACTS.grok.probes[0].required.includes('--reasoning-effort'));
});

test('probeProviderContract: live probe on installed ollama, missing lemonade', () => {
  const ollama = probeProviderContract('ollama');
  assert.strictEqual(ollama.ok, true);
  assert.ok(ollama.version);
  const env = { ...process.env };
  delete env.LEMONADE_BIN;
  const lemonade = probeProviderContract('lemonade', env);
  assert.strictEqual(lemonade.ok, false);
  assert.strictEqual(lemonade.failure.kind, 'missing-binary');
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
import { gradeAnswer, errorCorrelation, loadTasks, resolveTasksFile } from './xllm-bench.js';

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

test('suggestTiebreaker picks lowest measured agreement, else strong tier', () => {
  const ready = ['codex', 'gemini', 'grok'];
  const ledger = [
    { pair: 'codex ↔ ollama:llama3.2', agreement_rate: 0.9 },
    { pair: 'gemini ↔ ollama:llama3.2', agreement_rate: 0.3 },
  ];
  const t = suggestTiebreaker(['ollama:llama3.2'], ready, ledger);
  assert.strictEqual(t.provider, 'gemini'); // 0.3 < 0.9
  const noData = suggestTiebreaker(['ollama:llama3.2'], ['gemini', 'codex'], []);
  assert.ok(['gemini', 'codex'].includes(noData.provider)); // strongest tier
  const none = suggestTiebreaker(['codex', 'gemini', 'grok'], ['codex', 'grok'], []);
  assert.strictEqual(none.provider, null);
});

test('bench grader: deterministic defect detection + selftest tasks valid', () => {
  const spec = loadTasks();
  assert.ok(spec.tasks.length >= 6);
  const t1 = spec.tasks[0];
  const good = gradeAnswer(t1, 'SQL injection through concatenation; also XSS since output not escaped; password stored plaintext not hashed');
  assert.strictEqual(good.hits.length, 3);
  const partial = gradeAnswer(t1, 'looks fine to me');
  assert.strictEqual(partial.hits.length, 0);
  assert.strictEqual(partial.misses.length, 3);
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
} from './xllm-panel.js';

test('buildPanelPrompt appends the blind verdict protocol', () => {
  const p = buildPanelPrompt('Is eval safe?');
  assert.ok(p.startsWith('Is eval safe?'));
  assert.ok(p.includes('PANEL PROTOCOL'));
  assert.ok(p.includes('"verdict"'));
});

test('extractPanelVerdict repairs newline-wrapped JSON strings (ollama TTY)', () => {
  const wrapped =
    '```json\n{"verdict": "reject", "confidence": 0.5, "key_claims": ["Passing unsanitize\nunsanitized input is unsafe."]}\n```';
  const v = extractPanelVerdict(wrapped);
  assert.ok(v);
  assert.strictEqual(v.verdict, 'reject');
});

test('rawFromArtifact survives inner fenced blocks (anchored on Summary)', async () => {
  const { rawFromArtifact } = await import('./xllm-panel.js');
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-rawart-'));
  const f = path.join(tmp, 'a.md');
  try {
    fs.writeFileSync(
      f,
      '# x\n\n## Raw output\n\n```text\nanswer\n\n```json\n{"verdict":"approve","key_claims":[]}\n```\n```\n\n## Summary\n\nok\n',
      'utf8'
    );
    const raw = rawFromArtifact(f);
    assert.ok(raw.includes('```json'));
    assert.ok(extractPanelVerdict(raw));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    const xy = stats.matrix.find((m) => m.pair === 'x ↔ y');
    assert.strictEqual(xy.comparable_runs, 2);
    assert.strictEqual(xy.agreement_rate, 0.5);
    // abstention pair never entered the matrix
    assert.ok(!stats.matrix.find((m) => m.pair.includes('z')));
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
  assert.deepStrictEqual(rows[0], { a: 'codex', b: 'claude', agree: true });
  assert.deepStrictEqual(rows[1], { a: 'grok', b: 'claude', agree: false });
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
      { type: 'panel', run_id: 'p1', pairwise: [{ a: 'codex', b: 'grok', agree: false }] },
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
          { a: 'codex', b: 'claude', agree: true },
          { a: 'grok', b: 'claude', agree: false },
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

test('tiebreak loop closes: matrix from a past tiebreak steers the next pick', () => {
  // yesterday: codex↔grok split; claude tiebroke — agreed with codex, not grok
  const matrix = [
    { pair: 'claude ↔ codex', agreement_rate: 1, comparable_runs: 1 },
    { pair: 'claude ↔ grok', agreement_rate: 0, comparable_runs: 1 },
  ];
  // today: codex+claude panel splits; grok is the least-agreeing unconsulted
  const t = suggestTiebreaker(['codex', 'claude'], ['grok', 'gemini'], matrix);
  assert.strictEqual(t.provider, 'grok');
  assert.strictEqual(t.measured_agreement, 0);
});

// ---------------------------------------------------------------------------
// Structured-output layer (robust JSON extraction shared by the review family)
// ---------------------------------------------------------------------------

import { extractJson, lastBalanced, adherenceSummary } from './xllm-structured.js';

test('extractJson: fenced, bare, last-valid, trailing-comma, newline-wrapped', () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  // bare JSON without a fence
  assert.deepStrictEqual(extractJson('here it is: {"a":2} done'), { a: 2 });
  // last valid fenced block wins
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":3}\n```'), { a: 3 });
  // trailing comma repair
  assert.deepStrictEqual(extractJson('```json\n{"a":1,}\n```'), { a: 1 });
  // newline-wrapped string literal (ollama TTY)
  const wrapped = '```json\n{"v":"reject","c":["a long\nclaim here"]}\n```';
  assert.strictEqual(extractJson(wrapped).v, 'reject');
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
} from './xllm-debate.js';

const claim = { id: 'C0-1', author: 'claude', authorSpec: 'claude:opus', text: 'X is unsafe' };
const atk = (o = {}) => ({ claim_id: 'C0-1', stance: 'refute', mechanism: 'm', falsifier: 'f', tier: 'soft', attackerVendor: 'grok', ...o });

test('debate: no refutation → SURVIVED', () => {
  assert.strictEqual(classifyDebateClaim(claim, [], null, 2).status, 'SURVIVED');
});

test('debate: author concede → KILLED; amend → KILLED with replacement', () => {
  assert.strictEqual(classifyDebateClaim(claim, [atk()], { response: 'concede', rebuttals: [] }, 2).status, 'KILLED');
  const am = classifyDebateClaim(claim, [atk()], { response: 'amend', amended_claim: 'X unsafe only if unset', rebuttals: [] }, 2);
  assert.strictEqual(am.status, 'KILLED');
  assert.strictEqual(am.amended, 'X unsafe only if unset');
});

test('debate N=2: decisive falsifier author does NOT defeat → KILLED', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'decisive' })], { response: 'holds', rebuttals: [] }, 2);
  assert.strictEqual(r.status, 'KILLED');
  assert.ok(/decisive/.test(r.reason));
});

test('debate N=2: decisive falsifier the author DOES defeat (holds) → not killed', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'decisive' })], { response: 'holds', rebuttals: [{ attacker: 'grok', result: 'holds', counter: 'c' }] }, 2);
  assert.notStrictEqual(r.status, 'KILLED');
  assert.strictEqual(r.status, 'SURVIVED'); // all standing attacks held
});

test('debate N=2: single SOFT attack + author holds → UNRESOLVED (mere disagreement never kills)', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'soft' })], { response: 'holds', rebuttals: [] }, 2);
  assert.strictEqual(r.status, 'UNRESOLVED');
});

test('debate: soft attack alone can never KILL even without defense', () => {
  const r = classifyDebateClaim(claim, [atk({ tier: 'soft' })], null, 2);
  assert.notStrictEqual(r.status, 'KILLED'); // confabulated soft cannot kill
  assert.strictEqual(r.status, 'UNRESOLVED');
});

test('debate N=3: two distinct vendors refute, author holds neither → KILLED; same-vendor double does not', () => {
  const twoVendors = [atk({ attackerVendor: 'grok' }), atk({ attackerVendor: 'gemini' })];
  assert.strictEqual(classifyDebateClaim(claim, twoVendors, { response: 'holds', rebuttals: [] }, 3).status, 'KILLED');
  const sameVendor = [atk({ attackerVendor: 'grok' }), atk({ attackerVendor: 'grok' })];
  assert.notStrictEqual(classifyDebateClaim(claim, sameVendor, { response: 'holds', rebuttals: [] }, 3).status, 'KILLED');
});

test('debate: extractors parse the JSON contracts + repair wrapped newlines', () => {
  assert.strictEqual(extractClaims('```json\n{"claims":[{"text":"a","evidence":"e"}]}\n```')[0].text, 'a');
  const a = extractAttacks('```json\n{"attacks":[{"claim_id":"C0-1","stance":"refute","mechanism":"m","tier":"decisive"}]}\n```');
  assert.strictEqual(a[0].tier, 'decisive');
  // a refute with empty mechanism is dropped as a freeloader
  assert.strictEqual(extractAttacks('```json\n{"attacks":[{"claim_id":"C0-1","stance":"refute","mechanism":""}]}\n```').length, 0);
  const d = extractDefense('```json\n{"response":"holds","rebuttals":[{"attacker":"grok","result":"holds"}]}\n```');
  assert.strictEqual(d.response, 'holds');
  assert.strictEqual(extractDefense('no block'), null);
});

test('debate prompts force hostility + evidence typing', () => {
  const rp = buildRefutePrompt('Q', [{ id: 'C0-1', text: 'x' }]);
  assert.ok(/HOSTILE/.test(rp) && /Default to REFUTE/.test(rp) && /decisive/.test(rp));
  const dp = buildDefendPrompt({ text: 'x' }, [{ attacker: 'grok', tier: 'soft', mechanism: 'm' }]);
  assert.ok(/concede/.test(dp) && /holds/.test(dp));
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
  assert.strictEqual(out[2].author, 'claude');
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

test('scribe templates embed context and hard rules', () => {
  const p = SCRIBE_TEMPLATES.commit({ body: 'THE-DIFF' });
  assert.ok(p.includes('THE-DIFF'));
  assert.ok(p.includes('Conventional Commits'));
  assert.ok(p.includes('Never invent'));
  assert.ok(SCRIBE_TEMPLATES.pr({ body: 'X' }).includes('## Summary'));
  assert.ok(SCRIBE_TEMPLATES.release({ body: 'X' }).includes('### Added'));
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

test('pickScribeProvider: local-first for commit, escalates release off local', () => {
  const commit = pickScribeProvider('commit', { ready: ['ollama', 'codex', 'grok'] });
  assert.strictEqual(commit.parsed.provider, 'ollama'); // relative_cost 0
  const rel = pickScribeProvider('release', { ready: ['ollama', 'grok'] });
  assert.notStrictEqual(rel.parsed.provider, 'ollama');
  assert.strictEqual(rel.source, 'escalated');
  const relLocalOnly = pickScribeProvider('release', { ready: ['ollama'] });
  assert.strictEqual(relLocalOnly.parsed.provider, 'ollama'); // nothing to escalate to
  const explicit = pickScribeProvider('commit', { providerSpec: 'gemini@low' });
  assert.strictEqual(explicit.parsed.provider, 'gemini');
  assert.strictEqual(explicit.source, 'explicit');
});

// ---------------------------------------------------------------------------
// Role / intensity routing
// ---------------------------------------------------------------------------

import {
  inferIntensity,
  pickAdvisorForRole,
  pickTeamAdvisors,
  defaultRolesForTask,
} from './xllm-routing.js';

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

test('pickAdvisorForRole security uses codex high/xhigh', () => {
  const p = pickAdvisorForRole('security', {
    taskText: 'auth token rotation race',
    readyProviders: ['codex', 'ollama', 'grok', 'claude'],
    forceCli: true,
  });
  assert.strictEqual(p.role, 'security');
  assert.strictEqual(p.provider, 'codex');
  assert.ok(['high', 'xhigh'].includes(p.effort));
  assert.ok(p.spec.includes('codex'));
  assert.strictEqual(p.use_native, false);
});

test('pickAdvisorForRole explore prefers native', () => {
  const p = pickAdvisorForRole('explore', {
    taskText: 'map the auth module',
    readyProviders: ['ollama', 'grok'],
  });
  assert.strictEqual(p.role, 'explore');
  assert.ok(p.use_native);
  assert.ok(String(p.spec).startsWith('native:'));
});

test('pickAdvisorForRole design prefers antigravity chain', () => {
  const p = pickAdvisorForRole('design', {
    taskText: 'improve onboarding UX',
    readyProviders: ['antigravity', 'gemini', 'grok'],
    forceCli: true,
  });
  // On Windows antigravity substitutes to gemini if in chain
  assert.ok(['antigravity', 'gemini'].includes(p.provider));
});

test('pickAdvisorForRole critic escalates to cloud on high', () => {
  const p = pickAdvisorForRole('critic', {
    taskText: 'security review of payment module',
    readyProviders: ['ollama', 'codex', 'grok'],
    forceCli: true,
  });
  assert.ok(['codex', 'grok', 'claude'].includes(p.provider));
});

test('defaultRolesForTask includes security for auth', () => {
  const roles = defaultRolesForTask('Refactor auth and add tests');
  assert.ok(roles.includes('implement'));
  assert.ok(roles.includes('security'));
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
      taskText: 'security auth payment rewrite',
      forceCli: true,
      readyProviders: ['gemini', 'codex'],
    });
    assert.strictEqual(p.provider, 'gemini');
    assert.strictEqual(p.effort, 'low');
    assert.strictEqual(p.pinned, true);
  } finally {
    delete process.env.XLLM_PROVIDERS_PATH;
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
    taskText: 'fix typo in README',
    forceCli: true,
    readyProviders: ['ollama', 'grok', 'antigravity'],
  });
  assert.strictEqual(p.provider, 'ollama'); // relative_cost 0 wins on low intensity
  assert.ok(p.cost);
  assert.strictEqual(p.cost.tier, 'local');
  assert.strictEqual(p.pinned, false);
});

test('pickTeamAdvisors returns multiple picks', () => {
  const plan = pickTeamAdvisors('Refactor auth module with tests', null, {
    readyProviders: ['codex', 'ollama', 'grok', 'claude'],
  });
  assert.ok(plan.roles.length >= 2);
  assert.ok(plan.picks.implement || plan.picks.security);
});

console.log(`\n${passed} tests passed`);
