#!/usr/bin/env node
/**
 * Routing-policy regressions (node:test). Behavior only: strict evidence
 * identity, execution-policy boundary, health observation, tiebreak
 * identity, setup plans. Deterministic: no network, no spawned CLIs, temp dirs.
 *
 *   node --test scripts/test-routing-policy.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evidenceKey } from './xllm-evidence.js';
import {
  deriveTraitProfiles,
  healthDecision,
  resolveCandidateEvidence,
  adherenceVeto,
  loadTraits,
  TRAIT_GATES,
} from './xllm-traits.js';
import {
  pickAdvisorForRole,
  suggestTiebreaker,
  resolveSetupPlan,
  recommendPacks,
  RoutingUnsatisfiableError,
} from './xllm-routing.js';
import {
  recordProviderResult,
  readHealthCache,
  preserveAuthObservations,
} from './xllm-health.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();
const HOUR = 3600 * 1000;
const iso = (agoMs = HOUR) => new Date(NOW - agoMs).toISOString();

const profiles = (extra = {}) => ({
  defaults: {
    analysis_provider: 'codex',
    design_provider: 'antigravity',
    design_fallback: 'gemini',
    ...(extra.defaults || {}),
  },
  providers: {
    codex: { default_model: '', tier: 'strong', relative_cost: 7 },
    grok: { default_model: '', tier: 'strong', relative_cost: 6 },
    claude: { default_model: '', tier: 'strong', relative_cost: 7 },
    gemini: { default_model: '', tier: 'balanced', relative_cost: 4 },
    ollama: { default_model: 'llama3.2', tier: 'local', relative_cost: 0 },
    lmstudio: { default_model: '', tier: 'local', relative_cost: 0 },
  },
  ...(extra.roles ? { roles: extra.roles } : {}),
});
const LOCAL_ONLY = profiles({ defaults: { execution_policy: 'local-only' } });

/** Envelope attribution of a resolved run. */
const attr = (provider, model, o = {}) => ({
  requested_provider: provider,
  requested_model: '',
  executed_provider: provider,
  transmitted_model: null,
  substituted_from: null,
  model_correction_source: null,
  reported_model: model,
  identity_status: 'resolved',
  model_revision: null,
  requested_effort: 'xhigh',
  effective_effort: 'xhigh',
  cli_version: '1.2.3',
  surface: 'cli-agentic',
  execution_location: 'remote',
  ...o,
});

const localInfo = (digest, name = 'm') => ({
  name,
  digest,
  size: 2_000_000_000,
  details: { parameter_size: '3B' },
});
const inventory = (providers) => ({ inventory_version: 2, providers });

const contractsSnapshot = (versions, extra = {}) => ({
  probed_at: iso(HOUR),
  providers: Object.fromEntries(
    Object.entries(versions).map(([p, v]) => [p, { version: v, failure: null, probed_at: iso(HOUR) }])
  ),
  auth: {},
  ...extra,
});

/** 4 tasks × 3 defects, `hitsPerTask` hits each, each backed by 3 repeats. */
const benchRows = (key, hitsPerTask, { runs = 3, runId = 'r1' } = {}) => {
  const rows = [];
  for (let t = 1; t <= 4; t++) {
    for (let d = 1; d <= 3; d++) {
      const hit = d <= hitsPerTask;
      rows.push({
        run_id: runId,
        created_at: iso(HOUR),
        evidence_key: key,
        spec: 'display-only',
        task_id: `t${t}`,
        defect_id: `d${d}`,
        runs_n: runs,
        hits_n: hit ? runs : 0,
        hits_upper_n: hit ? runs : 0,
        uncertain_runs: 0,
        mean_duration_ms: 100,
      });
    }
  }
  return rows;
};

const ledgerPanel = (specToAttr, adherence = 'first') => ({
  type: 'panel',
  run_id: `p-${Math.random()}`,
  created_at: iso(HOUR),
  adherence: Object.fromEntries(Object.keys(specToAttr).map((s) => [s, { [adherence]: 1 }])),
  attributions: specToAttr,
});

const CRITIC_OPTS = (extra = {}) => ({
  profiles: profiles(),
  taskText: 'find bugs',
  intensity: 'high',
  forceCli: true,
  readyProviders: ['grok', 'codex'],
  readySource: 'detected',
  env: {},
  ...extra,
});

// ---------------------------------------------------------------------------
// Strict evidence identity
// ---------------------------------------------------------------------------

