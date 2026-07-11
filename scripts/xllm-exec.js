#!/usr/bin/env node
/**
 * xllm exec — isolated cross-vendor executor primitive.
 *
 * Escalation ladder: ask (opinion) → propose (static diff) → exec (this).
 * The foreign-vendor CLI works in an EPHEMERAL LOCAL CLONE — never in the
 * user's checkout. Deliverable: a ref fetched into the main repo
 * (refs/xllm/exec/<id>), a .patch file, and a test-evidence artifact.
 * Merge, push, and credentials stay host-side. One task per run; no loops,
 * no teams — composition belongs to the host's native agents.
 *
 *   node scripts/xllm-exec.js run <provider-spec> "<task>" [--test-cmd "npm test"]
 *        [--timeout-ms N] [--keep-clone] [--allow-self]
 *   node scripts/xllm-exec.js list
 *   node scripts/xllm-exec.js cleanup <id>|--all
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import process from 'process';
import {
  parseProviderSpec,
  loadProviderProfiles,
  resolveStateDir,
  ensureArtifactDirs,
  buildAdvisorEnv,
  detectHostCli,
  redactSecrets,
  resolveSpawnTarget,
  slugify,
} from './grok-ask-advisor.js';

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 900000; // 15 min — executors iterate
const MAX_DIFF_FILES = 200;
const MAX_DIFF_BYTES = 1.5 * 1024 * 1024;

/**
 * Providers allowed to execute, with their write-capable-but-sandboxed
 * invocation. Everything else is refused: a cwd change plus a warning is
 * security theater, not a sandbox.
 *  - codex: OS-level workspace sandbox; network for sandboxed commands is
 *    disabled by default in workspace-write mode.
 *  - claude: permission-mode acceptEdits confines edits to cwd; weaker than
 *    codex's sandbox — documented, still isolated by the ephemeral clone.
 */
export const EXEC_CAPABLE = {
  codex: {
    binary: 'codex',
    args: (cwd, mode = 'sandbox') =>
      mode === 'bypass'
        ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, '-']
        : ['exec', '--sandbox', 'workspace-write', '--cd', cwd, '-'],
    usesStdin: true,
    sandbox: 'os-workspace',
    preflight: true,
  },
  claude: {
    binary: 'claude',
    args: () => ['-p', '--permission-mode', 'acceptEdits'],
    usesStdin: true,
    sandbox: 'permission-mode',
    preflight: false,
  },
};

/**
 * Token-free probe: can codex's OS sandbox actually write in this directory?
 * On Windows the workspace-write sandbox needs capability-SID ACLs that may
 * not exist for arbitrary (e.g. temp) directories — fail closed if so.
 */
export function preflightCodexSandbox(dir) {
  const probe = '.xllm-sandbox-probe';
  const res = sh(
    'codex',
    ['sandbox', 'node', '-e', `require('fs').writeFileSync('${probe}','1')`],
    { cwd: dir, timeout: 30000 }
  );
  const ok = fs.existsSync(path.join(dir, probe));
  try {
    fs.unlinkSync(path.join(dir, probe));
  } catch {
    /* ignore */
  }
  return ok && res.status === 0;
}

export function execCapableProviders() {
  return Object.keys(EXEC_CAPABLE);
}

export function buildExecInstructions({ task, branch, testCmd }) {
  return `You are an EXECUTOR working in an isolated git clone (branch ${branch}). The user's real checkout is elsewhere and must never be touched — you only see this clone.

Rules:
1. Implement the task below by editing files in the current directory.
2. ${testCmd ? `Run \`${testCmd}\` and iterate until it passes.` : 'Run the project build/tests if present and iterate until green.'}
3. Commit your work with clear messages (git add/commit). Do NOT push. Do NOT create tags. Do NOT touch git config or hooks.
4. If you cannot finish, commit what is done and state plainly what remains — never claim success you did not verify.

## Task

