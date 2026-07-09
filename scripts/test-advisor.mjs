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
  pickDefaultCcgPair,
  resolvePreferredProvider,
  isEffortToken,
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

test('resolveSpawnConfig grok model+effort', () => {
  const c = resolveSpawnConfig('grok', 'grok-4', 'hi', process.env, {
    effort: 'high',
  });
  assert.strictEqual(c.binary, 'grok');
  assert.ok(c.args.includes('-m'));
  assert.ok(c.args.includes('grok-4'));
  assert.ok(c.args.includes('--reasoning-effort'));
  assert.ok(c.args.includes('high'));
  assert.ok(c.args.includes('--always-approve'));
});

test('resolveSpawnConfig codex model+effort', () => {
  const c = resolveSpawnConfig('codex', 'o3', 'short', process.env, {
    effort: 'xhigh',
  });
  assert.strictEqual(c.binary, 'codex');
  assert.ok(c.args.includes('-m'));
  assert.ok(c.args.includes('o3'));
  assert.ok(c.args.includes('-c'));
  assert.ok(c.args.some((a) => String(a).includes('model_reasoning_effort=xhigh')));
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

test('pickDefaultCcgPair prefers antigravity when ready', () => {
  const pair = pickDefaultCcgPair(
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

test('pickTeamAdvisors returns multiple picks', () => {
  const plan = pickTeamAdvisors('Refactor auth module with tests', null, {
    readyProviders: ['codex', 'ollama', 'grok', 'claude'],
  });
  assert.ok(plan.roles.length >= 2);
  assert.ok(plan.picks.implement || plan.picks.security);
});

console.log(`\n${passed} tests passed`);
