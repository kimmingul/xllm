#!/usr/bin/env node
/**
 * xllm panel — blind same-prompt panel + claim/agreement ledger.
 *
 * Improvement 2 of docs/diversity-roadmap.md: the measurement instrument
 * that separates model-diversity from prompt-diversity.
 *
 * Design rules from the cross-vendor debate:
 *  - IDENTICAL prompt to every panelist (blind — no panelist sees another).
 *  - Record-before-narrative: the structured ledger is written before any
 *    prose synthesis; the summary is UX, the ledger is truth.
 *  - Minority reports are first-class, never footnotes.
 *  - Failed/invalid panelists are ABSTENTIONS — they never count as
 *    agreement.
 *  - Decorrelation is MEASURED (pairwise agreement over comparable runs),
 *    never asserted from lineage metadata.
 *  - Consensus is confidence metadata, not truth.
 *
 * Evidence rule: spec strings are PRESENTATION. Every call's executed identity
 * comes from the advisor --json envelope's `attribution`; pairwise rows carry
 * the shared `evidenceKey(attribution)` of both sides, and stats count only
 * rows where both keys resolve.
 *
 *   node scripts/xllm-panel.js run p1,p2[,p3] "<question>" [--json] [--no-artifacts]
 *   node scripts/xllm-panel.js stats
 *   node scripts/xllm-panel.js outcome <run-id> --adopted <spec|none|majority|minority> --helpful yes|no [--note "…"]
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import {
  parseProviderSpec,
  resolveStateDir,
  ensureArtifactDirs,
  redactSecrets,
  slugify,
  getProviderCostMeta,
  detectAvailableProviders,
  buildInventory,
} from './xllm-advisor.js';
import { suggestTiebreaker } from './xllm-routing.js';
import { loadTraits } from './xllm-traits.js';
import {
  extractJson,
  askStructured,
  askAdvisor,
  adherenceSummary,
  mergeAttributions,
  noArtifactsRequested,
  sumUsage,
  sumCost,
} from './xllm-structured.js';
import { evidenceKey, executionLocation } from './xllm-evidence.js';
import {
  parseDiffFlags,
  hasDiffSource,
  collectReviewDiff,
  buildReviewContext,
  diffMeta,
  questionWithContext,
  coverageSummary,
  renderCoverage,
} from './xllm-diff.js';

/** Ledger record schema (panel / tiebreak / debate / outcome records written by this family). */
export const LEDGER_SCHEMA_VERSION = 2;

export const PANEL_VERDICTS = ['approve', 'reject', 'mixed'];

/** JSON schema for native structured output (strict-mode compatible: all properties required). */
export const PANEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'key_claims'],
  properties: {
    verdict: { type: 'string', enum: PANEL_VERDICTS },
    confidence: { type: 'number' },
    key_claims: { type: 'array', items: { type: 'string' } },
  },
};

export const PANEL_VERDICT_INSTRUCTIONS = `

---
PANEL PROTOCOL (mandatory): You are one blind panelist among several models answering the exact same question independently. After your full answer, END your response with exactly one fenced json block of this shape:

\`\`\`json
{"verdict": "approve" | "reject" | "mixed", "confidence": 0.0-1.0, "key_claims": ["claim 1", "claim 2", "..."]}
\`\`\`

- verdict: your overall stance on the question (approve = yes/safe/agree, reject = no/unsafe/disagree, mixed = genuinely split).
- key_claims: 1-5 atomic factual claims central to your answer, each one sentence, your own words.
- Nothing after the json block.`;

export function buildPanelPrompt(question) {
  return `${question}${PANEL_VERDICT_INSTRUCTIONS}`;
}

/** Validate a parsed verdict object (native structured output or extracted JSON), or null. */
export function validatePanelVerdict(v) {
  if (!v || typeof v !== 'object' || !PANEL_VERDICTS.includes(v.verdict)) return null;
  const confidence = Number(v.confidence);
  return {
    verdict: v.verdict,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    key_claims: Array.isArray(v.key_claims)
      ? v.key_claims.map((c) => String(c)).slice(0, 5)
      : [],
  };
}

/** Deterministically extract + validate the verdict json block from raw text, or null. */
export function extractPanelVerdict(raw) {
  return validatePanelVerdict(extractJson(raw));
}

