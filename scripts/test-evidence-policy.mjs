import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceKey, executionLocation, parseProviderOutput } from './xllm-evidence.js';
import { runAdvisor } from './xllm-advisor.js';
import { classifyFailure } from './xllm-failures.js';

const localInfo = { digest: 'sha256:one', size: 1000, details: { parameter_size: '3B' } };
const fact = { executed_provider: 'codex', reported_model: 'gpt-example-1', identity_status: 'resolved', effective_effort: 'high', surface: 'cli-agentic', cli_version: '1.0' };

test('routing keys reject unresolved and mutable identities and separate execution conditions', () => {
  assert.equal(evidenceKey({ ...fact, identity_status: 'unresolved' }), null);
  assert.equal(evidenceKey({ ...fact, reported_model: 'default' }), null);
  for (const variation of [{ effective_effort: 'low' }, { surface: 'http-completion' }, { cli_version: '2.0' }, { model_revision: 'digest-b' }]) {
    assert.notEqual(evidenceKey(fact), evidenceKey({ ...fact, ...variation }));
  }
  assert.notEqual(evidenceKey({ ...fact, reported_model: 'model:latest', model_revision: 'sha256:a' }), null);
});

test('loopback alone is not proof of local execution', () => {
  assert.equal(executionLocation('ollama', 'm', { env: {} }), 'unknown');
  assert.equal(executionLocation('ollama', 'm:cloud', { env: {}, modelInfo: localInfo }), 'remote');
  assert.equal(executionLocation('ollama', 'm', { env: {}, modelInfo: localInfo }), 'local');
  assert.equal(executionLocation('ollama', 'm', { env: { OLLAMA_HOST: 'gpu.example:11434' }, modelInfo: localInfo }), 'remote');
  assert.equal(executionLocation('ollama', 'm', { env: {}, modelInfo: { ...localInfo, remote_host: 'cloud.example' } }), 'remote');
});

test('Codex protocol ignores tools and assistant identity claims; preserves final text and failure', () => {
  const stream = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'secret' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'I am model fabricated-id' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7 } },
  ].map(JSON.stringify).join('\n');
  const r = parseProviderOutput('codex', stream);
  assert.equal(r.raw, 'I am model fabricated-id');
  assert.equal(r.reported_model, null);
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 7 });
  assert.equal(parseProviderOutput('codex', `${stream}\n${JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } })}`).error, 'quota');
  assert.equal(parseProviderOutput('codex', 'plain prose').raw, '');
});

test('Claude metadata requires a unique native model, not the requested alias', () => {
  const r = parseProviderOutput('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', modelUsage: { 'claude-example-1': { inputTokens: 8 } }, total_cost_usd: 0.01 }));
  assert.equal(r.reported_model, 'claude-example-1');
  assert.equal(r.cost_estimate, 0.01);
  const ambiguous = parseProviderOutput('claude', JSON.stringify({ result: 'answer', modelUsage: { a: {}, b: {} } }));
  assert.equal(ambiguous.reported_model, null);
  const failure = parseProviderOutput('claude', JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'unfinished' }));
  assert.ok(failure.error);
});

test('local-only rejects remote and unverified models before touching transport', () => {
  for (const [provider, model] of [['codex', null], ['ollama', 'm:cloud'], ['ollama', 'unverified']]) {
    const r = runAdvisor({ provider, model, prompt: 'private', env: {}, profiles: { defaults: { execution_policy: 'local-only' }, providers: {} },
      noArtifacts: true, quiet: true, spawnFn: () => assert.fail('remote transport called'), isBinaryAvailable: () => assert.fail('binary probe called') });
    assert.equal(r.exitCode, 1);
    assert.equal(r.failure.kind, 'policy-denied');
    assert.equal(r.raw, '');
    assert.equal(r.attribution.reported_model, null);
  }
});

test('unsupported readonly adapters fail closed without invoking a model', () => {
  const r = runAdvisor({ provider: 'grok', prompt: 'private', env: {}, profiles: { defaults: {}, providers: {} },
    noArtifacts: true, quiet: true, spawnFn: () => assert.fail('unsafe transport called') });
  assert.equal(r.failure.kind, 'safety-unverified');
  assert.equal(r.exitCode, 1);
});

test('successful process exit does not turn an HTTP model error into a successful answer', () => {
  const r = runAdvisor({ provider: 'ollama', model: 'missing-model', prompt: 'q', env: {}, profiles: { defaults: {}, providers: {} },
    noArtifacts: true, quiet: true, spawnFn: () => ({ status: 0, stdout: JSON.stringify({ error: 'model not found' }), stderr: '' }), isBinaryAvailable: () => true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.raw, '');
  assert.equal(r.failure.kind, 'unknown-model');
  assert.equal(r.attribution.identity_status, 'unresolved');
});

test('Ollama rejected effort is retried once and cannot be credited to the requested effort', () => {
  let calls = 0;
  const r = runAdvisor({ provider: 'ollama', model: 'model:latest', effort: 'high', prompt: 'q', env: {}, modelInfo: localInfo,
    profiles: { defaults: {}, providers: {} }, noArtifacts: true, quiet: true, isBinaryAvailable: () => true,
    spawnFn: (_cmd, _args, opts) => {
      calls++;
      const body = JSON.parse(opts.input);
      return body.think ? { status: 0, stdout: '{"error":"think not supported"}' }
        : { status: 0, stdout: '{"model":"model:latest","response":"answer","done":true,"eval_count":3}' };
    } });
  assert.equal(calls, 2);
  assert.equal(r.exitCode, 0);
  assert.equal(r.attribution.requested_effort, 'high');
  assert.equal(r.attribution.effective_effort, null);
  assert.equal(r.attribution.identity_status, 'resolved');
  assert.equal(r.attribution.model_revision, localInfo.digest);
});

test('expired OAuth is an auth observation, not a permanent model failure', () => {
  const failure = classifyFailure({ status: 1, stdout: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
  assert.equal(failure.kind, 'auth');
  assert.equal(failure.retryable, false);
});
