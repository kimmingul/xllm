#!/usr/bin/env node
/**
 * xllm debate — adversarial multi-LLM review (quality-maximizing complement
 * to the independent `panel`). Models see and try to REFUTE each other so
 * plausible-but-wrong claims die and correct ones survive.
 *
 * Designed via xllm's own adversarial method (codex@high vs grok@high, two
 * rounds) — see docs/debate-design.md. Key converged rules:
 *  - Mechanical resolution, NO judge LLM by default (order-immune set-logic).
 *  - Kill power comes from EVIDENCE TIER, not vendor count: only a DECISIVE
 *    falsifier can kill; SOFT/EXTERNAL_UNVERIFIED can never kill alone.
 *  - Works at N=2: one opponent can kill with a decisive falsifier the author
 *    fails to defeat; mere disagreement → UNRESOLVED.
 *  - Status is a protocol outcome, NOT truth. No auto-apply.
 *
 * Phase completion rule (a failed provider is NOT an argument):
 *  - SURVIVED needs every eligible opponent to have COMPLETED R1 and addressed
 *    the claim (a valid empty `attacks` list is an explicit no-objection from
 *    that opponent; a failed or non-compliant call, or silence on the claim,
 *    is not evidence of survival).
 *  - A refuted claim whose author's R2 defense failed is UNRESOLVED, never
 *    KILLED by the missing defense.
 *  - A KILL needs actual evidence (concession, amendment, a standing decisive
 *    falsifier, or two unrebutted opponents) from COMPLETED phases.
 *
 *   node scripts/xllm-debate.js run p1,p2[,p3] "<question>" [--json] [--no-artifacts]
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import {
  parseProviderSpec,
  ensureArtifactDirs,
  redactSecrets,
  slugify,
} from './xllm-advisor.js';
import { appendLedger, ledgerPath, emitResult, LEDGER_SCHEMA_VERSION } from './xllm-panel.js';
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
import { canonicalSpecKey } from './xllm-traits.js';
import { evidenceKey } from './xllm-evidence.js';
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

export const MAX_CLAIMS = 8;

// ---------------------------------------------------------------------------
// Prompts (verbatim contracts — synthesized from the adversarial design review)
// ---------------------------------------------------------------------------

export function buildClaimsPrompt(question) {
  return `${question}

---
DEBATE R0 (blind): Answer the question, then distill your answer into atomic, checkable claims. You are one of several models answering independently — you do NOT see the others. END with exactly one fenced json block and nothing after:

\`\`\`json
{"claims": [{"text": "one-sentence falsifiable claim", "evidence": "a concrete pointer into the input/code, or 'inference: <why>'"}]}
\`\`\`
1-5 claims. Each must be atomic and falsifiable. Do NOT invent files, APIs, or results not present in the question.`;
}

export function buildRefutePrompt(question, foreignClaims) {
  const list = foreignClaims.map((c) => `- ${c.id}: ${c.text}`).join('\n');
  return `You are a HOSTILE reviewer. Your default job is to KILL wrong claims, not to agree, endorse, or summarize.

QUESTION:
<<<
${question}
>>>

CLAIMS TO ATTACK (you did NOT author these):
${list}

Rules:
1. Default to REFUTE. "Looks fine" is failure unless you state a concrete reason it survives.
2. A refutation needs a concrete MECHANISM (the specific flaw: missing case, false premise, wrong invariant, unsafe assumption) AND a FALSIFIER (a checkable counterexample / failing input / contradiction).
3. tier = "decisive" ONLY if your falsifier is concrete and checkable against the input (a specific counterexample or contradiction). Otherwise tier = "soft" (prose reasoning).
4. Do NOT invent files, executions, quotes, or sources. Evidence you cannot ground is "soft".
5. You may NOT see peer full answers — only these claims. Do not guess what others "meant".

END with exactly one fenced json block and nothing after:

\`\`\`json
{"attacks": [{"claim_id": "C0-1", "stance": "refute", "mechanism": "...", "falsifier": "...", "tier": "decisive"}]}
\`\`\`
Use stance "pass" only when a genuine kill attempt failed; then say why in mechanism. Give one entry per claim you evaluated; an empty "attacks" list means you found NOTHING to object to in any claim above.`;
}

/**
 * Author/attacker identity is the MODEL (canonical spec key, effort stripped),
 * not the provider: 'ollama' is a runtime hosting models from different labs
 * (llama=Meta, gemma=Google, qwen=Alibaba), so provider-level identity made
 * same-runtime models invisible to each other and local-only debates
 * degenerate (claims SURVIVED with "no valid refutation" because nobody was
 * eligible to attack them — observed live, v0.15.0 council e2e). Correlated
 * same-lab refutation stays guarded by the decisive-falsifier bar: mere
 * agreement never kills regardless of how many correlated attackers pile on.
 * (This is protocol/presentation identity; evidence identity comes from the
 * executed attribution of each call.)
 */