/**
 * Pairwise verdict agreement. Abstentions (failed/invalid panelists) yield
 * null — never agreement. Rows carry each side's evidence key (null when the
 * executed identity did not resolve): spec text alone is never evidence.
 */
export function computePairwise(panelists) {
  const pairs = [];
  for (let i = 0; i < panelists.length; i++) {
    for (let j = i + 1; j < panelists.length; j++) {
      const a = panelists[i];
      const b = panelists[j];
      const comparable = a.verdict && b.verdict;
      pairs.push({
        a: a.spec,
        b: b.spec,
        agree: comparable ? a.verdict.verdict === b.verdict.verdict : null,
        a_evidence: a.evidence_key ?? null,
        b_evidence: b.evidence_key ?? null,
      });
    }
  }
  return pairs;
}

/**
 * Pairwise rows between one tiebreaker and every ORIGINAL panelist (never
 * original↔original — those are already on the panel record). Abstentions on
 * either end yield null, same rule as computePairwise. Pure.
 */
export function tiebreakPairwise(panelists, tb) {
  return panelists.map((p) => ({
    a: p.spec,
    b: tb.spec,
    agree: p.verdict && tb.verdict ? p.verdict.verdict === tb.verdict.verdict : null,
    a_evidence: p.evidence_key ?? null,
    b_evidence: tb.evidence_key ?? null,
  }));
}

/** Consensus label over valid verdicts only (abstentions excluded). */
export function consensusLabel(panelists) {
  const valid = panelists.filter((p) => p.verdict);
  if (valid.length === 0) return 'no-verdicts';
  if (valid.length === 1) return 'single-source';
  const counts = {};
  for (const p of valid) counts[p.verdict.verdict] = (counts[p.verdict.verdict] || 0) + 1;
  const top = Math.max(...Object.values(counts));
  if (top === valid.length) return 'unanimous';
  if (top > valid.length / 2) return 'majority';
  return 'split';
}

/**
 * How much of the panel actually reported. A label computed over survivors
 * ("unanimous" of 2 valid out of 3 asked) is NOT the same claim as unanimous
 * over everyone asked; this makes the difference explicit. Pure.
 */
export function panelCompletion(panelists) {
  const valid = panelists.filter((p) => p.verdict).length;
  return {
    asked: panelists.length,
    valid,
    abstained: panelists.length - valid,
    complete: panelists.length > 0 && valid === panelists.length,
    abstentions: panelists
      .filter((p) => !p.verdict)
      .map((p) => ({ spec: p.spec, adherence: p.adherence, exit_code: p.exit_code, failure: p.failure?.kind || null })),
  };
}

// ---------------------------------------------------------------------------
// Ledger (append-only jsonl; outcomes are separate records, never mutations)
// ---------------------------------------------------------------------------

export function ledgerPath(root = process.cwd()) {
  return path.join(resolveStateDir(root), 'panel-ledger.jsonl');
}

export function appendLedger(record, root = process.cwd()) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return file;
}

