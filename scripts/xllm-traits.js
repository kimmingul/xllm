#!/usr/bin/env node
/**
 * xllm traits — evidence-based provider trait profiles (docs/traits-design.md).
 *
 * A DERIVED, on-demand view over the evidence streams that already exist:
 * the panel ledger (adherence, debate claim outcomes, outcomes), adjudicated
 * benchmark evidence (seeded-defect detection), and the health cache (current
 * health). Never hand-authored lore, never written back into any stream,
 * silent below explicit sample gates — cold start is bit-identical to
 * pre-traits routing.
 *
 * STRICT EVIDENCE IDENTITY. Routable measurements are keyed ONLY by
 * evidenceKey(attribution) (xllm-evidence.js): a resolved reported model
 * (+revision), effective effort, surface and CLI version cohort, taken from a
 * run's envelope. Legacy records, bare provider/spec strings, mutable aliases
 * and unresolved identities are EXCLUDED (counted, never matched by spec
 * string, never used as a fallback). A routing candidate gets a key only via
 * resolveCandidateEvidence (observed current identity or an explicit
 * immutable ID) with a fresh CLI version; the reported model is never
 * inferred from the request.
 *
 * Routable map:
 *  - bench_defect_detection (Wilson 95% LCB) → general judgment routing only
 *    (critic|verify|tests|security), may cross tier/cost under strict gates.
 *    Architecture has NO benchmark and is never routed on measured quality.
 *  - structured_output (adherence) → suggestTiebreaker veto only.
 *  - health (contracts) → kind-aware filter (see healthDecision); flags/
 *    version and auth are separate facts with their own freshness.
 *  - claim_survival / decisive_refutation / outcomes / latency → inspect-only
 *    (spec-string keyed, unverified identity).
 *
 *   node scripts/xllm-traits.js [--json]
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import { resolveStateDir } from './xllm-advisor.js';
import {
  contractsCachePath,
  normalizeCliVersion,
  authObservationValidity,
  AUTH_TTL_MS,
} from './xllm-health.js';
import { evidenceKey, isMutableModel } from './xllm-evidence.js';
import { readBenchEvidence } from './xllm-bench.js';

// Own minimal ledger reader instead of importing xllm-panel.js: panel imports
// xllm-routing.js (suggestTiebreaker) and routing imports this module — going
// through panel here would close an ESM cycle. Same file, same parse rules.
export function traitsLedgerPath(root = process.cwd()) {
  return path.join(resolveStateDir(root), 'panel-ledger.jsonl');
}

function readLedgerFile(root = process.cwd()) {
  try {
    return fs
      .readFileSync(traitsLedgerPath(root), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const TRAIT_WINDOW = {
  horizon_days: 180,
  max_structured_output: 50, // per evidence key, newest first (batch-granular stop)
  max_claims: 50,
  max_outcomes: 30,
  contracts_fresh_ms: 24 * 60 * 60 * 1000,
  /** A mutable alias (default/sonnet/latest) identity observation is trusted this long. */
  identity_fresh_ms: 7 * 24 * 60 * 60 * 1000,
};

export const TRAIT_GATES = {
  bench_min_cells: 6, // per-key non-silent
  bench_min_runs: 3, // repeats behind one adjudicated {task, defect} opportunity
  bench_min_shared_tasks: 4, // comparator precondition
  bench_min_shared_opportunities: 12, // comparator precondition
  bench_lcb_margin: 0.1, // pay-more jump: candidate LCB ≥ baseline LCB + margin
  bench_lcb_parity: 0.03, // cheaper-at-parity band
  adherence_veto_n: 10,
  adherence_veto_failed_rate: 0.25,
};

/** Roles whose general pick may consume measured bench quality. NOT architecture:
 * the shipped benchmark is defect-listing code review, not architecture review. */
export const ROUTABLE_BENCH_ROLES = ['critic', 'verify', 'tests', 'security'];

/**
 * Effort is session policy, not identity: codex:gpt-5.5@high → codex:gpt-5.5.
 * PRESENTATION / model-author identity only — never a routing evidence key.
 */
export function canonicalSpecKey(spec) {
  return String(spec || '').trim().toLowerCase().split('@')[0];
}

