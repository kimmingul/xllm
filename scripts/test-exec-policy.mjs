// xllm exec boundary regressions (node:test). No live LLM calls: runAdvisor and
// the OS sandbox are injected. Real-OS proof is `node scripts/xllm-exec.js sandbox-check`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXEC_CAPABLE,
  execCapableProviders,
  buildSandboxProfile,
  buildCodexExecArgs,
  buildSandboxRunnerArgs,
  windowsSandboxArgs,
  assertNoUnsafeArgs,
  controlledEnv,
  resolveExecPlan,
  probeSandbox,
  deriveExecStatus,
  detectVerificationDefinitionChanges,
  cleanupRun,
  writeRegistry,
  runExec,
} from './xllm-exec.js';

const ALLOW = () => ({ allowed: true, location: 'remote', reason: 'test' });
const resolveTarget = () => ({ command: 'codex', argsPrefix: [] });

function git(cwd, args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
    { encoding: 'utf8' }
  );
  return r;
}

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-exec-repo-'));
  git(dir, ['init', '-q']);
  const all = {
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
    'a.txt': 'one\n',
    ...files,
  };
  for (const [f, c] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Stand-in for `codex sandbox`: emulates the probe; runs verification for real. */
function fakeSandbox({ escapeAfterProbes = Infinity } = {}) {
  const calls = [];
  let probes = 0;
  return {
    calls,
    spawnFn(_command, args, opts) {
      const cmd = args.slice(args.indexOf('--') + 1);
      calls.push({ args, cmd, env: opts.env, cwd: opts.cwd });
      if (/xllm-probe-[^/\\]*\.cjs$/.test(cmd[1] || '')) {
        probes++;
        const escape = probes > escapeAfterProbes;
        const t = JSON.parse(opts.env.XLLM_PROBE_TARGETS);
        for (const [k, p] of Object.entries(t.writes)) {
          if (k === 'inside' || (escape && (k === 'write-system-temp' || k === 'write-exec-root'))) {
            fs.writeFileSync(p, '1');
          }
        }
        const reads = Object.fromEntries(Object.keys(t.reads).map((k) => [k, escape ? 'readable' : 'denied']));
        const secretEnv = Object.keys(opts.env).filter((k) => new RegExp(t.secretPattern, 'i').test(k));
        return { status: 0, stdout: `XLLM_PROBE ${JSON.stringify({ writes: {}, reads, secretEnv })}\n`, stderr: '' };
      }
      return spawnSync(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
    },
  };
}

function harness(t, { files } = {}) {
  const repo = makeRepo(files);
  const execRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-exec-root-'));
  const prev = {
    root: process.env.XLLM_EXEC_ROOT,
    key: process.env.OPENAI_API_KEY,
    tok: process.env.GITHUB_TOKEN,
  };
  process.env.XLLM_EXEC_ROOT = execRoot;
  process.env.OPENAI_API_KEY = 'sk-test-secret-should-not-reach-verifier-0000';
  process.env.GITHUB_TOKEN = 'ghp_testtokenshouldnotreachverifier000000';
  t.after(() => {
    for (const [k, v] of [['XLLM_EXEC_ROOT', prev.root], ['OPENAI_API_KEY', prev.key], ['GITHUB_TOKEN', prev.tok]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(execRoot, { recursive: true, force: true });
  });
  return { repo, execRoot, env: { XLLM_EXEC_ROOT: execRoot } };
}

function silent(fn) {
  const err = console.error;
  const out = console.log;
  console.error = () => {};
  console.log = () => {};
  const restore = () => {
    console.error = err;
    console.log = out;
  };
  return fn().finally(restore);
}

function advisorStub(mutate) {
  const seen = [];
  const fn = (opts) => {
    seen.push(opts);
    mutate?.(opts);
    return { exitCode: 0, raw: 'did it', durationMs: 7, attribution: { executed_provider: 'codex', transmitted_model: 'gpt-x' } };
  };
  fn.seen = seen;
  return fn;
}

const run = (h, extra) =>
  silent(async () =>
    runExec({
      spec: 'codex',
      task: 'edit a.txt',
      root: h.repo,
      env: h.env,
      policyFn: ALLOW,
      resolveTarget,
      ...extra,
    })
  );

// ---------------------------------------------------------------------------
// Pure boundary construction
// ---------------------------------------------------------------------------

test('only codex is exec-capable; claude is refused with the sandbox reason', () => {
  assert.deepEqual(execCapableProviders(), ['codex']);
  assert.ok(!EXEC_CAPABLE.claude);
  const r = resolveExecPlan('claude', { env: {}, policyFn: ALLOW });
  assert.match(r.error, /refused for exec/);
  assert.match(r.error, /not isolation|Bash tool/);
  for (const p of ['gemini', 'grok', 'ollama']) {
    assert.match(resolveExecPlan(p, { env: {}, policyFn: ALLOW }).error, /refused for exec/);
  }
});

test('policy fails closed: denied and missing decisions both refuse', () => {
  const denied = resolveExecPlan('codex', {
    env: {},
    policyFn: () => ({ allowed: false, location: 'remote', reason: 'local-only' }),
  });
  assert.match(denied.error, /policy refuses/);
  assert.match(denied.error, /local-only/);
  const missing = resolveExecPlan('codex', { env: {}, policyFn: () => null });
  assert.match(missing.error, /fail closed/);
  const ok = resolveExecPlan('codex', { env: {}, policyFn: ALLOW });
  assert.equal(ok.parsed.provider, 'codex');
});

test('real policy helper: local-only default refuses cloud codex exec', () => {
  const r = resolveExecPlan('codex', {
    env: {},
    profiles: { defaults: { execution_policy: 'local-only' }, providers: {} },
  });
  assert.match(r.error || '', /policy/i);
});

test('sandbox profile denies temp, host repo and credentials, disables network, has no bypass', () => {
  const host = path.resolve('/repo/host');
  const profile = buildSandboxProfile({ hostRoot: host, platform: 'linux' });
  assert.match(profile, /extends=":workspace"/);
  assert.match(profile, /":tmpdir"="deny"/);
  assert.match(profile, /":slash_tmp"="deny"/);
  assert.ok(profile.includes(JSON.stringify(host)));
  for (const d of ['~/.codex', '~/.ssh', '~/.aws']) assert.ok(profile.includes(`"${d}"="deny"`), d);
  assert.match(profile, /network=\{enabled=false\}/);
  assert.ok(!/:slash_tmp/.test(buildSandboxProfile({ hostRoot: host, platform: 'win32' })));
});

test('executor argv selects the permission profile, never --sandbox or a bypass', () => {
  const args = buildCodexExecArgs({ cwd: '/tmp/clone', hostRoot: '/repo/bypass-demo' });
  assert.doesNotThrow(() => assertNoUnsafeArgs(args)); // path containing "bypass" is not a flag
  assert.ok(!args.includes('--sandbox'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('default_permissions="xllm_exec"'));
  assert.equal(args[args.indexOf('--cd') + 1], '/tmp/clone');
  for (const bad of [
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--sandbox', 'workspace-write'],
    ['--sandbox=danger-full-access'],
    ['-s'],
    ['-c', 'sandbox_mode="danger-full-access"'],
  ]) {
    assert.throws(() => assertNoUnsafeArgs(bad), /unsafe/, JSON.stringify(bad));
  }
});

test('sandbox runner argv: flags validated, user command is passed through untouched after --', () => {
  const argv = buildSandboxRunnerArgs({
    cwd: '/c',
    hostRoot: '/h',
    command: ['sh', '-c', 'npm test --sandbox'],
    platform: 'linux',
  });
  assert.equal(argv[0], 'sandbox');
  const dd = argv.indexOf('--');
  assert.deepEqual(argv.slice(dd + 1), ['sh', '-c', 'npm test --sandbox']);
  assert.equal(argv[argv.indexOf('-P') + 1], 'xllm_exec');
});

test('controlledEnv is an allow-list: secrets and unknown vars never pass', () => {
  const env = controlledEnv({
    PATH: '/bin',
    HOME: '/home/u',
    OPENAI_API_KEY: 'sk-x',
    GITHUB_TOKEN: 'ghp_x',
    ANTHROPIC_API_KEY: 'k',
    MY_CUSTOM_THING: 'v',
    NPM_CONFIG__AUTH: 'a',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/u');
  for (const k of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'MY_CUSTOM_THING', 'NPM_CONFIG__AUTH']) {
    assert.ok(!(k in env), k);
  }
});

test('deriveExecStatus: green needs a passing sandboxed test and untouched definitions', () => {
  const base = { changed: true, timedOut: false, testCmd: 't', defChanged: false, tampered: false };
  const pass = { state: 'ran', exit_code: 0 };
  assert.equal(deriveExecStatus({ ...base, verification: pass }), 'green');
  assert.equal(deriveExecStatus({ ...base, testCmd: null, verification: null }), 'unverified');
  assert.equal(deriveExecStatus({ ...base, verification: { state: 'ran', exit_code: 1 } }), 'not-green');
  assert.equal(deriveExecStatus({ ...base, verification: { state: 'blocked' } }), 'blocked');
  assert.equal(deriveExecStatus({ ...base, verification: null }), 'blocked');
  assert.equal(deriveExecStatus({ ...base, verification: pass, defChanged: true }), 'definition-changed');
  assert.equal(deriveExecStatus({ ...base, verification: pass, tampered: true }), 'tampered');
  assert.equal(deriveExecStatus({ ...base, verification: pass, timedOut: true }), 'timeout');
  assert.equal(deriveExecStatus({ ...base, changed: false, verification: null }), 'no-change');
});

// ---------------------------------------------------------------------------
// Sandbox probe
// ---------------------------------------------------------------------------

test('probe: a missing/dead directory never passes', () => {
  const r = probeSandbox({
    dir: path.join(os.tmpdir(), 'xllm-does-not-exist-' + Date.now()),
    hostRoot: os.tmpdir(),
    spawnFn: () => assert.fail('must not spawn'),
    resolveTarget,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
});

test('probe: passes only when the host filesystem proves confinement', (t) => {
  const h = harness(t);
  const dir = fs.mkdtempSync(path.join(h.execRoot, 'p-'));
  const good = probeSandbox({ dir, hostRoot: h.repo, execRoot: h.execRoot, spawnFn: fakeSandbox().spawnFn, resolveTarget });
  assert.equal(good.ok, true, JSON.stringify(good.checks.filter((c) => !c.ok)));
  const leaky = probeSandbox({
    dir,
    hostRoot: h.repo,
    execRoot: h.execRoot,
    spawnFn: fakeSandbox({ escapeAfterProbes: 0 }).spawnFn,
    resolveTarget,
  });
  assert.equal(leaky.ok, false);
  assert.match(leaky.reason, /write-system-temp|write-exec-root|read-host-repo/);
  assert.deepEqual(fs.readdirSync(dir), [], 'probe leaves nothing behind');
});

test('probe: a sandbox that cannot even write inside the clone is a failure, not a pass', (t) => {
  const h = harness(t);
  const dir = fs.mkdtempSync(path.join(h.execRoot, 'p-'));
  const r = probeSandbox({
    dir,
    hostRoot: h.repo,
    execRoot: h.execRoot,
    spawnFn: () => ({ status: 1, stdout: '', stderr: 'sandbox setup failed' }),
    resolveTarget,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /write-inside-clone|runner-started/);
});

test('probe: secret-looking env reaching the sandbox fails the probe', (t) => {
  const h = harness(t);
  const dir = fs.mkdtempSync(path.join(h.execRoot, 'p-'));
  const r = probeSandbox({
    dir,
    hostRoot: h.repo,
    execRoot: h.execRoot,
    env: { ...controlledEnv(), SOME_SECRET_VALUE: 'x' },
    spawnFn: fakeSandbox().spawnFn,
    resolveTarget,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no-secret-env/);
});

// ---------------------------------------------------------------------------
// runExec orchestration (real git, fake model + fake sandbox)
// ---------------------------------------------------------------------------

test('policy refusal happens before any clone or spawn', async (t) => {
  const h = harness(t);
  const adv = advisorStub();
  const sb = fakeSandbox();
  const res = await run(h, {
    advisorFn: adv,
    spawnFn: sb.spawnFn,
    policyFn: () => ({ allowed: false, location: 'remote', reason: 'execution_policy=local-only' }),
  });
  assert.equal(res.status, 'refused');
  assert.equal(res.exitCode, 1);
  assert.equal(adv.seen.length, 0);
  assert.equal(sb.calls.length, 0);
  assert.deepEqual(fs.readdirSync(h.execRoot), []);
});

test('unverifiable sandbox blocks the run before cloning; executor never starts', async (t) => {
  const h = harness(t);
  const adv = advisorStub();
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox({ escapeAfterProbes: 0 }).spawnFn });
  assert.equal(res.status, 'blocked');
  assert.equal(res.exitCode, 3);
  assert.equal(adv.seen.length, 0);
  assert.deepEqual(fs.readdirSync(h.execRoot).filter((n) => n !== '.no-hooks'), []);
});

test('green path: sandboxed passing test, ref fetched, host untouched, clone has no origin', async (t) => {
  const h = harness(t);
  const headBefore = git(h.repo, ['rev-parse', 'HEAD']).stdout.trim();
  let remotes = null;
  const adv = advisorStub((o) => {
    remotes = git(o.execution.cwd, ['remote']).stdout.trim();
    fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n');
  });
  const sb = fakeSandbox();
  const res = await run(h, { advisorFn: adv, spawnFn: sb.spawnFn, testCmd: 'node -e "process.exit(0)"' });
  assert.equal(res.status, 'green', JSON.stringify(res.record?.verification));
  assert.equal(res.exitCode, 0);
  assert.equal(remotes, '', 'origin remote removed from clone');
  // executor invocation contract
  const o = adv.seen[0];
  assert.equal(o.provider, 'codex');
  assert.equal(o.noArtifacts, true);
  assert.ok(!('allowWrite' in o) || o.allowWrite === false || o.allowWrite === undefined);
  assert.doesNotThrow(() => assertNoUnsafeArgs(o.execution.providerArgs));
  assert.ok(!o.execution.providerArgs.includes('--sandbox'));
  // result handed back by explicit fetch; host repo unchanged
  assert.equal(git(h.repo, ['show', `${res.ref}:a.txt`]).stdout.replace(/\r/g, ''), 'two\n');
  assert.equal(git(h.repo, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(fs.readFileSync(path.join(h.repo, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(git(h.repo, ['branch', '--list', 'xllm/*']).stdout.trim(), '');
  // verification ran through the sandbox runner with a scrubbed environment
  const verify = sb.calls.at(-1);
  assert.ok(verify.args.includes('-P'));
  for (const k of ['OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.ok(!(k in verify.env), k);
  assert.equal(res.record.verification.state, 'ran');
  assert.equal(res.record.verification_definition_changed, false);
  assert.ok(fs.existsSync(res.jsonPath));
});

test('Windows-safe verification: a failing command with embedded quotes is not-green, exit code preserved', async (t) => {
  const h = harness(t);
  const adv = advisorStub((o) => fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n'));
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox().spawnFn, testCmd: 'node -e "process.exit(3)"' });
  assert.equal(res.status, 'not-green');
  assert.equal(res.record.verification.exit_code, 3);
  assert.equal(res.exitCode, 2);
});

test('no test command: changed work is unverified, never green', async (t) => {
  const h = harness(t);
  const adv = advisorStub((o) => fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n'));
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox().spawnFn });
  assert.equal(res.status, 'unverified');
  assert.equal(res.exitCode, 2);
  assert.equal(res.record.verification.state, 'none');
  assert.match(fs.readFileSync(res.artifactPath, 'utf8'), /unverified/);
});

test('executor editing package.json test scripts is reported and withholds green', async (t) => {
  const h = harness(t);
  const adv = advisorStub((o) => {
    const p = path.join(o.execution.cwd, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.scripts.test = 'node -e "process.exit(0)" && echo weakened';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n');
  });
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox().spawnFn, testCmd: 'npm test' });
  // The test itself may or may not run (npm availability); definition drift must be reported either way.
  assert.equal(res.record.verification_definition_changed, true);
  assert.deepEqual(res.record.verification_scripts_changed, ['package.json#test']);
  assert.notEqual(res.status, 'green');
});

test('no changes → no-change; sandbox lost after the executor ran → blocked, not green', async (t) => {
  const h = harness(t);
  const none = await run(h, { advisorFn: advisorStub(), spawnFn: fakeSandbox().spawnFn, testCmd: 'node -e "0"' });
  assert.equal(none.status, 'no-change');
  assert.equal(none.exitCode, 1);

  const adv = advisorStub((o) => fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n'));
  // probe #1 (pre-clone) passes, probe #2 (post-run, before verification) leaks
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox({ escapeAfterProbes: 1 }).spawnFn, testCmd: 'node -e "process.exit(0)"' });
  assert.equal(res.status, 'blocked');
  assert.equal(res.exitCode, 3);
  assert.equal(res.record.verification.state, 'blocked');
});

test('tampering with the host repo or clone metadata is detected and the result is NOT fetched', async (t) => {
  const h = harness(t);
  const hostTamper = await run(h, {
    advisorFn: advisorStub((o) => {
      fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n');
      fs.writeFileSync(path.join(h.repo, 'evil.txt'), 'x');
    }),
    spawnFn: fakeSandbox().spawnFn,
    testCmd: 'node -e "process.exit(0)"',
  });
  assert.equal(hostTamper.status, 'tampered');
  assert.equal(hostTamper.ref, null);
  assert.equal(git(h.repo, ['for-each-ref', 'refs/xllm']).stdout.trim(), '');

  const h2 = harness(t);
  const cloneTamper = await run(h2, {
    advisorFn: advisorStub((o) => {
      fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n');
      fs.appendFileSync(path.join(o.execution.cwd, '.git', 'config'), '\n[alias]\n\tx = !echo pwned\n');
    }),
    spawnFn: fakeSandbox().spawnFn,
    testCmd: 'node -e "process.exit(0)"',
  });
  assert.equal(cloneTamper.status, 'tampered');
  assert.equal(cloneTamper.ref, null);
});

test('refuses an exec root that overlaps the repository', async (t) => {
  const h = harness(t);
  const adv = advisorStub();
  const res = await silent(() =>
    runExec({
      spec: 'codex',
      task: 'x',
      root: h.repo,
      env: { XLLM_EXEC_ROOT: path.join(h.repo, 'clones') },
      policyFn: ALLOW,
      advisorFn: adv,
      spawnFn: fakeSandbox().spawnFn,
      resolveTarget,
    })
  );
  assert.equal(res.status, 'refused');
  assert.match(res.error, /overlap/);
  assert.equal(adv.seen.length, 0);
});

// ---------------------------------------------------------------------------
// Verification-definition drift (real git)
// ---------------------------------------------------------------------------

test('definition drift: script edits count, unrelated package.json fields do not', () => {
  const repo = makeRepo({ 'tests/x.test.js': '// t\n', 'Makefile': 'test:\n\ttrue\n' });
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'nohooks-'));
  const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const commit = (mutate) => {
    mutate();
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'c']);
    return git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  };
  const files = (a, b) => git(repo, ['diff', '--name-only', `${a}..${b}`]).stdout.trim().split('\n').filter(Boolean);
  const detect = (head, testCmd = 'npm test') =>
    detectVerificationDefinitionChanges({ clone: repo, noHooks: hooks, base, head, testCmd, changedFiles: files(base, head) });

  const pkgPath = path.join(repo, 'package.json');
  const bump = commit(() => {
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    p.version = '2.0.0';
    fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2));
  });
  const a = detect(bump);
  assert.equal(a.changed, false, 'version bump alone is not a verification change');

  const edit = commit(() => {
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    p.scripts.test = 'true';
    fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2));
    fs.writeFileSync(path.join(repo, 'Makefile'), 'test:\n\techo skip\n');
    fs.writeFileSync(path.join(repo, 'tests', 'x.test.js'), '// changed\n');
  });
  const b = detect(edit);
  assert.equal(b.changed, true);
  assert.ok(b.files.includes('package.json') && b.files.includes('Makefile'));
  assert.deepEqual(b.scripts_changed, ['package.json#test']);
  assert.equal(b.test_files_changed, 1);

  const named = commit(() => fs.writeFileSync(path.join(repo, 'check.js'), 'process.exit(0)\n'));
  assert.deepEqual(
    detectVerificationDefinitionChanges({
      clone: repo, noHooks: hooks, base: edit, head: named, testCmd: 'node check.js', changedFiles: ['check.js'],
    }).files,
    ['check.js'],
    'a file named by the test command is a verification definition'
  );
});

// ---------------------------------------------------------------------------
// Cleanup safety
// ---------------------------------------------------------------------------

test('cleanupRun never deletes a directory outside the exec root', (t) => {
  const h = harness(t);
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'xllm-victim-'));
  t.after(() => fs.rmSync(victim, { recursive: true, force: true }));
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'precious');
  writeRegistry({ runs: { bad: { id: 'bad', clone: victim } } }, h.repo);
  const r = cleanupRun('bad', { root: h.repo, force: true });
  assert.equal(r.removed, false);
  assert.match(r.reason, /outside exec root/);
  assert.ok(fs.existsSync(path.join(victim, 'keep.txt')));
});