export function readLedger(root = process.cwd()) {
  try {
    return fs
      .readFileSync(ledgerPath(root), 'utf8')
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

/**
 * Pairwise agreement-rate matrix across all panel runs in the ledger.
 * Tiebreak records also contribute pairwise rows (the tiebreaker is blind and
 * prompt-identical → comparable) but never increment `runs` — that is how a
 * tiebreak bought today becomes routing evidence tomorrow.
 *
 * STRICT: a row is evidence only when BOTH sides carry an `evidenceKey`
 * written at record time from the executed attribution. Rows without keys
 * (legacy spec-only records, or identities that did not resolve) are excluded
 * and counted in `excluded` — never matched by spec string, never backfilled.
 * Matrix rows are keyed by the evidence-key pair; `pair` is presentation.
 */
export function ledgerStats(records) {
  const pairs = {};
  let runs = 0;
  let tiebreaks = 0;
  const excluded = { legacy_rows: 0, unresolved_rows: 0 };
  for (const r of records) {
    if (r.type !== 'panel' && r.type !== 'tiebreak') continue;
    if (r.type === 'panel') runs += 1;
    else tiebreaks += 1;
    for (const p of r.pairwise || []) {
      if (p.agree === null) continue; // abstention — not comparable
      if (!('a_evidence' in p) && !('b_evidence' in p)) {
        excluded.legacy_rows += 1;
        continue;
      }
      if (!p.a_evidence || !p.b_evidence) {
        excluded.unresolved_rows += 1;
        continue;
      }
      const evidence = [p.a_evidence, p.b_evidence].sort();
      const key = JSON.stringify(evidence);
      const row = (pairs[key] = pairs[key] || { evidence, labels: {}, comparable: 0, agreements: 0 });
      row.labels[p.a_evidence] = row.labels[p.a_evidence] || p.a;
      row.labels[p.b_evidence] = row.labels[p.b_evidence] || p.b;
      row.comparable += 1;
      if (p.agree) row.agreements += 1;
    }
  }
  const matrix = Object.values(pairs).map((s) => ({
    pair: s.evidence.map((e) => s.labels[e]).sort().join(' ↔ '),
    evidence: s.evidence,
    comparable_runs: s.comparable,
    agreement_rate: s.comparable ? +(s.agreements / s.comparable).toFixed(3) : null,
  }));
  const outcomes = records.filter((r) => r.type === 'outcome');
  return { runs, tiebreaks, matrix, outcomes_recorded: outcomes.length, excluded };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function panelId() {
  return (
    new Date().toISOString().replace(/[:.TZ-]/g, '').slice(2, 14) +
    '-' +
    Math.random().toString(36).slice(2, 6)
  );
}

/** CLI arg parser for `run` — shared with council. Pure. */
export function parsePanelRunArgs(argv) {
  const d = parseDiffFlags(argv);
  if (d.error) return { error: d.error };
  const rest = d.rest;
  const tiebreak = rest.includes('--tiebreak');
  const noArtifacts = rest.includes('--no-artifacts');
  const json = rest.includes('--json');
  const readyArg = rest.find((a) => a.startsWith('--ready='));
  const readyProviders = readyArg
    ? readyArg.slice('--ready='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;
  const flags = new Set(['--tiebreak', '--no-artifacts', '--json']);
  const positional = rest.filter((a) => !flags.has(a) && !a.startsWith('--ready='));
  const specs = (positional[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const question = positional.slice(1).join(' ').trim();
  return { specs, question, tiebreak, readyProviders, diffOpts: d.diffOpts, noArtifacts, json };
}

/**
 * Lane key for serialization. Panelists sharing a runtime that provably (or
 * possibly) runs on THIS machine's GPU/RAM run sequentially — parallel model
 * loads fight over VRAM (observed: ollama CUDA OOM). Cloud providers and local
 * runtimes proven to execute remotely (e.g. an ollama `:cloud` model) stay
 * parallel: serializing them buys nothing. Unknown location is treated as
 * local (the safe direction). Pure given env.
 */
export function laneKeyFor(p, env = process.env) {
  if (getProviderCostMeta(p.provider).tier !== 'local') return `cloud:${p.spec}`;
  return executionLocation(p.provider, p.model, { env }) === 'remote' ? `remote:${p.spec}` : `local:${p.provider}`;
}

/** Ledger/JSON form of one panelist (no raw output; content text omitted when not persisting). */
function panelistView(p, persist) {
  return {
    spec: p.spec,
    provider: p.provider,
    exit_code: p.exit_code,
    verdict: p.verdict?.verdict || null,
    confidence: p.verdict?.confidence ?? null,
    key_claims: persist ? p.verdict?.key_claims || [] : [],
    adherence: p.adherence,
    artifact: p.artifact,
    attempts: p.attempts,
    schema_mode: p.schema_mode,
    attribution: p.attribution,
    evidence_key: p.evidence_key,
    usage: p.usage,
    cost_estimate: p.cost_estimate,
    failure: p.failure,
    attempt_log: (p.attempt_log || []).map(({ attribution, ...rest }) => rest),
  };
}

function renderPanelMarkdown({ label, id, root, question, contextMeta, panelists, pairwise, suggestion, tbResult, completion }) {
  const valid = panelists.filter((p) => p.verdict);
  const counts = {};
  for (const p of valid) counts[p.verdict.verdict] = (counts[p.verdict.verdict] || 0) + 1;
  const majorityVerdict = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const abstainWhy = (p) => (p.exit_code !== 0 ? `failed${p.failure?.kind ? `: ${p.failure.kind}` : ''}` : 'invalid verdict block');
  const tiebreakMd = !suggestion
    ? []
    : [
        '## Tiebreak (measured decorrelation)',
        '',
        '- Trigger: initial consensus was **split**',
        suggestion.provider
          ? `- Suggested: **${suggestion.provider}** — ${suggestion.reason}`
          : `- Suggested: (none) — ${suggestion.reason}`,
        ...(tbResult
          ? [
              `- Ran: **${tbResult.panelist.spec}** → ${
                tbResult.panelist.verdict
                  ? `**${tbResult.panelist.verdict.verdict}** (confidence ${tbResult.panelist.verdict.confidence ?? '-'})`
                  : 'ABSTAIN (failed/invalid verdict — label unchanged)'
              }`,
              `- Pairwise vs panel: ${tbResult.pairwise
                .map((p) => `${p.a} ${p.agree === null ? 'not comparable' : p.agree ? 'agree' : 'DISAGREE'}`)
                .join(' · ')}`,
              `- Expanded consensus: **${tbResult.consensus_after}** (original **${label}** unchanged in ledger)`,
            ]
          : ['- Ran: no — re-invoke with `--tiebreak` to spend one blind call']),
        '',
      ];
  return [
    `# xllm panel — ${label}${completion.complete ? '' : ` (${completion.valid}/${completion.asked} panelists reported)`}`,
    '',
    `- Run id: ${id} (ledger: ${ledgerPath(root)})`,
    `- Question: ${redactSecrets(question)}`,
    ...(contextMeta ? [`- Code context: ${coverageSummary(contextMeta)} — diff body not persisted`] : []),
    ...(completion.complete
      ? []
      : [
          `- **Incomplete panel:** ${completion.abstained} of ${completion.asked} abstained (${completion.abstentions.map((a) => `${a.spec}: ${a.failure || a.adherence}`).join('; ')}). The label covers reporting panelists only.`,
        ]),
    '',
    ...(contextMeta && !contextMeta.coverage?.complete ? ['## Code coverage', '', '```text', renderCoverage(contextMeta.coverage), '```', ''] : []),
    '## Ledger (truth — the summary below may not override this)',
    '',
    '| Panelist | Verdict | Confidence | Key claims |',
    '|----------|---------|------------|------------|',
    ...panelists.map((p) =>
      p.verdict
        ? `| ${p.spec} | ${p.verdict.verdict}${p.verdict.verdict !== majorityVerdict && valid.length > 1 ? ' **(minority)**' : ''} | ${p.verdict.confidence ?? '-'} | ${p.verdict.key_claims.join(' / ').replace(/\|/g, '\\|')} |`
        : `| ${p.spec} | ABSTAIN (${abstainWhy(p)}) | - | - |`
    ),
    '',
    '## Pairwise',
    '',
    ...pairwise.map(
      (p) => `- ${p.a} ↔ ${p.b}: ${p.agree === null ? 'not comparable (abstention)' : p.agree ? 'agree' : 'DISAGREE'}`
    ),
    '',
    ...tiebreakMd,
    '## Synthesis contract (for the host)',
    '',
    '- The ledger above is the record; your prose summary is UX and must not',
    '  contradict or omit it.',
    '- Surface minority reports explicitly — they are findings, not noise.',
    `- Consensus label: **${label}** — confidence metadata, not truth;`,
    '  unanimous can still be wrong.',
    '- On split: the Tiebreak section above names the measured-decorrelation',
    '  pick — spend it with `--tiebreak`; never hand-pick by lineage.',
    `- Afterwards record what you did: \`xllm review outcome ${id} --adopted <spec|majority|minority|none> --helpful yes|no\``,
    '',
    '## Contract adherence (structured-output health)',
    '',
    ...panelists.map((p) => `- ${p.spec}: ${p.adherence}${p.adherence === 'retry' ? ' (recovered on retry)' : p.adherence === 'failed' ? ' (abstained — no valid block)' : ''}${p.schema_mode ? ` · ${p.schema_mode} schema` : ''}`),
    '',
    '## Full answers',
    '',
    ...panelists.filter((p) => p.artifact).map((p) => `- ${p.spec}: ${p.artifact}`),
    ...(tbResult && tbResult.panelist.artifact
      ? [`- ${tbResult.panelist.spec} (tiebreaker): ${tbResult.panelist.artifact}`]
      : []),
    '',
  ].join('\n');
}

/**
 * Run a blind panel. Returns a result object (never prints to stdout — the
 * CLI prints). Result: { exitCode, schema_version:2, kind:'panel', id, label,
 * expandedLabel, completion, mdPath|null, markdown, panelists, pairwise,
 * tiebreakSuggestion, tiebreakResult, context, attributions, attribution_conflicts,
 * usage, cost_estimate } or { exitCode:1, error }.
 *
 * @param ask  call seam (defaults to the child-process advisor with --json)
 */
export async function runPanel({
  specs,
  question,
  root = process.cwd(),
  tiebreak = false,
  readyProviders = null,
  context = null,
  contextMeta = null,
  noArtifacts = false,
  ask = askAdvisor,
  inventory = undefined,
  env = process.env,
}) {
  noArtifacts = noArtifactsRequested(noArtifacts, env);
  const persist = !noArtifacts;
  const parsed = [];
  for (const s of specs) {
    const p = parseProviderSpec(s);
    if (!p) return { exitCode: 1, error: `Unknown provider spec: ${s}` };
    parsed.push(p);
  }
  if (parsed.length < 2) return { exitCode: 1, error: 'Need at least 2 panelists.' };

  const prompt = buildPanelPrompt(questionWithContext(question, context));

  // Ask each panelist for a structured verdict via the shared layer: native
  // schema where the adapter supports it, one corrective retry before counting
  // a non-compliant model as an abstention.
  const runPanelist = async (p) => {
    console.error(`[panel] asking ${p.spec} (blind)…`);
    const r = await askStructured({
      spec: p.spec,
      prompt,
      validate: validatePanelVerdict,
      schema: PANEL_SCHEMA,
      repairHint:
        'your previous attempt omitted the mandatory verdict block. You MUST end with exactly one fenced ```json block matching the PANEL PROTOCOL above.',
      noArtifacts,
      env,
      ask,
    });
    if (r.adherence === 'retry') console.error(`[panel] ${p.spec}: verdict recovered on retry`);
    if (r.adherence === 'failed') {
      console.error(`[panel] ${p.spec}: no valid verdict (${r.failure?.kind || 'unknown'}) — abstains`);
    }
    return {
      spec: p.spec,
      provider: p.provider,
      exit_code: r.code,
      artifact: r.artifact,
      verdict: r.value,
      adherence: r.adherence,
      attempts: r.attempts,
      schema_mode: r.schema_mode,
      attribution: r.attribution,
      evidence_key: evidenceKey(r.attribution),
      usage: r.usage,
      cost_estimate: r.cost_estimate,
      failure: r.failure,
      attempt_log: r.attempt_log,
      raw: r.raw,
    };
  };

  // Lanes: see laneKeyFor — serialize only what may share this machine's GPU/RAM.
  const lanes = new Map();
  for (const p of parsed) {
    const laneKey = laneKeyFor(p, env);
    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey).push(p);
  }
  const laneResults = await Promise.all(
    [...lanes.values()].map(async (lane) => {
      const acc = [];
      for (let i = 0; i < lane.length; i++) {
        const done = await runPanelist(lane[i]);
        acc.push(done);
        // ollama keeps finished models resident in VRAM — unload before the
        // next panelist's model or it OOMs on load (observed live). Skipped
        // when the executed model is remote: there is nothing resident here.
        const cur = lane[i];
        const next = lane[i + 1];
        const remote = done.attribution?.execution_location === 'remote';
        if (cur.provider === 'ollama' && next && next.model !== cur.model && !remote) {
          const { spawnSync } = await import('child_process');
          spawnSync('ollama', ['stop', cur.model || 'llama3.2'], {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 30000,
          });
          console.error(`[panel] unloaded ollama model ${cur.model || '(default)'}`);
        }
      }
      return acc;
    })
  );
  const bySpec = new Map(laneResults.flat().map((r) => [r.spec, r]));
  const panelists = parsed.map((p) => bySpec.get(p.spec));

  const pairwise = computePairwise(panelists);
  const label = consensusLabel(panelists);
  const completion = panelCompletion(panelists);
  const id = panelId();
  const attrib = mergeAttributions(panelists.map((p) => ({ spec: p.spec, attribution: p.attribution })));
  const usage = sumUsage(panelists.map((p) => p.usage));
  const cost = sumCost(panelists.map((p) => p.cost_estimate));

  // Record BEFORE narrative: ledger first, index md second.
  const record = {
    type: 'panel',
    schema_version: LEDGER_SCHEMA_VERSION,
    run_id: id,
    created_at: new Date().toISOString(),
    question: persist ? redactSecrets(question) : null,
    content_persisted: persist,
    ...(contextMeta ? { diff_context: contextMeta } : {}),
    panelists: panelists.map((p) => panelistView(p, persist)),
    pairwise,
    consensus: label,
    completion,
    adherence: adherenceSummary(panelists.map((p) => ({ spec: p.spec, adherence: p.adherence }))),
    attributions: attrib.attributions,
    ...(Object.keys(attrib.conflicts).length ? { attribution_conflicts: attrib.conflicts } : {}),
    usage,
    cost_estimate: cost,
  };
  appendLedger(record, root);

  // Measurement→routing loop (docs/tiebreak-design.md): on a SPLIT the ledger's
  // measured agreement picks an unconsulted tiebreaker. Suggestion is always
  // free (no LLM call); the one extra blind call is opt-in via --tiebreak.
  let suggestion = null;
  let tbResult = null;
  let expandedLabel = null;
  if (label === 'split') {
    const override = Array.isArray(readyProviders) && readyProviders.length > 0;
    const readyList = override ? readyProviders : detectAvailableProviders();
    // Post-append matrix (record-before-narrative). Candidate scores are
    // unaffected by the current run: candidates are unconsulted, so this
    // run's pairwise rows (on-panel only) never mention them.
    const matrix = ledgerStats(readLedger(root)).matrix;
    const onPanel = parsed.map((p) => p.spec);
    // Traits add health/adherence VETOES only (docs/traits-design.md D′);
    // the lowest-measured-agreement selection itself is untouched.
    // Inventory supplies per-model server metadata (model_details) and
    // advisor_eligible so the router can expand a local runtime into verified
    // local models and refuse unverified/unsafe ones. Production loads the
    // cached inventory; callers/tests may inject a fixture (or null = none).
    let tbInventory = inventory;
    if (tbInventory === undefined) {
      try {
        tbInventory = buildInventory({ env });
      } catch {
        tbInventory = null;
      }
    }
    suggestion = suggestTiebreaker(onPanel, readyList, matrix, null, loadTraits(root), {
      readySource: override ? 'explicit' : 'detected',
      panelEvidence: panelists.map((p) => p.evidence_key),
      inventory: tbInventory,
      env,
    });
    const suggestId = panelId();
    appendLedger(
      {
        type: 'tiebreak_suggest',
        schema_version: LEDGER_SCHEMA_VERSION,
        run_id: suggestId,
        panel_run_id: id,
        created_at: new Date().toISOString(),
        provider: suggestion.provider,
        measured_agreement: suggestion.measured_agreement ?? null,
        reason: suggestion.reason,
        ...(suggestion.refusals ? { refusals: suggestion.refusals } : {}),
        selection_basis:
          suggestion.measured_agreement != null ? 'lowest-measured-agreement' : 'strongest-tier-no-data',
        ready: readyList,
        ready_source: override ? 'override' : 'detect',
        on_panel: onPanel,
        requested: !!tiebreak,
        status: suggestion.provider ? 'suggested' : 'unavailable',
      },
      root
    );
    console.error(
      suggestion.provider
        ? `[panel] tiebreak suggest: ${suggestion.provider} — ${suggestion.reason}${tiebreak ? '' : ' (add --tiebreak to run it)'}`
        : `[panel] tiebreak suggest: (none) — ${suggestion.reason}`
    );

    if (tiebreak && suggestion.provider) {
      const tbParsed = parseProviderSpec(suggestion.provider);
      if (tbParsed) {
        console.error(`[panel] tiebreak run: ${tbParsed.spec} (blind, identical prompt)…`);
        const tb = await runPanelist(tbParsed);
        const tbPairwise = tiebreakPairwise(panelists, tb);
        // A failed tiebreaker abstains: consensusLabel ignores it and the
        // expanded label stays 'split'; it never counts as agreement.
        expandedLabel = consensusLabel([...panelists, tb]);
        appendLedger(
          {
            type: 'tiebreak',
            schema_version: LEDGER_SCHEMA_VERSION,
            run_id: panelId(),
            panel_run_id: id,
            suggest_run_id: suggestId,
            created_at: new Date().toISOString(),
            content_persisted: persist,
            selection: {
              spec: tb.spec,
              basis: suggestion.measured_agreement != null ? 'lowest-measured-agreement' : 'strongest-tier-no-data',
              ready_source: override ? 'override' : 'detect',
              measured_agreement: suggestion.measured_agreement ?? null,
            },
            blind_prompt: true,
            panelist: panelistView(tb, persist),
            pairwise: tbPairwise,
            consensus_before: label,
            consensus_after: expandedLabel,
          },
          root
        );
        tbResult = { panelist: tb, pairwise: tbPairwise, consensus_after: expandedLabel };
        console.error(`[panel] expanded consensus: ${expandedLabel} (initial: ${label})`);
      }
    }
  }

  // Human index: ledger table first, prose contract second. Not written
  // under --no-artifacts (the markdown is returned for the CLI to print).
  const markdown = renderPanelMarkdown({
    label,
    id,
    root,
    question,
    contextMeta,
    panelists,
    pairwise,
    suggestion,
    tbResult,
    completion,
  });
  let mdPath = null;
  if (persist) {
    const dir = path.join(ensureArtifactDirs(root), 'xllm');
    mdPath = path.join(dir, `panel-${slugify(question)}-${id}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');
  }

  const recovered = panelists.filter((p) => p.adherence === 'retry').length;
  const failed = panelists.filter((p) => p.adherence === 'failed').length;
  console.error(
    `[panel] consensus: ${label}${recovered ? ` · ${recovered} recovered on retry` : ''}${failed ? ` · ${failed} abstained` : ''}`
  );
  return {
    exitCode: completion.valid === 0 ? 1 : 0,
    error: completion.valid === 0 ? 'No panelist produced a valid verdict.' : null,
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'panel',
    id,
    label,
    expandedLabel,
    completion,
    mdPath,
    markdown,
    panelists,
    pairwise,
    tiebreakSuggestion: suggestion,
    tiebreakResult: tbResult,
    context: contextMeta,
    attributions: attrib.attributions,
    attribution_conflicts: attrib.conflicts,
    usage,
    cost_estimate: cost,
    noArtifacts,
  };
}

/** Machine result for `--json` (answers inline only when no artifact holds them). */
export function panelJson(r) {
  if (!r.panelists) return { schema_version: LEDGER_SCHEMA_VERSION, kind: 'panel', exitCode: r.exitCode, error: r.error || 'panel failed' };
  const persist = !r.noArtifacts;
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'panel',
    exitCode: r.exitCode,
    error: r.error || null,
    run_id: r.id,
    consensus: r.label,
    expanded_consensus: r.expandedLabel,
    completion: r.completion,
    index_path: r.mdPath,
    context: r.context,
    panelists: r.panelists.map((p) => ({ ...panelistView(p, true), ...(persist ? {} : { answer: p.raw }) })),
    pairwise: r.pairwise,
    tiebreak: r.tiebreakSuggestion
      ? {
          suggestion: r.tiebreakSuggestion,
          result: r.tiebreakResult
            ? { panelist: { ...panelistView(r.tiebreakResult.panelist, true), ...(persist ? {} : { answer: r.tiebreakResult.panelist.raw }) }, pairwise: r.tiebreakResult.pairwise, consensus_after: r.tiebreakResult.consensus_after }
            : null,
        }
      : null,
    attributions: r.attributions,
    attribution_conflicts: r.attribution_conflicts,
    usage: r.usage,
    cost_estimate: r.cost_estimate,
  };
}

/** Print a result per CLI mode (shared shape with debate/council mains). */
export function emitResult(r, toJson, json) {
  if (json) console.log(JSON.stringify(toJson(r)));
  else if (r.exitCode !== 0) console.error(`[${r.kind || 'review'}] ${r.error || 'failed'}`);
  else console.log(r.mdPath || r.markdown);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'stats') {
    const stats = ledgerStats(readLedger());
    if (argv.includes('--json')) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    console.log(
      `panel runs: ${stats.runs}   tiebreaks: ${stats.tiebreaks}   outcomes recorded: ${stats.outcomes_recorded}`
    );
    const ex = stats.excluded;
    if (ex.legacy_rows || ex.unresolved_rows) {
      console.log(
        `excluded from evidence: ${ex.legacy_rows} legacy row(s) without attribution, ${ex.unresolved_rows} row(s) with unresolved model identity`
      );
    }
    if (!stats.matrix.length) {
      console.log('(no attributed comparable pairs yet — run `panel run` with 2+ panelists)');
      return;
    }
    console.log('\npairwise agreement (low rate = measured decorrelation):');
    for (const row of stats.matrix.sort((a, b) => a.agreement_rate - b.agreement_rate)) {
      console.log(
        `  ${row.pair.padEnd(50)} ${String(row.agreement_rate).padEnd(6)} over ${row.comparable_runs} run(s)`
      );
    }
    return;
  }

  if (cmd === 'outcome') {
    const runId = argv[1];
    const adopted = argv.includes('--adopted') ? argv[argv.indexOf('--adopted') + 1] : null;
    const helpful = argv.includes('--helpful') ? argv[argv.indexOf('--helpful') + 1] : null;
    const note = argv.includes('--note') ? argv[argv.indexOf('--note') + 1] : null;
    if (!runId || !adopted || !['yes', 'no'].includes(helpful || '')) {
      console.error(
        'Usage: xllm-panel outcome <run-id> --adopted <spec|majority|minority|none> --helpful yes|no [--note "…"]'
      );
      process.exit(1);
    }
    const known = readLedger().some((r) => r.type === 'panel' && r.run_id === runId);
    if (!known) {
      console.error(`[panel] unknown run id: ${runId}`);
      process.exit(1);
    }
    appendLedger({
      type: 'outcome',
      schema_version: LEDGER_SCHEMA_VERSION,
      run_id: runId,
      created_at: new Date().toISOString(),
      adopted,
      helpful: helpful === 'yes',
      note: note ? redactSecrets(note) : null,
    });
    console.log(`recorded outcome for ${runId}`);
    return;
  }

  if (cmd === 'run') {
    const p = parsePanelRunArgs(argv.slice(1));
    if (p.error || p.specs.length < 2 || !p.question) {
      if (p.error) console.error(`[panel] ${p.error}`);
      console.error('Usage: xllm-panel run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]');
      process.exit(1);
    }
    let context = null;
    let contextMeta = null;
    if (hasDiffSource(p.diffOpts)) {
      const diff = collectReviewDiff(p.diffOpts);
      if (diff.error) {
        console.error(`[panel] ${diff.error}`);
        process.exit(1);
      }
      context = buildReviewContext(diff);
      contextMeta = diffMeta(diff);
      console.error(`[panel] code context: ${coverageSummary(contextMeta)}`);
    }
    const r = await runPanel({ specs: p.specs, question: p.question, tiebreak: p.tiebreak, readyProviders: p.readyProviders, context, contextMeta, noArtifacts: p.noArtifacts });
    r.kind = 'panel';
    emitResult(r, panelJson, p.json);
    process.exit(r.exitCode);
  }

  console.error(`xllm panel — blind same-prompt panel + agreement ledger
Usage:
  node scripts/xllm-panel.js run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]
  node scripts/xllm-panel.js stats [--json]                # pairwise agreement matrix
  node scripts/xllm-panel.js outcome <run-id> --adopted <…> --helpful yes|no

--staged/--base/--diff-file attach a code diff to the prompt (review family).
The diff is budgeted at file/hunk boundaries (24KB); anything not shown is
enumerated in a coverage manifest. The ledgers/index never store the diff
body — only source/stat/bytes/truncated/coverage land there as diff_context
— but advisor child artifacts persist prompts unless --no-artifacts is set.

--json prints ONE JSON result on stdout (progress on stderr). --no-artifacts
(or XLLM_NO_ARTIFACTS=1) runs children with --no-artifacts, writes no index
md, and keeps question/claim text out of the ledger (metadata only).

On a SPLIT the ledger's measured agreement picks an unconsulted tiebreaker
(suggestion is always free and recorded; the one extra blind call runs only
with --tiebreak). --ready= overrides detected providers.

Ledger: <state>/panel-ledger.jsonl (append-only; schema_version 2; outcomes
are new records, never mutations). The ledger is the record; prose synthesis
is UX.`);
  process.exit(cmd ? 1 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-panel.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