/** Wilson 95% lower bound — the small-n guard: 6/6 raw = 1.0 but LCB ≈ 0.61. */
export function wilson95Lower(successes, n) {
  if (!n || n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return +(((center - margin) / denom).toFixed(4));
}

/** Timestamp-less or out-of-horizon evidence never routes (design G/F2). */
function withinHorizon(iso, now, horizonDays) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now - t <= horizonDays * 86400000 && t <= now + 60000;
}

const opKey = (taskId, defectId) => `${taskId}::${defectId}`;
const normEffort = (e) => {
  const s = String(e ?? '').trim().toLowerCase();
  return s || null;
};

/** Identity fields of an evidenceKey (xllm-evidence.js layout). null if unparsable. */
export function parseEvidenceKey(key) {
  try {
    const [provider, reported_model, model_revision, effective_effort, surface, cli_version] = JSON.parse(key);
    if (!provider || !reported_model) return null;
    return {
      provider,
      reported_model,
      model_revision: model_revision ?? null,
      effective_effort: effective_effort ?? null,
      surface: surface ?? null,
      cli_version: cli_version ?? null,
    };
  } catch {
    return null;
  }
}

function emptyStructured() {
  return { first: 0, retry: 0, failed: 0, n: 0, routable: 'tiebreak_only' };
}

/**
 * Health per provider from a contracts snapshot. Flags/version and auth are
 * separate facts, each with its own timestamp/freshness. Only OBSERVED
 * failures block; unknown auth is never success and never a veto.
 */
function deriveHealth(contracts, { now, env }) {
  const health = {};
  if (!contracts || (!contracts.providers && !contracts.auth)) return health;
  const probedAt = Date.parse(contracts.probed_at || '');
  const probeFresh = Number.isFinite(probedAt) && now - probedAt <= TRAIT_WINDOW.contracts_fresh_ms;
  const known = contracts.providers || {};
  // A provider can have an auth observation (runtime/live) without a probe row.
  for (const p of new Set([...Object.keys(known), ...Object.keys(contracts.auth || {})])) {
    const r = known[p] || {};
    const flags = {
      kind: r.failure ? r.failure.kind : 'ok',
      retryable: r.failure ? !!r.failure.retryable : null,
      probed_at: r.probed_at || (known[p] ? contracts.probed_at : null) || null,
      fresh: !!known[p] && probeFresh,
    };
    const version = normalizeCliVersion(r.version);
    const a = contracts.auth && contracts.auth[p];
    const auth = { status: 'unknown', kind: null, observed_at: null, fresh: false, source: null, reason: null };
    if (a && !a.skipped && a.observed_at) {
      const validity = authObservationValidity(a, { provider: p, env, cliVersion: r.version ?? null });
      const t = Date.parse(a.observed_at);
      auth.observed_at = a.observed_at;
      auth.source = a.source || null;
      if (!validity.valid) {
        auth.reason = `observation invalidated: ${validity.reason}`;
      } else {
        auth.status = a.auth_verified === true ? 'verified' : a.auth_verified === false ? 'failed' : 'unknown';
        auth.kind = a.failure ? a.failure.kind : null;
        auth.fresh = Number.isFinite(t) && now - t <= AUTH_TTL_MS && t <= now + 60000;
        if (!auth.fresh) auth.reason = 'observation past its TTL';
      }
    }
    // Effective blocking fact: a failing flags/version probe, else an observed auth failure.
    let eff = { kind: 'ok', retryable: null, fresh: probeFresh, source: 'flags' };
    const authBlocks = auth.status === 'failed';
    if (flags.kind !== 'ok' && !(authBlocks && auth.fresh && !flags.fresh)) {
      eff = { kind: flags.kind, retryable: flags.retryable, fresh: flags.fresh, source: 'flags' };
    } else if (authBlocks) {
      eff = { kind: auth.kind || 'auth', retryable: false, fresh: auth.fresh, source: 'auth' };
    }
    health[p] = {
      kind: eff.kind,
      retryable: eff.retryable,
      probed_at: flags.probed_at,
      fresh: eff.fresh,
      blocking_source: eff.kind === 'ok' ? null : eff.source,
      version,
      flags,
      auth,
      safety: r.safety || null,
    };
  }
  return health;
}