${task}`;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

function git(repo, args, opts = {}) {
  return sh('git', ['-C', repo, ...args], opts);
}

function execId() {
  return (
    new Date().toISOString().replace(/[:.TZ-]/g, '').slice(2, 14) +
    '-' +
    Math.random().toString(36).slice(2, 6)
  );
}

export function execRootDir(env = process.env) {
  if (env.XLLM_EXEC_ROOT) return env.XLLM_EXEC_ROOT;
  return path.join(os.tmpdir(), 'xllm-exec');
}

function registryPath(root = process.cwd()) {
  return path.join(resolveStateDir(root), 'exec-registry.json');
}

export function readRegistry(root = process.cwd()) {
  try {
    return JSON.parse(fs.readFileSync(registryPath(root), 'utf8'));
  } catch {
    return { runs: {} };
  }
}

export function writeRegistry(reg, root = process.cwd()) {
  const file = registryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2), 'utf8');
  return file;
}

/** Resolve exec spawn plan or a refusal reason. Pure — unit-testable. */
export function resolveExecPlan(spec, { env = process.env, allowSelf = false } = {}) {
  const parsed = parseProviderSpec(spec);
  if (!parsed) return { error: `Unknown provider spec: ${spec}` };
  const cap = EXEC_CAPABLE[parsed.provider];
  if (!cap) {
    return {
      error:
        `[exec] Provider '${parsed.provider}' is refused for exec: no credible ` +
        `write sandbox. Capable providers: ${execCapableProviders().join(', ')}. ` +
        `(A cwd change plus a warning is not a sandbox.)`,
    };
  }
  const host = detectHostCli(env);
  if (host && host === parsed.provider && !allowSelf && env.XLLM_ALLOW_SELF !== '1') {
    return {
      error:
        `[exec] Refusing same-provider execution: host CLI is '${host}'. ` +
        `Use a different vendor, or pass --allow-self to override.`,
    };
  }
  return { parsed, cap };
}

export function cleanupRun(id, { root = process.cwd(), force = false } = {}) {
  const reg = readRegistry(root);
  const run = reg.runs[id];
  if (!run) return { removed: false, reason: 'unknown id' };
  if (run.clone && fs.existsSync(run.clone)) {
    try {
      fs.rmSync(run.clone, { recursive: true, force: true });
    } catch (e) {
      if (!force) return { removed: false, reason: `clone delete failed: ${e.message}` };
    }
  }
  delete reg.runs[id];
  writeRegistry(reg, root);
  return { removed: true };
}

function tailOf(text, lines = 30) {
  const arr = String(text || '').trim().split(/\r?\n/);
  return arr.slice(-lines).join('\n');
}

export async function runExec({
  spec,
  task,
  testCmd = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keepClone = false,
  allowSelf = false,
  sandboxMode = 'auto',
  root = process.cwd(),
}) {
  const plan = resolveExecPlan(spec, { allowSelf });
  if (plan.error) {
    console.error(plan.error);
    return { exitCode: 1, error: plan.error };
  }
  const { parsed, cap } = plan;

  // Preconditions on the host repo
  const isRepo = git(root, ['rev-parse', '--git-dir']);
  if (isRepo.status !== 0) {
    const msg = '[exec] Not a git repository.';
    console.error(msg);
    return { exitCode: 1, error: msg };
  }
  const baseRev = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (!baseRev) {
    const msg = '[exec] Repository has no commits (HEAD unresolved).';
    console.error(msg);
    return { exitCode: 1, error: msg };
  }

  const id = execId();
  const branch = `xllm/exec/${id}`;
  const clone = path.join(execRootDir(), `${path.basename(root)}-${id}`);
  fs.mkdirSync(path.dirname(clone), { recursive: true });

  // Ephemeral local clone: separate .git — the executor cannot pollute the
  // main repo's refs/config/hooks. --local hardlinks objects (fast, cheap).
  console.error(`[exec] cloning → ${clone}`);
  const cloneRes = sh('git', ['clone', '--local', '--no-hardlinks', root, clone]);
  if (cloneRes.status !== 0) {
    const msg = `[exec] clone failed: ${cloneRes.stderr || cloneRes.stdout}`;
    console.error(msg);
    return { exitCode: 1, error: msg };
  }
  git(clone, ['checkout', '-b', branch, baseRev]);

  const reg = readRegistry(root);
  reg.runs[id] = {
    id,
    spec: parsed.spec,
    provider: parsed.provider,
    branch,
    clone,
    base: baseRev,
    status: 'running',
    created_at: new Date().toISOString(),
  };
  writeRegistry(reg, root);

  // Sandbox mode resolution — fail closed when the OS sandbox is broken.
  let effectiveMode = 'sandbox';
  if (cap.preflight) {
    const sandboxOk = preflightCodexSandbox(clone);
    if (!sandboxOk) {
      if (sandboxMode !== 'bypass') {
        const msg =
          `[exec] ${parsed.provider}'s workspace-write sandbox cannot write in the ` +
          `clone on this machine (capability ACLs missing). Refusing to run. ` +
          `If you accept CLONE-LEVEL ISOLATION ONLY (workflow isolation, not an OS ` +
          `security boundary), re-run with --sandbox-mode bypass.`;
        console.error(msg);
        cleanupRun(id, { root, force: true });
        return { exitCode: 1, error: msg };
      }
      effectiveMode = 'bypass';
      console.error(
        '[exec] WARNING: OS sandbox unavailable — running with clone-level isolation only (--sandbox-mode bypass).'
      );
    }
  }

  // Tamper tripwire: snapshot the main repo before the executor runs.
  const mainHeadBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const mainStatusBefore = git(root, ['status', '--porcelain']).stdout;

  // Spawn the executor CLI inside the clone
  const instructions = buildExecInstructions({ task, branch, testCmd });
  const env = buildAdvisorEnv(parsed.provider);
  const target = resolveSpawnTarget(cap.binary);
  const args = [...(target.argsPrefix || []), ...cap.args(clone, effectiveMode)];
  console.error(
    `[exec] running ${parsed.spec} in isolation (mode ${effectiveMode}, timeout ${timeoutMs}ms)…`
  );
  const started = Date.now();
  const run = sh(target.command, args, {
    cwd: clone,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    input: instructions,
  });
  const durationMs = Date.now() - started;
  const timedOut = !!run.signal || (run.error && /ETIMEDOUT/i.test(String(run.error?.code)));

  // Deterministic close-out: commit anything the executor left uncommitted.
  const dirty = git(clone, ['status', '--porcelain']).stdout.trim();
  if (dirty) {
    git(clone, ['add', '-A']);
    git(clone, [
      '-c', 'user.name=xllm-exec',
      '-c', 'user.email=xllm-exec@localhost',
      'commit', '-m', `xllm exec ${id}: uncommitted executor changes`,
    ]);
  }
  const headRev = git(clone, ['rev-parse', 'HEAD']).stdout.trim();
  const changed = headRev !== baseRev;

  // Deterministic verification — OUR evidence, not the executor's claim.
  let test = null;
  if (testCmd && changed) {
    console.error(`[exec] verifying: ${testCmd}`);
    const t = sh(
      IS_WINDOWS ? (process.env.ComSpec || 'cmd.exe') : 'sh',
      IS_WINDOWS ? ['/d', '/s', '/c', testCmd] : ['-c', testCmd],
      { cwd: clone, timeout: Math.min(timeoutMs, 300000) }
    );
    test = {
      cmd: testCmd,
      exit_code: typeof t.status === 'number' ? t.status : 1,
      output_tail: tailOf([t.stdout, t.stderr].filter(Boolean).join('\n')),
    };
  }

  // Diff stats + caps
  const stat = changed
    ? git(clone, ['diff', '--shortstat', `${baseRev}..HEAD`]).stdout.trim()
    : '';
  const filesChanged = changed
    ? git(clone, ['diff', '--name-only', `${baseRev}..HEAD`]).stdout.trim().split('\n').filter(Boolean)
    : [];
  const patch = changed ? git(clone, ['format-patch', '--stdout', `${baseRev}..HEAD`]).stdout : '';
  const oversized = filesChanged.length > MAX_DIFF_FILES || patch.length > MAX_DIFF_BYTES;

  // Handback: fetch the result ref into the MAIN repo. `git fetch` only adds
  // objects and a ref under refs/xllm/ — the user's working tree, branches,
  // index, and config are untouched.
  let refFetched = false;
  if (changed) {
    const fetch = git(root, ['fetch', clone, `+HEAD:refs/xllm/exec/${id}`]);
    refFetched = fetch.status === 0;
  }

  // Evidence artifact + patch sidecar in the main repo's state dir
  const dir = path.join(ensureArtifactDirs(root), 'exec');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${parsed.provider}-${slugify(task)}-${id}`;
  const artifactPath = path.join(dir, `${base}.md`);
  let patchPath = null;
  if (changed && !oversized) {
    patchPath = path.join(dir, `${base}.patch`);
    fs.writeFileSync(patchPath, patch, 'utf8');
  }

  const green = changed && !timedOut && (test ? test.exit_code === 0 : run.status === 0);
  const status = timedOut ? 'timeout' : green ? 'green' : changed ? 'not-green' : 'no-change';

  // Tamper tripwire check: the executor must not have touched the main repo.
  const mainHeadAfter = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const mainStatusAfter = git(root, ['status', '--porcelain']).stdout;
  const mainIntact =
    mainHeadAfter === mainHeadBefore && mainStatusAfter === mainStatusBefore;
  if (!mainIntact) {
    console.error(
      '[exec] ⚠ TAMPER WARNING: the main repository changed during execution — inspect before trusting this run.'
    );
  }

  fs.writeFileSync(
    artifactPath,
    [
      `# xllm exec evidence — ${parsed.spec}`,
      '',
      `- Run id: ${id}`,
      `- Status: **${status}**`,
      `- Base: ${baseRev}`,
      `- Result ref: ${refFetched ? `refs/xllm/exec/${id}` : '(not fetched)'}`,
      `- Files changed: ${filesChanged.length}${oversized ? ' (OVERSIZED — patch omitted)' : ''}`,
      stat ? `- Diff: ${stat}` : null,
      `- Sandbox mode: ${effectiveMode}${effectiveMode === 'bypass' ? ' (clone-level isolation only)' : ''}`,
      `- Main repo integrity: ${mainIntact ? 'unchanged ✓' : '**CHANGED — INSPECT ⚠**'}`,
      `- Executor exit: ${run.status}${timedOut ? ' (TIMED OUT — killed)' : ''}`,
      `- Duration ms: ${durationMs}`,
      test ? `- Verification \`${test.cmd}\`: exit ${test.exit_code}` : '- Verification: (no --test-cmd given — executor claims only)',
      patchPath ? `- Patch: ${patchPath}` : null,
      '',
      '## Task',
      '',
      redactSecrets(task),
      '',
      ...(test
        ? ['## Verification output (tail)', '', '```text', redactSecrets(test.output_tail), '```', '']
        : []),
      '## Executor output (tail)',
      '',
      '```text',
      redactSecrets(tailOf([run.stdout, run.stderr].filter(Boolean).join('\n'), 40)),
      '```',
      '',
      '## Handback (host-side)',
      '',
      '```bash',
      `git diff ${baseRev.slice(0, 12)}..refs/xllm/exec/${id}   # review`,
      `git merge --no-ff refs/xllm/exec/${id}                # or cherry-pick`,
      `node scripts/xllm-exec.js cleanup ${id}`,
      '```',
      '',
      '> Executor-green is evidence, not trust: re-run your own verification after merging.',
      '',
    ]
      .filter((x) => x !== null)
      .join('\n'),
    'utf8'
  );

  // Registry + cleanup
  const reg2 = readRegistry(root);
  reg2.runs[id] = {
    ...reg2.runs[id],
    status,
    ref: refFetched ? `refs/xllm/exec/${id}` : null,
    artifact: artifactPath,
    patch: patchPath,
    duration_ms: durationMs,
  };
  writeRegistry(reg2, root);
  if (!keepClone && refFetched) {
    cleanupRun(id, { root, force: true });
    const reg3 = readRegistry(root);
    reg3.runs[id] = { ...reg2.runs[id], clone: null, cleaned: true };
    writeRegistry(reg3, root);
  } else if (!refFetched) {
    console.error(`[exec] clone kept (no ref fetched): ${clone}`);
  }

  console.error(`[exec] ${status}${refFetched ? ` → refs/xllm/exec/${id}` : ''}`);
  console.log(artifactPath);
  return {
    exitCode: status === 'green' ? 0 : status === 'no-change' || status === 'timeout' ? 1 : 2,
    id,
    status,
    ref: refFetched ? `refs/xllm/exec/${id}` : null,
    artifactPath,
    patchPath,
  };
}