test('traits: legacy, mutable and unresolved records are never evidence', () => {
  const t = deriveTraitProfiles({
    now: NOW,
    ledgerRecords: [
      // legacy: adherence by bare spec, no envelope attribution
      { type: 'panel', run_id: 'old', created_at: iso(), adherence: { codex: { first: 5, failed: 5 } } },
      // mutable alias identity
      ledgerPanel({ 'claude:sonnet': attr('claude', 'sonnet', { identity_status: 'mutable' }) }),
      // unresolved
      ledgerPanel({ grok: attr('grok', null, { identity_status: 'unresolved' }) }),
      // resolved → the only evidence
      ledgerPanel({ codex: attr('codex', 'gpt-5.5') }),
    ],
  });
  const keys = Object.keys(t.evidence);
  assert.equal(keys.length, 1);
  assert.equal(t.evidence[keys[0]].identity.reported_model, 'gpt-5.5');
  assert.equal(t.excluded.ledger_no_evidence, 3);
  // The 5/5 legacy failures attributed to bare "codex" did not poison the resolved key.
  assert.equal(t.evidence[keys[0]].structured_output.failed, 0);
});

test('traits: conflicting per-spec attributions are not evidence', () => {
  const rec = ledgerPanel({ codex: attr('codex', 'gpt-5.5') });
  rec.attribution_conflicts = { codex: [attr('codex', 'gpt-5.5'), attr('codex', 'gpt-5.4')] };
  const t = deriveTraitProfiles({ now: NOW, ledgerRecords: [rec] });
  assert.deepEqual(Object.keys(t.evidence), []);
});

test('traits: bench opportunities need repeats, majority hit, and certainty', () => {
  const key = evidenceKey(attr('codex', 'gpt-5.5'));
  const once = deriveTraitProfiles({ now: NOW, benchEvidence: benchRows(key, 3, { runs: 1 }) });
  assert.equal(once.evidence[key], undefined, 'runs=1 regression data is not routable');
  assert.ok(once.excluded.bench_below_min_runs > 0);

  const ok = deriveTraitProfiles({ now: NOW, benchEvidence: benchRows(key, 3, { runs: TRAIT_GATES.bench_min_runs }) });
  assert.equal(ok.evidence[key].bench_defect_detection.n, 12);
  assert.equal(ok.evidence[key].bench_defect_detection.gated, true);

  const uncertain = benchRows(key, 3).map((r) => ({ ...r, hits_n: 1, hits_upper_n: 3 })); // 1/3 vs 3/3 disagree on majority
  const u = deriveTraitProfiles({ now: NOW, benchEvidence: uncertain });
  assert.equal(u.evidence[key], undefined);
  assert.equal(u.excluded.bench_uncertain, 12);
});

test('traits: a rerun does not manufacture n (newest per opportunity wins)', () => {
  const key = evidenceKey(attr('codex', 'gpt-5.5'));
  const older = benchRows(key, 3, { runId: 'a' }).map((r) => ({ ...r, created_at: iso(5 * HOUR) }));
  const newer = benchRows(key, 0, { runId: 'b' });
  const t = deriveTraitProfiles({ now: NOW, benchEvidence: [...older, ...newer] });
  assert.equal(t.evidence[key].bench_defect_detection.n, 12);
  assert.equal(t.evidence[key].bench_defect_detection.detected, 0);
});

// ---------------------------------------------------------------------------
// Candidate keys: current identity, never inferred from the request
// ---------------------------------------------------------------------------

const keyedTraits = ({ cli = '1.2.3', probeVersion = 'codex-cli 1.2.3', observedAgo = HOUR, effort = 'xhigh' } = {}) => {
  const a = attr('codex', 'gpt-5.5', { cli_version: cli, requested_effort: effort, effective_effort: effort });
  const rec = ledgerPanel({ codex: a });
  rec.created_at = iso(observedAgo);
  return deriveTraitProfiles({
    now: NOW,
    ledgerRecords: [rec],
    contracts: contractsSnapshot({ codex: probeVersion }),
    env: {},
  });
};

test('candidate evidence: observed identity + same CLI cohort + same effort resolves', () => {
  const t = keyedTraits();
  const r = resolveCandidateEvidence('codex', '', 'xhigh', t, { now: NOW });
  assert.equal(r.key, evidenceKey(attr('codex', 'gpt-5.5')));
  assert.equal(r.basis, 'observed-identity');
});

test('candidate evidence: different effort, CLI version change, or stale alias identity → no key', () => {
  assert.equal(resolveCandidateEvidence('codex', '', 'low', keyedTraits(), { now: NOW }).key, null);
  const bumped = keyedTraits({ probeVersion: 'codex-cli 1.3.0' });
  const r = resolveCandidateEvidence('codex', '', 'xhigh', bumped, { now: NOW });
  assert.equal(r.key, null);
  assert.match(r.reason, /CLI/);
  const stale = keyedTraits({ observedAgo: 30 * 24 * HOUR });
  assert.equal(resolveCandidateEvidence('codex', '', 'xhigh', stale, { now: NOW }).key, null);
});