/**
 * Pure derivation over evidence inputs. No filesystem access — unit tests
 * pass fixtures; loadTraits() does the IO.
 *
 * benchEvidence: entries from xllm-bench readBenchEvidence() — one adjudicated
 * {evidence_key, task_id, defect_id} opportunity with runs_n/hits_n repeats.
 */
export function deriveTraitProfiles({
  ledgerRecords = [],
  benchEvidence = [],
  contracts = null,
  now = Date.now(),
  horizonDays = TRAIT_WINDOW.horizon_days,
  env = process.env,
  legacyBenchFiles = 0,
} = {}) {
  const specs = {}; // spec-string keyed, INSPECT-ONLY (unverified identity)
  const warnings = [];
  const excluded = {
    no_timestamp: 0,
    ledger_no_evidence: 0, // adherence rows without a resolved envelope attribution
    bench_below_min_runs: 0,
    bench_uncertain: 0,
    legacy_bench_files: legacyBenchFiles,
  };
  const spec = (key) =>
    (specs[key] = specs[key] || {
      claim_survival: { survived: 0, killed: 0, unresolved: 0, n: 0, routable: false },
      outcome_useful_adoption: { adopted_helpful: 0, n: 0, routable: false },
    });

  const evidence = {}; // evidenceKey -> routable profile
  const observations = {}; // `${provider}\0${requested_model}\0${requested_effort}` -> newest observed identity
  const ev = (key, identity) =>
    (evidence[key] = evidence[key] || {
      key,
      identity,
      structured_output: emptyStructured(),
      bench_defect_detection: null,
      latency_ms: { attempts: 0, total_ms: 0, routable: false },
      latest_t: 0,
    });

  const observe = (a, tMs) => {
    const key = evidenceKey(a);
    if (!key) return null;
    const id = parseEvidenceKey(key);
    if (!id) return null;
    const rec0 = ev(key, id);
    rec0.latest_t = Math.max(rec0.latest_t, tMs);
    const ok = `${String(a.executed_provider).toLowerCase()}\0${String(a.requested_model || '').trim()}\0${normEffort(a.requested_effort) || ''}`;
    const prev = observations[ok];
    if (!prev || tMs > prev.t) {
      observations[ok] = {
        evidence_key: key,
        t: tMs,
        observed_at: new Date(tMs).toISOString(),
        provider: id.provider,
        requested_model: a.requested_model || null,
        requested_effort: normEffort(a.requested_effort),
        reported_model: id.reported_model,
        model_revision: id.model_revision,
        effective_effort: id.effective_effort,
        surface: id.surface,
        cli_version: a.cli_version || null,
      };
    }
    return key;
  };

  // Newest-first over the append-only ledger.
  const records = [...ledgerRecords].reverse();
  const inWindow = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (!withinHorizon(r.created_at, now, horizonDays)) {
      if (r.created_at == null) excluded.no_timestamp += 1;
      continue;
    }
    inWindow.push(r);
  }

  // structured_output: adherence joined to the envelope attribution of the SAME
  // calls. No attribution (legacy), or conflicting attributions → not evidence.
  const addAdherence = (attr, counts, tMs) => {
    const key = observe(attr, tMs);
    if (!key) {
      excluded.ledger_no_evidence += 1;
      return;
    }
    const s = evidence[key].structured_output;
    if (s.n >= TRAIT_WINDOW.max_structured_output) return;
    s.first += counts.first || 0;
    s.retry += counts.retry || 0;
    s.failed += counts.failed || 0;
    s.n = s.first + s.retry + s.failed;
  };
  const attributionFor = (r, specName) => {
    if (r.attribution_conflicts && r.attribution_conflicts[specName]) return null;
    if (r.attributions && r.attributions[specName]) return r.attributions[specName];
    const p = Array.isArray(r.panelists) ? r.panelists.find((x) => x && x.spec === specName) : null;
    return p && p.attribution ? p.attribution : null;
  };
  for (const r of inWindow) {
    const tMs = Date.parse(r.created_at);
    if ((r.type === 'panel' || r.type === 'debate' || r.type === 'council') && r.adherence && typeof r.adherence === 'object') {
      for (const [specName, c] of Object.entries(r.adherence)) {
        addAdherence(attributionFor(r, specName), c || {}, tMs);
      }
    } else if (r.type === 'panel' && Array.isArray(r.panelists)) {
      for (const p of r.panelists) {
        if (p && ['first', 'retry', 'failed'].includes(p.adherence)) {
          addAdherence(attributionFor(r, p.spec), { [p.adherence]: 1 }, tMs);
        }
      }
    } else if (r.type === 'tiebreak' && r.panelist && ['first', 'retry', 'failed'].includes(r.panelist.adherence)) {
      addAdherence(r.panelist.attribution || null, { [r.panelist.adherence]: 1 }, tMs);
    }
  }
  for (const e of Object.values(evidence)) {
    const so = e.structured_output;
    so.success_rate = so.n ? +(((so.first + so.retry) / so.n).toFixed(3)) : null;
    so.first_pass_rate = so.n ? +((so.first / so.n).toFixed(3)) : null;
  }

  // claim_survival (inspect-only): debate claims per author spec string.
  const providers = {};
  for (const r of inWindow) {
    if (r.type !== 'debate' || !Array.isArray(r.claims)) continue;
    for (const c of r.claims) {
      const key = canonicalSpecKey(c.author);
      const cs = spec(key).claim_survival;
      if (cs.survived + cs.killed + cs.unresolved >= TRAIT_WINDOW.max_claims) continue;
      if (c.status === 'SURVIVED') cs.survived += 1;
      else if (c.status === 'KILLED') cs.killed += 1;
      else cs.unresolved += 1;
      cs.n = cs.survived + cs.killed; // UNRESOLVED excluded from the rate base
      // decisive_refutation (inspect-only, provider-level: the ledger does not
      // persist WHICH attack the classifier selected as decisive).
      for (const a of c.attacks || []) {
        if (a.stance !== 'refute' || a.tier !== 'decisive') continue;
        const dp = (providers[a.by] = providers[a.by] || {
          decisive_refutation: {
            decisive_attacks: 0,
            associated_kills: 0,
            n: 0,
            routable: false,
            reason: 'ledger lacks causal decisive-refutation attribution',
          },
        }).decisive_refutation;
        dp.decisive_attacks += 1;
        if (c.status === 'KILLED') dp.associated_kills += 1;
        dp.n = dp.decisive_attacks;
      }
    }
  }
  for (const s of Object.values(specs)) {
    const cs = s.claim_survival;
    cs.rate = cs.n ? +((cs.survived / cs.n).toFixed(3)) : null;
  }
  for (const p of Object.values(providers)) {
    const d = p.decisive_refutation;
    d.rate = d.n ? +((d.associated_kills / d.n).toFixed(3)) : null;
  }

  // outcomes (inspect-only): join outcome records to their panel's roster.
  const rosterByRun = {};
  for (const r of inWindow) {
    if (r.type === 'panel' && Array.isArray(r.panelists)) {
      rosterByRun[r.run_id] = r.panelists.map((p) => canonicalSpecKey(p.spec));
    }
  }
  for (const r of inWindow) {
    if (r.type !== 'outcome') continue;
    const roster = rosterByRun[r.run_id];
    if (!roster) continue;
    for (const key of roster) {
      const o = spec(key).outcome_useful_adoption;
      if (o.n >= TRAIT_WINDOW.max_outcomes) continue;
      o.n += 1;
      if (canonicalSpecKey(r.adopted) === key && r.helpful) o.adopted_helpful += 1;
    }
  }
  for (const s of Object.values(specs)) {
    const o = s.outcome_useful_adoption;
    o.rate = o.n ? +((o.adopted_helpful / o.n).toFixed(3)) : null;
  }

  // bench_defect_detection: adjudicated opportunities keyed by evidence key.
  // Newest observation per {evidence_key, task, defect} (reruns must not
  // manufacture n); a cell needs ≥ bench_min_runs repeats, is a hit only on a
  // strict majority of repeats, and is dropped when uncertain-as-negative and
  // uncertain-as-positive disagree (no fake precision).
  const newestOp = {};
  for (const e of benchEvidence) {
    if (!e || typeof e !== 'object' || !e.evidence_key || !e.task_id || !e.defect_id) continue;
    if (!withinHorizon(e.created_at, now, horizonDays)) {
      if (e.created_at == null) excluded.no_timestamp += 1;
      continue;
    }
    if (!(e.runs_n >= TRAIT_GATES.bench_min_runs)) {
      excluded.bench_below_min_runs += 1;
      continue;
    }
    const k = `${e.evidence_key}\u0000${opKey(e.task_id, e.defect_id)}`;
    const t = Date.parse(e.created_at);
    if (!newestOp[k] || t > newestOp[k].t) newestOp[k] = { t, e };
  }
  const latencySeen = new Set();
  for (const { t, e } of Object.values(newestOp)) {
    const id = parseEvidenceKey(e.evidence_key);
    if (!id) continue;
    const majority = e.hits_n * 2 > e.runs_n;
    const majorityUpper = (Number.isFinite(e.hits_upper_n) ? e.hits_upper_n : e.hits_n) * 2 > e.runs_n;
    if (majority !== majorityUpper) {
      excluded.bench_uncertain += 1;
      continue;
    }
    const rec = ev(e.evidence_key, id);
    rec.latest_t = Math.max(rec.latest_t, t);
    const b = (rec.bench_defect_detection = rec.bench_defect_detection || {
      detected: 0,
      n: 0,
      tasks: 0,
      cells: {},
      min_runs: e.runs_n,
      routable: true,
      _tasks: new Set(),
    });
    b.cells[opKey(e.task_id, e.defect_id)] = majority;
    b.n += 1;
    if (majority) b.detected += 1;
    b._tasks.add(e.task_id);
    b.min_runs = Math.min(b.min_runs, e.runs_n);
    const lk = `${e.run_id}\u0000${e.evidence_key}\u0000${e.task_id}`;
    if (!latencySeen.has(lk) && Number.isFinite(e.mean_duration_ms)) {
      latencySeen.add(lk);
      rec.latency_ms.attempts += e.runs_n;
      rec.latency_ms.total_ms += e.mean_duration_ms * e.runs_n;
    }
  }
  for (const rec of Object.values(evidence)) {
    const b = rec.bench_defect_detection;
    if (b) {
      b.tasks = b._tasks.size;
      delete b._tasks;
      b.rate = b.n ? +((b.detected / b.n).toFixed(3)) : null;
      b.wilson95_lower = wilson95Lower(b.detected, b.n);
      b.gated = b.n >= TRAIT_GATES.bench_min_cells;
    }
    const lat = rec.latency_ms;
    lat.mean_ms_per_task = lat.attempts ? Math.round(lat.total_ms / lat.attempts) : null;
  }

  const health = deriveHealth(contracts, { now, env });

  return {
    version: 2,
    generated_at: new Date(now).toISOString(),
    window: { horizon_days: horizonDays, caps: { ...TRAIT_WINDOW } },
    evidence,
    observations,
    specs,
    providers,
    health,
    excluded,
    provenance: {
      ledger_records: ledgerRecords.length,
      ledger_records_in_window: inWindow.length,
      bench_opportunities_used: Object.keys(newestOp).length - excluded.bench_uncertain,
      contracts: !!contracts,
    },
    warnings,
  };
}

