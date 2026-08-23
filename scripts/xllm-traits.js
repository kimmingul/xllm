#!/usr/bin/env node
/**
 * xllm traits — evidence-based provider trait profiles (docs/traits-design.md).
 *
 * A DERIVED, on-demand view over the evidence streams that already exist:
 * the panel ledger (adherence, debate claim outcomes, outcomes), benchmark
 * results (seeded-defect detection cells), and the contracts cache (current
 * health). Never hand-authored lore, never written back into any stream,
 * silent below explicit sample gates — cold start is bit-identical to
 * pre-traits routing.
 *
 * Routable map (3-round codex/grok adversarial review, user-adjudicated):
 *  - bench_defect_detection (Wilson 95% LCB) → general judgment routing only
 *    (critic|verify|tests|security), may cross tier/cost under strict gates.
 *  - structured_output (adherence) → suggestTiebreaker veto only.
 *  - health (contracts) → kind-aware filter (see healthDecision).
 *  - claim_survival / decisive_refutation / outcomes / latency → inspect-only.
 *
 *   node scripts/xllm-traits.js [--json]
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import { resolveStateDir } from './xllm-advisor.js';
import { contractsCachePath } from './xllm-contracts.js';

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
  max_structured_output: 50, // per spec, newest first (batch-granular stop)
  max_claims: 50,
  max_outcomes: 30,
  contracts_fresh_ms: 24 * 60 * 60 * 1000,
};

export const TRAIT_GATES = {
  bench_min_cells: 6, // per-spec non-silent
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

/** Effort is session policy, not identity: codex:gpt-5.5@high → codex:gpt-5.5 */
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

/**
 * Pure derivation over evidence inputs. No filesystem access — unit tests
 * pass fixtures; loadTraits() does the IO.
 */
export function deriveTraitProfiles({
  ledgerRecords = [],
  benchReports = [],
  contracts = null,
  now = Date.now(),
  horizonDays = TRAIT_WINDOW.horizon_days,
} = {}) {
  const specs = {};
  const warnings = [];
  let excludedNoTimestamp = 0;
  const spec = (key) =>
    (specs[key] = specs[key] || {
      structured_output: { first: 0, retry: 0, failed: 0, n: 0, routable: 'tiebreak_only' },
      claim_survival: { survived: 0, killed: 0, unresolved: 0, n: 0, routable: false },
      outcome_useful_adoption: { adopted_helpful: 0, n: 0, routable: false },
      latency_ms: { attempts: 0, total_ms: 0, routable: false },
      bench_defect_detection: null, // filled from bench cells below
    });

  // Newest-first over the append-only ledger.
  const records = [...ledgerRecords].reverse();
  const inWindow = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (!withinHorizon(r.created_at, now, horizonDays)) {
      if (r.created_at == null) excludedNoTimestamp += 1;
      continue;
    }
    inWindow.push(r);
  }

  // structured_output: panel/debate adherence summaries + tiebreak panelist.
  for (const r of inWindow) {
    if ((r.type === 'panel' || r.type === 'debate') && r.adherence && typeof r.adherence === 'object') {
      for (const [rawSpec, c] of Object.entries(r.adherence)) {
        const s = spec(canonicalSpecKey(rawSpec)).structured_output;
        if (s.n >= TRAIT_WINDOW.max_structured_output) continue;
        s.first += c.first || 0;
        s.retry += c.retry || 0;
        s.failed += c.failed || 0;
        s.n = s.first + s.retry + s.failed;
      }
    } else if (r.type === 'tiebreak' && r.panelist && r.panelist.adherence) {
      const s = spec(canonicalSpecKey(r.panelist.spec)).structured_output;
      if (s.n < TRAIT_WINDOW.max_structured_output) {
        s[r.panelist.adherence] = (s[r.panelist.adherence] || 0) + 1;
        s.n = s.first + s.retry + s.failed;
      }
    }
  }
  for (const s of Object.values(specs)) {
    const so = s.structured_output;
    so.success_rate = so.n ? +(((so.first + so.retry) / so.n).toFixed(3)) : null;
    so.first_pass_rate = so.n ? +((so.first / so.n).toFixed(3)) : null;
  }

  // claim_survival (inspect-only): debate claims per author spec.
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

  // bench_defect_detection: newest observation per {canonical_spec, task_id}
  // (whole-file summation would let reruns manufacture n).
  const newestCell = {}; // `${key}\u0000${taskId}` -> {t, hits, misses}
  let benchFilesUsed = 0;
  for (const rep of benchReports) {
    if (!rep || typeof rep !== 'object' || !rep.single) continue;
    if (!withinHorizon(rep.created_at, now, horizonDays)) {
      if (rep.created_at == null) excludedNoTimestamp += 1;
      continue;
    }
    benchFilesUsed += 1;
    const t = Date.parse(rep.created_at);
    for (const [rawSpec, s] of Object.entries(rep.single)) {
      const key = canonicalSpecKey(rawSpec);
      for (const [taskId, cell] of Object.entries(s.per_task || {})) {
        if (!cell || cell.error || !Array.isArray(cell.hits)) continue;
        const k = `${key}\u0000${taskId}`;
        if (!newestCell[k] || t > newestCell[k].t) {
          newestCell[k] = { t, key, taskId, hits: cell.hits, misses: cell.misses || [] };
        }
      }
      // latency (inspect-only)
      if (Number.isFinite(s.duration_ms) && Number.isFinite(s.graded_tasks) && s.graded_tasks > 0) {
        const lat = spec(key).latency_ms;
        lat.attempts += s.graded_tasks;
        lat.total_ms += s.duration_ms;
      }
    }
  }
  for (const obs of Object.values(newestCell)) {
    const b = (spec(obs.key).bench_defect_detection = spec(obs.key).bench_defect_detection || {
      detected: 0,
      n: 0,
      tasks: 0,
      cells: {},
      routable: true,
    });
    b.tasks += 1;
    for (const id of obs.hits) {
      b.cells[opKey(obs.taskId, id)] = true;
      b.detected += 1;
      b.n += 1;
    }
    for (const id of obs.misses) {
      b.cells[opKey(obs.taskId, id)] = false;
      b.n += 1;
    }
  }
  for (const s of Object.values(specs)) {
    const b = s.bench_defect_detection;
    if (b) {
      b.rate = b.n ? +((b.detected / b.n).toFixed(3)) : null;
      b.wilson95_lower = wilson95Lower(b.detected, b.n);
      b.gated = b.n >= TRAIT_GATES.bench_min_cells;
    }
    const lat = s.latency_ms;
    lat.mean_ms_per_task = lat.attempts ? Math.round(lat.total_ms / lat.attempts) : null;
  }

  // health (contracts snapshot; kind-aware consumption is healthDecision()).
  const health = {};
  if (contracts && contracts.providers) {
    const probedAt = Date.parse(contracts.probed_at || '');
    const fresh = Number.isFinite(probedAt) && now - probedAt <= TRAIT_WINDOW.contracts_fresh_ms;
    for (const [p, r] of Object.entries(contracts.providers)) {
      health[p] = {
        kind: r.failure ? r.failure.kind : 'ok',
        retryable: r.failure ? !!r.failure.retryable : null,
        probed_at: contracts.probed_at || null,
        fresh,
      };
    }
  }

  return {
    version: 1,
    generated_at: new Date(now).toISOString(),
    window: { horizon_days: horizonDays, caps: { ...TRAIT_WINDOW } },
    specs,
    providers,
    health,
    excluded: { no_timestamp: excludedNoTimestamp },
    provenance: {
      ledger_records: ledgerRecords.length,
      ledger_records_in_window: inWindow.length,
      bench_files_used: benchFilesUsed,
      contracts: !!contracts,
    },
    warnings,
  };
}

