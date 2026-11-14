#!/usr/bin/env node
// Cross-platform launcher for the Claude Code plugin (no `sh` needed, so it works on Windows).
// Installs runtime deps on first run, then starts the MCP stdio bridge.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'node_modules'))) {
  // stdout is the MCP protocol channel: send npm's output to stderr. shell:true lets Windows resolve npm.cmd.
  const r = spawnSync('npm', ['install', '--omit=dev', '--silent', '--no-audit', '--no-fund'],
    { cwd: root, stdio: ['ignore', 2, 2], shell: true });
  if (r.status !== 0) { console.error('lan-agent-hub: npm install failed'); process.exit(1); }
}
process.argv.splice(2, 0, 'mcp');
await import('./lah.js');