/**
 * Kind-aware health filter (design C). Explicit user --ready= is authority;
 * with detected/absent ready sets only FRESH observed failures act, and only
 * the kinds binary-presence detection cannot see may veto.
 */
export function healthDecision(provider, healthMap, { readySource = 'detected', detectedReady = null } = {}) {
  if (readySource === 'explicit') return 'ignore';
  const h = healthMap && healthMap[provider];
  if (!h || !h.fresh || !h.kind || h.kind === 'ok') return 'ignore';
  if (h.kind === 'missing-binary') {
    if (Array.isArray(detectedReady) && detectedReady.includes(provider)) return 'ignore'; // stale contradiction
    return 'veto';
  }
  if (h.retryable) return 'demote';
  if (h.kind === 'auth' || h.kind === 'contract-drift') return 'veto';
  return 'demote';
}

/** suggestTiebreaker adherence veto (design D′): known ≥25% abstainer at n≥10, by evidence key. */
export function adherenceVeto(key, traits) {
  const so = key && traits && traits.evidence && traits.evidence[key]?.structured_output;
  if (!so || so.n < TRAIT_GATES.adherence_veto_n) return false;
  return so.failed / so.n >= TRAIT_GATES.adherence_veto_failed_rate;
}

/**
 * Head-to-head bench comparison over the EXACT shared {task_id, defect_id}
 * opportunity set (a reused task_id with different defects is not the same
 * opportunity). Pure; returns null when either side is unmeasured.
 */