// ---------------------------------------------------------------------------
// Executor failure + Windows backend pin (found by a live smoke)
// ---------------------------------------------------------------------------

test('Windows backend is pinned to a deny-read-capable sandbox; unelevated is refused', () => {
  // --ignore-user-config drops the user's [windows] sandbox; the default (unelevated)
  // cannot enforce deny-read paths and codex then refuses to start the session.
  assert.deepEqual(windowsSandboxArgs('win32', {}), ['-c', 'windows.sandbox="elevated"']);
  assert.deepEqual(windowsSandboxArgs('win32', { XLLM_EXEC_WINDOWS_SANDBOX: 'mxc' }), ['-c', 'windows.sandbox="mxc"']);
  assert.throws(() => windowsSandboxArgs('win32', { XLLM_EXEC_WINDOWS_SANDBOX: 'unelevated' }), /refused/);
  assert.deepEqual(windowsSandboxArgs('linux', {}), []);
  const exec = buildCodexExecArgs({ cwd: '/c', hostRoot: '/h', platform: 'win32' });
  assert.ok(exec.includes('windows.sandbox="elevated"'));
  const runner = buildSandboxRunnerArgs({ cwd: '/c', hostRoot: '/h', command: ['x'], platform: 'win32' });
  assert.ok(runner.includes('windows.sandbox="elevated"'));
});