export function claimAuthorKey(claim) {
  return canonicalSpecKey(claim.authorSpec || claim.author);
}

/** Claims a debater with this spec may attack (everything it did not author). Pure. */
export function foreignClaims(capped, spec) {
  const mine = canonicalSpecKey(spec);
  return capped.filter((c) => claimAuthorKey(c) !== mine);
}

/**
 * question is the same promptQuestion R0/R1 saw (question + diff context when
 * present) — without it the author defends code-review claims blind while the
 * attackers argued from the diff, an asymmetry that favored refutation.
 */
export function buildDefendPrompt(claim, attacks, question = null) {
  const list = attacks
    .map((a) => `- [${a.attacker}] tier=${a.tier}: ${a.mechanism}${a.falsifier ? ` | falsifier: ${a.falsifier}` : ''}`)
    .join('\n');
  const questionBlock = question
    ? `QUESTION (as posed to every debater, including any code under review):
<<<
${question}
>>>

`
    : '';
  return `You authored this claim: "${claim.text}"

It is under HOSTILE attack. Do NOT preserve it out of consistency, and do NOT concede out of politeness. Answer the strongest attack.

${questionBlock}ATTACKS:
${list}

Rules:
1. Overall response: "holds" (claim stands), "amend" (a narrower claim survives — give it), or "concede" (claim is false/overstated — it dies).
2. For EACH attack, rebut it with a concrete counter (evidence/test/why the mechanism is wrong) or mark it conceded.
3. Unsupported counter-evidence is not binding. Do not invent facts.

END with exactly one fenced json block and nothing after:

\`\`\`json
{"response": "holds", "amended_claim": null, "rebuttals": [{"attacker": "grok", "result": "holds", "counter": "..."}]}
\`\`\`
result is "holds" (you defeated the attack) or "conceded" (the attack stands).`;
}

// ---------------------------------------------------------------------------
// Native-schema contracts (strict-mode compatible: every property required)
// ---------------------------------------------------------------------------

export const CLAIMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidence'],
        properties: { text: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
  },
};

export const ATTACKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attacks'],
  properties: {
    attacks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim_id', 'stance', 'mechanism', 'falsifier', 'tier'],
        properties: {
          claim_id: { type: 'string' },
          stance: { type: 'string', enum: ['refute', 'pass'] },
          mechanism: { type: 'string' },
          falsifier: { type: 'string' },
          tier: { type: 'string', enum: ['decisive', 'soft'] },
        },
      },
    },
  },
};