export function sharedBenchComparison(candBench, baseBench) {
  if (!candBench || !baseBench || !candBench.cells || !baseBench.cells) return null;
  const shared = Object.keys(candBench.cells).filter((k) => k in baseBench.cells);
  const tasks = new Set(shared.map((k) => k.split('::')[0]));
  const candHits = shared.filter((k) => candBench.cells[k]).length;
  const baseHits = shared.filter((k) => baseBench.cells[k]).length;
  return {
    shared_opportunities: shared.length,
    shared_tasks: tasks.size,
    candidate_lcb: wilson95Lower(candHits, shared.length),
    baseline_lcb: wilson95Lower(baseHits, shared.length),
  };
}

/**
 * Evidence key a routed candidate WOULD produce — or null with the reason it
 * has no measured basis. Never infers the reported model from the request:
 *
 *  - mutable/default request (alias, 'latest', no model): needs an observed
 *    envelope for exactly this {provider, requested model, requested effort}
 *    whose identity was observed recently (identity_fresh_ms);
 *  - explicit immutable model ID: may also match any evidence whose REPORTED
 *    model is exactly that ID with the same effective effort;
 *  - both require the evidence's CLI version cohort to equal the current CLI
 *    version from a fresh contracts probe (unknown/changed → no basis).
 *
 * @returns {{key:string|null, basis:string|null, reason:string|null, identity?:object}}
 */
