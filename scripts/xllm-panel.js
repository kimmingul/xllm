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

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'process';
import {
  parseProviderSpec,
  resolveStateDir,
  ensureArtifactDirs,
  redactSecrets,
  slugify,
  getProviderCostMeta,
} from './grok-ask-advisor.js';

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

/** Deterministically extract the final verdict json block, or null. */
export function extractPanelVerdict(raw) {
  const blocks = [...String(raw || '').matchAll(/```json\r?\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  const text = blocks[blocks.length - 1][1];
  let v = null;
  try {
    v = JSON.parse(text);
  } catch {
    // Terminal line-wrapping (observed with ollama) injects raw newlines
    // inside JSON string literals — flatten and retry before giving up.
    try {
      v = JSON.parse(text.replace(/\r?\n/g, ' '));
    } catch {
      return null;
    }
  }
  try {
    if (!PANEL_VERDICTS.includes(v.verdict)) return null;
    const confidence = Number(v.confidence);
    return {
      verdict: v.verdict,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      key_claims: Array.isArray(v.key_claims)
        ? v.key_claims.map((c) => String(c)).slice(0, 5)
        : [],
    };
  } catch {
    return null;
  }
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

/** Pairwise agreement-rate matrix across all panel runs in the ledger. */
export function ledgerStats(records) {
  const pairs = {};
  let runs = 0;
  for (const r of records) {
    if (r.type !== 'panel') continue;
    runs += 1;
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
  return { runs, matrix, outcomes_recorded: outcomes.length };
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

/**
 * Read the raw output back out of an advisor artifact (format we own).
 * Anchored on the trailing "## Summary" heading — the raw text may itself
 * contain fenced blocks (e.g. the panel verdict json), so terminating at
 * the first closing fence would truncate it (live-observed bug).
 */
export function rawFromArtifact(artifactPath) {
  try {
    const body = fs.readFileSync(artifactPath, 'utf8');
    const m = body.match(
      /## Raw output\r?\n\r?\n```text\r?\n([\s\S]*?)\r?\n```\r?\n\r?\n## Summary/
    );
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export async function runPanel({ specs, question, root = process.cwd() }) {
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

  const advisor = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grok-ask-advisor.js');
  const prompt = buildPanelPrompt(question);

  const spawnOnce = (p, extraReminder = '') =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [advisor, p.spec, prompt + extraReminder],
        { env: process.env, windowsHide: true }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('error', () => resolve({ code: 1, artifact: null }));
      child.on('close', (code) =>
        resolve({
          code: code ?? 1,
          artifact: code === 0 && out.trim() ? out.trim().split(/\r?\n/).pop() : null,
        })
      );
    });

  // Small models often ignore the verdict protocol on the first try —
  // one corrective retry before counting them as abstentions.
  const runPanelist = async (p) => {
    console.error(`[panel] asking ${p.spec} (blind)…`);
    let r = await spawnOnce(p);
    let verdict = r.code === 0 ? extractPanelVerdict(rawFromArtifact(r.artifact)) : null;
    if (r.code === 0 && !verdict) {
      console.error(`[panel] ${p.spec}: missing/invalid verdict block — corrective retry`);
      r = await spawnOnce(
        p,
        '\n\nREMINDER: your previous attempt omitted the mandatory verdict block. You MUST end with exactly one fenced ```json block matching the PANEL PROTOCOL above.'
      );
      verdict = r.code === 0 ? extractPanelVerdict(rawFromArtifact(r.artifact)) : null;
    }
    return {
      spec: p.spec,
      provider: p.provider,
      exit_code: r.code,
      artifact: r.artifact,
      verdict,
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
      artifact: p.artifact,
    })),
    pairwise,
    consensus: label,
  };
  appendLedger(record, root);

  // Human index: ledger table first, prose contract second.
  const valid = panelists.filter((p) => p.verdict);
  const counts = {};
  for (const p of valid) counts[p.verdict.verdict] = (counts[p.verdict.verdict] || 0) + 1;
  const majorityVerdict =
    Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || null;

  const dir = path.join(ensureArtifactDirs(root), 'xllm');
  const mdPath = path.join(dir, `panel-${slugify(question)}-${id}.md`);
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
      '## Synthesis contract (for the host)',
      '',
      '- The ledger above is the record; your prose summary is UX and must not',
      '  contradict or omit it.',
      '- Surface minority reports explicitly — they are findings, not noise.',
      `- Consensus label: **${label}** — confidence metadata, not truth;`,
      '  unanimous can still be wrong.',
      '- On split: consider one tiebreaker from a vendor not on this panel,',
      '  chosen by LOW measured agreement (see `panel stats`), never by lineage.',
      `- Afterwards record what you did: \`xllm panel outcome ${id} --adopted <spec|majority|minority|none> --helpful yes|no\``,
      '',
      '## Full answers',
      '',
      ...panelists.filter((p) => p.artifact).map((p) => `- ${p.spec}: ${p.artifact}`),
      '',
    ].join('\n'),
    'utf8'
  );

  console.error(`[panel] consensus: ${label}`);
  console.log(mdPath);
  return { exitCode: 0, id, label, mdPath, panelists, pairwise };
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
    console.log(`panel runs: ${stats.runs}   outcomes recorded: ${stats.outcomes_recorded}`);
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
    const specs = (argv[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const question = argv.slice(2).join(' ').trim();
    if (specs.length < 2 || !question) {
      console.error('Usage: xllm-panel run p1,p2[,p3] "<question>"');
      process.exit(1);
    }
    const r = await runPanel({ specs, question });
    process.exit(r.exitCode);
  }

  console.error(`xllm panel — blind same-prompt panel + agreement ledger
Usage:
  node scripts/xllm-panel.js run p1,p2[,p3] "<question>"   # identical prompt, blind
  node scripts/xllm-panel.js stats [--json]                # pairwise agreement matrix
  node scripts/xllm-panel.js outcome <run-id> --adopted <…> --helpful yes|no

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