/**
 * Kind-aware health filter (design C). Explicit user --ready= is authority;
 * with detected/absent ready sets only FRESH failures act, and only the kinds
 * binary-presence detection cannot see may veto.
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

/** suggestTiebreaker adherence veto (design D′): known ≥25% abstainer at n≥10. */
export function adherenceVeto(specKey, traits) {
  const so = traits && traits.specs && traits.specs[canonicalSpecKey(specKey)]?.structured_output;
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

/** Resolve the trait key a routed pick would actually RUN (no sibling rollup). */
export function resolveCandidateKey(provider, route, profiles) {
  const model =
    (route && route.model) || (profiles && profiles.providers && profiles.providers[provider]?.default_model) || '';
  return canonicalSpecKey(model ? `${provider}:${model}` : provider);
}

// ---------------------------------------------------------------------------
// IO (thin; the derivation above stays pure)
// ---------------------------------------------------------------------------

export function readBenchResults(root = process.cwd()) {
  const dir = path.join(root, 'benchmarks', 'results');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push({ _file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
    } catch {
      /* malformed report: skipped (visible via provenance count difference) */
    }
  }
  return out;
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
    benchReports: readBenchResults(root),
    contracts: readContractsCache(env),
    now,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatTraitsTable(t) {
  const fmt = (v) => (v == null ? '—' : String(v));
  const lines = [
    `xllm traits — derived ${t.generated_at} (window ${t.window.horizon_days}d)`,
    `sources: ledger ${t.provenance.ledger_records_in_window}/${t.provenance.ledger_records} records in window · bench files ${t.provenance.bench_files_used} · contracts ${t.provenance.contracts ? 'yes' : 'no'}${t.excluded.no_timestamp ? ` · excluded(no timestamp) ${t.excluded.no_timestamp}` : ''}`,
    '',
    'key                        structured(n)   rate   claims(n)  survive  bench(n)  rate   LCB     routing',
  ];
  const keys = Object.keys(t.specs).sort();
  if (!keys.length) lines.push('  (no evidence yet — run panel/debate/council or xllm-bench)');
  for (const k of keys) {
    const s = t.specs[k];
    const so = s.structured_output;
    const cs = s.claim_survival;
    const b = s.bench_defect_detection;
    lines.push(
      `${k.padEnd(26)} ${String(so.n).padStart(6)}        ${fmt(so.success_rate).padEnd(6)} ${String(cs.n).padStart(6)}     ${fmt(cs.rate).padEnd(8)} ${String(b ? b.n : 0).padStart(5)}     ${fmt(b && b.rate).padEnd(6)} ${fmt(b && b.wilson95_lower).padEnd(7)} ${b && b.gated ? 'bench:eligible' : 'below gates'}`
    );
  }
  const health = Object.entries(t.health).filter(([, h]) => h.kind !== 'ok');
  if (health.length) {
    lines.push('', 'health (contracts):');
    for (const [p, h] of health) lines.push(`  ${p}: ${h.kind}${h.fresh ? '' : ' (stale — ignored by routing)'}`);
  }
  lines.push(
    '',
    'routable: bench LCB → judgment roles (critic|verify|tests|security) under shared-opportunity gates;',
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