export function resolveCandidateEvidence(provider, model, effort, traits, { now = Date.now() } = {}) {
  const none = (reason) => ({ key: null, basis: null, reason });
  if (!traits || !traits.evidence) return none('no trait evidence loaded');
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();
  const eff = normEffort(effort);
  const h = traits.health && traits.health[p];
  const cliNow = h && h.flags?.fresh && h.version ? h.version : null;
  const cliCheck = (was) => {
    const w = normalizeCliVersion(was);
    if (!w) return null; // no CLI version cohort in this key
    if (!cliNow) return 'current CLI version unknown (run xllm-contracts)';
    if (w !== cliNow) return `evidence cohort is CLI ${w}, current is ${cliNow}`;
    return null;
  };

  const obs = (traits.observations || {})[`${p}\0${m}\0${eff || ''}`];
  if (obs) {
    const bad = cliCheck(obs.cli_version);
    if (bad) return none(bad);
    if (isMutableModel(m) && now - obs.t > TRAIT_WINDOW.identity_fresh_ms) {
      return none('mutable alias/default identity not observed recently');
    }
    return { key: obs.evidence_key, basis: 'observed-identity', reason: null, identity: obs };
  }
  if (m && !isMutableModel(m)) {
    const want = m.toLowerCase();
    let best = null;
    for (const e of Object.values(traits.evidence)) {
      const id = e.identity;
      if (!id || id.provider !== p || String(id.reported_model).toLowerCase() !== want) continue;
      if (normEffort(id.effective_effort) !== eff) continue;
      if (cliCheck(id.cli_version)) continue;
      if (!best || (e.latest_t ?? 0) > (best.latest_t ?? 0)) best = e;
    }
    if (best) return { key: best.key, basis: 'explicit-immutable-id', reason: null, identity: best.identity };
  }
  return none(
    m && !isMutableModel(m)
      ? 'no evidence for this exact model ID, effort and current CLI version'
      : 'no observed current identity for this request (mutable/default model)'
  );
}

// ---------------------------------------------------------------------------
// IO (thin; the derivation above stays pure)
// ---------------------------------------------------------------------------

/** Adjudicated bench evidence (project <state>/benchmarks/results via xllm-bench). */
export function readBenchResults(root = process.cwd(), env = process.env) {
  try {
    return readBenchEvidence(root, env);
  } catch {
    return [];
  }
}