test('candidate evidence: no fresh probe → CLI version unknown → no key', () => {
  const a = attr('codex', 'gpt-5.5');
  const t = deriveTraitProfiles({ now: NOW, ledgerRecords: [ledgerPanel({ codex: a })], contracts: null });
  const r = resolveCandidateEvidence('codex', '', 'xhigh', t, { now: NOW });
  assert.equal(r.key, null);
});

test('candidate evidence: explicit immutable ID matches by REPORTED model; an unobserved alias never does', () => {
  const t = keyedTraits();
  const exact = resolveCandidateEvidence('codex', 'gpt-5.5', 'xhigh', t, { now: NOW });
  assert.equal(exact.basis, 'explicit-immutable-id');
  assert.equal(exact.key, evidenceKey(attr('codex', 'gpt-5.5')));
  // 'latest' is mutable: the request is not an identity and was never observed.
  assert.equal(resolveCandidateEvidence('codex', 'gpt-5.5:latest', 'xhigh', t, { now: NOW }).key, null);
});

// ---------------------------------------------------------------------------
// Measured routing uses only keyed evidence
// ---------------------------------------------------------------------------

function measuredWorld({ benchRunsFor = 3, grokVersion = '1.2.3' } = {}) {
  const grokAttr = attr('grok', 'grok-4.5');
  const codexAttr = attr('codex', 'gpt-5.5');
  const gk = evidenceKey(grokAttr);
  const ck = evidenceKey(codexAttr);
  return deriveTraitProfiles({
    now: NOW,
    ledgerRecords: [ledgerPanel({ grok: grokAttr, codex: codexAttr })],
    benchEvidence: [
      ...benchRows(gk, 1, { runs: benchRunsFor }), // baseline weak: 4/12
      ...benchRows(ck, 3, { runs: benchRunsFor }), // challenger 12/12
    ],
    contracts: contractsSnapshot({ grok: `grok ${grokVersion}`, codex: 'codex-cli 1.2.3' }),
    env: {},
  });
}

test('pick: measured keyed evidence promotes the better candidate with its basis shown', () => {
  const cold = pickAdvisorForRole('critic', CRITIC_OPTS());
  assert.equal(cold.provider, 'grok');
  const traits = measuredWorld();
  const pick = pickAdvisorForRole('critic', CRITIC_OPTS({ traits }));
  assert.equal(pick.provider, 'codex');
  assert.equal(pick.measured_basis.status, 'measured');
  assert.equal(pick.trait_decisions.at(-1).via, 'lcb-margin');
});

test('pick: no measured basis is stated, and ordering stays at the legacy baseline', () => {
  // Bench rows exist but only below the repeat gate → no routable evidence.
  const pick = pickAdvisorForRole('critic', CRITIC_OPTS({ traits: measuredWorld({ benchRunsFor: 1 }) }));
  assert.equal(pick.provider, 'grok');
  assert.equal(pick.measured_basis.status, 'none');
  assert.match(pick.reason, /no measured basis/);
});

test('pick: a CLI version change drops the old cohort instead of reusing it', () => {
  const pick = pickAdvisorForRole('critic', CRITIC_OPTS({ traits: measuredWorld({ grokVersion: '9.9.9' }) }));
  assert.equal(pick.provider, 'grok');
  assert.equal(pick.measured_basis.status, 'none');
  assert.match(pick.measured_basis.detail, /CLI/);
});

test('pick: architecture has no benchmark → never routed on measured quality', () => {
  const pick = pickAdvisorForRole(
    'architecture',
    CRITIC_OPTS({ traits: measuredWorld(), readyProviders: ['codex', 'grok'] })
  );
  assert.equal(pick.measured_basis.status, 'not-applicable');
  assert.equal(pick.provider, 'codex'); // route order, untouched by bench rows
});

// ---------------------------------------------------------------------------
// Execution policy boundary
// ---------------------------------------------------------------------------

test('local-only: cloud candidates are refused even with an explicit --ready list', () => {
  assert.throws(
    () => pickAdvisorForRole('critic', { ...CRITIC_OPTS({ profiles: LOCAL_ONLY }), readySource: 'explicit' }),
    (e) => e instanceof RoutingUnsatisfiableError && e.refusals.length > 0 && /local-only/.test(e.message)
  );
});

test('local-only: a role pin cannot bypass the policy', () => {
  const pinned = profiles({ defaults: { execution_policy: 'local-only' }, roles: { critic: 'codex@high' } });
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ profiles: pinned })),
    RoutingUnsatisfiableError
  );
});

