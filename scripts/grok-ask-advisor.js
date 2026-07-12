#!/usr/bin/env node
/**
 * DEPRECATED forwarding shim — the advisor moved to scripts/xllm-advisor.js
 * in v0.20.0 (the grok- prefix was a grok-xllm-era leftover; every other
 * script is xllm-*). This shim keeps stale path markers, XLLM_ADVISOR_PATH
 * values, and old docs working for one or two releases, then it will be
 * removed. Update your references; `xllm remember` regenerates markers.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xllm-advisor.js');
const res = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});
process.exit(res.status ?? 1);