function countLegacyBenchFiles(root) {
  try {
    return fs.readdirSync(path.join(root, 'benchmarks', 'results')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export function readContractsCache(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(contractsCachePath(env), 'utf8'));
  } catch {
    return null;
  }
}

export function loadTraits(root = process.cwd(), { env = process.env, now = Date.now() } = {}) {
  return deriveTraitProfiles({
    ledgerRecords: readLedgerFile(root),
    benchEvidence: readBenchResults(root, env),
    contracts: readContractsCache(env),
    legacyBenchFiles: countLegacyBenchFiles(root),
    now,
    env,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function describeEvidenceIdentity(id) {
  if (!id) return '(unknown)';
  const rev = id.model_revision ? `#${String(id.model_revision).slice(0, 12)}` : '';
  return `${id.provider}:${id.reported_model}${rev}@${id.effective_effort ?? '-'} ${id.surface || '?'} cli ${id.cli_version || '-'}`;
}

export function formatTraitsTable(t) {
  const fmt = (v) => (v == null ? '—' : String(v));
  const lines = [
    `xllm traits — derived ${t.generated_at} (window ${t.window.horizon_days}d)`,
    `sources: ledger ${t.provenance.ledger_records_in_window}/${t.provenance.ledger_records} records in window · bench opportunities ${t.provenance.bench_opportunities_used} · contracts ${t.provenance.contracts ? 'yes' : 'no'}`,
    `excluded (never routed): ledger rows without resolved attribution ${t.excluded.ledger_no_evidence} · bench < ${TRAIT_GATES.bench_min_runs} runs ${t.excluded.bench_below_min_runs} · bench uncertain ${t.excluded.bench_uncertain} · legacy bench files ${t.excluded.legacy_bench_files}${t.excluded.no_timestamp ? ` · no timestamp ${t.excluded.no_timestamp}` : ''}`,
    '',
    'measured identity (provider:reported-model@effective-effort surface CLI)   structured(n) rate   bench(n) rate   LCB     routing',
  ];
  const keys = Object.keys(t.evidence || {}).sort();
  if (!keys.length) {
    lines.push('  (no measured basis — no run with a resolved model identity yet; legacy/bare/mutable records are not used)');
  }
  for (const k of keys) {
    const e = t.evidence[k];
    const so = e.structured_output;
    const b = e.bench_defect_detection;
    lines.push(
      `${describeEvidenceIdentity(e.identity).padEnd(70)} ${String(so.n).padStart(6)}   ${fmt(so.success_rate).padEnd(6)} ${String(b ? b.n : 0).padStart(5)}   ${fmt(b && b.rate).padEnd(6)} ${fmt(b && b.wilson95_lower).padEnd(7)} ${b && b.gated ? 'bench:eligible' : 'below gates'}`
    );
  }
  const specKeys = Object.keys(t.specs || {}).sort();
  if (specKeys.length) {
    lines.push('', 'inspect-only (spec-string keyed, identity unverified — never routed):');
    for (const k of specKeys) {
      const cs = t.specs[k].claim_survival;
      lines.push(`  ${k.padEnd(28)} claims n=${cs.n} survive=${fmt(cs.rate)}`);
    }
  }
  const health = Object.entries(t.health || {});
  if (health.length) {
    lines.push('', 'health (contracts; flags/version and auth are separate facts):');
    for (const [p, h] of health) {
      const flags = h.flags.kind === 'ok' ? 'flags ok' : `flags ${h.flags.kind}${h.flags.fresh ? '' : ' (stale)'}`;
      const auth =
        h.auth.status === 'unknown'
          ? `auth unknown${h.auth.reason ? ` (${h.auth.reason})` : ''}`
          : `auth ${h.auth.status}${h.auth.fresh ? '' : ' (past TTL — ignored)'} @${h.auth.observed_at}`;
      lines.push(`  ${p.padEnd(12)} ${flags} · ${auth}${h.version ? ` · cli ${h.version}` : ''}${h.safety ? ` · safety ${h.safety.boundary}` : ''}`);
    }
  }
  lines.push(
    '',
    'routable: bench LCB → judgment roles (critic|verify|tests|security) under shared-opportunity gates, per evidence identity;',
    'structured_output → tiebreak veto only; survival/outcomes/latency/decisive-refutation: inspect-only.',
    `ledger: ${traitsLedgerPath()}`
  );
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] && argv[0] !== '--json') {
    console.error('Usage: node scripts/xllm-traits.js [--json]');
    process.exit(1);
  }
  const t = loadTraits(process.cwd());
  if (argv.includes('--json')) console.log(JSON.stringify(t, null, 2));
  else console.log(formatTraitsTable(t));
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-traits.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
