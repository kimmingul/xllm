#!/usr/bin/env node
/**
 * xllm exec — isolated cross-vendor executor primitive.
 *
 * Escalation ladder: ask (opinion) → propose (static diff) → exec (this).
 * The foreign-vendor CLI works in an EPHEMERAL LOCAL CLONE inside a native
 * OS-enforced sandbox. A clone alone is workflow isolation, NOT a security
 * boundary, so exec refuses to run when the sandbox cannot be proven:
 *
 *   - Only Codex is supported. Its OS sandbox runs under a named permission
 *     profile built here: write = the clone only, read of the host repo and
 *     credential directories denied, system temp not writable, network off.
 *   - Claude is refused: its sandbox covers the Bash tool only, is not
 *     available on native Windows, and `acceptEdits` is a permission mode,
 *     not isolation.
 *   - There is no bypass mode. `--sandbox-mode bypass` was removed.
 *   - Local-only execution policy is checked before anything is cloned or
 *     spawned; the model call goes through runAdvisor (never a private spawn).
 *   - Verification (--test-cmd) runs through the same OS sandbox via
 *     `codex sandbox` with an allow-listed environment — never a host shell.
 *   - Without a verified passing test the status is never `green`.
 *
 * Deliverable: a ref fetched into the main repo (refs/xllm/exec/<id>) by an
 * explicit host-side fetch, a .patch file, and an evidence artifact. Merge,
 * push, and credentials stay host-side. One task per run; no loops.
 *
 *   node scripts/xllm-exec.js run <provider-spec> "<task>" [--test-cmd "npm test"]
 *        [--timeout-ms N] [--keep-clone] [--allow-self]
 *   node scripts/xllm-exec.js sandbox-check
 *   node scripts/xllm-exec.js list
 *   node scripts/xllm-exec.js cleanup <id>|--all
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
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
  detectHostCli,
  redactSecrets,
  resolveSpawnTarget,
  runAdvisor,
  slugify,
} from './xllm-advisor.js';
import { executionPolicyDecision } from './xllm-evidence.js';

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 900000; // 15 min — executors iterate
const MAX_VERIFY_MS = 300000;
const MAX_DIFF_FILES = 200;
const MAX_DIFF_BYTES = 1.5 * 1024 * 1024;
const PROFILE_NAME = 'xllm_exec';

/**
 * Providers allowed to execute. Everything else is refused: a cwd change plus
 * a warning is security theater, not a sandbox.
 *  - codex: OS-level sandbox (Windows sandbox users / Seatbelt / bubblewrap)
 *    selected through a permission profile; see buildSandboxProfile.
 *  - claude is deliberately absent — see file header.
 */
export const EXEC_CAPABLE = {
  codex: { binary: 'codex', sandbox: 'os-permission-profile' },
};

export function execCapableProviders() {
  return Object.keys(EXEC_CAPABLE);
}

const REFUSED_REASONS = {
  claude:
    'Claude has no OS-enforced sandbox usable here: its sandbox covers the Bash tool only, ' +
    'is unsupported on native Windows, and --permission-mode acceptEdits is a permission ' +
    'mode, not isolation.',
};

/** Home-relative locations that hold credentials; the sandbox cannot read them. */
export const CREDENTIAL_DIRS = [
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.docker',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.xllm',
];

// ---------------------------------------------------------------------------
// Sandbox profile + argv builders (pure)
// ---------------------------------------------------------------------------

