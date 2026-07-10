#!/usr/bin/env node
/**
 * Static sanity checks for the Grok plugin layout (no network, no LLMs).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failed += 1;
  }
}

console.log('check-plugin');

const pluginPath = path.join(root, 'plugin.json');
ok(fs.existsSync(pluginPath), 'plugin.json exists');

const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
ok(plugin.name === 'grok-xllm', 'plugin name is grok-xllm');
ok(typeof plugin.version === 'string' && /^\d+\.\d+\.\d+/.test(plugin.version), 'semver version');
ok(Array.isArray(plugin.skills) && plugin.skills.length >= 6, 'skills array has core set');

// Every path the manifest references must exist (no dangling targets)
for (const key of ['commands', 'agents', 'personas', 'skills']) {
  const val = plugin[key];
  if (typeof val === 'string') {
    ok(fs.existsSync(path.join(root, val)), `plugin.json ${key} target exists (${val})`);
  } else if (Array.isArray(val)) {
    for (const entry of val) {
      ok(fs.existsSync(path.join(root, entry)), `plugin.json ${key} entry exists (${entry})`);
    }
  }
}

const requiredSkills = ['ask', 'xllm', 'ralph', 'team', 'verify', 'xllm-setup'];
for (const s of requiredSkills) {
  const skillMd = path.join(root, '.grok', 'skills', s, 'SKILL.md');
  ok(fs.existsSync(skillMd), `skill ${s}/SKILL.md`);
  const body = fs.readFileSync(skillMd, 'utf8');
  ok(/^---\n[\s\S]*?name:\s*\S+/m.test(body), `skill ${s} has frontmatter name`);
}

const requiredAgents = [
  'critic',
  'executor',
  'verifier',
  'security-reviewer',
  'explore',
  'planner',
  'architect',
  'local-optimizer',
];
for (const a of requiredAgents) {
  ok(fs.existsSync(path.join(root, '.grok', 'agents', `${a}.md`)), `agent ${a}.md`);
}

const scripts = [
  'grok-ask-advisor.js',
  'xllm-doctor.js',
  'xllm-routing.js',
  'test-advisor.mjs',
  'xllm.mjs',
];
for (const s of scripts) {
  ok(fs.existsSync(path.join(root, 'scripts', s)), `script ${s}`);
}

// Team skill must mention auto routing
{
  const team = fs.readFileSync(path.join(root, '.grok', 'skills', 'team', 'SKILL.md'), 'utf8');
  ok(team.includes('xllm-routing'), 'team skill uses xllm-routing');
  ok(team.includes('pick-team') || team.includes('pickAdvisor'), 'team skill mandates pick-team');
}

const docs = [
  'SCOPE.md',
  'getting-started.md',
  'architecture.md',
  'local-llms.md',
  'install.md',
];
for (const d of docs) {
  ok(fs.existsSync(path.join(root, '.grok', 'docs', d)), `doc ${d}`);
}

ok(fs.existsSync(path.join(root, 'LICENSE')), 'LICENSE');
ok(
  fs.existsSync(path.join(root, '.grok', 'xllm-providers.toml')),
  'xllm-providers.toml profiles'
);

// Skills must route through the advisor (by name or path-resolution contract)
for (const s of ['ask', 'xllm', 'ralph', 'team']) {
  const body = fs.readFileSync(path.join(root, '.grok', 'skills', s, 'SKILL.md'), 'utf8');
  const wired =
    body.includes('grok-ask-advisor.js') ||
    body.includes('xllm-advisor-path') ||
    body.includes('<advisor.js>');
  ok(wired, `skill ${s} wires advisor path`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(pkg.name === 'grok-xllm', 'package.json name is grok-xllm');
ok(pkg.version === plugin.version, `package.json version matches plugin.json (${pkg.version})`);

// Claude Code adapter (.claude-plugin/ + ./skills/)
{
  const cPluginPath = path.join(root, '.claude-plugin', 'plugin.json');
  const cMarketPath = path.join(root, '.claude-plugin', 'marketplace.json');
  ok(fs.existsSync(cPluginPath), 'claude adapter: .claude-plugin/plugin.json exists');
  ok(fs.existsSync(cMarketPath), 'claude adapter: .claude-plugin/marketplace.json exists');
  const cPlugin = JSON.parse(fs.readFileSync(cPluginPath, 'utf8'));
  const cMarket = JSON.parse(fs.readFileSync(cMarketPath, 'utf8'));
  ok(cPlugin.name === 'xllm', 'claude adapter: plugin name is xllm');
  ok(cPlugin.version === pkg.version, `claude adapter: version matches package.json (${cPlugin.version})`);
  ok(
    Array.isArray(cMarket.plugins) && cMarket.plugins[0]?.source === './',
    'claude adapter: marketplace self-hosts plugin at ./'
  );
  ok(
    cMarket.plugins?.[0]?.version === pkg.version,
    'claude adapter: marketplace version matches package.json'
  );
  for (const entry of cPlugin.skills || []) {
    const skillMd = path.join(root, entry, 'SKILL.md');
    ok(fs.existsSync(skillMd), `claude skill ${entry}SKILL.md exists`);
    const body = fs.readFileSync(skillMd, 'utf8');
    ok(/^---\n[\s\S]*?name:\s*\S+/m.test(body), `claude skill ${entry} has frontmatter name`);
    ok(body.includes('CLAUDE_PLUGIN_ROOT'), `claude skill ${entry} wires advisor via CLAUDE_PLUGIN_ROOT`);
    ok(/read-only/i.test(body), `claude skill ${entry} states read-only default`);
  }
}

for (const sub of ['ask', 'xllm', 'ralph', 'team', 'verify']) {
  ok(
    fs.existsSync(path.join(root, '.grok', 'artifacts', sub, '.gitkeep')) ||
      fs.existsSync(path.join(root, '.grok', 'artifacts', sub)),
    `artifacts/${sub} present`
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall plugin checks passed');