export const DEFENSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['response', 'amended_claim', 'rebuttals'],
  properties: {
    response: { type: 'string', enum: ['holds', 'amend', 'concede'] },
    amended_claim: { type: ['string', 'null'] },
    rebuttals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attacker', 'result', 'counter'],
        properties: {
          attacker: { type: 'string' },
          result: { type: 'string', enum: ['holds', 'conceded'] },
          counter: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Deterministic validators (parsed JSON → value|null) and raw-text wrappers
// ---------------------------------------------------------------------------

/** Parsed claims block → claims array (possibly empty) or null when non-compliant. */
export function validateClaims(j) {
  if (!j || !Array.isArray(j.claims)) return null; // non-compliant → retry
  return j.claims
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .slice(0, 5)
    .map((c) => ({ text: String(c.text).trim(), evidence: c.evidence ? String(c.evidence) : '' }));
}

/** R0 contract: at least one usable claim, else non-compliant. */
const validateR0Claims = (j) => {
  const c = validateClaims(j);
  return c && c.length ? c : null;
};

/**
 * Parsed attacks block → { attacks, declared, dropped, no_objection } or null.
 * A VALID empty list (declared 0) is an explicit no-objection. A non-empty list
 * whose entries are ALL invalid (freeloader refutes, unknown stances) is
 * non-compliant — it must never masquerade as "no objection".
 */
export function validateAttacks(j) {
  if (!j || !Array.isArray(j.attacks)) return null; // non-compliant → retry
  const attacks = j.attacks
    .filter((a) => a && a.claim_id && (a.stance === 'refute' || a.stance === 'pass'))
    .map((a) => ({
      claim_id: String(a.claim_id),
      stance: a.stance,
      mechanism: String(a.mechanism || '').trim(),
      falsifier: String(a.falsifier || '').trim(),
      tier: a.tier === 'decisive' ? 'decisive' : 'soft',
    }))
    // a refute with no mechanism is a freeloader — invalid
    .filter((a) => a.stance === 'pass' || a.mechanism.length > 0);
  const declared = j.attacks.length;
  if (declared > 0 && attacks.length === 0) return null;
  return { attacks, declared, dropped: declared - attacks.length, no_objection: declared === 0 };
}

export function validateDefense(j) {
  if (!j || !['holds', 'amend', 'concede'].includes(j.response)) return null;
  return {
    response: j.response,
    amended_claim: j.amended_claim ? String(j.amended_claim) : null,
    rebuttals: Array.isArray(j.rebuttals)
      ? j.rebuttals.map((r) => ({
          attacker: String(r.attacker || ''),
          result: r.result === 'holds' ? 'holds' : 'conceded',
          counter: String(r.counter || ''),
        }))
      : [],
  };
}

export function extractClaims(raw) {
  return validateClaims(extractJson(raw));
}

/** Raw text → attacks array (valid entries only) or null when non-compliant. */
export function extractAttacks(raw) {
  const v = validateAttacks(extractJson(raw));
  return v ? v.attacks : null;
}

export function extractDefense(raw) {
  return validateDefense(extractJson(raw));
}

// ---------------------------------------------------------------------------
// Mechanical classification — PURE, order-immune, no judge LLM.
// ---------------------------------------------------------------------------

/**
 * @param claim   { id, author }
 * @param attacks [{ claim_id, stance, mechanism, falsifier, tier, attacker }]
 * @param defense { response, amended_claim, rebuttals:[{attacker,result}] } | null
 *                (null = no completed defense: not asked, or the call failed)
 * @param N       number of debaters
 * @param phases  REQUIRED phase-completion metadata for this claim:
 *   { r1: [{ spec, attacker, status:'completed'|'failed',
 *            coverage:'refuted'|'passed'|'no-objection'|'unaddressed'|null, failure }],
 *     r2: { spec, status:'completed'|'failed', failure } | null }
 *   r1 lists every opponent that was ELIGIBLE to attack the claim.
 * @returns { status, reason, decisive_refutation|null, amended|null, incomplete, incomplete_reasons }
 */
export function classifyDebateClaim(claim, attacks, defense, N, phases = null) {
  const mk = (status, reason, extra = {}) => ({
    status,
    reason,
    decisive_refutation: null,
    amended: null,
    incomplete: false,
    incomplete_reasons: [],
    ...extra,
  });
  if (!phases || !Array.isArray(phases.r1)) {
    return mk('UNRESOLVED', 'phase completion not recorded — absence of attacks is not evidence of survival', {
      incomplete: true,
      incomplete_reasons: ['phase completion not recorded'],
    });
  }
  if (phases.r1.length === 0) {
    return mk('UNRESOLVED', 'no eligible opponent could attack this claim (every debater shares the author model)', {
      incomplete: true,
      incomplete_reasons: ['no eligible opponent'],
    });
  }
  const refutes = attacks.filter((a) => a.stance === 'refute');
  const gaps = [
    ...phases.r1
      .filter((o) => o.status === 'failed')
      .map((o) => `${o.attacker || o.spec} did not complete R1${o.failure ? ` (${o.failure})` : ''}`),
    ...phases.r1
      .filter((o) => o.status === 'completed' && o.coverage === 'unaddressed')
      .map((o) => `${o.attacker || o.spec} did not address this claim`),
  ];
  const gapInfo = gaps.length ? { incomplete: true, incomplete_reasons: gaps } : {};

  if (refutes.length === 0) {
    if (gaps.length) return mk('UNRESOLVED', `not fully tested — ${gaps.join('; ')}`, gapInfo);
    return mk('SURVIVED', `no valid refutation (${phases.r1.length} opponent(s) completed review)`);
  }

  // Refuted: the author's defense decides. No completed defense is NOT a kill.
  if (!defense) {
    const why =
      phases.r2 && phases.r2.status === 'failed'
        ? `author defense did not complete${phases.r2.failure ? ` (${phases.r2.failure})` : ''}`
        : 'no author defense recorded';
    return mk('UNRESOLVED', `${why} — refutation unanswered, but a missing defense is not a kill`, {
      incomplete: true,
      incomplete_reasons: [...gaps, why],
    });
  }
  if (defense.response === 'concede') {
    return mk('KILLED', 'author conceded', gapInfo);
  }
  if (defense.response === 'amend') {
    return mk('KILLED', 'author amended (original narrowed)', { ...gapInfo, amended: defense.amended_claim || null });
  }

  // author holds
  const heldAttackers = new Set(
    (defense.rebuttals || []).filter((r) => r.result === 'holds').map((r) => r.attacker.toLowerCase())
  );
  // Attacker identity is the canonical MODEL spec (a.attacker); the legacy
  // provider-level field is tolerated for pre-v0.18 records/fixtures.
  const attackerId = (a) => String(a.attacker || a.attackerVendor || '').toLowerCase();
  const attackerHeld = (a) => heldAttackers.has(attackerId(a));

  // A decisive falsifier the author did NOT defeat → KILLED (works at N=2).
  const standingDecisive = refutes.find((a) => a.tier === 'decisive' && a.falsifier && !attackerHeld(a));
  if (standingDecisive) {
    return mk('KILLED', 'decisive falsifier the author did not defeat', { ...gapInfo, decisive_refutation: standingDecisive });
  }

  // N>=3: two distinct non-author opponents (models) validly refute and the
  // author fails each. Model-level identity: two same-runtime models count as
  // two opponents — the decisive bar above stays the guard against correlated
  // same-lab piling-on, since this branch still requires the author to fail
  // BOTH defenses individually.
  if (N >= 3) {
    const unheldOpponents = new Set(refutes.filter((a) => !attackerHeld(a)).map((a) => attackerId(a)));
    if (unheldOpponents.size >= 2) {
      return mk('KILLED', `${unheldOpponents.size} distinct opponents refuted and the author did not hold against each`, gapInfo);
    }
  }

  // Author held against everything standing, and nothing decisive remains.
  if (refutes.every((a) => attackerHeld(a))) {
    if (gaps.length) {
      return mk('UNRESOLVED', `author defeated every refutation received, but review was incomplete — ${gaps.join('; ')}`, gapInfo);
    }
    return mk('SURVIVED', 'author defeated every refutation');
  }

  // Soft dispute with no decisive evidence either way → honest limbo.
  return mk('UNRESOLVED', 'soft dispute — no decisive evidence, needs human', gapInfo);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function debateId() {
  return (
    new Date().toISOString().replace(/[:.TZ-]/g, '').slice(2, 14) +
    '-' +
    Math.random().toString(36).slice(2, 6)
  );
}

/** Parse debater specs; throws `Unknown provider spec: <s>` on the first bad one. */
export function parseDebaters(specs) {
  return specs.map((s) => {
    const p = parseProviderSpec(s);
    if (!p) throw new Error(`Unknown provider spec: ${s}`);
    return p;
  });
}

/**
 * Round-robin cap of author-attributed claims at MAX_CLAIMS. Pure.
 * claims: [{ id: 'C{pi}-{i}', author, authorSpec, text, evidence }]
 */
export function capClaims(claims, parsed) {
  const capped = [];
  let idx = 0;
  const byAuthor = parsed.map((_, pi) => claims.filter((c) => c.id.startsWith(`C${pi}-`)));
  while (capped.length < MAX_CLAIMS && byAuthor.some((a) => a.length)) {
    const lane = byAuthor[idx % byAuthor.length];
    if (lane.length) capped.push(lane.shift());
    idx++;
  }
  return capped;
}

/** CLI arg parser for `run`. Pure. */
export function parseDebateRunArgs(argv) {
  const d = parseDiffFlags(argv);
  if (d.error) return { error: d.error };
  const flags = new Set(['--no-artifacts', '--json']);
  const noArtifacts = d.rest.includes('--no-artifacts');
  const json = d.rest.includes('--json');
  const positional = d.rest.filter((a) => !flags.has(a));
  const specs = (positional[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const question = positional.slice(1).join(' ').trim();
  return { specs, question, diffOpts: d.diffOpts, noArtifacts, json };
}

/** One advisor call, as recorded in the ledger / returned in JSON (no raw text). */
function callMeta(phase, spec, r, extra = {}) {
  return {
    phase,
    spec,
    ...extra,
    status: r.value != null ? 'completed' : 'failed',
    attempts: r.attempts,
    adherence: r.adherence,
    schema_mode: r.schema_mode,
    exit_code: r.code,
    failure: r.failure,
    artifact: r.artifact,
    attribution: r.attribution,
    evidence_key: evidenceKey(r.attribution),
    usage: r.usage,
    cost_estimate: r.cost_estimate,
  };
}

function phaseSummary(calls, phase) {
  const cs = calls.filter((c) => c.phase === phase);
  return {
    asked: cs.length,
    completed: cs.filter((c) => c.status === 'completed').length,
    failed: cs.filter((c) => c.status === 'failed').map((c) => ({ spec: c.spec, claim_id: c.claim_id || null, failure: c.failure?.kind || null, adherence: c.adherence })),
  };
}

export async function runDebate({
  specs,
  question,
  root = process.cwd(),
  context = null,
  contextMeta = null,
  noArtifacts = false,
  ask = askAdvisor,
  env = process.env,
}) {
  noArtifacts = noArtifactsRequested(noArtifacts, env);
  let parsed;
  try {
    parsed = parseDebaters(specs);
  } catch (err) {
    return { exitCode: 1, kind: 'debate', error: err.message };
  }
  if (parsed.length < 2) return { exitCode: 1, kind: 'debate', error: 'Need at least 2 debaters.' };
  const promptQuestion = questionWithContext(question, context);
  // R0 — blind claims (sequential to avoid local/cloud contention). Native
  // schema where supported, one corrective retry per model.
  console.error('[debate] R0 blind claims…');
  const claims = [];
  const adherence = [];
  const r0Calls = [];
  for (let pi = 0; pi < parsed.length; pi++) {
    const p = parsed[pi];
    console.error(`[debate]   ${p.spec}`);
    const r = await askStructured({
      spec: p.spec,
      prompt: buildClaimsPrompt(promptQuestion),
      validate: validateR0Claims,
      schema: CLAIMS_SCHEMA,
      repairHint: 'end with exactly one fenced ```json block: {"claims":[{"text":"...","evidence":"..."}]}',
      noArtifacts,
      env,
      ask,
    });
    adherence.push({ spec: p.spec, phase: 'R0', adherence: r.adherence });
    r0Calls.push(callMeta('R0', p.spec, r));
    (r.value || []).forEach((c, i) =>
      claims.push({ id: `C${pi}-${i + 1}`, author: canonicalSpecKey(p.spec), authorSpec: p.spec, ...c })
    );
  }
  const capped = capClaims(claims, parsed);
  if (!capped.length) {
    return {
      exitCode: 1,
      kind: 'debate',
      error: 'no claims extracted — no advisor produced a valid claims block.',
      completion: { complete: false, r0: phaseSummary(r0Calls, 'R0') },
      calls: r0Calls,
    };
  }
  return runDebateOnClaims({
    question,
    parsed,
    capped,
    root,
    r0Adherence: adherence,
    r0Calls,
    context,
    contextMeta,
    noArtifacts,
    ask,
    env,
  });
}

function renderDebateMarkdown({ id, root, parsed, N, question, contextMeta, results, tally, adherence, completion }) {
  const section = (title, list) =>
    [`## ${title} (${list.length})`, '', ...(list.length ? list : ['- (none)']), ''].join('\n');
  const text = (s) => redactSecrets(s);
  const incompleteNote = (r) => (r.incomplete ? `\n  - INCOMPLETE REVIEW: ${r.incomplete_reasons.join('; ')}` : '');
  const failedCalls = ['R0', 'R1', 'R2'].flatMap((ph) => completion[ph.toLowerCase()].failed.map((f) => `${ph} ${f.spec}${f.claim_id ? ` (${f.claim_id})` : ''}: ${f.failure || f.adherence}`));
  return [
    `# xllm debate — ${tally.SURVIVED} survived · ${tally.KILLED} killed · ${tally.UNRESOLVED} unresolved${completion.complete ? '' : ' (INCOMPLETE: provider failures)'}`,
    '',
    `- Run id: ${id} (ledger: ${ledgerPath(root)})`,
    `- Debaters: ${parsed.map((p) => p.spec).join(', ')}  (N=${N})`,
    `- Question: ${redactSecrets(question)}`,
    ...(contextMeta ? [`- Code context: ${coverageSummary(contextMeta)} — diff body not persisted`] : []),
    '',
    '> Status is a protocol outcome, not truth. SURVIVED = withstood hostile',
    '> refutation from opponents that COMPLETED review; it is not proof. A failed',
    '> or non-compliant provider call is never evidence either way (→ UNRESOLVED).',
    '> Nothing is auto-applied — you decide.',
    '',
    ...(contextMeta && !contextMeta.coverage?.complete ? ['## Code coverage', '', '```text', renderCoverage(contextMeta.coverage), '```', ''] : []),
    ...(failedCalls.length ? ['## Phase completion — failed calls', '', ...failedCalls.map((f) => `- ${f}`), ''] : []),
    section(
      'SURVIVED — withstood refutation',
      results.filter((r) => r.status === 'SURVIVED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)}${r.amended ? ` → amended: ${text(r.amended)}` : ''}`)
    ),
    section(
      'KILLED — refuted',
      results.filter((r) => r.status === 'KILLED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)}\n  - killed: ${r.reason}${r.decisive_refutation ? ` — ${text(r.decisive_refutation.mechanism)}` : ''}${incompleteNote(r)}`)
    ),
    section(
      'UNRESOLVED — needs human',
      results.filter((r) => r.status === 'UNRESOLVED').map((r) => `- **${r.id}** (${r.author}): ${text(r.text)}\n  - ${r.reason}${incompleteNote(r)}`)
    ),
    ...(adherence.some((a) => a.adherence !== 'first')
      ? [
          '## Contract adherence (structured-output health)',
          '',
          ...Object.entries(adherenceSummary(adherence)).map(
            ([spec, s]) => `- ${spec}: first ${s.first || 0} · retry ${s.retry || 0} · failed ${s.failed || 0}`
          ),
          '',
        ]
      : []),
  ].join('\n');
}

/**
 * The adversarial rounds (R1 refute → R2 defend → mechanical classify) over
 * PRE-SUPPLIED claims. Reused by `debate` (claims from its own R0) and by
 * `council` (claims surfaced by an independent panel). panelRunId links the
 * ledger record back to the originating panel.
 *
 * Returns { exitCode:0, schema_version:2, kind:'debate', id, tally, completion,
 * mdPath|null, markdown, results, calls, context, attributions, usage,
 * cost_estimate }. Never prints to stdout (the CLI prints).
 */
export async function runDebateOnClaims({
  question,
  parsed,
  capped,
  root = process.cwd(),
  panelRunId = null,
  r0Adherence = [],
  r0Calls = [],
  context = null,
  contextMeta = null,
  noArtifacts = false,
  ask = askAdvisor,
  env = process.env,
}) {
  noArtifacts = noArtifactsRequested(noArtifacts, env);
  const persist = !noArtifacts;
  const N = parsed.length;
  const id = debateId();
  const adherence = [...r0Adherence];
  const calls = [...r0Calls];
  const promptQuestion = questionWithContext(question, context);

  // R1 — refute (each provider attacks foreign claims only), with retry.
  console.error('[debate] R1 refute…');
  const attacksByClaim = Object.fromEntries(capped.map((c) => [c.id, []]));
  const r1Calls = []; // { spec, attacker, asked:[claim ids], status, no_objection, failure }
  for (const p of parsed) {
    const foreign = foreignClaims(capped, p.spec); // model-level: same-runtime siblings ARE foreign
    if (!foreign.length) continue;
    console.error(`[debate]   ${p.spec} attacks ${foreign.length}`);
    const r = await askStructured({
      spec: p.spec,
      prompt: buildRefutePrompt(promptQuestion, foreign),
      validate: validateAttacks,
      schema: ATTACKS_SCHEMA,
      repairHint: 'end with exactly one fenced ```json block: {"attacks":[{"claim_id":"...","stance":"refute","mechanism":"...","falsifier":"...","tier":"decisive"}]} — use {"attacks":[]} only if you found nothing to object to.',
      noArtifacts,
      env,
      ask,
    });
    adherence.push({ spec: p.spec, phase: 'R1', adherence: r.adherence });
    calls.push(callMeta('R1', p.spec, r, { claims: foreign.map((c) => c.id) }));
    const ok = r.value != null;
    const attacker = canonicalSpecKey(p.spec);
    r1Calls.push({
      spec: p.spec,
      attacker,
      asked: foreign.map((c) => c.id),
      status: ok ? 'completed' : 'failed',
      no_objection: ok && r.value.no_objection,
      failure: ok ? null : r.failure?.kind || 'failed',
    });
    // Only claims this opponent was actually shown can be attacked by it.
    const shown = new Set(foreign.map((c) => c.id));
    for (const a of ok ? r.value.attacks : []) {
      if (shown.has(a.claim_id)) attacksByClaim[a.claim_id].push({ ...a, attacker });
    }
  }

  // Per-claim R1 phase view: every opponent that was eligible, and what it did.
  const r1PhaseFor = (c) =>
    r1Calls
      .filter((o) => o.asked.includes(c.id))
      .map((o) => {
        let coverage = null;
        if (o.status === 'completed') {
          if (o.no_objection) coverage = 'no-objection';
          else if (attacksByClaim[c.id].some((a) => a.attacker === o.attacker && a.stance === 'refute')) coverage = 'refuted';
          else if (attacksByClaim[c.id].some((a) => a.attacker === o.attacker)) coverage = 'passed';
          else coverage = 'unaddressed';
        }
        return { spec: o.spec, attacker: o.attacker, status: o.status, coverage, failure: o.failure };
      });

  // R2 — defend (authors only, challenged claims), with retry.
  console.error('[debate] R2 defend…');
  const defenseByClaim = {};
  const r2ByClaim = {};
  for (const c of capped) {
    const atk = attacksByClaim[c.id].filter((a) => a.stance === 'refute');
    if (!atk.length) continue;
    console.error(`[debate]   ${c.authorSpec} defends ${c.id}`);
    const r = await askStructured({
      spec: c.authorSpec,
      prompt: buildDefendPrompt(c, atk, promptQuestion),
      validate: validateDefense,
      schema: DEFENSE_SCHEMA,
      repairHint: 'end with exactly one fenced ```json block: {"response":"holds|amend|concede","amended_claim":null,"rebuttals":[{"attacker":"...","result":"holds","counter":"..."}]}',
      noArtifacts,
      env,
      ask,
    });
    adherence.push({ spec: c.authorSpec, phase: 'R2', adherence: r.adherence });
    calls.push(callMeta('R2', c.authorSpec, r, { claim_id: c.id }));
    defenseByClaim[c.id] = r.value;
    r2ByClaim[c.id] = { spec: c.authorSpec, status: r.value != null ? 'completed' : 'failed', failure: r.value != null ? null : r.failure?.kind || 'failed' };
  }

  // Resolve (mechanical, from COMPLETED phases only).
  const results = capped.map((c) => {
    const phases = { r1: r1PhaseFor(c), r2: r2ByClaim[c.id] || null };
    const res = classifyDebateClaim(c, attacksByClaim[c.id], defenseByClaim[c.id] || null, N, phases);
    return { ...c, attacks: attacksByClaim[c.id], defense: defenseByClaim[c.id] || null, phases, ...res };
  });
  const tally = { SURVIVED: 0, KILLED: 0, UNRESOLVED: 0 };
  for (const r of results) tally[r.status]++;

  const phaseStats = { r0: phaseSummary(calls, 'R0'), r1: phaseSummary(calls, 'R1'), r2: phaseSummary(calls, 'R2') };
  const incompleteClaims = results.filter((r) => r.incomplete).length;
  const completion = {
    complete: incompleteClaims === 0 && ['r0', 'r1', 'r2'].every((k) => phaseStats[k].failed.length === 0),
    incomplete_claims: incompleteClaims,
    ...phaseStats,
  };
  const attrib = mergeAttributions(calls.map((c) => ({ spec: c.spec, attribution: c.attribution })));
  const usage = sumUsage(calls.map((c) => c.usage));
  const cost = sumCost(calls.map((c) => c.cost_estimate));
  const phasesView = (ph) => ({
    r1: ph.r1.map(({ spec, attacker, status, coverage, failure }) => ({ spec, attacker, status, coverage, failure })),
    r2: ph.r2,
  });

  // Ledger before prose.
  appendLedger(
    {
      type: 'debate',
      schema_version: LEDGER_SCHEMA_VERSION,
      run_id: id,
      panel_run_id: panelRunId,
      created_at: new Date().toISOString(),
      question: persist ? redactSecrets(question) : null,
      content_persisted: persist,
      ...(contextMeta ? { diff_context: contextMeta } : {}),
      debaters: parsed.map((p) => p.spec),
      claims: results.map((r) => ({
        id: r.id,
        author: r.authorSpec,
        text: persist ? redactSecrets(r.text) : null,
        status: r.status,
        reason: r.reason,
        incomplete: r.incomplete,
        incomplete_reasons: r.incomplete_reasons,
        phases: phasesView(r.phases),
        attacks: r.attacks.map((a) => ({
          by: a.attacker || a.attackerVendor,
          tier: a.tier,
          stance: a.stance,
          mechanism: persist ? redactSecrets(a.mechanism) : null,
        })),
        defense: r.defense ? r.defense.response : null,
        amended: persist && r.amended ? redactSecrets(r.amended) : null,
      })),
      tally,
      completion,
      calls,
      adherence: adherenceSummary(adherence),
      attributions: attrib.attributions,
      ...(Object.keys(attrib.conflicts).length ? { attribution_conflicts: attrib.conflicts } : {}),
      usage,
      cost_estimate: cost,
    },
    root
  );

  // Human index (not written under --no-artifacts; returned for the CLI to print).
  const markdown = renderDebateMarkdown({ id, root, parsed, N, question, contextMeta, results, tally, adherence, completion });
  let mdPath = null;
  if (persist) {
    const dir = path.join(ensureArtifactDirs(root), 'xllm');
    mdPath = path.join(dir, `debate-${slugify(question)}-${id}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');
  }

  console.error(
    `[debate] ${tally.SURVIVED} survived · ${tally.KILLED} killed · ${tally.UNRESOLVED} unresolved${completion.complete ? '' : ` · INCOMPLETE (${incompleteClaims} claim(s) not fully reviewed)`}`
  );
  return {
    exitCode: 0,
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'debate',
    id,
    panelRunId,
    tally,
    completion,
    mdPath,
    markdown,
    results,
    calls,
    context: contextMeta,
    attributions: attrib.attributions,
    attribution_conflicts: attrib.conflicts,
    usage,
    cost_estimate: cost,
    noArtifacts,
  };
}

/** Machine result for `--json`. */
export function debateJson(r) {
  if (r.exitCode !== 0) {
    return { schema_version: LEDGER_SCHEMA_VERSION, kind: 'debate', exitCode: r.exitCode, error: r.error || 'debate failed', completion: r.completion || null, calls: r.calls || [] };
  }
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'debate',
    exitCode: r.exitCode,
    run_id: r.id,
    panel_run_id: r.panelRunId,
    tally: r.tally,
    completion: r.completion,
    index_path: r.mdPath,
    context: r.context,
    claims: r.results.map((c) => ({
      id: c.id,
      author: c.authorSpec,
      text: c.text,
      evidence: c.evidence,
      status: c.status,
      reason: c.reason,
      incomplete: c.incomplete,
      incomplete_reasons: c.incomplete_reasons,
      phases: c.phases,
      attacks: c.attacks,
      defense: c.defense,
      amended: c.amended,
      decisive_refutation: c.decisive_refutation,
    })),
    calls: r.calls,
    attributions: r.attributions,
    attribution_conflicts: r.attribution_conflicts,
    usage: r.usage,
    cost_estimate: r.cost_estimate,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    const p = parseDebateRunArgs(argv.slice(1));
    if (p.error || p.specs.length < 2 || !p.question) {
      if (p.error) console.error(`[debate] ${p.error}`);
      console.error('Usage: xllm-debate run p1,p2[,p3] "<question>" [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]');
      process.exit(1);
    }
    let context = null;
    let contextMeta = null;
    if (hasDiffSource(p.diffOpts)) {
      const diff = collectReviewDiff(p.diffOpts);
      if (diff.error) {
        console.error(`[debate] ${diff.error}`);
        process.exit(1);
      }
      context = buildReviewContext(diff);
      contextMeta = diffMeta(diff);
      console.error(`[debate] code context: ${coverageSummary(contextMeta)}`);
    }
    const r = await runDebate({ specs: p.specs, question: p.question, context, contextMeta, noArtifacts: p.noArtifacts });
    r.kind = 'debate';
    emitResult(r, debateJson, p.json);
    process.exit(r.exitCode);
  }
  console.error(`xllm debate — adversarial multi-LLM review (models refute each other)
Usage:
  node scripts/xllm-debate.js run p1,p2[,p3] "<question>" [--staged|--base <ref>|--diff-file <path>] [--json] [--no-artifacts]

R0 blind claims → R1 refute (foreign only) → R2 defend → mechanical
resolution (SURVIVED / KILLED / UNRESOLVED). Only a decisive falsifier kills;
mere disagreement → UNRESOLVED. A failed or non-compliant provider call is
never evidence: it leaves the claim UNRESOLVED with phase-completion metadata.
Status is a protocol outcome, not truth.
--json prints ONE JSON result on stdout; --no-artifacts (or XLLM_NO_ARTIFACTS=1)
writes no index md and keeps text out of the ledger.
Ledger: <state>/panel-ledger.jsonl (type "debate", schema_version 2).`);
  process.exit(argv.length ? 1 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-debate.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