test('local-only: only a model with verified local metadata is routable', () => {
  const opts = CRITIC_OPTS({ profiles: LOCAL_ONLY, readyProviders: ['ollama'] });
  // No metadata → location unknown → fails closed.
  assert.throws(() => pickAdvisorForRole('critic', opts), RoutingUnsatisfiableError);
  const inv = inventory({ ollama: { model_details: { 'llama3.2:latest': localInfo('sha256:aaa') } } });
  const pick = pickAdvisorForRole('critic', { ...opts, inventory: inv });
  assert.equal(pick.provider, 'ollama');
  assert.equal(pick.execution_policy.location, 'local');
  assert.equal(pick.use_native, false);
});

test('local-only: host-native execution is refused (location unverifiable)', () => {
  const inv = inventory({ ollama: { model_details: { 'llama3.2:latest': localInfo('sha256:aaa') } } });
  assert.throws(
    () => pickAdvisorForRole('explore', { profiles: LOCAL_ONLY, forceNative: true, readyProviders: ['ollama'], inventory: inv, env: {} }),
    RoutingUnsatisfiableError
  );
  const p = pickAdvisorForRole('explore', { profiles: LOCAL_ONLY, readyProviders: ['ollama'], inventory: inv, env: {} });
  assert.equal(p.use_native, false); // explore prefers native; policy overrides
});

test('a loopback model served from the cloud is remote, not local, and its cost is not zero', () => {
  const cloudInv = inventory({
    ollama: {
      model_details: {
        'glm-5.2:cloud': { ...localInfo('sha256:bbb'), remote_model: 'glm-5.2', remote_host: 'https://ollama.com' },
      },
    },
  });
  const base = { taskText: 'fix typo', forceCli: true, readyProviders: ['ollama'], model: 'glm-5.2:cloud', inventory: cloudInv, env: {} };
  assert.throws(
    () => pickAdvisorForRole('docs', { ...base, profiles: LOCAL_ONLY }),
    RoutingUnsatisfiableError
  );
  const any = pickAdvisorForRole('docs', { ...base, profiles: profiles() });
  assert.equal(any.execution_policy.location, 'remote');
  assert.ok(any.cost.relative_cost > 0, 'unknown cloud cost must not become zero');
  assert.match(any.cost.cost_basis, /unknown-remote/);
});

test('safety-unverified advisors (inventory advisor_eligible === false) are refused; missing field is not', () => {
  const inv = inventory({ codex: { advisor_eligible: false }, grok: { advisor_eligible: false } });
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ inventory: inv })),
    (e) => e instanceof RoutingUnsatisfiableError && /safety unverified/.test(e.message)
  );
  const unknown = pickAdvisorForRole('critic', CRITIC_OPTS({ inventory: inventory({ grok: {} }) }));
  assert.equal(unknown.provider, 'grok');
});

// ---------------------------------------------------------------------------
// Health: observed failures veto; no dead fallback
// ---------------------------------------------------------------------------

const authDead = { kind: 'auth', retryable: false, fresh: true, blocking_source: 'auth' };

test('pick: when every candidate is health-vetoed the pick fails instead of returning a dead one', () => {
  const traits = { version: 2, evidence: {}, specs: {}, health: { grok: authDead, codex: authDead } };
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ traits })),
    (e) => e instanceof RoutingUnsatisfiableError && e.refusals.every((r) => r.kind === 'health')
  );
});

test('pick: an observed auth failure vetoes even explicit --ready and pins (no override)', () => {
  const traits = { version: 2, evidence: {}, specs: {}, health: { grok: authDead } };
  assert.equal(pickAdvisorForRole('critic', CRITIC_OPTS({ traits })).provider, 'codex');
  // Explicit ready list: still skips the known-dead login.
  assert.equal(pickAdvisorForRole('critic', CRITIC_OPTS({ traits, readySource: 'explicit' })).provider, 'codex');
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ traits, readySource: 'explicit', readyProviders: ['grok'] })),
    RoutingUnsatisfiableError
  );
  // Profile pin: same.
  const pinned = profiles({ roles: { critic: 'grok@high' } });
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ traits, profiles: pinned, readyProviders: ['grok'] })),
    RoutingUnsatisfiableError
  );
});

test('pick: non-auth health kinds keep their weaker rules (explicit ready and pins stay authoritative)', () => {
  const drift = { kind: 'contract-drift', retryable: false, fresh: true, blocking_source: 'flags' };
  const traits = { version: 2, evidence: {}, specs: {}, health: { grok: drift } };
  assert.equal(pickAdvisorForRole('critic', CRITIC_OPTS({ traits })).provider, 'codex');
  assert.equal(pickAdvisorForRole('critic', CRITIC_OPTS({ traits, readySource: 'explicit' })).provider, 'grok');
  const pinned = profiles({ roles: { critic: 'grok@high' } });
  assert.equal(pickAdvisorForRole('critic', CRITIC_OPTS({ traits, profiles: pinned, readyProviders: ['grok'] })).provider, 'grok');
});

