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
 *   node scripts/xllm-debate.js run p1,p2[,p3] "<question>"
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
} from './xllm-advisor.js';
import { appendLedger, ledgerPath } from './xllm-panel.js';
import { extractJson, askStructured, adherenceSummary } from './xllm-structured.js';
import { canonicalSpecKey } from './xllm-traits.js';

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
Use stance "pass" only when a genuine kill attempt failed; then say why in mechanism.`;
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
 */
export function claimAuthorKey(claim) {
  return canonicalSpecKey(claim.authorSpec || claim.author);
}

/** Claims a debater with this spec may attack (everything it did not author). Pure. */
export function foreignClaims(capped, spec) {
  const mine = canonicalSpecKey(spec);
  return capped.filter((c) => claimAuthorKey(c) !== mine);
}

export function buildDefendPrompt(claim, attacks) {
  const list = attacks
    .map((a) => `- [${a.attacker}] tier=${a.tier}: ${a.mechanism}${a.falsifier ? ` | falsifier: ${a.falsifier}` : ''}`)
    .join('\n');
  return `You authored this claim: "${claim.text}"

It is under HOSTILE attack. Do NOT preserve it out of consistency, and do NOT concede out of politeness. Answer the strongest attack.

ATTACKS:
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
// Deterministic parsers
// ---------------------------------------------------------------------------

export function extractClaims(raw) {
  const j = extractJson(raw);
  if (!j || !Array.isArray(j.claims)) return null; // non-compliant → retry
  return j.claims
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .slice(0, 5)
    .map((c) => ({ text: String(c.text).trim(), evidence: c.evidence ? String(c.evidence) : '' }));
}

export function extractAttacks(raw) {
  const j = extractJson(raw);
  if (!j || !Array.isArray(j.attacks)) return null; // non-compliant → retry
  return j.attacks
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
}

