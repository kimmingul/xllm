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
 *   node scripts/xllm-panel.js run p1,p2[,p3] "<question>"
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
} from './grok-ask-advisor.js';
import { suggestTiebreaker } from './xllm-routing.js';
import { loadTraits } from './xllm-traits.js';
import {
  extractJson,
  askStructured,
  adherenceSummary,
  rawFromArtifact,
} from './xllm-structured.js';

// rawFromArtifact now lives in the shared structured layer; re-export for
// callers (e.g. xllm-debate) that imported it from here.
export { rawFromArtifact };

export const PANEL_VERDICTS = ['approve', 'reject', 'mixed'];

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

/** Deterministically extract + validate the verdict json block, or null. */
export function extractPanelVerdict(raw) {
  const v = extractJson(raw);
  if (!v || !PANEL_VERDICTS.includes(v.verdict)) return null;
  const confidence = Number(v.confidence);
  return {
    verdict: v.verdict,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    key_claims: Array.isArray(v.key_claims)
      ? v.key_claims.map((c) => String(c)).slice(0, 5)
      : [],
  };
}

/**
 * Pairwise verdict agreement. Abstentions (failed/invalid panelists) yield
 * null — never agreement.
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
 */
export function ledgerStats(records) {
  const pairs = {};
  let runs = 0;
  let tiebreaks = 0;
  for (const r of records) {
    if (r.type !== 'panel' && r.type !== 'tiebreak') continue;
    if (r.type === 'panel') runs += 1;
    else tiebreaks += 1;
    for (const p of r.pairwise || []) {
      if (p.agree === null) continue; // abstention — not comparable
      const key = [p.a, p.b].sort().join(' ↔ ');
      pairs[key] = pairs[key] || { comparable: 0, agreements: 0 };
      pairs[key].comparable += 1;
      if (p.agree) pairs[key].agreements += 1;
    }
  }
  const matrix = Object.entries(pairs).map(([pair, s]) => ({
    pair,
    comparable_runs: s.comparable,
    agreement_rate: s.comparable ? +(s.agreements / s.comparable).toFixed(3) : null,
  }));
  const outcomes = records.filter((r) => r.type === 'outcome');
  return { runs, tiebreaks, matrix, outcomes_recorded: outcomes.length };
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

export async function runPanel({
  specs,
  question,
  root = process.cwd(),
  tiebreak = false,
  readyProviders = null,
}) {
  const parsed = specs.map((s) => {
    const p = parseProviderSpec(s);
    if (!p) {
      console.error(`[panel] Unknown provider spec: ${s}`);
      process.exit(1);
    }
    return p;
  });
  if (parsed.length < 2) {
    console.error('[panel] Need at least 2 panelists.');
    return { exitCode: 1 };
  }

  const prompt = buildPanelPrompt(question);

  // Ask each panelist for a structured verdict via the shared layer: one
  // corrective retry before counting a non-compliant model as an abstention.
  const runPanelist = async (p) => {
    console.error(`[panel] asking ${p.spec} (blind)…`);
    const r = await askStructured({
      spec: p.spec,
      prompt,
      parse: extractPanelVerdict,
      repairHint:
        'your previous attempt omitted the mandatory verdict block. You MUST end with exactly one fenced ```json block matching the PANEL PROTOCOL above.',
    });
    if (r.adherence === 'retry') console.error(`[panel] ${p.spec}: verdict recovered on retry`);
    if (r.adherence === 'failed') console.error(`[panel] ${p.spec}: no valid verdict — abstains`);
    return {
      spec: p.spec,
      provider: p.provider,
      exit_code: r.code,
      artifact: r.artifact,
      verdict: r.value,
      adherence: r.adherence,
    };
  };

  // Panelists sharing a LOCAL provider run sequentially — parallel model
  // loads on one local runtime fight over GPU/RAM (observed: ollama CUDA
  // OOM when two models load at once). Cloud panelists stay parallel.
  const lanes = new Map();
  for (const p of parsed) {
    const isLocal = getProviderCostMeta(p.provider).tier === 'local';
    const laneKey = isLocal ? `local:${p.provider}` : `cloud:${p.spec}`;
    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey).push(p);
  }
  const laneResults = await Promise.all(
    [...lanes.values()].map(async (lane) => {
      const acc = [];
      for (let i = 0; i < lane.length; i++) {
        acc.push(await runPanelist(lane[i]));
        // ollama keeps finished models resident in VRAM — unload before the
        // next panelist's model or it OOMs on load (observed live).
        const cur = lane[i];
        const next = lane[i + 1];
        if (cur.provider === 'ollama' && next && next.model !== cur.model) {
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
  const id = panelId();

  // Record BEFORE narrative: ledger first, index md second.
  const record = {
    type: 'panel',
    run_id: id,
    created_at: new Date().toISOString(),
    question: redactSecrets(question),
    panelists: panelists.map((p) => ({
      spec: p.spec,
      provider: p.provider,
      exit_code: p.exit_code,
      verdict: p.verdict?.verdict || null,
      confidence: p.verdict?.confidence ?? null,
      key_claims: p.verdict?.key_claims || [],
      adherence: p.adherence,
      artifact: p.artifact,
    })),
    pairwise,
    consensus: label,
    adherence: adherenceSummary(panelists.map((p) => ({ spec: p.spec, adherence: p.adherence }))),
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
    suggestion = suggestTiebreaker(onPanel, readyList, matrix, null, loadTraits(root), {
      readySource: override ? 'explicit' : 'detected',
    });
    const suggestId = panelId();
    appendLedger(
      {
        type: 'tiebreak_suggest',
        run_id: suggestId,
        panel_run_id: id,
        created_at: new Date().toISOString(),
        provider: suggestion.provider,
        measured_agreement: suggestion.measured_agreement ?? null,
        reason: suggestion.reason,
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
            run_id: panelId(),
            panel_run_id: id,
            suggest_run_id: suggestId,
            created_at: new Date().toISOString(),
            selection: {
              spec: tb.spec,
              basis: suggestion.measured_agreement != null ? 'lowest-measured-agreement' : 'strongest-tier-no-data',
              ready_source: override ? 'override' : 'detect',
              measured_agreement: suggestion.measured_agreement ?? null,
            },
            blind_prompt: true,
            panelist: {
              spec: tb.spec,
              provider: tb.provider,
              exit_code: tb.exit_code,
              verdict: tb.verdict?.verdict || null,
              confidence: tb.verdict?.confidence ?? null,
              key_claims: tb.verdict?.key_claims || [],
              adherence: tb.adherence,
              artifact: tb.artifact,
            },
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

  // Human index: ledger table first, prose contract second.
  const valid = panelists.filter((p) => p.verdict);
  const counts = {};
  for (const p of valid) counts[p.verdict.verdict] = (counts[p.verdict.verdict] || 0) + 1;
  const majorityVerdict =
    Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || null;

  const dir = path.join(ensureArtifactDirs(root), 'xllm');
  const mdPath = path.join(dir, `panel-${slugify(question)}-${id}.md`);
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
  fs.writeFileSync(
    mdPath,
    [
      `# xllm panel — ${label}`,
      '',
      `- Run id: ${id} (ledger: ${ledgerPath(root)})`,
      `- Question: ${redactSecrets(question)}`,
      '',
      '## Ledger (truth — the summary below may not override this)',
      '',
      '| Panelist | Verdict | Confidence | Key claims |',
      '|----------|---------|------------|------------|',
      ...panelists.map((p) =>
        p.verdict
          ? `| ${p.spec} | ${p.verdict.verdict}${p.verdict.verdict !== majorityVerdict && valid.length > 1 ? ' **(minority)**' : ''} | ${p.verdict.confidence ?? '-'} | ${p.verdict.key_claims.join(' / ').replace(/\|/g, '\\|')} |`
          : `| ${p.spec} | ABSTAIN (${p.exit_code !== 0 ? 'failed' : 'invalid verdict block'}) | - | - |`
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
      `- Afterwards record what you did: \`xllm panel outcome ${id} --adopted <spec|majority|minority|none> --helpful yes|no\``,
      '',
      '## Contract adherence (structured-output health)',
      '',
      ...panelists.map((p) => `- ${p.spec}: ${p.adherence}${p.adherence === 'retry' ? ' (recovered on retry)' : p.adherence === 'failed' ? ' (abstained — no valid block)' : ''}`),
      '',
      '## Full answers',
      '',
      ...panelists.filter((p) => p.artifact).map((p) => `- ${p.spec}: ${p.artifact}`),
      ...(tbResult && tbResult.panelist.artifact
        ? [`- ${tbResult.panelist.spec} (tiebreaker): ${tbResult.panelist.artifact}`]
        : []),
      '',
    ].join('\n'),
    'utf8'
  );

  const recovered = panelists.filter((p) => p.adherence === 'retry').length;
  const failed = panelists.filter((p) => p.adherence === 'failed').length;
  console.error(
    `[panel] consensus: ${label}${recovered ? ` · ${recovered} recovered on retry` : ''}${failed ? ` · ${failed} abstained` : ''}`
  );
  console.log(mdPath);
  return {
    exitCode: 0,
    id,
    label,
    expandedLabel,
    mdPath,
    panelists,
    pairwise,
    tiebreakSuggestion: suggestion,
    tiebreakResult: tbResult,
  };
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
    if (!stats.matrix.length) {
      console.log('(no comparable pairs yet — run `panel run` with 2+ panelists)');
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
    const rest = argv.slice(1);
    const tiebreak = rest.includes('--tiebreak');
    const readyArg = rest.find((a) => a.startsWith('--ready='));
    const readyProviders = readyArg
      ? readyArg.slice('--ready='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : null;
    const positional = rest.filter((a) => a !== '--tiebreak' && !a.startsWith('--ready='));
    const specs = (positional[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const question = positional.slice(1).join(' ').trim();
    if (specs.length < 2 || !question) {
      console.error('Usage: xllm-panel run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]');
      process.exit(1);
    }
    const r = await runPanel({ specs, question, tiebreak, readyProviders });
    process.exit(r.exitCode);
  }

  console.error(`xllm panel — blind same-prompt panel + agreement ledger
Usage:
  node scripts/xllm-panel.js run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c]
  node scripts/xllm-panel.js stats [--json]                # pairwise agreement matrix
  node scripts/xllm-panel.js outcome <run-id> --adopted <…> --helpful yes|no

On a SPLIT the ledger's measured agreement picks an unconsulted tiebreaker
(suggestion is always free and recorded; the one extra blind call runs only
with --tiebreak). --ready= overrides detected providers.

Ledger: <state>/panel-ledger.jsonl (append-only; outcomes are new records,
never mutations). The ledger is the record; prose synthesis is UX.`);
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