test('executor exit 1 with no changes is executor-failed, not a quiet no-change', () => {
  const base = { changed: false, timedOut: false, testCmd: 't', verification: null, defChanged: false, tampered: false };
  assert.equal(deriveExecStatus({ ...base, executorFailed: true }), 'executor-failed');
  assert.equal(deriveExecStatus({ ...base, executorFailed: false }), 'no-change');
  // changes left behind by a failed executor can never be green
  assert.equal(
    deriveExecStatus({ ...base, changed: true, executorFailed: true, verification: { state: 'ran', exit_code: 0 } }),
    'not-green'
  );
});

test('failed executor: record + artifact carry the redacted failure, status executor-failed', async (t) => {
  const h = harness(t);
  const adv = () => ({
    exitCode: 1,
    raw: '',
    durationMs: 5,
    failure: {
      kind: 'permanent',
      retryable: false,
      hint: 'Read the provider output',
      message: 'session failed: key sk-abcdefghijklmnopqrstuvwxyz0123 rejected',
    },
  });
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox().spawnFn, testCmd: 'node -e "0"' });
  assert.equal(res.status, 'executor-failed');
  assert.equal(res.exitCode, 1);
  assert.equal(res.record.executor.failure.kind, 'permanent');
  assert.equal(res.record.executor.exit_code, 1);
  const md = fs.readFileSync(res.artifactPath, 'utf8');
  assert.match(md, /## Executor failure/);
  assert.match(md, /session failed/);
  assert.ok(!md.includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'secret redacted');
  assert.ok(!fs.readFileSync(res.jsonPath, 'utf8').includes('sk-abcdefghijklmnopqrstuvwxyz0123'));
});