export function extractDefense(raw) {
  const j = extractJson(raw);
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

// ---------------------------------------------------------------------------
// Mechanical classification — PURE, order-immune, no judge LLM.
// ---------------------------------------------------------------------------

/**
 * @param claim   { id, author (vendor) }
 * @param attacks [{ claim_id, stance, mechanism, falsifier, tier, attackerVendor }]
 * @param defense { response, amended_claim, rebuttals:[{attacker,result}] } | null
 * @param N       number of panelists
 * @returns { status, reason, decisive_refutation|null, amended|null }
 */
export function classifyDebateClaim(claim, attacks, defense, N) {
  const refutes = attacks.filter((a) => a.stance === 'refute');
  if (refutes.length === 0) {
    return { status: 'SURVIVED', reason: 'no valid refutation', decisive_refutation: null, amended: null };
  }
  if (defense && defense.response === 'concede') {
    return { status: 'KILLED', reason: 'author conceded', decisive_refutation: null, amended: null };
  }
  if (defense && defense.response === 'amend') {
    return {
      status: 'KILLED',
      reason: 'author amended (original narrowed)',
      decisive_refutation: null,
      amended: defense.amended_claim || null,
    };
  }

  // author holds (or gave no defense — treated as not-holding)
  const heldAttackers = new Set(
    (defense?.rebuttals || []).filter((r) => r.result === 'holds').map((r) => r.attacker.toLowerCase())
  );
  // Attacker identity is the canonical MODEL spec (a.attacker); the legacy
  // provider-level field is tolerated for pre-v0.18 records/fixtures.
  const attackerId = (a) => String(a.attacker || a.attackerVendor || '').toLowerCase();
  const attackerHeld = (a) => heldAttackers.has(attackerId(a));

  // A decisive falsifier the author did NOT defeat → KILLED (works at N=2).
  const standingDecisive = refutes.find((a) => a.tier === 'decisive' && a.falsifier && !attackerHeld(a));
  if (standingDecisive) {
    return {
      status: 'KILLED',
      reason: 'decisive falsifier the author did not defeat',
      decisive_refutation: standingDecisive,
      amended: null,
    };
  }

  // N>=3: two distinct non-author opponents (models) validly refute and the
  // author fails each. Model-level identity: two same-runtime models count as
  // two opponents — the decisive bar above stays the guard against correlated
  // same-lab piling-on, since this branch still requires the author to fail
  // BOTH defenses individually.
  if (N >= 3) {
    const unheldOpponents = new Set(refutes.filter((a) => !attackerHeld(a)).map((a) => attackerId(a)));
    if (unheldOpponents.size >= 2) {
      return {
        status: 'KILLED',
        reason: `${unheldOpponents.size} distinct opponents refuted and the author did not hold against each`,
        decisive_refutation: null,
        amended: null,
      };
    }
  }

  // Author held against everything standing, and nothing decisive remains.
  const allHeld = refutes.every((a) => attackerHeld(a));
  if (allHeld) {
    return { status: 'SURVIVED', reason: 'author defeated every refutation', decisive_refutation: null, amended: null };
  }

  // Soft dispute with no decisive evidence either way → honest limbo.
  return { status: 'UNRESOLVED', reason: 'soft dispute — no decisive evidence, needs human', decisive_refutation: null, amended: null };
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

export function parseDebaters(specs) {
  return specs.map((s) => {
    const p = parseProviderSpec(s);
    if (!p) {
      console.error(`[debate] Unknown provider spec: ${s}`);
      process.exit(1);
    }
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

export async function runDebate({ specs, question, root = process.cwd() }) {
  const parsed = parseDebaters(specs);
  if (parsed.length < 2) {
    console.error('[debate] Need at least 2 debaters.');
    return { exitCode: 1 };
  }
  // R0 — blind claims (sequential to avoid local/cloud contention). One
  // corrective retry per model via the shared structured layer.
  console.error('[debate] R0 blind claims…');
  const claims = [];
  const adherence = [];
  for (let pi = 0; pi < parsed.length; pi++) {
    const p = parsed[pi];
    console.error(`[debate]   ${p.spec}`);
    const r = await askStructured({
      spec: p.spec,
      prompt: buildClaimsPrompt(question),
      parse: (raw) => {
        const c = extractClaims(raw);
        return c && c.length ? c : null;
      },
      repairHint: 'end with exactly one fenced ```json block: {"claims":[{"text":"...","evidence":"..."}]}',
    });
    adherence.push({ spec: p.spec, phase: 'R0', adherence: r.adherence });
    (r.value || []).forEach((c, i) =>
      claims.push({ id: `C${pi}-${i + 1}`, author: canonicalSpecKey(p.spec), authorSpec: p.spec, ...c })
    );
  }
  const capped = capClaims(claims, parsed);
  if (!capped.length) {
    console.error('[debate] no claims extracted — advisors did not emit the claims block.');
    return { exitCode: 1 };
  }
  return runDebateOnClaims({ question, parsed, capped, root, r0Adherence: adherence });
}

/**
 * The adversarial rounds (R1 refute → R2 defend → mechanical classify) over
 * PRE-SUPPLIED claims. Reused by `debate` (claims from its own R0) and by
 * `council` (claims surfaced by an independent panel). panelRunId links the
 * ledger record back to the originating panel.
 */
export async function runDebateOnClaims({ question, parsed, capped, root = process.cwd(), panelRunId = null, r0Adherence = [] }) {
  const N = parsed.length;
  const id = debateId();
  const adherence = [...r0Adherence];

  // R1 — refute (each provider attacks foreign claims only), with retry.
  console.error('[debate] R1 refute…');
  const attacksByClaim = Object.fromEntries(capped.map((c) => [c.id, []]));
  for (const p of parsed) {
    const foreign = foreignClaims(capped, p.spec); // model-level: same-runtime siblings ARE foreign
    if (!foreign.length) continue;
    console.error(`[debate]   ${p.spec} attacks ${foreign.length}`);
    const r = await askStructured({
      spec: p.spec,
      prompt: buildRefutePrompt(question, foreign),
      parse: extractAttacks,
      repairHint: 'end with exactly one fenced ```json block: {"attacks":[{"claim_id":"...","stance":"refute","mechanism":"...","falsifier":"...","tier":"decisive"}]}',
    });
    adherence.push({ spec: p.spec, phase: 'R1', adherence: r.adherence });
    for (const a of r.value || []) {
      if (attacksByClaim[a.claim_id]) attacksByClaim[a.claim_id].push({ ...a, attacker: canonicalSpecKey(p.spec) });
    }
  }

  // R2 — defend (authors only, challenged claims), with retry.
  console.error('[debate] R2 defend…');
  const defenseByClaim = {};
  for (const c of capped) {
    const atk = attacksByClaim[c.id].filter((a) => a.stance === 'refute');
    if (!atk.length) continue;
    console.error(`[debate]   ${c.authorSpec} defends ${c.id}`);
    const r = await askStructured({
      spec: c.authorSpec,
      prompt: buildDefendPrompt(c, atk),
      parse: extractDefense,
      repairHint: 'end with exactly one fenced ```json block: {"response":"holds|amend|concede","amended_claim":null,"rebuttals":[{"attacker":"...","result":"holds","counter":"..."}]}',
    });
    adherence.push({ spec: c.authorSpec, phase: 'R2', adherence: r.adherence });
    defenseByClaim[c.id] = r.value;
  }

  // Resolve (mechanical).
  const results = capped.map((c) => {
    const res = classifyDebateClaim(c, attacksByClaim[c.id], defenseByClaim[c.id] || null, N);
    return { ...c, attacks: attacksByClaim[c.id], defense: defenseByClaim[c.id] || null, ...res };
  });
  const tally = { SURVIVED: 0, KILLED: 0, UNRESOLVED: 0 };
  for (const r of results) tally[r.status]++;

  // Ledger before prose.
  appendLedger(
    {
      type: 'debate',
      run_id: id,
      panel_run_id: panelRunId,
      created_at: new Date().toISOString(),
      question: redactSecrets(question),
      debaters: parsed.map((p) => p.spec),
      claims: results.map((r) => ({
        id: r.id,
        author: r.authorSpec,
        text: redactSecrets(r.text),
        status: r.status,
        reason: r.reason,
        attacks: r.attacks.map((a) => ({ by: a.attacker || a.attackerVendor, tier: a.tier, stance: a.stance, mechanism: redactSecrets(a.mechanism) })),
        defense: r.defense ? r.defense.response : null,
        amended: r.amended ? redactSecrets(r.amended) : null,
      })),
      tally,
      adherence: adherenceSummary(adherence),
    },
    root
  );

  // Human index.
  const dir = path.join(ensureArtifactDirs(root), 'xllm');
  const mdPath = path.join(dir, `debate-${slugify(question)}-${id}.md`);
  const section = (title, list) =>
    [`## ${title} (${list.length})`, '', ...(list.length ? list : ['- (none)']), ''].join('\n');
  fs.writeFileSync(
    mdPath,
    [
      `# xllm debate — ${tally.SURVIVED} survived · ${tally.KILLED} killed · ${tally.UNRESOLVED} unresolved`,
      '',
      `- Run id: ${id} (ledger: ${ledgerPath(root)})`,
      `- Debaters: ${parsed.map((p) => p.spec).join(', ')}  (N=${N})`,
      `- Question: ${redactSecrets(question)}`,
      '',
      '> Status is a protocol outcome, not truth. SURVIVED = withstood hostile',
      '> refutation; it is not proof. Nothing is auto-applied — you decide.',
      '',
      section(
        'SURVIVED — withstood refutation',
        results.filter((r) => r.status === 'SURVIVED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)}${r.amended ? ` → amended: ${redactSecrets(r.amended)}` : ''}`)
      ),
      section(
        'KILLED — refuted',
        results.filter((r) => r.status === 'KILLED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)}\n  - killed: ${r.reason}${r.decisive_refutation ? ` — ${redactSecrets(r.decisive_refutation.mechanism)}` : ''}`)
      ),
      section(
        'UNRESOLVED — needs human',
        results.filter((r) => r.status === 'UNRESOLVED').map((r) => `- **${r.id}** (${r.author}): ${redactSecrets(r.text)}\n  - ${r.reason}`)
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
    ].join('\n'),
    'utf8'
  );

  console.error(`[debate] ${tally.SURVIVED} survived · ${tally.KILLED} killed · ${tally.UNRESOLVED} unresolved`);
  console.log(mdPath);
  return { exitCode: 0, id, tally, mdPath, results };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    const specs = (argv[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const question = argv.slice(2).join(' ').trim();
    if (specs.length < 2 || !question) {
      console.error('Usage: xllm-debate run p1,p2[,p3] "<question>"');
      process.exit(1);
    }
    const r = await runDebate({ specs, question });
    process.exit(r.exitCode);
  }
  console.error(`xllm debate — adversarial multi-LLM review (models refute each other)
Usage:
  node scripts/xllm-debate.js run p1,p2[,p3] "<question>"

R0 blind claims → R1 refute (foreign only) → R2 defend → mechanical
resolution (SURVIVED / KILLED / UNRESOLVED). Only a decisive falsifier kills;
mere disagreement → UNRESOLVED. Status is a protocol outcome, not truth.
Ledger: <state>/panel-ledger.jsonl (type "debate").`);
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
