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
ok(plugin.name === 'xllm', 'plugin name is xllm');
ok(typeof plugin.version === 'string' && /^\d+\.\d+\.\d+/.test(plugin.version), 'semver version');
ok(Array.isArray(plugin.skills) && plugin.skills.length >= 3, 'skills array has core set');

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

const requiredSkills = ['ask', 'xllm', 'xllm-setup'];
for (const s of requiredSkills) {
  const skillMd = path.join(root, '.grok', 'skills', s, 'SKILL.md');
  ok(fs.existsSync(skillMd), `skill ${s}/SKILL.md`);
  const body = fs.readFileSync(skillMd, 'utf8');
  ok(/^---\n[\s\S]*?name:\s*\S+/m.test(body), `skill ${s} has frontmatter name`);
}

const scripts = [
  'xllm-advisor.js',
  'xllm-doctor.js',
  'xllm-routing.js',
  'test-advisor.mjs',
  'xllm.mjs',
];
for (const s of scripts) {
  ok(fs.existsSync(path.join(root, 'scripts', s)), `script ${s}`);
}

const docs = [
  'SCOPE.md',
  'getting-started.md',
  'architecture.md',
  'local-llms.md',
  'install.md',
];
for (const d of docs) {
  ok(fs.existsSync(path.join(root, 'docs', d)), `doc ${d}`);
}

ok(fs.existsSync(path.join(root, 'LICENSE')), 'LICENSE');
ok(
  fs.existsSync(path.join(root, '.xllm', 'xllm-providers.toml')),
  'xllm-providers.toml profiles'
);

// Skills must route through the advisor (by name or path-resolution contract)
for (const s of ['ask', 'xllm']) {
  const body = fs.readFileSync(path.join(root, '.grok', 'skills', s, 'SKILL.md'), 'utf8');
  const wired =
    body.includes('xllm-advisor.js') ||
    body.includes('xllm-advisor-path') ||
    body.includes('<advisor.js>');
  ok(wired, `skill ${s} wires advisor path`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(pkg.name === 'xllm', 'package.json name is xllm');
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

// Codex adapter (.codex-plugin/ + .agents/plugins/marketplace.json + shared ./skills/)
{
  const xPluginPath = path.join(root, '.codex-plugin', 'plugin.json');
  const xMarketPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
  ok(fs.existsSync(xPluginPath), 'codex adapter: .codex-plugin/plugin.json exists');
  ok(fs.existsSync(xMarketPath), 'codex adapter: .agents/plugins/marketplace.json exists');
  const xPlugin = JSON.parse(fs.readFileSync(xPluginPath, 'utf8'));
  const xMarket = JSON.parse(fs.readFileSync(xMarketPath, 'utf8'));
  ok(xPlugin.name === 'xllm', 'codex adapter: plugin name is xllm');
  ok(xPlugin.version === pkg.version, `codex adapter: version matches package.json (${xPlugin.version})`);
  ok(typeof xPlugin.skills === 'string' && fs.existsSync(path.join(root, xPlugin.skills)),
    `codex adapter: skills dir exists (${xPlugin.skills})`);
  ok(xPlugin.interface && typeof xPlugin.interface.displayName === 'string',
    'codex adapter: interface.displayName present');
  const xEntry = Array.isArray(xMarket.plugins) ? xMarket.plugins[0] : null;
  ok(xEntry?.name === 'xllm', 'codex adapter: marketplace entry name is xllm');
  ok(xEntry?.source?.url === './', 'codex adapter: marketplace self-hosts plugin at ./');
  // Shared skills must not be Claude-only: advisor resolution has to work on
  // hosts without CLAUDE_PLUGIN_ROOT (Codex resolves relative to the SKILL.md).
  for (const s of ['ask', 'multi', 'setup']) {
    const body = fs.readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8');
    ok(/plugin.root|plugin-root/i.test(body), `shared skill ${s} documents non-Claude plugin-root resolution`);
  }
}

// Shipped surface must not re-advertise removed grok-xllm-era features
// (/ralph and /team skills removed in v0.20.0; pick-team removed after v0.21.1).
// Historical records are exempt: CHANGELOG, FINDINGS, docs/*-design.md, and
// diversity-roadmap.md (transcribed debate records are append-only evidence).
{
  const forbidden = [/\/ralph\b/, /\/team\b/, /pick-team/];
  const shipped = ['README.md'];
  const collectMd = (dir) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) collectMd(rel);
      else if (e.name.endsWith('.md')) shipped.push(rel);
    }
  };
  collectMd('examples');
  collectMd('skills');
  collectMd(path.join('.grok', 'skills'));
  for (const e of fs.readdirSync(path.join(root, 'docs'))) {
    if (e.endsWith('.md') && !e.endsWith('-design.md') && e !== 'diversity-roadmap.md') {
      shipped.push(path.join('docs', e));
    }
  }
  for (const rel of shipped) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8');
    const hit = forbidden.find((re) => re.test(body));
    ok(!hit, `no removed-feature residue in ${rel}${hit ? ` (matched ${hit})` : ''}`);
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall plugin checks passed');
