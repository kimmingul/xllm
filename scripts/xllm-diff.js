#!/usr/bin/env node
/**
 * xllm diff context — deterministic git-diff collector for the review family.
 *
 * Modeled on scribe's collectors: gathered with plain git, size-bounded, and
 * NEVER persisted by the review ledgers/indexes — the diff body goes only into
 * the advisor prompt; ledgers and indexes record metadata (source / stat /
 * bytes / truncated / coverage), not the diff. (Advisor child artifacts DO
 * persist prompts unless --no-artifacts is set.)
 *
 * Budgeting is file/hunk-boundary, never a silent byte cut: the diff is parsed
 * into files → hunks, hunks are chosen under a strict byte budget, hunks too
 * large for any single slot are split on line boundaries into explicit parts,
 * and EVERYTHING not shown is enumerated in a coverage manifest (complete in
 * the metadata, bounded in the prompt). The reviewer is told exactly what it
 * was not given.
 *
 * Standalone on purpose (no project imports) so it stays ESM-cycle-free:
 * xllm-advisor.js AND panel/debate/council all import this module.
 */

import fs from 'fs';
import { spawnSync } from 'child_process';

/** Strict upper bound (UTF-8 bytes) on the diff body that travels in a prompt. */
export const DIFF_MAX_BYTES = 24 * 1024;

/**
 * Prompts longer than this (in CHARS — the unit of the Windows ~32K
 * CreateProcess command-line cap) are handed to the advisor via --prompt-file
 * instead of argv. Single source of truth for BOTH the structured layer and
 * advisor --multi; lives here because this module is import-cycle-free
 * (structured imports advisor's sibling path, advisor imports this).
 */
export const PROMPT_FILE_THRESHOLD = 24000;

/** Prompt-side bounds for the non-diff blocks (the full data lives in metadata). */
export const MANIFEST_MAX_BYTES = 6 * 1024;
export const STAT_MAX_BYTES = 4 * 1024;

/** Max bytes read from git (`git diff` bigger than this is refused, not clipped). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Worst-case size of one inline "NOT SHOWN" marker line, reserved in the budget. */
const MARKER_COST = 80;
/** Worst-case size of a rewritten part header line, reserved when splitting. */
const PART_HEADER_RESERVE = 256;
/** A single diff line longer than this is cut (explicitly) at a codepoint boundary. */
const MAX_LINE_BYTES = 2048;

const enc = (s) => Buffer.byteLength(s, 'utf8');

/** Longest prefix of `s` within `maxBytes` UTF-8 bytes, cut on a codepoint boundary. */
function clipUtf8(s, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // continuation bytes
  return buf.subarray(0, end).toString('utf8');
}

/** Path text safe to embed in a prompt/manifest line (no control chars, bounded). */
function displayPath(p) {
  return clipUtf8(String(p).replace(/[\u0000-\u001f\u007f]/g, '?'), 160);
}

/** Extract --staged / --base <ref> / --diff-file <path> from argv. Pure. */
export function parseDiffFlags(argv) {
  const rest = [];
  const diffOpts = { staged: false, base: null, diffFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') diffOpts.staged = true;
    else if (a === '--base') {
      // git refs cannot start with '-', so a flag-like token is a missing value
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--base requires a ref' };
      diffOpts.base = argv[++i];
    } else if (a === '--diff-file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--diff-file requires a path' };
      diffOpts.diffFile = argv[++i];
    } else rest.push(a);
  }
  const sources = [diffOpts.staged, diffOpts.base, diffOpts.diffFile].filter(Boolean).length;
  if (sources > 1) {
    return { error: 'pick exactly one diff source: --staged | --base <ref> | --diff-file <path>' };
  }
  return { diffOpts, rest };
}

export function hasDiffSource(diffOpts) {
  return !!(diffOpts && (diffOpts.staged || diffOpts.base || diffOpts.diffFile));
}

