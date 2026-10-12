#!/usr/bin/env node
/**
 * xllm council — the two-phase pipeline: panel (independent divergence) then
 * debate (adversarial convergence), in one command.
 *
 * Phase 1 (panel): every model answers the SAME question blind and independent
 * → surfaces diverse claims and MEASURES their decorrelation (pairwise
 * agreement). Phase 2 (debate): those independently-surfaced claims are put
 * through hostile cross-refutation → each ends SURVIVED / KILLED / UNRESOLVED.
 *
 * Panel-first is deliberate: refutation targets claims that were reached
 * INDEPENDENTLY (no anchoring), and you keep the diversity measurement.
 * Status is a protocol outcome, not truth. Nothing is auto-applied.
 *
 *   node scripts/xllm-council.js run p1,p2[,p3] "<question>" [--json] [--no-artifacts]
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import { ensureArtifactDirs, redactSecrets, slugify } from './xllm-advisor.js';
import { runPanel, panelJson, ledgerPath, parsePanelRunArgs, emitResult, LEDGER_SCHEMA_VERSION } from './xllm-panel.js';
import { parseDebaters, capClaims, runDebateOnClaims, debateJson, MAX_CLAIMS } from './xllm-debate.js';
import { askAdvisor, noArtifactsRequested } from './xllm-structured.js';
import { canonicalSpecKey } from './xllm-traits.js';
import { hasDiffSource, collectReviewDiff, buildReviewContext, diffMeta, coverageSummary, renderCoverage } from './xllm-diff.js';

/**
 * Bridge panel output → debate claims. Each panelist's key_claims become
 * author-attributed atomic claims for the adversarial rounds. Pure.
 */
export function claimsFromPanel(panelists, parsed) {
  const claims = [];
  parsed.forEach((p, pi) => {
    const panelist = panelists.find((x) => x && x.spec === p.spec);
    const kc = panelist && panelist.verdict ? panelist.verdict.key_claims || [] : [];
    kc.forEach((text, i) => {
      if (text && String(text).trim()) {
        // author = canonical MODEL key (not provider): same-runtime models are
        // distinct authors and may attack each other in phase 2 (v0.18.0).
        claims.push({
          id: `C${pi}-${i + 1}`,
          author: canonicalSpecKey(p.spec),
          authorSpec: p.spec,
          text: String(text).trim(),
          evidence: '',
        });
      }
    });
  });
  return capClaims(claims, parsed);
}

/**
 * Tiebreaker claims join phase 2 as a claim AUTHOR only (docs/tiebreak-design.md):
 * original members' claims are capped first (round-robin untouched); tiebreak
 * claims fill only leftover MAX_CLAIMS capacity, so they can never displace an
 * original member's claim. The tiebreaker is NEVER added to `parsed` — R1
 * refute lanes stay one-per-member, and R2 defend already routes by
 * claim.authorSpec. Pure.
 */