test('successful executor has no failure section', async (t) => {
  const h = harness(t);
  const adv = advisorStub((o) => fs.writeFileSync(path.join(o.execution.cwd, 'a.txt'), 'two\n'));
  const res = await run(h, { advisorFn: adv, spawnFn: fakeSandbox().spawnFn, testCmd: 'node -e "process.exit(0)"' });
  assert.equal(res.record.executor.failure, null);
  assert.doesNotMatch(fs.readFileSync(res.artifactPath, 'utf8'), /## Executor failure/);
});

test('probe env guard: codex-injected git config transport is exempt, credential-like names are not', (t) => {
  // Pass-through "sandbox" (runs the probe script directly) so the REAL in-child
  // env check executes; only the no-secret-env verdict is asserted here.
  const h = harness(t);
  const passthrough = (extra) => (_c, args, opts) => {
    const cmd = args.slice(args.indexOf('--') + 1);
    return spawnSync(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...opts.env, ...extra }, encoding: 'utf8' });
  };
  const verdict = (extra) => {
    const dir = fs.mkdtempSync(path.join(h.execRoot, 'p-'));
    const r = probeSandbox({ dir, hostRoot: h.repo, execRoot: h.execRoot, spawnFn: passthrough(extra), resolveTarget });
    return r.checks.find((c) => c.name === 'no-secret-env');
  };
  // measured: codex sandbox sets these when cwd is a git repo (safe.directory=<clone>)
  assert.equal(
    verdict({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: 'C:\\clone', GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: 'C:\\clone/*' }).ok,
    true
  );
  const bad = verdict({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: x' });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /GIT_CONFIG_KEY_0/);
  assert.ok(!bad.detail.includes('Authorization'), 'reports names only, never values');
  const tok = verdict({ MY_API_TOKEN: 'v' });
  assert.equal(tok.ok, false);
  assert.match(tok.detail, /MY_API_TOKEN/);
});
