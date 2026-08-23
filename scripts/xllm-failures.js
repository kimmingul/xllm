#!/usr/bin/env node
/**
 * Failure taxonomy — how a provider CLI failed, in terms xllm can act on.
 *
 * Pure and side-effect free: it reads a spawnSync-like result object and
 * returns a classification. It must never import from xllm-advisor.js (the
 * design review named leaf-to-facade imports as the abort signal for the
 * module split). The retry execution loop deliberately stays in the advisor —
 * only the decision lives here.
 */

const AUTH_RE =
  /\b(401|403 forbidden|unauthorized|not logged in|login required|please (log ?in|sign ?in)|invalid api key|api key (missing|not set)|authentication (failed|required)|credential|token expired)\b/i;
const TRANSIENT_RE =
  /\b(429|rate limit|too many requests|overloaded|capacity|temporar(y|ily)|try again|502 bad gateway|503|504|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang ?up|network (error|failure))\b/i;

// The model name exists as a product but this credential may not use it.
// Measured 2026-08-02 on codex 0.146.0:
//   "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account"
// This is a permission failure, not a model-quality failure — it must never be
// attributed to the model in traits.
const ACCOUNT_UNSUPPORTED_RE =
  /\b(not supported when using .{0,40}account|not available (on|for|with) your (plan|account|subscription|tier)|requires? (a |an )?[\w .-]{0,30}(plan|subscription|tier)|upgrade your (plan|account|subscription)|not entitled|no access to (this )?model)\b/i;

// The CLI does not know this model id at all.
// Measured 2026-08-02 on grok 0.2.118:
//   "Couldn't set model 'grok-4': Invalid params: \"unknown model id\""
const UNKNOWN_MODEL_RE =
  /\b(unknown model( id)?|model not found|no such model|invalid model|unrecognized model|unsupported model|model .{0,40} (does not exist|is not valid)|model metadata for .{0,40} not found)\b/i;

/**
 * How each CLI reports the model ids it will accept. Commands only — xllm does
 * not parse or cache these (that would be a roster by another name); they are
 * printed so the user can run one and read the truth from the vendor.
 * Verified 2026-08-02: `codex models` needs a TTY, so codex points at `doctor`.
 */
export const MODEL_LIST_COMMANDS = {
  codex: 'codex doctor        # shows the active model; ~/.codex/config.toml holds the pin',
  grok: 'grok models',
  antigravity: 'agy models',
  ollama: 'ollama list',
  claude: 'claude --help       # aliases such as opus/sonnet always track the latest',
};

/**
 * A model failure that traces back to `default_model` in xllm-providers.toml is
 * confusing on its own: the user never typed the name, so the CLI's error names
 * a model they did not choose. Name the pin explicitly.
 * Returns null when the failing model did not come from a pin.
 */
export function stalePinHint(provider, model, profiles) {
  const pin = profiles?.providers?.[provider]?.default_model;
  if (!pin) return null;
  if (model && String(model) !== String(pin)) return null;
  return `'${pin}' came from default_model in xllm-providers.toml, not from your command — update or clear that pin (\`--set-default\` or edit .xllm/xllm-providers.toml).`;
}

/**
 * Classify a spawnSync-like result into a structured failure:
 * missing-binary / timeout / auth / account-unsupported / unknown-model /
 * transient / permanent / ok.
 * Pure — safe to unit-test with fixture objects.
 */
export function classifyFailure(result = {}) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`;
  if (
    result.error?.code === 'ENOENT' ||
    /not recognized as an internal or external command|command not found|No such file or directory/i.test(text)
  ) {
    return {
      kind: 'missing-binary',
      retryable: false,
      hint: 'Install the CLI and ensure it is on PATH.',
    };
  }
  if (result.timedOut || result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    return {
      kind: 'timeout',
      retryable: false,
      hint: 'Increase timeout or check for hangs; timeouts are usually systemic, not transient.',
    };
  }
  if ((result.status ?? 0) !== 0 && AUTH_RE.test(text)) {
    return {
      kind: 'auth',
      retryable: false,
      hint: 'Run the provider CLI login flow, then verify with `contracts --live`.',
    };
  }
  // Order matters: the account-refusal message also contains "model … is not
  // supported", so it would be misread as unknown-model if checked second.
  if ((result.status ?? 0) !== 0 && ACCOUNT_UNSUPPORTED_RE.test(text)) {
    return {
      kind: 'account-unsupported',
      retryable: false,
      hint: 'The model name exists but this account/plan cannot use it. Pick a variant this account allows — this is a permission failure, not a model-quality one, so it is not attributed to the model.',
    };
  }
  if ((result.status ?? 0) !== 0 && UNKNOWN_MODEL_RE.test(text)) {
    return {
      kind: 'unknown-model',
      retryable: false,
      hint: 'The CLI does not recognise this model id. List what it accepts and use an exact name.',
    };
  }
  if ((result.status ?? 0) !== 0 && TRANSIENT_RE.test(text)) {
    return {
      kind: 'transient',
      retryable: true,
      hint: 'Retried automatically with jittered backoff.',
    };
  }
  if ((result.status ?? 0) !== 0 || result.error) {
    return {
      kind: 'permanent',
      retryable: false,
      hint: 'Read the provider output; this is not a retry candidate.',
    };
  }
  return { kind: 'ok', retryable: false, hint: null };
}
