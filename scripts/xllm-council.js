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
 *   node scripts/xllm-council.js run p1,p2[,p3] "<question>"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'process';
import { ensureArtifactDirs, redactSecrets, slugify } from './xllm-advisor.js';
import { runPanel, ledgerPath, parsePanelRunArgs } from './xllm-panel.js';
import { parseDebaters, capClaims, runDebateOnClaims, MAX_CLAIMS } from './xllm-debate.js';
import { canonicalSpecKey } from './xllm-traits.js';
import { hasDiffSource, collectReviewDiff, buildReviewContext, diffMeta } from './xllm-diff.js';

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

export async function runCouncil({
  specs,
  question,
  root = process.cwd(),
  tiebreak = false,
  readyProviders = null,
  context = null,
  contextMeta = null,
}) {
  const parsed = parseDebaters(specs);
  if (parsed.length < 2) {
    console.error('[council] Need at least 2 members.');
    return { exitCode: 1 };
  }

  // Phase 1 — independent panel (diversity measurement + blind claims).
  console.error('[council] phase 1/2 — panel (independent divergence)…');
  const panel = await runPanel({ specs, question, root, tiebreak, readyProviders, context, contextMeta });
  if (panel.exitCode !== 0) {
    console.error('[council] panel phase failed.');
    return { exitCode: 1 };
  }

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
    console.error('[council] panel surfaced no usable claims (all abstained/invalid) — cannot debate.');
    return { exitCode: 1, panel };
  }

  console.error(`[council] phase 2/2 — debate (adversarial convergence) over ${capped.length} claims…`);
  const debate = await runDebateOnClaims({ question, parsed, capped, root, panelRunId: panel.id, context, contextMeta });
  if (debate.exitCode !== 0) {
    console.error('[council] debate phase failed.');
    return { exitCode: 1, panel };
  }

  // Combined index linking both phases.
  const dir = path.join(ensureArtifactDirs(root), 'xllm');
  const mdPath = path.join(dir, `council-${slugify(question)}-${panel.id}.md`);
  const agreeRows = (panel.pairwise || []).map(
    (p) => `- ${p.a} ↔ ${p.b}: ${p.agree === null ? 'not comparable (abstention)' : p.agree ? 'agree' : 'DISAGREE'}`
  );
  fs.writeFileSync(
    mdPath,
    [
      `# xllm council — ${panel.label} → ${debate.tally.SURVIVED} survived · ${debate.tally.KILLED} killed · ${debate.tally.UNRESOLVED} unresolved`,
      '',
      `- Members: ${parsed.map((p) => p.spec).join(', ')}  (N=${parsed.length})`,
      `- Question: ${redactSecrets(question)}`,
      ...(contextMeta ? [`- Code context: ${contextMeta.source} (${contextMeta.bytes} bytes${contextMeta.truncated ? ', truncated' : ''}) — diff body not persisted`] : []),
      `- Ledger: ${ledgerPath(root)}  (panel run ${panel.id} → debate)`,
      '',
      '> Two phases: independent panel (measures diversity) → adversarial debate',
      '> (stress-tests the surfaced claims). Status is a protocol outcome, not',
      '> truth; SURVIVED ≠ proven; nothing is auto-applied — you decide.',
      '',
      '## Phase 1 — panel (independent divergence)',
      '',
      `- Consensus: **${panel.label}**  (confidence metadata, not truth)`,
      ...(panel.tiebreakSuggestion
        ? [
            panel.tiebreakResult
              ? `- Tiebreak: **${panel.tiebreakResult.panelist.spec}** ran (blind) → expanded consensus **${panel.expandedLabel}** (original **${panel.label}** unchanged in ledger)`
              : `- Tiebreak suggested: ${panel.tiebreakSuggestion.provider || '(none available)'} — not run${panel.tiebreakSuggestion.provider ? ' (pass `--tiebreak` to spend it)' : ''}`,
          ]
        : []),
      `- Detail: ${panel.mdPath}`,
      ...(agreeRows.length ? ['', '### Pairwise agreement', '', ...agreeRows] : []),
      '',
      '## Phase 2 — debate (adversarial convergence)',
      '',
      `- Verdict: **${debate.tally.SURVIVED} survived · ${debate.tally.KILLED} killed · ${debate.tally.UNRESOLVED} unresolved**`,
      `- Detail: ${debate.mdPath}`,
      '',
      '### Claims that SURVIVED hostile refutation',
      '',
      ...(debate.results.filter((r) => r.status === 'SURVIVED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)}${r.amended ? ` → amended: ${redactSecrets(r.amended)}` : ''}`) || []),
      '',
      '### KILLED',
      '',
      ...(debate.results.filter((r) => r.status === 'KILLED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)} — ${r.reason}`) || []),
      '',
      '### UNRESOLVED — needs human',
      '',
      ...(debate.results.filter((r) => r.status === 'UNRESOLVED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)}`) || []),
      '',
      '## How to read this',
      '',
      '- **SURVIVED** claims withstood both independent scrutiny and hostile',
      '  refutation — act on them with more confidence (still re-verify if',
      '  consequential).',
      '- **KILLED** claims were surfaced but did not survive refutation.',
      '- **UNRESOLVED** claims are genuinely disputed — human judgment needed.',
      '- Low pairwise agreement in phase 1 means the panel was genuinely',
      '  decorrelated; high agreement means correlated views (treat unanimity',
      '  as confidence metadata, not proof).',
      '',
    ].join('\n'),
    'utf8'
  );

  console.error(
    `[council] done — panel ${panel.label}; debate ${debate.tally.SURVIVED}/${debate.tally.KILLED}/${debate.tally.UNRESOLVED} (survived/killed/unresolved)`
  );
  console.log(mdPath);
  return { exitCode: 0, mdPath, panel, debate };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    const p = parsePanelRunArgs(argv.slice(1));
    if (p.error || p.specs.length < 2 || !p.question) {
      if (p.error) console.error(`[council] ${p.error}`);
      console.error('Usage: xllm-council run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>]');
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
      console.error(`[council] code context: ${contextMeta.source} (${contextMeta.bytes} bytes${contextMeta.truncated ? ', truncated' : ''})`);
    }
    const r = await runCouncil({ specs: p.specs, question: p.question, tiebreak: p.tiebreak, readyProviders: p.readyProviders, context, contextMeta });
    process.exit(r.exitCode);
  }
  console.error(`xllm council — panel (independent) → debate (adversarial), one pipeline
Usage:
  node scripts/xllm-council.js run p1,p2[,p3] "<question>" [--tiebreak] [--ready=a,b,c] [--staged|--base <ref>|--diff-file <path>]

Phase 1 panel measures diversity + surfaces blind claims; phase 2 debate
stress-tests those claims (SURVIVED/KILLED/UNRESOLVED). On a phase-1 SPLIT
the measured-agreement tiebreaker applies (suggest always; run with
--tiebreak) — its claims join phase 2 as an author (leftover claim slots
only), never as a debater. Both phases recorded to
<state>/panel-ledger.jsonl (panel run linked to debate). Protocol outcome,
not truth; nothing auto-applied.`);
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