test('pick: no ready route provider falls back only to a ready one that is healthy and allowed', () => {
  const traits = { version: 2, evidence: {}, specs: {}, health: { claude: authDead } };
  const ok = pickAdvisorForRole('critic', CRITIC_OPTS({ traits, readyProviders: ['gemini', 'claude'] }));
  assert.equal(ok.provider, 'gemini');
  assert.throws(
    () => pickAdvisorForRole('critic', CRITIC_OPTS({ traits, readyProviders: ['claude'] })),
    RoutingUnsatisfiableError
  );
});

// ---------------------------------------------------------------------------
// Auth observation cache (own timestamp, context, no secrets)
// ---------------------------------------------------------------------------

function tmpEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-health-'));
  return { dir, env: { XLLM_HOME: dir, HOME: dir, USERPROFILE: dir, ...extra } };
}

test('health: an observed auth failure vetoes; the same fact under a changed account context does not', () => {
  const { dir, env } = tmpEnv({ OPENAI_API_KEY: 'sk-super-secret-value' });
  try {
    recordProviderResult(
      { exitCode: 1, failure: { kind: 'auth', retryable: false }, attribution: { executed_provider: 'codex', cli_version: 'codex-cli 1.2.3' } },
      { env, now: NOW - HOUR }
    );
    const cache = readHealthCache(env);
    assert.equal(cache.auth.codex.auth_verified, false);
    assert.ok(!JSON.stringify(cache).includes('sk-super-secret-value'), 'secret must never be persisted');

    const probed = { ...cache, probed_at: iso(HOUR), providers: { codex: { version: 'codex-cli 1.2.3', failure: null } } };
    const same = deriveTraitProfiles({ now: NOW, contracts: probed, env });
    assert.equal(same.health.codex.auth.status, 'failed');
    assert.equal(healthDecision('codex', same.health), 'veto');

    const rotated = deriveTraitProfiles({ now: NOW, contracts: probed, env: { ...env, OPENAI_API_KEY: 'sk-other' } });
    assert.equal(rotated.health.codex.auth.status, 'unknown');
    assert.equal(healthDecision('codex', rotated.health), 'ignore'); // unknown never vetoes
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health: runtime success/failure observation ignores dry runs and non-auth failures', () => {
  const { dir, env } = tmpEnv();
  try {
    const base = { attribution: { executed_provider: 'codex', cli_version: '1.2.3' } };
    assert.equal(recordProviderResult({ ...base, exitCode: 0, dryRun: true }, { env }), null);
    assert.equal(recordProviderResult({ ...base, exitCode: 1, failure: { kind: 'timeout' } }, { env }), null);
    assert.equal(recordProviderResult({ exitCode: 1, failure: { kind: 'auth' }, attribution: { executed_provider: 'ollama' } }, { env }), null);
    assert.equal(readHealthCache(env), null);
    assert.equal(recordProviderResult({ ...base, exitCode: 0 }, { env }).auth_verified, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health: a token-free probe preserves auth with its own timestamp; version or context change drops it', () => {
  const { dir, env } = tmpEnv({ ANTHROPIC_API_KEY: 'k1' });
  try {
    recordProviderResult(
      { exitCode: 0, attribution: { executed_provider: 'claude', cli_version: 'claude 2.1.0' } },
      { env, now: NOW - 5 * HOUR }
    );
    const previous = readHealthCache(env);
    const kept = preserveAuthObservations(previous, { claude: { version: '2.1.0 (Claude Code)' } }, env);
    assert.equal(kept.claude.observed_at, previous.auth.claude.observed_at);
    assert.deepEqual(preserveAuthObservations(previous, { claude: { version: '2.2.0' } }, env), {});
    assert.deepEqual(preserveAuthObservations(previous, { claude: { version: '2.1.0' } }, { ...env, ANTHROPIC_BASE_URL: 'https://proxy.example' }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health: a past-TTL failure observation no longer vetoes', () => {
  const { dir, env } = tmpEnv();
  try {
    recordProviderResult(
      { exitCode: 1, failure: { kind: 'auth' }, attribution: { executed_provider: 'codex', cli_version: '1.2.3' } },
      { env, now: NOW - 48 * HOUR }
    );
    const t = deriveTraitProfiles({ now: NOW, contracts: readHealthCache(env), env });
    assert.equal(healthDecision('codex', t.health), 'ignore');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tiebreak: model identity, not transport
// ---------------------------------------------------------------------------

test('tiebreak: a different proven local model on the same runtime is a valid tiebreaker', () => {
  const inv = inventory({
    ollama: {
      model_details: {
        'llama3.2:latest': localInfo('sha256:aaa'),
        'qwen3:8b': localInfo('sha256:bbb'),
      },
    },
  });
  const s = suggestTiebreaker(['ollama:llama3.2'], ['ollama'], [], profiles(), null, { inventory: inv, env: {} });
  assert.equal(s.provider, 'ollama:qwen3:8b');
  assert.equal(s.runtime, 'ollama');
  assert.ok(s.refusals.some((r) => r.kind === 'same-identity'));
});

test('tiebreak: two names for identical weights count once', () => {
  const inv = inventory({
    ollama: { model_details: { 'a:latest': localInfo('sha256:same'), 'b:latest': localInfo('sha256:same') } },
  });
  const s = suggestTiebreaker(['codex'], ['ollama'], [], profiles(), null, { inventory: inv, env: {} });
  assert.ok(s.provider);
  assert.equal(s.refusals.filter((r) => r.kind === 'same-identity').length, 1);
  // …and if one of them is already on the panel, neither is a fresh voice.
  const none = suggestTiebreaker(['ollama:a:latest'], ['ollama'], [], profiles(), null, { inventory: inv, env: {} });
  assert.equal(none.provider, null);
});

test('tiebreak: the same model name via another transport is not diversity', () => {
  const s = suggestTiebreaker(['ollama:gemma4:cloud'], ['grok:gemma4'], [], profiles(), null, { env: {} });
  assert.equal(s.provider, null);
  assert.match(s.reason, /same underlying model/);
});

test('tiebreak: execution policy applies to explicit ready lists', () => {
  const inv = inventory({ ollama: { model_details: { 'qwen3:8b': localInfo('sha256:bbb') } } });
  const s = suggestTiebreaker(['grok'], ['codex', 'ollama'], [], LOCAL_ONLY, null, { inventory: inv, env: {}, readySource: 'explicit' });
  assert.equal(s.provider, 'ollama:qwen3:8b');
  const none = suggestTiebreaker(['grok'], ['codex', 'gemini'], [], LOCAL_ONLY, null, { env: {}, readySource: 'explicit' });
  assert.equal(none.provider, null);
  assert.ok(none.refusals.every((r) => r.kind === 'policy'));
});

test('tiebreak: agreement is matched by evidence identity; legacy spec-string rows are ignored', () => {
  const g = attr('grok', 'grok-4.5', { requested_effort: null, effective_effort: null });
  const c = attr('codex', 'gpt-5.5', { requested_effort: null, effective_effort: null });
  const m = attr('gemini', 'gemini-3', { requested_effort: null, effective_effort: null });
  const traits = deriveTraitProfiles({
    now: NOW,
    ledgerRecords: [ledgerPanel({ grok: g, codex: c, gemini: m })],
    contracts: contractsSnapshot({ grok: '1.2.3', codex: '1.2.3', gemini: '1.2.3' }),
    env: {},
  });
  const [gk, ck, mk] = [g, c, m].map(evidenceKey);
  const matrix = [
    { pair: 'grok ↔ codex', agreement_rate: 0.0 }, // legacy: no evidence → must not count
    { pair: 'grok ↔ codex', evidence: [gk, ck].sort(), comparable_runs: 4, agreement_rate: 0.9 },
    { pair: 'grok ↔ gemini', evidence: [gk, mk].sort(), comparable_runs: 4, agreement_rate: 0.2 },
  ];
  const s = suggestTiebreaker(['grok'], ['codex', 'gemini'], matrix, profiles(), traits, { env: {}, panelEvidence: [gk] });
  assert.equal(s.provider, 'gemini');
  assert.equal(s.measured_agreement, 0.2);
});

test('tiebreak: adherence veto reads the candidate evidence identity only', () => {
  const c = attr('codex', 'gpt-5.5', { requested_effort: null, effective_effort: null });
  const failing = Array.from({ length: 12 }, () => ledgerPanel({ codex: c }, 'failed'));
  const traits = deriveTraitProfiles({
    now: NOW,
    ledgerRecords: failing,
    contracts: contractsSnapshot({ codex: '1.2.3', gemini: '1.2.3' }),
    env: {},
  });
  assert.equal(adherenceVeto(evidenceKey(c), traits), true);
  assert.equal(adherenceVeto('codex', traits), false, 'bare spec string is not a key');
  const s = suggestTiebreaker(['grok'], ['codex', 'gemini'], [], profiles(), traits, { env: {} });
  assert.equal(s.provider, 'gemini');
  assert.ok(s.refusals.some((r) => r.kind === 'adherence'));
});

// ---------------------------------------------------------------------------
// Setup plans
// ---------------------------------------------------------------------------

const setupInv = () =>
  inventory({
    codex: { installed: true, healthy: true, kind: 'cloud', tier: 'strong', relative_cost: 7, advisor_eligible: true },
    grok: { installed: true, healthy: true, kind: 'cloud', tier: 'strong', relative_cost: 6, advisor_eligible: false },
    ollama: {
      installed: true,
      healthy: true,
      kind: 'local',
      tier: 'local',
      relative_cost: 0,
      advisor_eligible: true,
      models: ['llama3.2:latest', 'gpt-oss:cloud', 'mystery:1b'],
      model_details: {
        'llama3.2:latest': localInfo('sha256:aaa'),
        'gpt-oss:cloud': { ...localInfo('sha256:ccc'), remote_model: 'gpt-oss', remote_host: 'https://ollama.com' },
        'mystery:1b': { name: 'mystery:1b' }, // no digest/size → not demonstrable
      },
    },
  });

test('setup local pack: only demonstrably local models are pinned; policy is persisted', () => {
  const plan = resolveSetupPlan(setupInv(), { pack: 'local', env: {} });
  assert.equal(plan.execution_policy, 'local-only');
  assert.equal(plan.ok, true);
  for (const spec of Object.values(plan.roles)) assert.match(spec, /^ollama:llama3\.2:latest@/);
});

test('setup local pack: no verified local model → unsatisfiable, nothing pinned', () => {
  const inv = setupInv();
  delete inv.providers.ollama.model_details['llama3.2:latest'];
  const plan = resolveSetupPlan(inv, { pack: 'local', env: {} });
  assert.equal(plan.ok, false);
  assert.equal(plan.unsatisfiable, true);
  assert.deepEqual(Object.values(plan.roles), [null, null, null]);
  assert.match(plan.error, /demonstrably local/);
});

test('setup: a role override cannot bypass local-only', () => {
  const plan = resolveSetupPlan(setupInv(), { pack: 'local', env: {}, overrides: { critic: 'codex@high' } });
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.role === 'critic' && /local-only/.test(e.reason)));
  assert.match(plan.roles.critic, /^ollama:/, 'refused override leaves the policy-satisfying pin');
});

test('setup: other packs preserve a persisted local-only policy (no cloud pins, no relaxing)', () => {
  const plan = resolveSetupPlan(setupInv(), { pack: 'quality', executionPolicy: 'local-only', env: {} });
  assert.equal(plan.execution_policy, 'local-only');
  for (const spec of Object.values(plan.roles)) assert.ok(spec === null || spec.startsWith('ollama:'));
  const noLocal = setupInv();
  noLocal.providers.ollama.model_details = {};
  noLocal.providers.ollama.models = [];
  const bad = resolveSetupPlan(noLocal, { pack: 'balanced', executionPolicy: 'local-only', env: {} });
  assert.equal(bad.ok, false);
});

test('setup: safety-unverified providers are never pinned; cloud-served ollama models are not local', () => {
  const plan = resolveSetupPlan(setupInv(), { pack: 'quality', env: {} });
  assert.equal(plan.execution_policy, 'any');
  for (const spec of Object.values(plan.roles)) assert.ok(!/^grok/.test(spec ?? ''));
  assert.match(plan.roles.analysis, /^codex@/);
  assert.ok(!Object.values(plan.roles).some((s) => /cloud|mystery/.test(s ?? '')));
});

test('setup: `local` is only recommended when local weights are demonstrable', () => {
  assert.ok(recommendPacks(setupInv(), { env: {} }).includes('local'));
  const inv = setupInv();
  inv.providers.ollama.model_details = {};
  assert.ok(!recommendPacks(inv, { env: {} }).includes('local'));
});

// ---------------------------------------------------------------------------
// loadTraits integration: legacy ledger never routes
// ---------------------------------------------------------------------------

test('loadTraits: a legacy ledger (no attribution) produces no routable evidence and counts the exclusion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-traits-'));
  const prevState = process.env.XLLM_STATE_DIR;
  try {
    process.env.XLLM_STATE_DIR = '.state';
    fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.state', 'panel-ledger.jsonl'),
      JSON.stringify({ type: 'panel', run_id: 'x', created_at: iso(), adherence: { codex: { first: 3 } } }) + '\n'
    );
    const t = loadTraits(dir, { env: { XLLM_HOME: dir }, now: NOW });
    assert.deepEqual(t.evidence, {});
    assert.equal(t.excluded.ledger_no_evidence, 1);
    assert.deepEqual(t.health, {});
  } finally {
    if (prevState === undefined) delete process.env.XLLM_STATE_DIR;
    else process.env.XLLM_STATE_DIR = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Model-level candidates in pick (inventory expansion, no placeholder default)
// ---------------------------------------------------------------------------

const mixedOllamaInventory = () =>
  inventory({
    ollama: {
      model_details: {
        'llama3.2:latest': localInfo('sha256:aaa'),
        'gpt-oss:cloud': { ...localInfo('sha256:ccc'), remote_model: 'gpt-oss', remote_host: 'https://ollama.com' },
        'mystery:1b': { name: 'mystery:1b' }, // no digest/size → not demonstrably local
      },
    },
  });
const noDefaultProfiles = (policy) => {
  const p = profiles({ defaults: policy ? { execution_policy: policy } : {} });
  p.providers.ollama.default_model = ''; // no placeholder default, no role pin
  return p;
};

test('pick: local-only + verified local inventory + no default/pin → a concrete verified model; :cloud and unverified excluded', () => {
  const pick = pickAdvisorForRole('critic', {
    ...CRITIC_OPTS({ profiles: noDefaultProfiles('local-only'), readyProviders: ['ollama'] }),
    inventory: mixedOllamaInventory(),
  });
  assert.equal(pick.provider, 'ollama');
  assert.equal(pick.model, 'llama3.2:latest');
  assert.match(pick.spec, /^ollama:llama3\.2:latest@/, 'the winning model is carried into the spec');
  assert.equal(pick.execution_policy.location, 'local');
  const refused = pick.policy_refusals.map((r) => r.model);
  assert.ok(refused.includes('gpt-oss:cloud') && refused.includes('mystery:1b'));
});

test('pick: local-only with only cloud-served / unverified models is unsatisfiable (no provider-default fallback)', () => {
  const inv = mixedOllamaInventory();
  delete inv.providers.ollama.model_details['llama3.2:latest'];
  assert.throws(
    () =>
      pickAdvisorForRole('critic', {
        ...CRITIC_OPTS({ profiles: noDefaultProfiles('local-only'), readyProviders: ['ollama'] }),
        inventory: inv,
      }),
    RoutingUnsatisfiableError
  );
});

test('pick: policy any also routes to a concrete installed model, never the bare provider', () => {
  const pick = pickAdvisorForRole('critic', {
    ...CRITIC_OPTS({ profiles: noDefaultProfiles(), readyProviders: ['ollama'] }),
    inventory: mixedOllamaInventory(),
  });
  assert.ok(pick.model, 'a model must be selected');
  assert.notEqual(pick.model, 'mystery:1b', 'capability-floor-passing models are tried first');
  assert.ok(pick.spec.includes(pick.model));
});

test('pick: the any-ready fallback expands inventory models too, and still respects readiness', () => {
  const inv = inventory({
    lmstudio: { model_details: { 'qwen-7b': { id: 'qwen-7b', state: 'loaded', quantization: 'Q4_K_M', type: 'llm' } } },
  });
  const pick = pickAdvisorForRole('design', {
    profiles: noDefaultProfiles('local-only'),
    taskText: 'improve onboarding UX',
    forceCli: true,
    readyProviders: ['lmstudio'], // not on the design route → fallback path
    readySource: 'detected',
    inventory: inv,
    env: {},
  });
  assert.equal(pick.provider, 'lmstudio');
  assert.equal(pick.model, 'qwen-7b');
  assert.match(pick.reason, /fell back/);
  // Readiness is not bypassed: a model of a provider that is not READY is never picked.
  assert.throws(
    () =>
      pickAdvisorForRole('design', {
        profiles: noDefaultProfiles('local-only'),
        forceCli: true,
        readyProviders: ['grok'],
        inventory: inv,
        env: {},
      }),
    RoutingUnsatisfiableError
  );
});

test('pick: useTraits:false disables quality evidence only — observed auth failures still apply', () => {
  const measured = measuredWorld();
  // Quality evidence off → legacy baseline, even though bench would promote codex.
  const off = pickAdvisorForRole('critic', CRITIC_OPTS({ traits: measured, useTraits: false }));
  assert.equal(off.provider, 'grok');
  assert.equal(off.measured_basis.status, 'disabled');
  // Health from the same loaded traits still vetoes.
  const dead = { ...measured, health: { ...measured.health, grok: authDead } };
  const stillVetoed = pickAdvisorForRole('critic', CRITIC_OPTS({ traits: dead, useTraits: false }));
  assert.equal(stillVetoed.provider, 'codex');
});