function git(args, root) {
  return spawnSync('git', ['-c', 'core.quotepath=off', '-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

// ---------------------------------------------------------------------------
// Unified-diff parsing (files → hunks)
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A line longer than maxBytes is cut at a codepoint boundary, with an explicit marker. */
function capLine(line, maxBytes) {
  const total = enc(line);
  if (total <= maxBytes) return { text: line, cut: 0, total };
  const keep = clipUtf8(line, maxBytes);
  const cut = total - enc(keep);
  return { text: `${keep} [... LINE CUT: ${cut} bytes not shown ...]`, cut, total };
}

function parseGitPath(S) {
  const rest = S.slice('diff --git '.length);
  const at = Math.max(rest.lastIndexOf(' b/'), rest.lastIndexOf(' "b/'));
  const p = at >= 0 ? rest.slice(rest.indexOf('b/', at) + 2) : rest;
  return p.replace(/^"|"$/g, '');
}

function pathFromMarker(S) {
  // "+++ b/x\t<timestamp>" / "--- a/x" / "+++ /dev/null"
  const p = S.slice(4).split('\t')[0].trim().replace(/^"|"$/g, '');
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
}

function newFile(path) {
  return { path, change: 'modified', headerLines: [], hunks: [], binary: false, payloadBytes: 0, preamble: false };
}

/**
 * Parse unified-diff text into files and hunks. Tolerant of git and plain
 * `---`/`+++` patches, format-patch preambles/trailers, binary markers and
 * unparseable `@@` headers; text it cannot attribute to a file becomes the
 * "(preamble)" pseudo-file so NOTHING is dropped from accounting. Hunk bodies
 * are consumed by the header's line counts, so a removed line such as
 * "-- comment" is never mistaken for a file marker.
 */
function parseUnifiedDiff(text, maxLine) {
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const pre = newFile('(preamble)');
  pre.preamble = true;
  pre.change = 'preamble';
  const files = [];
  let cur = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let payload = false;

  const bodyLine = (h, line, kind) => {
    const c = capLine(line, maxLine);
    h.lines.push({ text: c.text, kind, cut: c.cut, total: c.total });
  };
  const preHunk = () => {
    if (!pre.hunks.length) pre.hunks.push({ idx: 1, header: null, counts: null, lines: [] });
    return pre.hunks[0];
  };

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const S = line.endsWith('\r') ? line.slice(0, -1) : line;

    // 1. counted hunk body
    if (hunk && hunk.counts && (oldLeft > 0 || newLeft > 0)) {
      const c = S[0];
      if (c === '\\') {
        bodyLine(hunk, line, 'meta');
        continue;
      }
      if (c === '+' && newLeft > 0) {
        newLeft--;
        bodyLine(hunk, line, 'add');
        continue;
      }
      if (c === '-' && oldLeft > 0) {
        oldLeft--;
        bodyLine(hunk, line, 'del');
        continue;
      }
      if ((c === ' ' || S === '') && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        bodyLine(hunk, line, 'ctx');
        continue;
      }
      oldLeft = newLeft = 0; // declared counts disagree with the body: re-sync structurally
    }

    // 2. opaque binary payload (base85 data after "GIT binary patch")
    if (payload && !S.startsWith('diff --git ')) {
      cur.payloadBytes += enc(line) + 1;
      continue;
    }

    // 3. structural markers
    if (S.startsWith('diff --git ')) {
      cur = newFile(parseGitPath(S));
      cur.headerLines.push(capLine(line, maxLine).text);
      files.push(cur);
      hunk = null;
      payload = false;
      continue;
    }
    if (S.startsWith('--- ') && raw[i + 1] !== undefined && raw[i + 1].startsWith('+++ ') && (!cur || cur.hunks.length > 0)) {
      cur = newFile(pathFromMarker(raw[i + 1].replace(/\r$/, '')) || pathFromMarker(S) || '(unknown)');
      cur.headerLines.push(capLine(line, maxLine).text, capLine(raw[i + 1], maxLine).text);
      files.push(cur);
      hunk = null;
      i++;
      continue;
    }
    if (S.startsWith('@@')) {
      const owner = cur || (cur = newFile('(patch)'), files.push(cur), cur);
      const m = HUNK_RE.exec(S);
      const counts = m
        ? { os: +m[1], oc: m[2] === undefined ? 1 : +m[2], ns: +m[3], nc: m[4] === undefined ? 1 : +m[4], section: m[5] }
        : null;
      hunk = { idx: owner.hunks.length + 1, header: capLine(line, maxLine).text, counts, lines: [] };
      owner.hunks.push(hunk);
      oldLeft = counts ? counts.oc : 0;
      newLeft = counts ? counts.nc : 0;
      continue;
    }

    // 4. everything else: file header, hunk trailer/raw body, or preamble
    if (S.startsWith('\\') && hunk) {
      bodyLine(hunk, line, 'meta');
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (/^Binary files .* differ$/.test(S)) cur.binary = true;
      if (S === 'GIT binary patch') {
        cur.binary = true;
        payload = true;
      }
      cur.headerLines.push(capLine(line, maxLine).text);
      continue;
    }
    if (hunk) {
      bodyLine(hunk, line, hunk.counts ? 'meta' : 'raw');
      continue;
    }
    bodyLine(preHunk(), line, 'raw');
  }

  for (const f of files) {
    const h = f.headerLines.join('\n');
    const plus = f.headerLines.find((l) => l.startsWith('+++ '));
    const minus = f.headerLines.find((l) => l.startsWith('--- '));
    if (f.path === '(unknown)' || !f.path) f.path = (plus && pathFromMarker(plus)) || (minus && pathFromMarker(minus)) || '(unknown)';
    f.change = f.binary
      ? 'binary'
      : /^new file mode/m.test(h)
        ? 'added'
        : /^deleted file mode/m.test(h)
          ? 'deleted'
          : /^rename (from|to) /m.test(h)
            ? 'renamed'
            : /^copy (from|to) /m.test(h)
              ? 'copied'
              : !f.hunks.length && /^old mode/m.test(h)
                ? 'mode-change'
                : 'modified';
  }
  return pre.hunks.length ? [pre, ...files] : files;
}

/** 1 = deprioritized (lockfiles, generated/minified/snapshot/vendored output). */
function pathTier(p) {
  return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|Pipfile\.lock)$/.test(p) ||
    /\.(lock|min\.js|min\.css|snap|map|pb\.go|generated\.[a-z]+)$/.test(p) ||
    /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\//.test(p)
    ? 1
    : 0;
}

const rangeOf = (start, count) => (count > 0 ? `${start}-${start + count - 1}` : null);

/** Split one hunk into ≤maxUnit-byte segments on LINE boundaries (never mid-line/codepoint). */
function segmentHunk(file, hunk, maxUnit) {
  const c = hunk.counts;
  const head = hunk.header ? [hunk.header] : [];
  const headBytes = head.reduce((a, l) => a + enc(l) + 1, 0);
  const lineBytes = (l) => enc(l.text) + 1;
  const bodyBytes = hunk.lines.reduce((a, l) => a + lineBytes(l), 0);
  if (headBytes + bodyBytes <= maxUnit || !hunk.lines.length) {
    return [
      {
        part: null,
        parts: 1,
        lines: [...head, ...hunk.lines.map((l) => l.text)],
        rawLines: hunk.lines,
        old_lines: c ? rangeOf(c.os, c.oc) : null,
        new_lines: c ? rangeOf(c.ns, c.nc) : null,
        header: hunk.header,
      },
    ];
  }
  const room = Math.max(maxUnit - PART_HEADER_RESERVE, 64);
  const chunks = [];
  let cur = [];
  let used = 0;
  for (const l of hunk.lines) {
    const b = lineBytes(l);
    if (cur.length && used + b > room) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(l);
    used += b;
  }
  if (cur.length) chunks.push(cur);
  let o = c ? c.os : 0;
  let n = c ? c.ns : 0;
  let at = 1;
  return chunks.map((chunk, k) => {
    let oc = 0;
    let nc = 0;
    for (const l of chunk) {
      if (l.kind === 'ctx' || l.kind === 'del') oc++;
      if (l.kind === 'ctx' || l.kind === 'add') nc++;
    }
    const tag = `[part ${k + 1}/${chunks.length} of hunk ${hunk.idx}]`;
    let header;
    let old_lines = null;
    let new_lines = null;
    if (c) {
      header = `@@ -${o},${oc} +${n},${nc} @@${clipUtf8(c.section, 100)} ${tag}`;
      old_lines = rangeOf(o, oc);
      new_lines = rangeOf(n, nc);
      o += oc;
      n += nc;
    } else {
      header = `[part ${k + 1}/${chunks.length} of ${file.preamble ? 'the text before the first file header' : `hunk ${hunk.idx} (unparsed @@ header)`}; body lines ${at}-${at + chunk.length - 1}]`;
    }
    at += chunk.length;
    return {
      part: k + 1,
      parts: chunks.length,
      lines: [header, ...chunk.map((l) => l.text)],
      rawLines: chunk,
      old_lines,
      new_lines,
      header: hunk.header,
    };
  });
}

function gapMarker(units) {
  const bytes = units.reduce((a, u) => a + u.bytes, 0);
  const what = units.map((u) => (u.kind === 'header' ? 'file header' : u.part ? `#${u.hunk} part ${u.part}/${u.parts}` : `#${u.hunk}`)).join(', ');
  const t = `[... NOT SHOWN: ${what} (${bytes} bytes) ...]`;
  // Fallback worst case is ~56 bytes, so every marker is ≤ MARKER_COST.
  return enc(t) <= MARKER_COST ? t : `[... NOT SHOWN: ${units.length} segment(s), ${bytes} bytes ...]`;
}

/**
 * Budget a diff to `budget` UTF-8 bytes at file/hunk boundaries. Pure.
 *
 * - If the whole diff fits, it is returned verbatim (coverage complete).
 * - Otherwise hunks are chosen round-robin across files (first hunk of every
 *   file, then every second hunk, …; lockfiles/generated files last) so the
 *   budget is spread over the change instead of exhausted by the first files,
 *   then emitted in original order with inline NOT SHOWN markers.
 * - A hunk larger than budget/4 is split on line boundaries into explicit
 *   `[part k/n]` segments (headers rewritten so line numbers stay true);
 *   unshown parts are enumerated — a huge hunk is never pretended-read.
 * - A single line over ~2KB is cut at a codepoint boundary with a marker.
 * - `body` is strictly ≤ budget bytes.
 *
 * Returns { body, coverage }.
 */
export function budgetDiff(text, budget = DIFF_MAX_BYTES) {
  const src = String(text ?? '');
  const total = enc(src);
  const fits = total <= budget;
  const maxLine = fits ? Infinity : Math.min(MAX_LINE_BYTES, Math.max(64, Math.floor(budget / 16)));
  const maxUnit = Math.max(Math.floor(budget / 4), (fits ? 0 : maxLine) + PART_HEADER_RESERVE);
  const files = parseUnifiedDiff(src, maxLine);

  const units = [];
  files.forEach((f, fi) => {
    f.tier = pathTier(f.path);
    f.headerBytes = f.headerLines.reduce((a, l) => a + enc(l) + 1, 0);
    f.units = [];
    if (!f.hunks.length) {
      f.units.push({ kind: 'header', ord: 0, lines: [], rawLines: [], bytes: 0, hunk: null, part: null, parts: 1, old_lines: null, new_lines: null, header: null });
    } else {
      let ord = 0;
      for (const h of f.hunks) {
        for (const seg of segmentHunk(f, h, maxUnit)) {
          f.units.push({ kind: 'hunk', ord: ord++, hunk: h.idx, bytes: seg.lines.reduce((a, l) => a + enc(l) + 1, 0), ...seg });
        }
      }
    }
    f.shownFlags = new Array(f.units.length).fill(fits);
    f.gaps = 0;
    f.anyShown = false;
    f.units.forEach((u, pos) => {
      u.fi = fi;
      u.pos = pos;
      u.shown = fits;
      units.push(u);
    });
  });

  if (!fits) {
    // Round-robin by unit ordinal within file; deprioritized files after all others.
    const order = units.slice().sort((a, b) => files[a.fi].tier - files[b.fi].tier || a.ord - b.ord || a.fi - b.fi);
    let used = 0;
    for (const u of order) {
      const f = files[u.fi];
      // Exact rendered-size accounting: a gap marker (≤ MARKER_COST bytes) is
      // emitted per maximal run of unshown units inside a shown file, so
      // showing a unit changes the file's gap count by a computable delta.
      const n = f.units.length;
      let newGaps;
      if (!f.anyShown) newGaps = (u.pos > 0 ? 1 : 0) + (u.pos < n - 1 ? 1 : 0);
      else {
        let a = u.pos;
        while (a > 0 && !f.shownFlags[a - 1]) a--;
        let b = u.pos;
        while (b < n - 1 && !f.shownFlags[b + 1]) b++;
        newGaps = f.gaps + (a < u.pos ? 1 : 0) + (u.pos < b ? 1 : 0) - 1;
      }
      const cost = u.bytes + (f.anyShown ? 0 : f.headerBytes) + (newGaps - f.gaps) * MARKER_COST;
      if (used + cost <= budget) {
        u.shown = true;
        f.shownFlags[u.pos] = true;
        f.anyShown = true;
        f.gaps = newGaps;
        used += cost;
      }
    }
  }

  let body;
  if (fits) {
    body = src.replace(/\r?\n$/, '');
  } else {
    const out = [];
    for (const f of files) {
      if (!f.units.some((u) => u.shown)) continue;
      out.push(...f.headerLines);
      let pending = [];
      const flush = () => {
        if (pending.length) out.push(gapMarker(pending));
        pending = [];
      };
      for (const u of f.units) {
        if (u.shown) {
          flush();
          out.push(...u.lines);
        } else pending.push(u);
      }
      flush();
    }
    body = out.join('\n');
  }

  return { body, coverage: buildCoverage(files, units, { budget, total, body, fits }) };
}

function buildCoverage(files, units, { budget, total, body, fits }) {
  const covered = [];
  const omitted = [];
  const opaque = [];
  const truncatedLines = [];
  let hunksTotal = 0;
  let hunksShown = 0;
  let hunksPartial = 0;
  let hunksOmitted = 0;
  let filesOmitted = 0;

  for (const f of files) {
    const path = f.preamble ? '(preamble)' : f.path;
    const fileBytes = f.headerBytes + f.units.reduce((a, u) => a + u.bytes, 0);
    if (f.binary) opaque.push({ path, bytes: f.headerBytes + f.payloadBytes, reason: 'binary content is not representable as text' });
    const anyShown = f.units.some((u) => u.shown);
    if (!f.hunks.length) {
      if (anyShown) covered.push({ path, change: f.change, hunks: [], partial: [] });
      else {
        filesOmitted++;
        omitted.push({ path, change: f.change, scope: 'file', hunks: 0, bytes: f.headerBytes, reason: 'budget' });
      }
      continue;
    }
    if (!anyShown) {
      filesOmitted++;
      hunksTotal += f.hunks.length;
      hunksOmitted += f.hunks.length;
      omitted.push({ path, change: f.change, scope: 'file', hunks: f.hunks.length, bytes: fileBytes, reason: 'budget' });
      continue;
    }
    const full = [];
    const partial = [];
    for (const h of f.hunks) {
      hunksTotal++;
      const us = f.units.filter((u) => u.hunk === h.idx);
      const shown = us.filter((u) => u.shown);
      for (const u of shown) {
        u.rawLines.forEach((l, k) => {
          if (l.cut) truncatedLines.push({ path, hunk: h.idx, part: u.part, body_line: k + 1, bytes_total: l.total, bytes_not_shown: l.cut });
        });
      }
      if (shown.length === us.length) {
        hunksShown++;
        full.push(h.idx);
      } else if (!shown.length) {
        hunksOmitted++;
        omitted.push({
          path,
          change: f.change,
          scope: 'hunk',
          hunk: h.idx,
          // numeric range only: the function-context text after "@@" is source code
          header: h.counts ? `@@ -${h.counts.os},${h.counts.oc} +${h.counts.ns},${h.counts.nc} @@` : null,
          bytes: us.reduce((a, u) => a + u.bytes, 0),
          old_lines: h.counts ? rangeOf(h.counts.os, h.counts.oc) : null,
          new_lines: h.counts ? rangeOf(h.counts.ns, h.counts.nc) : null,
          reason: 'budget',
        });
      } else {
        hunksPartial++;
        partial.push({ hunk: h.idx, parts_total: us.length, parts_shown: shown.map((u) => u.part) });
        for (const u of us.filter((x) => !x.shown)) {
          omitted.push({
            path,
            change: f.change,
            scope: 'part',
            hunk: h.idx,
            part: u.part,
            parts_total: u.parts,
            bytes: u.bytes,
            old_lines: u.old_lines,
            new_lines: u.new_lines,
            reason: 'budget',
          });
        }
      }
    }
    covered.push({ path, change: f.change, hunks: full, partial });
  }

  const shownUnits = units.filter((u) => u.shown);
  const complete = omitted.length === 0 && truncatedLines.length === 0;
  return {
    version: 1,
    budget_bytes: budget,
    total_bytes: total,
    shown_bytes: enc(body),
    complete,
    files_total: files.length,
    files_omitted: filesOmitted,
    hunks_total: hunksTotal,
    hunks_shown: hunksShown,
    hunks_partial: hunksPartial,
    hunks_omitted: hunksOmitted,
    covered,
    omitted,
    opaque,
    truncated_lines: truncatedLines,
    units_shown: shownUnits.length,
    verbatim: fits,
  };
}

/**
 * Coverage manifest as prompt text, bounded to maxBytes (NOT SHOWN entries
 * first; overflow is counted, with the complete list in the persisted
 * metadata). Tells the reviewer what it was NOT given. Pure.
 */
export function renderCoverage(cov, maxBytes = MANIFEST_MAX_BYTES) {
  const nopaque = cov.opaque.length;
  if (cov.complete) {
    const lines = [
      `DIFF COVERAGE — COMPLETE: every text hunk (${cov.hunks_total} in ${cov.files_total} file(s), ${cov.total_bytes} bytes) is shown.`,
    ];
    if (nopaque) lines.push(`OPAQUE (binary, content not readable): ${cov.opaque.map((o) => displayPath(o.path)).join(', ')}`);
    return clipUtf8(lines.join('\n'), maxBytes);
  }
  const out = [
    `DIFF COVERAGE — PARTIAL: ${cov.shown_bytes} of ${cov.total_bytes} diff bytes shown; ` +
      `${cov.hunks_shown} of ${cov.hunks_total} hunk(s) shown in full, ${cov.hunks_partial} in part, ${cov.hunks_omitted} not shown; ` +
      `${cov.files_omitted} of ${cov.files_total} file(s) not shown at all.`,
    'Anything listed as NOT SHOWN was NOT given to you. Do not assert facts about it; say so explicitly when a conclusion depends on unseen code.',
  ];
  let used = enc(out.join('\n'));
  const reserve = 160;
  let dropped = 0;
  const add = (line) => {
    const b = enc(line) + 1;
    if (used + b > maxBytes - reserve) {
      dropped++;
      return;
    }
    out.push(line);
    used += b;
  };
  const label = (o) =>
    o.scope === 'file'
      ? `- ${displayPath(o.path)} (${o.change}${o.hunks ? `, ${o.hunks} hunk(s)` : ''}, ${o.bytes} bytes) — entire file`
      : o.scope === 'hunk'
        ? `- ${displayPath(o.path)} hunk ${o.hunk}${o.header ? ` ${o.header}` : ''} (${o.bytes} bytes)`
        : `- ${displayPath(o.path)} hunk ${o.hunk} part ${o.part}/${o.parts_total}${o.new_lines ? ` (new lines ${o.new_lines})` : ''} (${o.bytes} bytes)`;
  if (cov.omitted.length) {
    out.push('NOT SHOWN:');
    for (const o of cov.omitted) add(label(o));
  }
  const parts = cov.covered.filter((c) => c.partial.length);
  if (parts.length) {
    out.push('SHOWN IN PART:');
    for (const c of parts) {
      add(`- ${displayPath(c.path)}: ${c.partial.map((p) => `hunk ${p.hunk} parts ${p.parts_shown.join(',')} of ${p.parts_total}`).join('; ')}`);
    }
  }
  if (nopaque) {
    out.push('OPAQUE (binary, content not readable):');
    for (const o of cov.opaque) add(`- ${displayPath(o.path)}`);
  }
  if (cov.truncated_lines.length) {
    out.push(`LINES CUT (single line too long): ${cov.truncated_lines.length} line(s) — marked inline`);
  }
  const shownList = cov.covered.filter((c) => !c.partial.length).map((c) => `${displayPath(c.path)}${c.hunks.length ? ` (${c.hunks.length})` : ''}`);
  if (shownList.length) add(`SHOWN IN FULL: ${shownList.join('; ')}`);
  if (dropped) out.push(`… ${dropped} more manifest line(s) not listed here — the complete manifest is in the result/ledger metadata (diff_context.coverage).`);
  return clipUtf8(out.join('\n'), maxBytes);
}

/** Bound `git diff --stat` to STAT_MAX_BYTES, keeping the summary line. Pure. */
export function boundStat(stat, maxBytes = STAT_MAX_BYTES) {
  const s = String(stat || '').trim();
  if (!s || enc(s) <= maxBytes) return s;
  const lines = s.split('\n');
  const summary = lines.pop();
  const kept = [];
  let used = enc(summary) + 96;
  for (const l of lines) {
    const b = enc(l) + 1;
    if (used + b > maxBytes) break;
    kept.push(l);
    used += b;
  }
  const omitted = lines.length - kept.length;
  return [...kept, `... ${omitted} more file stat line(s) omitted ...`, summary].join('\n');
}

/**
 * Collect the diff for exactly one source. Deterministic (plain git / file
 * read). Returns { source, body, stat, bytes, truncated, coverage } or { error }.
 * `truncated` is true when any text hunk is not (fully) shown.
 */
export function collectReviewDiff(diffOpts, root = process.cwd(), { budget = DIFF_MAX_BYTES } = {}) {
  const finish = (source, body, stat) => {
    const t = budgetDiff(body, budget);
    return {
      source,
      body: t.body,
      stat: boundStat(stat) || null,
      bytes: enc(body),
      truncated: !t.coverage.complete,
      coverage: t.coverage,
    };
  };
  if (diffOpts.diffFile) {
    let body;
    try {
      body = fs.readFileSync(diffOpts.diffFile, 'utf8');
    } catch {
      return { error: `cannot read diff file: ${diffOpts.diffFile}` };
    }
    if (!body.trim()) return { error: `diff file is empty: ${diffOpts.diffFile}` };
    return finish(`file:${diffOpts.diffFile}`, body, null);
  }
  const probe = git(['rev-parse', '--git-dir'], root);
  if (probe.error) return { error: 'git binary not found on PATH' };
  if (probe.status !== 0) return { error: 'not a git repository' };
  if (diffOpts.base && git(['rev-parse', '--verify', '--quiet', diffOpts.base], root).status !== 0) {
    return { error: `unknown ref: ${diffOpts.base}` };
  }
  const range = diffOpts.staged ? ['--staged'] : [diffOpts.base];
  const diff = git(['diff', '--no-color', '--no-ext-diff', ...range], root);
  if (diff.error) {
    return {
      error:
        diff.error.code === 'ENOBUFS'
          ? `diff exceeds ${GIT_MAX_BUFFER} bytes — refusing to review a clipped diff; narrow the range`
          : `git diff failed: ${diff.error.message}`,
    };
  }
  if (diff.status !== 0) return { error: `git diff failed (exit ${diff.status}): ${String(diff.stderr || '').trim()}` };
  const body = diff.stdout;
  if (!body.trim()) {
    return {
      error: diffOpts.staged ? 'nothing staged (git add … first)' : `no changes vs ${diffOpts.base}`,
    };
  }
  const stat = git(['diff', '--stat', '--no-color', '--no-ext-diff', ...range], root);
  return finish(diffOpts.staged ? 'staged' : `base:${diffOpts.base}`, body, stat.status === 0 ? stat.stdout : '');
}

/** Fence longer than any backtick run in the body, so diffs of Markdown cannot break out. */
function fenceFor(body) {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Prompt block appended to the question — the ONLY place the body travels. Pure. */
export function buildReviewContext(diff) {
  const fence = fenceFor(diff.body);
  return [
    '',
    '---',
    `CODE UNDER REVIEW (${diff.source}${diff.truncated ? ', PARTIAL — see DIFF COVERAGE' : ''}):`,
    ...(diff.stat ? ['', diff.stat] : []),
    '',
    renderCoverage(diff.coverage),
    '',
    `${fence}diff`,
    diff.body,
    fence,
  ].join('\n');
}

/** The question advisors actually see: question + optional diff context. Pure. */
export function questionWithContext(question, context) {
  return context ? `${question}\n${context}` : question;
}

/**
 * Persistable metadata — never the body. Includes the COMPLETE coverage
 * manifest (covered / omitted / opaque / cut lines). Pure.
 */
export function diffMeta(diff) {
  return { source: diff.source, stat: diff.stat, bytes: diff.bytes, truncated: diff.truncated, coverage: diff.coverage };
}

/** One-line human summary of a context's coverage (stderr / md index). Pure. */
export function coverageSummary(meta) {
  if (!meta) return 'no code context';
  const c = meta.coverage;
  if (!c) return `${meta.source} (${meta.bytes} bytes${meta.truncated ? ', partial' : ''})`;
  return c.complete
    ? `${meta.source}: complete (${c.hunks_total} hunk(s), ${meta.bytes} bytes)`
    : `${meta.source}: PARTIAL — ${c.hunks_shown}/${c.hunks_total} hunk(s) in full, ${c.hunks_partial} in part, ${c.hunks_omitted} not shown (${c.shown_bytes}/${c.total_bytes} bytes)`;
}