export function appendTiebreakClaims(capped, tbPanelist, originalAuthorCount) {
  if (!tbPanelist || !tbPanelist.verdict) return capped;
  const leftover = MAX_CLAIMS - capped.length;
  if (leftover <= 0) return capped;
  const pi = originalAuthorCount;
  return [
    ...capped,
    ...(tbPanelist.verdict.key_claims || [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, leftover)
      .map((text, i) => ({
        id: `C${pi}-${i + 1}`,
        author: canonicalSpecKey(tbPanelist.spec),
        authorSpec: tbPanelist.spec,
        text,
        evidence: '',
      })),
  ];
}

function renderCouncilMarkdown({ panel, debate, parsed, question, contextMeta, root, completion }) {
  const text = (s) => redactSecrets(s);
  const agreeRows = (panel.pairwise || []).map(
    (p) => `- ${p.a} ↔ ${p.b}: ${p.agree === null ? 'not comparable (abstention)' : p.agree ? 'agree' : 'DISAGREE'}`
  );
  const incompleteNote = (r) => (r.incomplete ? ` — INCOMPLETE REVIEW: ${r.incomplete_reasons.join('; ')}` : '');
  return [
    `# xllm council — ${panel.label} → ${debate.tally.SURVIVED} survived · ${debate.tally.KILLED} killed · ${debate.tally.UNRESOLVED} unresolved${completion.complete ? '' : ' (INCOMPLETE: provider failures)'}`,
    '',
    `- Members: ${parsed.map((p) => p.spec).join(', ')}  (N=${parsed.length})`,
    `- Question: ${text(question)}`,
    ...(contextMeta ? [`- Code context: ${coverageSummary(contextMeta)} — diff body not persisted`] : []),
    `- Ledger: ${ledgerPath(root)}  (panel run ${panel.id} → debate)`,
    '',
    '> Two phases: independent panel (measures diversity) → adversarial debate',
    '> (stress-tests the surfaced claims). Status is a protocol outcome, not',
    '> truth; SURVIVED ≠ proven; a failed provider call is never evidence (it',
    '> leaves claims UNRESOLVED). Nothing is auto-applied — you decide.',
    '',
    ...(contextMeta && !contextMeta.coverage?.complete ? ['## Code coverage', '', '```text', renderCoverage(contextMeta.coverage), '```', ''] : []),
    '## Phase 1 — panel (independent divergence)',
    '',
    `- Consensus: **${panel.label}**  (confidence metadata, not truth)${panel.completion.complete ? '' : ` — only ${panel.completion.valid}/${panel.completion.asked} panelists reported`}`,
    ...(panel.tiebreakSuggestion
      ? [
          panel.tiebreakResult
            ? `- Tiebreak: **${panel.tiebreakResult.panelist.spec}** ran (blind) → expanded consensus **${panel.expandedLabel}** (original **${panel.label}** unchanged in ledger)`
            : `- Tiebreak suggested: ${panel.tiebreakSuggestion.provider || '(none available)'} — not run${panel.tiebreakSuggestion.provider ? ' (pass `--tiebreak` to spend it)' : ''}`,
        ]
      : []),
    `- Detail: ${panel.mdPath || '(not written: --no-artifacts)'}`,
    ...(agreeRows.length ? ['', '### Pairwise agreement', '', ...agreeRows] : []),
    '',
    '## Phase 2 — debate (adversarial convergence)',
    '',
    `- Verdict: **${debate.tally.SURVIVED} survived · ${debate.tally.KILLED} killed · ${debate.tally.UNRESOLVED} unresolved**${debate.completion.complete ? '' : ` — ${debate.completion.incomplete_claims} claim(s) not fully reviewed`}`,
    `- Detail: ${debate.mdPath || '(not written: --no-artifacts)'}`,
    '',
    '### Claims that SURVIVED hostile refutation',
    '',
    ...debate.results.filter((r) => r.status === 'SURVIVED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)}${r.amended ? ` → amended: ${text(r.amended)}` : ''}`),
    '',
    '### KILLED',
    '',
    ...debate.results.filter((r) => r.status === 'KILLED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)} — ${r.reason}${incompleteNote(r)}`),
    '',
    '### UNRESOLVED — needs human',
    '',
    ...debate.results.filter((r) => r.status === 'UNRESOLVED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)} — ${r.reason}${incompleteNote(r)}`),
    '',
    '## How to read this',
    '',
    '- **SURVIVED** claims withstood both independent scrutiny and hostile',
    '  refutation from opponents that completed review — act on them with more',
    '  confidence (still re-verify if consequential).',
    '- **KILLED** claims were surfaced but did not survive refutation.',
    '- **UNRESOLVED** claims are genuinely disputed OR could not be fully',
    '  reviewed (provider failure / non-compliant output) — human judgment needed.',
    '- Low pairwise agreement in phase 1 means the panel was genuinely',
    '  decorrelated; high agreement means correlated views (treat unanimity',
    '  as confidence metadata, not proof).',
    '',
  ].join('\n');
}

/**
 * Run panel → debate. Returns { exitCode:0, schema_version:2, kind:'council',
 * mdPath|null, markdown, panel, debate, context, completion } or
 * { exitCode:1, kind:'council', error, panel? }. Never prints to stdout.
 */
export async function runCouncil({
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
  let parsed;
  try {
    parsed = parseDebaters(specs);
  } catch (err) {
    return { exitCode: 1, kind: 'council', error: err.message };
  }
  if (parsed.length < 2) return { exitCode: 1, kind: 'council', error: 'Need at least 2 members.' };

  // Phase 1 — independent panel (diversity measurement + blind claims).
  console.error('[council] phase 1/2 — panel (independent divergence)…');
  const panel = await runPanel({ specs, question, root, tiebreak, readyProviders, context, contextMeta, noArtifacts, ask, inventory, env });
  if (panel.exitCode !== 0) return { exitCode: 1, kind: 'council', error: `panel phase failed: ${panel.error || 'unknown'}`, panel };

  // Bridge → adversarial phase over the independently-surfaced claims.
  let capped = claimsFromPanel(panel.panelists, parsed);
  if (panel.tiebreakResult) {
    const before = capped.length;
    capped = appendTiebreakClaims(capped, panel.tiebreakResult.panelist, parsed.length);
    if (capped.length > before) {
      console.error(
        `[council] tiebreaker ${panel.tiebreakResult.panelist.spec} contributes ${capped.length - before} claim(s) as author (leftover slots only, not a debater)`
      );
    }
  }
  if (!capped.length) {
    return {
      exitCode: 1,
      kind: 'council',
      error: 'panel surfaced no usable claims (all abstained/invalid) — cannot debate.',
      panel,
    };
  }

  console.error(`[council] phase 2/2 — debate (adversarial convergence) over ${capped.length} claims…`);
  const debate = await runDebateOnClaims({ question, parsed, capped, root, panelRunId: panel.id, context, contextMeta, noArtifacts, ask, env });
  if (debate.exitCode !== 0) return { exitCode: 1, kind: 'council', error: `debate phase failed: ${debate.error || 'unknown'}`, panel };

  const completion = {
    complete: panel.completion.complete && debate.completion.complete,
    panel: panel.completion,
    debate: debate.completion,
  };
  const markdown = renderCouncilMarkdown({ panel, debate, parsed, question, contextMeta, root, completion });
  let mdPath = null;
  if (!noArtifacts) {
    const dir = path.join(ensureArtifactDirs(root), 'xllm');
    mdPath = path.join(dir, `council-${slugify(question)}-${panel.id}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');
  }

  console.error(
    `[council] done — panel ${panel.label}; debate ${debate.tally.SURVIVED}/${debate.tally.KILLED}/${debate.tally.UNRESOLVED} (survived/killed/unresolved)${completion.complete ? '' : ' · INCOMPLETE'}`
  );
  return {
    exitCode: 0,
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'council',
    mdPath,
    markdown,
    panel,
    debate,
    context: contextMeta,
    completion,
    noArtifacts,
  };
}

/** Machine result for `--json`: both phases, context once at top level. */
export function councilJson(r) {
  if (r.exitCode !== 0) {
    return {
      schema_version: LEDGER_SCHEMA_VERSION,
      kind: 'council',
      exitCode: r.exitCode,
      error: r.error || 'council failed',
      panel: r.panel ? { ...panelJson(r.panel), context: undefined } : null,
    };
  }
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'council',
    exitCode: r.exitCode,
    index_path: r.mdPath,
    context: r.context,
    completion: r.completion,
    panel: { ...panelJson(r.panel), context: undefined },
    debate: { ...debateJson(r.debate), context: undefined },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    const p = parsePanelRunArgs(argv.slice(1));
    if (p.error || p.specs.length < 2 || !p.question) {
      if (p.error) console.error(`[council] ${p.error}`);
      console.error('Usage: xllm-council run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]');
      process.exit(1);
    }
    let context = null;
    let contextMeta = null;
    if (hasDiffSource(p.diffOpts)) {
      const diff = collectReviewDiff(p.diffOpts);
      if (diff.error) {
        console.error(`[council] ${diff.error}`);
        process.exit(1);
      }
      context = buildReviewContext(diff);
      contextMeta = diffMeta(diff);
      console.error(`[council] code context: ${coverageSummary(contextMeta)}`);
    }
    const r = await runCouncil({ specs: p.specs, question: p.question, tiebreak: p.tiebreak, readyProviders: p.readyProviders, context, contextMeta, noArtifacts: p.noArtifacts });
    emitResult(r, councilJson, p.json);
    process.exit(r.exitCode);
  }
  console.error(`xllm council — panel (independent) → debate (adversarial), one pipeline
Usage:
  node scripts/xllm-council.js run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]

Phase 1 panel measures diversity + surfaces blind claims; phase 2 debate
stress-tests those claims (SURVIVED/KILLED/UNRESOLVED; a failed provider call
leaves a claim UNRESOLVED, never survived/killed). On a phase-1 SPLIT
the measured-agreement tiebreaker applies (suggest always; run with
--tiebreak) — its claims join phase 2 as an author (leftover claim slots
only), never as a debater. Both phases recorded to
<state>/panel-ledger.jsonl (panel run linked to debate). Protocol outcome,
not truth; nothing auto-applied. --json prints ONE JSON result on stdout;
--no-artifacts writes no index md and keeps text out of the ledger.`);
  process.exit(argv.length ? 1 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-council.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