function listRuns(root = process.cwd()) {
  const reg = readRegistry(root);
  const rows = Object.values(reg.runs);
  if (!rows.length) {
    console.log('(no exec runs)');
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.id}  ${String(r.status || '?').padEnd(9)}  ${r.spec || r.provider}  ${r.ref || '-'}${r.clone ? `  clone:${r.clone}` : ''}`
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = {
    testCmd: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepClone: false,
    allowSelf: false,
    sandboxMode: 'auto',
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-cmd') flags.testCmd = argv[++i];
    else if (a === '--timeout-ms') flags.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (a === '--keep-clone') flags.keepClone = true;
    else if (a === '--allow-self') flags.allowSelf = true;
    else if (a === '--sandbox-mode') flags.sandboxMode = argv[++i] || 'auto';
    else pos.push(a);
  }
  const cmd = pos[0];

  if (cmd === 'list') return listRuns();
  if (cmd === 'cleanup') {
    if (pos[1] === '--all') {
      const reg = readRegistry();
      let n = 0;
      for (const id of Object.keys(reg.runs)) {
        if (cleanupRun(id, { force: true }).removed) n++;
      }
      console.log(`cleaned ${n} run(s)`);
      return;
    }
    if (!pos[1]) {
      console.error('Usage: xllm-exec cleanup <id>|--all');
      process.exit(1);
    }
    const r = cleanupRun(pos[1], { force: true });
    console.log(r.removed ? `cleaned ${pos[1]}` : `not cleaned: ${r.reason}`);
    return;
  }
  if (cmd === 'run') {
    const spec = pos[1];
    const task = pos.slice(2).join(' ').trim();
    if (!spec || !task) {
      console.error('Usage: xllm-exec run <provider-spec> "<task>" [--test-cmd "npm test"]');
      process.exit(1);
    }
    const res = await runExec({ spec, task, ...flags });
    process.exit(res.exitCode);
  }
  console.error(`xllm exec — isolated cross-vendor executor (capable: ${execCapableProviders().join(', ')})
Usage:
  node scripts/xllm-exec.js run <provider-spec> "<task>" [--test-cmd "npm test"] [--timeout-ms N] [--keep-clone] [--allow-self] [--sandbox-mode auto|bypass]
  node scripts/xllm-exec.js list
  node scripts/xllm-exec.js cleanup <id>|--all

Invariants: user's checkout/branches/index/config are never touched; the
executor works in an ephemeral clone; result comes back as refs/xllm/exec/<id>
+ patch + evidence artifact; merge/push/credentials stay host-side.`);
  process.exit(cmd ? 1 : 0);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return entry.endsWith('xllm-exec.js');
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
