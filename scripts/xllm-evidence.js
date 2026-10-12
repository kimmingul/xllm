#!/usr/bin/env node
/** Pure execution facts shared by transport, policy, and measured routing. */
import { CLOUD_PROVIDERS } from './xllm-constants.js';

export const RESULT_SCHEMA_VERSION = 2;

export function isMutableModel(model) {
  const name = String(model || '').trim().toLowerCase();
  return !name || /^(default|auto|best|opus|sonnet|haiku|fable|opusplan|pro|flash|fast|local-model)(\[.*\])?$/.test(name)
    || /(?:[:@/-])(latest|default|auto)$/.test(name);
}

export function evidenceKey(attribution) {
  const a = attribution;
  if (!a || a.identity_status !== 'resolved' || !a.executed_provider || !a.reported_model
      || (!a.model_revision && isMutableModel(a.reported_model)) || !a.surface) return null;
  return JSON.stringify([
    a.executed_provider, a.reported_model, a.model_revision || null,
    a.effective_effort ?? null, a.surface, a.cli_version || null,
  ]);
}

function endpointHost(value, fallback) {
  try {
    const raw = String(value || fallback);
    return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch { return null; }
}

export function executionLocation(provider, model, { env = process.env, modelInfo = null } = {}) {
  if (CLOUD_PROVIDERS.includes(provider)) return 'remote';
  if (/(?:[:/-])cloud(?:$|[:@/-])/i.test(String(model || '')) || modelInfo?.remote_model
      || modelInfo?.remote_host || modelInfo?.execution_location === 'remote') return 'remote';
  const host = provider === 'ollama'
    ? endpointHost(env.OLLAMA_HOST, 'http://localhost:11434')
    : provider === 'lmstudio' ? endpointHost(env.LMSTUDIO_BASE, 'http://localhost:1234') : null;
  if (!host) return 'unknown';
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return 'remote';
  // A loopback gateway can still relay to the cloud. Require local weight metadata.
  if (provider === 'ollama' && modelInfo?.digest && Number(modelInfo.size) > 0
      && modelInfo.details?.parameter_size) return 'local';
  if (provider === 'lmstudio' && modelInfo?.state === 'loaded' && modelInfo?.quantization
      && modelInfo?.type === 'llm') return 'local';
  return 'unknown';
}

export function executionPolicyDecision(provider, model, { profiles = {}, env = process.env, modelInfo = null } = {}) {
  const policy = profiles.defaults?.execution_policy || 'any';
  const location = executionLocation(provider, model, { env, modelInfo });
  if (!['any', 'local-only'].includes(policy)) {
    return { allowed: false, location, reason: `unknown execution policy: ${policy}` };
  }
  const allowed = policy !== 'local-only' || location === 'local';
  return { allowed, location, reason: allowed ? null : `local-only requires verified local weights; ${provider}:${model || '(default)'} is ${location}` };
}

export function makeResult(values = {}) {
  const a = values.attribution || {};
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    raw: '', exitCode: 1, durationMs: 0, artifactPath: null, patchPath: null,
    failure: null, usage: null, cost_estimate: null, structured: null,
    ...values,
    attribution: {
      requested_provider: null, requested_model: null, executed_provider: null,
      transmitted_model: null, substituted_from: null, model_correction_source: null,
      reported_model: null, identity_status: 'unresolved', model_revision: null,
      requested_effort: null, effective_effort: null, cli_version: null,
      surface: null, execution_location: 'unknown', ...a,
    },
  };
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const textOf = (value) => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter((p) => p?.type === 'text' || p?.type === 'output_text').map((p) => p.text || '').join('\n') : '';

/** Parse only vendor protocol fields, never assistant claims about model identity. */
export function parseProviderOutput(provider, stdout) {
  const text = String(stdout || '').trim();
  const out = { raw: '', reported_model: null, usage: null, cost_estimate: null, structured: null, error: null };
  let value;
  try { value = JSON.parse(text); } catch { /* JSONL, or unsupported vendor text */ }
  if (provider === 'codex') {
    const events = value ? [value] : text.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    for (const event of events) {
      if ((event.type === 'thread.started' || event.type === 'turn.started') && typeof event.model === 'string') out.reported_model = event.model;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') out.raw = textOf(event.item.text);
      if (event.type === 'turn.completed') {
        out.usage = event.usage || null;
        if (typeof event.model === 'string') out.reported_model = event.model;
        out.error = null;
      }
      if (event.type === 'turn.failed') out.error = event.error?.message || 'Codex turn failed';
    }
    if (!out.raw && !out.error) out.error = 'Codex returned no final agent message';
    return out;
  }
  if (provider === 'ollama') {
    if (!value || typeof value !== 'object') return { ...out, error: 'Invalid Ollama response' };
    out.raw = textOf(value.response || value.message?.content);
    out.reported_model = typeof value.model === 'string' ? value.model : null;
    out.error = value.error ? String(value.error) : null;
    out.usage = { input_tokens: finite(value.prompt_eval_count), output_tokens: finite(value.eval_count) };
    return out;
  }
  if (provider === 'lmstudio') {
    if (!value || typeof value !== 'object') return { ...out, error: 'Invalid LM Studio response' };
    out.raw = textOf(value.choices?.[0]?.message?.content);
    out.reported_model = typeof value.model === 'string' ? value.model : null;
    out.usage = value.usage || null;
    out.error = value.error ? String(value.error.message || value.error) : null;
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    out.raw = textOf(value.result) || textOf(value.response) || textOf(value.content)
      || textOf(value.message?.content) || textOf(value.text);
    out.structured = value.structured_output ?? null;
    if (out.structured != null) out.raw = JSON.stringify(out.structured);
    out.reported_model = typeof value.model === 'string' ? value.model : null;
    if (!out.reported_model && value.modelUsage && Object.keys(value.modelUsage).length === 1) {
      out.reported_model = Object.keys(value.modelUsage)[0];
    }
    out.usage = value.usage || value.modelUsage || null;
    out.cost_estimate = finite(value.total_cost_usd ?? value.cost_usd);
    if (value.is_error || value.error || (value.type === 'result' && value.subtype && value.subtype !== 'success')) {
      out.error = String(value.error?.message || value.error || value.errors?.join('; ') || out.raw || 'Provider reported an unsuccessful result');
    }
    return out;
  }
  // Only adapters which have no native JSON contract may use plain text.
  if (provider === 'lemonade') out.raw = text;
  else out.error = 'Provider returned no valid machine result';
  return out;
}