function toml(s) {
  return JSON.stringify(String(s));
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export function isInside(child, parent) {
  const rel = path.relative(canonicalPath(parent), canonicalPath(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * TOML inline table for `-c permissions.xllm_exec=…`. Extends the built-in
 * `:workspace` profile (writes confined to workspace roots, `.git`/`.codex`
 * inside them stay read-only) and additionally denies: system temp, the host
 * repository, and credential directories. Network stays disabled.
 */
export function buildSandboxProfile({ hostRoot, platform = process.platform } = {}) {
  const entries = [[':tmpdir', 'deny']];
  if (platform !== 'win32') entries.push([':slash_tmp', 'deny']);
  if (hostRoot) entries.push([path.resolve(hostRoot), 'deny']);
  for (const d of CREDENTIAL_DIRS) entries.push([`~/${d}`, 'deny']);
  const fsTable = entries.map(([k, v]) => `${toml(k)}=${toml(v)}`).join(', ');
  return `permissions.${PROFILE_NAME}={extends=":workspace", filesystem={${fsTable}}, network={enabled=false}}`;
}

/**
 * Complete codex flags placed after `codex exec` by runAdvisor's `execution`
 * hook (runAdvisor appends only --json, model/effort and `-`). Deliberately
 * NO `--sandbox`: that flag selects the legacy settings and discards the
 * permission profile. User config and execpolicy rules are ignored so a
 * `sandbox_mode`/`default_permissions` there cannot override the profile.
 */
export function buildCodexExecArgs({ cwd, hostRoot, platform = process.platform } = {}) {
  return [
    '--cd', cwd,
    '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '-c', buildSandboxProfile({ hostRoot, platform }),
    '-c', `default_permissions=${toml(PROFILE_NAME)}`,
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'mcp_servers={}',
    '-c', 'features.hooks=false',
    '-c', 'features.multi_agent=false',
    '-c', 'approval_policy="never"',
    ...windowsSandboxArgs(platform),
  ];
}

// Matches flag/config tokens that weaken the sandbox. Anchored so a path that
// merely contains the word "bypass" is not refused.
const UNSAFE_ARG = /^--dangerously|^--bypass|^--sandbox(=|$)|^-s$|danger-full-access|(^|[\s{,])sandbox_mode\s*=/i;
export function assertNoUnsafeArgs(args) {
  const bad = args.find((a) => UNSAFE_ARG.test(String(a)));
  if (bad) throw new Error(`[exec] refusing unsafe sandbox argument: ${bad}`);
  return args;
}

/**
 * Windows sandbox backend, pinned explicitly. `codex exec --ignore-user-config`
 * drops the user's `[windows] sandbox`, and the default `unelevated` backend
 * cannot enforce deny-read paths: codex then refuses to start the session
 * ("windows unelevated restricted-token sandbox cannot enforce deny-read
 * restrictions directly") — measured on codex 0.156.1. Only backends that
 * enforce deny-read are allowed; `unelevated` is refused. Override with
 * XLLM_EXEC_WINDOWS_SANDBOX=elevated|mxc.
 */
export function windowsSandboxArgs(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [];
  const want = String(env.XLLM_EXEC_WINDOWS_SANDBOX || 'elevated').toLowerCase();
  if (want !== 'elevated' && want !== 'mxc') {
    throw new Error(
      `[exec] XLLM_EXEC_WINDOWS_SANDBOX=${want} refused: only 'elevated' or 'mxc' can enforce deny-read paths`
    );
  }
  return ['-c', `windows.sandbox=${toml(want)}`];
}

/** argv (after the codex binary) that runs `command` under the OS sandbox. */
export function buildSandboxRunnerArgs({ cwd, hostRoot, command, platform = process.platform }) {
  const head = assertNoUnsafeArgs([
    'sandbox',
    ...windowsSandboxArgs(platform),
    '-c', buildSandboxProfile({ hostRoot, platform }),
    '-P', PROFILE_NAME,
    '-C', cwd,
    '--',
  ]);
  return [...head, ...command];
}

/**
 * Command that runs a user-supplied verification string. POSIX: `sh -c`.
 * Windows: argv quoting through cmd.exe mangles embedded quotes (measured:
 * `node -e "process.exit(3)"` reported exit 0 — a false green), so the
 * string is written verbatim to a batch file and that file is run instead.
 * Caller must call cleanup().
 */
export function prepareVerifyCommand(cwd, cmd, platform = process.platform) {
  if (platform !== 'win32') return { command: ['sh', '-c', cmd], cleanup() {} };
  const file = path.join(cwd, `xllm-verify-${crypto.randomBytes(4).toString('hex')}.cmd`);
  fs.writeFileSync(file, `@echo off\r\n${cmd}\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  return {
    command: [process.env.ComSpec || 'cmd.exe', '/d', '/c', file],
    cleanup() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'OS',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER', 'LOGNAME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'ALLUSERSPROFILE',
  'PUBLIC', 'SystemDrive', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
  'SHELL', 'CODEX_HOME',
];
const SECRET_NAME = /key|token|secret|passw|credential|auth|session|cookie/i;

/**
 * Allow-listed environment for the sandbox runner and everything it starts.
 * Allow-list (not deny-list): unknown variables never leak. Secret-looking
 * names are dropped even if allow-listed.
 */
export function controlledEnv(base = process.env, extra = {}) {
  const out = {};
  const lower = new Map(Object.keys(base).map((k) => [k.toLowerCase(), k]));
  for (const name of ENV_ALLOW) {
    const k = base[name] !== undefined ? name : lower.get(name.toLowerCase());
    if (k === undefined || base[k] === undefined) continue;
    if (SECRET_NAME.test(k)) continue;
    out[k] = base[k];
  }
  out.CI = '1';
  out.GIT_TERMINAL_PROMPT = '0';
  out.NO_COLOR = '1';
  return { ...out, ...extra };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

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

/** Host-side git run inside the clone: never executes clone-supplied hooks. */
function cloneGit(clone, noHooks, args, opts = {}) {
  return git(
    clone,
    ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args],
    opts
  );
}

function execId() {
  return (
    new Date().toISOString().replace(/[:.TZ-]/g, '').slice(2, 14) +
    '-' +
    crypto.randomBytes(3).toString('hex')
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

function tailOf(text, lines = 30) {
  const arr = String(text || '').trim().split(/\r?\n/);
  return arr.slice(-lines).join('\n');
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plan / policy
// ---------------------------------------------------------------------------

/** Resolve exec plan or a refusal reason. Pure — unit-testable. */
export function resolveExecPlan(
  spec,
  { env = process.env, allowSelf = false, profiles = null, policyFn = executionPolicyDecision } = {}
) {
  const parsed = parseProviderSpec(spec);
  if (!parsed) return { error: `Unknown provider spec: ${spec}` };
  const cap = EXEC_CAPABLE[parsed.provider];
  if (!cap) {
    return {
      error:
        `[exec] Provider '${parsed.provider}' is refused for exec: no verified OS write sandbox. ` +
        (REFUSED_REASONS[parsed.provider] ? `${REFUSED_REASONS[parsed.provider]} ` : '') +
        `Capable providers: ${execCapableProviders().join(', ')}.`,
    };
  }
  // Execution policy applies BEFORE any clone/spawn and has no flag bypass.
  const decision = policyFn(parsed.provider, parsed.model, {
    profiles: profiles || loadProviderProfiles(),
    env,
  });
  if (!decision || !decision.allowed) {
    return {
      error: `[exec] Execution policy refuses ${parsed.spec}: ${(decision && decision.reason) || 'policy decision unavailable (fail closed)'}`,
      policy: decision || null,
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
  return { parsed, cap, policy: decision };
}

// ---------------------------------------------------------------------------
// Sandbox runner + capability probe
// ---------------------------------------------------------------------------

function defaultSpawn(command, args, opts) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

/**
 * Run `command` inside the OS sandbox. Returns { status, stdout, stderr,
 * timedOut, error }. `error` is set when the runner itself could not start
 * (not when the command exits non-zero).
 */
export function runInSandbox({
  cwd,
  hostRoot,
  command,
  env,
  timeoutMs = MAX_VERIFY_MS,
  spawnFn = defaultSpawn,
  resolveTarget = resolveSpawnTarget,
  binary = 'codex',
  platform = process.platform,
}) {
  const target = resolveTarget(binary);
  if (target.viaCmd) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: `${binary} resolves to a cmd shim; argv cannot be passed safely through it`,
    };
  }
  const args = [...(target.argsPrefix || []), ...buildSandboxRunnerArgs({ cwd, hostRoot, command, platform })];
  const res = spawnFn(target.command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const timedOut = !!res.signal || (res.error && /ETIMEDOUT/i.test(String(res.error.code)));
  return {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: !!timedOut,
    error: res.error && !timedOut ? res.error.message : null,
  };
}

const PROBE_SCRIPT = `const fs=require('fs');
const t=JSON.parse(process.env.XLLM_PROBE_TARGETS);
const out={writes:{},reads:{},secretEnv:[]};
for (const [k,p] of Object.entries(t.writes)) { try { fs.writeFileSync(p,'1'); out.writes[k]='written'; } catch (e) { out.writes[k]='denied'; } }
for (const [k,p] of Object.entries(t.reads)) { try { fs.readdirSync(p); out.reads[k]='readable'; } catch (e) { out.reads[k]=e&&e.code==='ENOENT'?'absent':'denied'; } }
// codex's sandbox injects git's config transport (GIT_CONFIG_COUNT/KEY_n/VALUE_n,
// e.g. safe.directory=<clone>) when cwd is a git repo. KEY_n there is a config
// *name*, not a credential, so it is exempt from the name pattern — but only
// while it names a known benign git setting (measured: safe.directory,
// credential.interactive, credential.guiPrompt); anything else is still flagged.
const BENIGN_GIT_KEYS = new Set(['safe.directory', 'credential.interactive', 'credential.guiprompt']);
out.secretEnv=Object.keys(process.env).filter((k)=>{
  if (/^GIT_CONFIG_(COUNT|VALUE_\\d+)$/.test(k)) return false;
  if (/^GIT_CONFIG_KEY_\\d+$/.test(k)) return !BENIGN_GIT_KEYS.has(String(process.env[k]).toLowerCase());
  return new RegExp(t.secretPattern,'i').test(k);
});
console.log('XLLM_PROBE '+JSON.stringify(out));
`;

/**
 * Prove the sandbox on THIS machine, judged by host-side filesystem facts:
 * a write inside `dir` must land; writes to system temp, the host repo and
 * the home directory must not; reads of the host repo and credential dirs
 * must be denied; no secret-looking env var may reach the child. Dead or
 * missing temp dirs never count as a pass.
 */
export function probeSandbox({
  dir,
  hostRoot,
  execRoot = execRootDir(),
  env = controlledEnv(),
  spawnFn = defaultSpawn,
  resolveTarget = resolveSpawnTarget,
  platform = process.platform,
  home = os.homedir(),
  timeoutMs = 60000,
} = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    add('probe-dir-exists', false, `${dir} is not an existing directory`);
    return { ok: false, checks, reason: 'probe directory missing' };
  }
  const tag = crypto.randomBytes(4).toString('hex');
  const insideFile = path.join(dir, `xllm-probe-inside-${tag}.txt`);
  const outside = {
    'write-exec-root': path.join(execRoot, `xllm-probe-${tag}.txt`),
    'write-system-temp': path.join(os.tmpdir(), `xllm-probe-${tag}.txt`),
    'write-home': path.join(home, `.xllm-probe-${tag}.txt`),
  };
  if (hostRoot) outside['write-host-repo'] = path.join(hostRoot, `.xllm-probe-${tag}.txt`);
  // Never test an "outside" target that is really inside the probe dir.
  for (const k of Object.keys(outside)) {
    if (isInside(outside[k], dir)) delete outside[k];
  }
  const reads = {};
  if (hostRoot) reads['read-host-repo'] = hostRoot;
  for (const d of ['.codex', '.ssh']) reads[`read-home-${d}`] = path.join(home, d);

  const scriptPath = path.join(dir, `xllm-probe-${tag}.cjs`);
  const cleanup = () => {
    for (const f of [scriptPath, insideFile, ...Object.values(outside)]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
  let res;
  try {
    fs.writeFileSync(scriptPath, PROBE_SCRIPT, 'utf8');
    const targets = {
      writes: { inside: insideFile, ...outside },
      reads,
      secretPattern: SECRET_NAME.source,
    };
    res = runInSandbox({
      cwd: dir,
      hostRoot,
      command: [process.execPath, scriptPath],
      env: { ...env, XLLM_PROBE_TARGETS: JSON.stringify(targets) },
      timeoutMs,
      spawnFn,
      resolveTarget,
      platform,
    });
    add('runner-started', !res.error && !res.timedOut && res.status === 0,
      res.error || (res.timedOut ? 'timed out' : `exit ${res.status}: ${tailOf(res.stderr, 3)}`));
    // Judge by the host's own view of the filesystem.
    add('write-inside-clone', fs.existsSync(insideFile), insideFile);
    for (const [name, p] of Object.entries(outside)) {
      add(name, !fs.existsSync(p), fs.existsSync(p) ? `ESCAPED: ${p} was written` : 'denied');
    }
    const line = String(res.stdout).split(/\r?\n/).find((l) => l.startsWith('XLLM_PROBE '));
    let report = null;
    try {
      report = line ? JSON.parse(line.slice('XLLM_PROBE '.length)) : null;
    } catch {
      report = null;
    }
    add('probe-report', !!report, report ? '' : 'sandboxed probe produced no report');
    if (report) {
      for (const [name, p] of Object.entries(reads)) {
        const v = report.reads && report.reads[name];
        const existsOnHost = fs.existsSync(p);
        add(name, v === 'denied' || (v === 'absent' && !existsOnHost), `observed ${v}`);
      }
      add('no-secret-env', Array.isArray(report.secretEnv) && report.secretEnv.length === 0,
        (report.secretEnv || []).join(','));
    }
  } catch (e) {
    add('probe-error', false, e.message);
  } finally {
    cleanup();
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    reason: failed.length ? `sandbox check failed: ${failed.map((c) => c.name).join(', ')}` : null,
  };
}

// ---------------------------------------------------------------------------
// Verification-definition drift
// ---------------------------------------------------------------------------

const DEFINITION_FILE = [
  /(^|\/)(makefile|gnumakefile|justfile|taskfile\.ya?ml|tox\.ini|noxfile\.py|pytest\.ini|conftest\.py|setup\.cfg|pyproject\.toml|cargo\.toml|build\.rs|pom\.xml|cmakelists\.txt|build\.gradle(\.kts)?|\.mocharc[^/]*|\.nycrc[^/]*)$/i,
  /(^|\/)(jest|vitest|mocha|ava|playwright|cypress|karma)\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.github\/workflows\//i,
];
const PACKAGE_TEST_KEYS = ['scripts', 'jest', 'mocha', 'ava', 'vitest', 'nyc', 'c8'];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test[-_][^/]*\.[a-z]+$/i;

function showJson(clone, noHooks, rev, file) {
  const r = cloneGit(clone, noHooks, ['show', `${rev}:${file}`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Report whether the executor changed WHAT VERIFICATION MEANS (package
 * scripts, test-runner config, CI, files named by the test command). A green
 * result from edited verification is not evidence the original bar was met.
 */
export function detectVerificationDefinitionChanges({ clone, noHooks, base, head, testCmd, changedFiles }) {
  const files = [];
  const scriptsChanged = [];
  const norm = (f) => f.replace(/\\/g, '/');
  const cmdText = norm(String(testCmd || ''));
  for (const f of changedFiles.map(norm)) {
    if (f === 'package.json' || f.endsWith('/package.json')) {
      const before = showJson(clone, noHooks, base, f);
      const after = showJson(clone, noHooks, head, f);
      if (before === undefined || after === undefined) {
        files.push(f); // unparsable → cannot prove unchanged
        continue;
      }
      let touched = false;
      for (const key of PACKAGE_TEST_KEYS) {
        const a = JSON.stringify((before || {})[key] ?? null);
        const b = JSON.stringify((after || {})[key] ?? null);
        if (a === b) continue;
        touched = true;
        if (key === 'scripts') {
          const names = new Set([
            ...Object.keys((before || {}).scripts || {}),
            ...Object.keys((after || {}).scripts || {}),
          ]);
          for (const n of names) {
            if (((before || {}).scripts || {})[n] !== ((after || {}).scripts || {})[n]) {
              scriptsChanged.push(`${f}#${n}`);
            }
          }
        }
      }
      if (touched) files.push(f);
      continue;
    }
    if (DEFINITION_FILE.some((re) => re.test(f))) {
      files.push(f);
      continue;
    }
    if (cmdText && cmdText.includes(f)) files.push(f);
  }
  return {
    changed: files.length > 0,
    files,
    scripts_changed: scriptsChanged,
    test_files_changed: changedFiles.map(norm).filter((f) => TEST_FILE.test(f)).length,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const STATUS_EXIT = {
  green: 0,
  'no-change': 1,
  'executor-failed': 1,
  timeout: 1,
  unverified: 2,
  'not-green': 2,
  'definition-changed': 2,
  blocked: 3,
  tampered: 3,
};

/**
 * Pure status derivation. `green` requires: changed, executor not timed out,
 * a verification command that ran in the OS sandbox and passed, verification
 * definitions untouched, and no tampering.
 */
export function deriveExecStatus({ changed, timedOut, executorFailed = false, testCmd, verification, defChanged, tampered }) {
  if (tampered) return 'tampered';
  if (timedOut) return 'timeout';
  if (!changed) return executorFailed ? 'executor-failed' : 'no-change';
  if (executorFailed) return 'not-green';
  if (!testCmd) return 'unverified';
  if (!verification || verification.state === 'blocked') return 'blocked';
  if (verification.state !== 'ran' || verification.exit_code !== 0) return 'not-green';
  if (defChanged) return 'definition-changed';
  return 'green';
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export function buildExecInstructions({ task, branch, testCmd }) {
  return `You are an EXECUTOR working in an isolated, sandboxed git clone (branch ${branch}). Only this directory is writable; there is no network and no access to the user's real checkout or credentials.

Rules:
1. Implement the task below by editing files in the current directory.
2. ${testCmd ? `You may run \`${testCmd}\` to iterate; the host re-runs it independently in its own sandbox.` : 'Run the project build/tests if present to iterate; no host verification command was configured, so the result will be reported as unverified.'}
3. Do NOT commit, push, tag, or touch git metadata (.git is read-only). The host commits your working-tree changes.
4. Do NOT edit test scripts, test-runner configuration, CI definitions, or package.json scripts to make checks pass; changes there are detected and reported.
5. If you cannot finish, leave what is done and state plainly what remains — never claim success you did not verify.

## Task

${task}`;
}

// ---------------------------------------------------------------------------
// Host snapshots (tamper tripwires)
// ---------------------------------------------------------------------------

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function listHooks(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !n.endsWith('.sample'))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return `${n}:${st.size}:${hashFile(path.join(dir, n))}`;
      })
      .sort()
      .join('|');
  } catch {
    return '';
  }
}

function gitPath(repo, what) {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', what]);
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : path.join(repo, '.git', what);
}

/** Snapshot of everything exec promises not to disturb in a repository. */
export function repoSnapshot(repo) {
  return {
    head: git(repo, ['rev-parse', 'HEAD']).stdout.trim(),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout,
    status: git(repo, ['status', '--porcelain']).stdout,
    config: hashFile(gitPath(repo, 'config')),
    hooks: listHooks(gitPath(repo, 'hooks')),
  };
}

export function snapshotDiff(a, b) {
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupRun(id, { root = process.cwd(), force = false } = {}) {
  const reg = readRegistry(root);
  const run = reg.runs[id];
  if (!run) return { removed: false, reason: 'unknown id' };
  // Only ever delete directories exec itself created (under the exec root).
  if (run.clone && fs.existsSync(run.clone)) {
    if (!isInside(run.clone, execRootDir())) {
      return { removed: false, reason: `refusing to delete ${run.clone}: outside exec root` };
    }
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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function refuse(msg, status = 'refused', extra = {}) {
  console.error(msg);
  return { exitCode: status === 'blocked' ? 3 : 1, status, error: msg, ...extra };
}

export async function runExec({
  spec,
  task,
  testCmd = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keepClone = false,
  allowSelf = false,
  root = process.cwd(),
  // Injection seams (tests): production uses the real runAdvisor, `codex
  // sandbox`, and the real policy helper.
  advisorFn = runAdvisor,
  spawnFn = defaultSpawn,
  resolveTarget = resolveSpawnTarget,
  policyFn = executionPolicyDecision,
  env = process.env,
}) {
  const plan = resolveExecPlan(spec, { env, allowSelf, policyFn });
  if (plan.error) return refuse(plan.error, 'refused', { policy: plan.policy || null });
  const { parsed } = plan;

  const isRepo = git(root, ['rev-parse', '--git-dir']);
  if (isRepo.status !== 0) return refuse('[exec] Not a git repository.');
  const hostRoot = path.resolve((git(root, ['rev-parse', '--show-toplevel']).stdout || '').trim() || root);
  const baseRev = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (!baseRev) return refuse('[exec] Repository has no commits (HEAD unresolved).');

  const execRoot = path.resolve(execRootDir(env));
  if (isInside(execRoot, hostRoot) || isInside(hostRoot, execRoot)) {
    return refuse(
      `[exec] Refusing: exec root (${execRoot}) and the repository (${hostRoot}) overlap. ` +
        `Set XLLM_EXEC_ROOT to a directory outside the repository.`
    );
  }

  const id = execId();
  const branch = `xllm/exec/${id}`;
  const clone = path.join(execRoot, `${slugify(path.basename(hostRoot))}-${id}`);
  const noHooks = path.join(execRoot, '.no-hooks');
  const runEnv = controlledEnv(process.env);

  // Fail closed BEFORE cloning: prove the OS sandbox on a real, existing
  // scratch directory with the exact profile used for the executor.
  fs.mkdirSync(execRoot, { recursive: true });
  fs.mkdirSync(noHooks, { recursive: true });
  const probeDir = path.join(execRoot, `${id}-probe`);
  fs.mkdirSync(probeDir, { recursive: true });
  const pre = probeSandbox({ dir: probeDir, hostRoot, execRoot, env: runEnv, spawnFn, resolveTarget });
  rmDir(probeDir);
  if (!pre.ok) {
    return refuse(
      `[exec] BLOCKED: the OS sandbox could not be verified on this machine (${pre.reason}). ` +
        `Refusing to run; there is no bypass mode. Details: ${JSON.stringify(pre.checks.filter((c) => !c.ok))}`,
      'blocked',
      { sandbox: pre }
    );
  }

  // Ephemeral clone with a separate .git. Objects are copied, not hardlinked.
  console.error(`[exec] cloning → ${clone}`);
  const cloneRes = sh('git', [
    '-c', `core.hooksPath=${noHooks}`,
    'clone', '--local', '--no-hardlinks', '--no-checkout', '--no-tags', hostRoot, clone,
  ]);
  if (cloneRes.status !== 0) {
    rmDir(clone);
    return refuse(`[exec] clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
  }
  // The origin remote is a push/fetch channel back to the user's repository.
  // Remove it; the single return path is the explicit host-side fetch below.
  cloneGit(clone, noHooks, ['remote', 'remove', 'origin']);
  const co = cloneGit(clone, noHooks, ['checkout', '-b', branch, baseRev]);
  if (co.status !== 0) {
    rmDir(clone);
    return refuse(`[exec] checkout failed: ${co.stderr || co.stdout}`);
  }

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

  const hostBefore = repoSnapshot(root);
  const cloneConfigBefore = hashFile(path.join(clone, '.git', 'config'));
  const cloneHooksBefore = listHooks(path.join(clone, '.git', 'hooks'));

  // --- Executor: external model call goes through runAdvisor only. ---
  const instructions = buildExecInstructions({ task, branch, testCmd });
  console.error(`[exec] running ${parsed.spec} in the OS sandbox (timeout ${timeoutMs}ms)…`);
  const started = Date.now();
  let adv;
  try {
    adv = advisorFn({
      provider: parsed.provider,
      model: parsed.model,
      effort: parsed.effort,
      prompt: instructions,
      originalTask: task,
      modelAliased: parsed.modelAliased,
      allowSelf,
      noArtifacts: true,
      quiet: true,
      execution: {
        cwd: clone,
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs,
        providerArgs: assertNoUnsafeArgs(buildCodexExecArgs({ cwd: clone, hostRoot })),
      },
    });
  } catch (e) {
    adv = { exitCode: 1, raw: `[exec] advisor threw: ${e.message}`, durationMs: Date.now() - started };
  }
  const durationMs = adv.durationMs || Date.now() - started;
  const timedOut =
    (adv.failure && adv.failure.kind === 'timeout') || /^\[killed by signal/.test(String(adv.raw || ''));
  const execOutput = String(adv.raw || '');
  // A non-zero executor exit is a failure, never a quiet "nothing changed".
  // Only the advisor's already-redacted failure fields are kept, not raw stderr.
  const clip = (s) => (s == null ? null : redactSecrets(String(s)).slice(0, 800));
  const executorFailure =
    typeof adv.exitCode === 'number' && adv.exitCode === 0 && !(adv.failure && adv.failure.kind !== 'ok')
      ? null
      : {
          kind: (adv.failure && adv.failure.kind) || 'unknown',
          exit_code: typeof adv.exitCode === 'number' ? adv.exitCode : null,
          retryable: !!(adv.failure && adv.failure.retryable),
          hint: clip(adv.failure && adv.failure.hint),
          message: clip(adv.failure && adv.failure.message),
        };

  // --- Tamper tripwires (host repo AND clone metadata). ---
  const hostAfter = repoSnapshot(root);
  const hostDiff = snapshotDiff(hostBefore, hostAfter);
  const cloneTamper = [];
  if (hashFile(path.join(clone, '.git', 'config')) !== cloneConfigBefore) cloneTamper.push('clone .git/config');
  if (listHooks(path.join(clone, '.git', 'hooks')) !== cloneHooksBefore) cloneTamper.push('clone .git/hooks');
  const tampered = hostDiff.length > 0 || cloneTamper.length > 0;
  if (tampered) {
    console.error(
      `[exec] TAMPER: ${[...hostDiff.map((k) => `main repo ${k}`), ...cloneTamper].join(', ')} changed during execution — result NOT fetched.`
    );
  }

  // Deterministic close-out: commit anything the executor left (host-side, no hooks).
  const dirty = cloneGit(clone, noHooks, ['status', '--porcelain']).stdout.trim();
  if (dirty && !tampered) {
    cloneGit(clone, noHooks, ['add', '-A']);
    cloneGit(clone, noHooks, [
      '-c', 'user.name=xllm-exec',
      '-c', 'user.email=xllm-exec@localhost',
      'commit', '--no-verify', '-m', `xllm exec ${id}: executor changes`,
    ]);
  }
  const headRev = cloneGit(clone, noHooks, ['rev-parse', 'HEAD']).stdout.trim();
  const changed = !!headRev && headRev !== baseRev;

  const filesChanged = changed
    ? cloneGit(clone, noHooks, ['diff', '--name-only', `${baseRev}..HEAD`]).stdout.trim().split('\n').filter(Boolean)
    : [];
  const defs = changed
    ? detectVerificationDefinitionChanges({
        clone, noHooks, base: baseRev, head: headRev, testCmd, changedFiles: filesChanged,
      })
    : { changed: false, files: [], scripts_changed: [], test_files_changed: 0 };

  // --- Verification: OUR evidence, only via the OS sandbox with a controlled env. ---
  let verification = null;
  if (testCmd && changed && !timedOut && !tampered) {
    console.error(`[exec] verifying in OS sandbox: ${testCmd}`);
    const post = probeSandbox({ dir: clone, hostRoot, execRoot, env: runEnv, spawnFn, resolveTarget });
    if (!post.ok) {
      verification = { state: 'blocked', cmd: testCmd, reason: post.reason, checks: post.checks };
    } else {
      let verify = null;
      let t;
      try {
        verify = prepareVerifyCommand(clone, testCmd);
        t = runInSandbox({
          cwd: clone,
          hostRoot,
          command: verify.command,
          env: runEnv,
          timeoutMs: Math.min(timeoutMs, MAX_VERIFY_MS),
          spawnFn,
          resolveTarget,
        });
      } catch (e) {
        t = { status: null, stdout: '', stderr: '', timedOut: false, error: e.message };
      } finally {
        if (verify) verify.cleanup();
      }
      if (t.error) {
        verification = { state: 'blocked', cmd: testCmd, reason: t.error };
      } else if (t.timedOut) {
        verification = { state: 'timeout', cmd: testCmd, exit_code: null, output_tail: tailOf(t.stdout + '\n' + t.stderr) };
      } else {
        verification = {
          state: 'ran',
          cmd: testCmd,
          exit_code: t.status === null ? 1 : t.status,
          output_tail: tailOf([t.stdout, t.stderr].filter(Boolean).join('\n')),
        };
      }
    }
  }

  const status = deriveExecStatus({
    changed,
    timedOut,
    executorFailed: !!executorFailure,
    testCmd,
    verification: verification && verification.state === 'timeout' ? { state: 'ran', exit_code: 1 } : verification,
    defChanged: defs.changed,
    tampered,
  });

  const stat = changed ? cloneGit(clone, noHooks, ['diff', '--shortstat', `${baseRev}..HEAD`]).stdout.trim() : '';
  const patch = changed ? cloneGit(clone, noHooks, ['format-patch', '--stdout', `${baseRev}..HEAD`]).stdout : '';
  const oversized = filesChanged.length > MAX_DIFF_FILES || patch.length > MAX_DIFF_BYTES;

  // --- Handback: explicit host-side fetch (objects + one ref under refs/xllm/). ---
  let refFetched = false;
  if (changed && !tampered) {
    const fetch = git(root, [
      '-c', 'transfer.fsckObjects=true',
      '-c', 'protocol.file.allow=always',
      'fetch', '--no-tags', '--no-recurse-submodules', clone, `+HEAD:refs/xllm/exec/${id}`,
    ]);
    refFetched = fetch.status === 0;
  }

  const dir = path.join(ensureArtifactDirs(root), 'exec');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${parsed.provider}-${slugify(task)}-${id}`;
  const artifactPath = path.join(dir, `${base}.md`);
  let patchPath = null;
  if (changed && !oversized && !tampered) {
    patchPath = path.join(dir, `${base}.patch`);
    fs.writeFileSync(patchPath, patch, 'utf8');
  }

  const attribution = adv.attribution || null;
  const record = {
    schema_version: 1,
    id,
    status,
    provider_spec: parsed.spec,
    attribution,
    base: baseRev,
    result_ref: refFetched ? `refs/xllm/exec/${id}` : null,
    sandbox: { kind: EXEC_CAPABLE[parsed.provider].sandbox, preflight: 'passed', profile: PROFILE_NAME },
    executor: {
      exit_code: typeof adv.exitCode === 'number' ? adv.exitCode : null,
      timed_out: !!timedOut,
      duration_ms: durationMs,
      failure: executorFailure,
    },
    changed,
    files_changed: filesChanged.length,
    oversized,
    verification: verification
      ? {
          ...verification,
          checks: undefined,
          failed_checks: (verification.checks || []).filter((c) => !c.ok).map((c) => ({ name: c.name, detail: redactSecrets(String(c.detail || '')).slice(0, 300) })),
        }
      : { state: testCmd ? 'not-run' : 'none', cmd: testCmd },
    verification_definition_changed: defs.changed,
    verification_definition_files: defs.files,
    verification_scripts_changed: defs.scripts_changed,
    test_files_changed: defs.test_files_changed,
    tamper: { host: hostDiff, clone: cloneTamper },
  };
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');

  const verifyLine = !testCmd
    ? '- Verification: NONE (no --test-cmd) — status is `unverified`; executor claims are not evidence'
    : !verification
      ? `- Verification \`${testCmd}\`: NOT RUN`
      : verification.state === 'ran'
        ? `- Verification \`${testCmd}\` (OS sandbox, controlled env): exit ${verification.exit_code}`
        : `- Verification \`${testCmd}\`: ${verification.state.toUpperCase()}${verification.reason ? ` — ${verification.reason}` : ''}`;
  fs.writeFileSync(
    artifactPath,
    [
      `# xllm exec evidence — ${parsed.spec}`,
      '',
      `- Run id: ${id}`,
      `- Status: **${status}**${status === 'green' ? '' : ' (not green)'}`,
      `- Base: ${baseRev}`,
      `- Result ref: ${refFetched ? `refs/xllm/exec/${id}` : '(not fetched)'}`,
      `- Files changed: ${filesChanged.length}${oversized ? ' (OVERSIZED — patch omitted)' : ''}`,
      stat ? `- Diff: ${stat}` : null,
      `- Sandbox: ${record.sandbox.kind} (profile ${PROFILE_NAME}; preflight passed; no bypass mode)`,
      attribution
        ? `- Executed: ${attribution.executed_provider || parsed.provider} / model ${attribution.transmitted_model || '(default)'}` +
          (attribution.reported_model ? ` (reported ${attribution.reported_model})` : '')
        : null,
      `- Main repo / clone integrity: ${tampered ? `**CHANGED — INSPECT** (${[...hostDiff, ...cloneTamper].join(', ')})` : 'unchanged ✓ (HEAD, refs, status, config, hooks)'}`,
      `- Executor exit: ${record.executor.exit_code}${timedOut ? ' (TIMED OUT — killed)' : ''}`,
      `- Duration ms: ${durationMs}`,
      verifyLine,
      defs.changed
        ? `- **Verification definitions changed** by the executor: ${defs.files.join(', ')}${defs.scripts_changed.length ? ` (scripts: ${defs.scripts_changed.join(', ')})` : ''} — a pass does not prove the ORIGINAL bar; review these first`
        : '- Verification definitions: unchanged',
      defs.test_files_changed ? `- Test files touched: ${defs.test_files_changed}` : null,
      patchPath ? `- Patch: ${patchPath}` : null,
      `- Machine record: ${jsonPath}`,
      '',
      '## Task',
      '',
      redactSecrets(task),
      '',
      ...(verification && verification.output_tail
        ? ['## Verification output (tail)', '', '```text', redactSecrets(verification.output_tail), '```', '']
        : []),
      ...(executorFailure
        ? [
            '## Executor failure',
            '',
            `- Kind: ${executorFailure.kind}`,
            `- Exit code: ${executorFailure.exit_code}`,
            executorFailure.hint ? `- Hint: ${executorFailure.hint}` : null,
            executorFailure.message ? `- Message: ${executorFailure.message}` : null,
            '',
          ].filter((x) => x !== null)
        : []),
      '## Executor output (tail)',
      '',
      '```text',
      redactSecrets(tailOf(execOutput, 40)),
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
      '> Executor output is not evidence. Only `green` (sandbox-verified passing test, unchanged verification definitions) is a pass; re-run your own verification after merging.',
      '',
    ]
      .filter((x) => x !== null)
      .join('\n'),
    'utf8'
  );

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
  } else {
    console.error(`[exec] clone kept: ${clone}`);
  }

  console.error(`[exec] ${status}${refFetched ? ` → refs/xllm/exec/${id}` : ''}`);
  console.log(artifactPath);
  return {
    exitCode: STATUS_EXIT[status] ?? 2,
    id,
    status,
    ref: refFetched ? `refs/xllm/exec/${id}` : null,
    artifactPath,
    patchPath,
    jsonPath,
    record,
  };
}

/** Prove the sandbox on this machine without calling any model. */
export function sandboxCheck({ root = process.cwd(), env = process.env, spawnFn = defaultSpawn } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const hostRoot = top.status === 0 ? path.resolve(top.stdout.trim()) : null;
  const execRoot = path.resolve(execRootDir(env));
  fs.mkdirSync(execRoot, { recursive: true });
  const dir = path.join(execRoot, `check-${execId()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return { hostRoot, execRoot, ...probeSandbox({ dir, hostRoot, execRoot, env: controlledEnv(process.env), spawnFn }) };
  } finally {
    rmDir(dir);
  }
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
      `${r.id}  ${String(r.status || '?').padEnd(18)}  ${r.spec || r.provider}  ${r.ref || '-'}${r.clone ? `  clone:${r.clone}` : ''}`
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = { testCmd: null, timeoutMs: DEFAULT_TIMEOUT_MS, keepClone: false, allowSelf: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-cmd') flags.testCmd = argv[++i];
    else if (a === '--timeout-ms') flags.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (a === '--keep-clone') flags.keepClone = true;
    else if (a === '--allow-self') flags.allowSelf = true;
    else if (a === '--sandbox-mode' || a === '--allow-write' || a === '--ready') {
      console.error(`[exec] ${a} is not supported: exec has no sandbox bypass and no policy override.`);
      process.exit(1);
    } else pos.push(a);
  }
  const cmd = pos[0];

  if (cmd === 'list') return listRuns();
  if (cmd === 'sandbox-check') {
    const r = sandboxCheck();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 3);
  }
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
  node scripts/xllm-exec.js run <provider-spec> "<task>" [--test-cmd "npm test"] [--timeout-ms N] [--keep-clone] [--allow-self]
  node scripts/xllm-exec.js sandbox-check
  node scripts/xllm-exec.js list
  node scripts/xllm-exec.js cleanup <id>|--all

Invariants: runs only inside a verified native OS sandbox (no bypass; refused
otherwise); local-only policy is checked before clone/spawn; the executor works
in an ephemeral clone with no origin remote; verification runs through the OS
sandbox with a controlled env; no passing sandboxed test => never 'green';
result returns as refs/xllm/exec/<id> + patch + evidence by explicit host
fetch; merge/push/credentials stay host-side.`);
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
