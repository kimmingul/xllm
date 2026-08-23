#!/usr/bin/env node
/**
 * Provider tables and vocabulary — the one leaf every other xllm module can
 * import without pulling in the advisor.
 *
 * This file must stay side-effect free and must never import from
 * xllm-advisor.js. Extracting it was the precondition the design review
 * identified: without it, any module split re-imports the advisor to reach
 * these tables and the facade/leaf pair goes circular (ESM surfaces that as a
 * TDZ error at load time).
 */

export const PROVIDER_BINARIES = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'agy',
  grok: 'grok',
  cursor: 'cursor-agent',
  ollama: 'ollama',
  lmstudio: 'curl',
  lemonade: 'lemonade',
};

export const CLOUD_PROVIDERS = [
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'grok',
  'cursor',
];

export const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'lemonade'];

export const KNOWN_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
