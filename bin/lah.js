#!/usr/bin/env node
import { createHub } from '../src/hub.js';
import { HubClient, discoverHub } from '../src/client.js';
import { DEFAULT_PORT } from '../src/protocol.js';
import { runMcpBridge } from '../src/mcp-bridge.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (flags[rest[i].slice(2)] = rest[++i]) : pos.push(rest[i]);
const token = flags.token ?? process.env.LAH_TOKEN;
const hubUrl = async () => flags.url ?? process.env.LAH_URL ?? (await discoverHub()) ?? (console.error('no hub found; use --url'), process.exit(1));
const mk = async (id) => { const c = new HubClient({ url: await hubUrl(), token, id: flags.id ?? id, kind: 'cli' }); await c.connect(); return c; };

switch (cmd) {
  case 'hub': {
    const hub = createHub({ port: Number(flags.port ?? DEFAULT_PORT), token, log: console.log });
    const p = await hub.start();
    console.log(`lan-agent-hub listening on :${p}${token ? ' (token auth)' : ' (NO AUTH — use --token)'}`);
    break;
  }
  case 'agents': { const c = await mk(`cli-${process.pid}`); console.table(await c.list()); c.close(); break; }
  case 'send': {
    const [to, ...words] = pos; const c = await mk(`cli-${process.pid}`);
    console.log(await c.send(to, words.join(' '))); c.close(); break;
  }
  case 'listen': {
    const c = await mk(flags.id ?? `listener-${process.pid}`);
    if (flags.topics) await c.subscribe(...flags.topics.split(','));
    c.on('message', (m) => console.log(`[${m.ts}] ${m.from} -> ${m.to}: ${typeof m.content.body === 'string' ? m.content.body : JSON.stringify(m.content.body)}`));
    c.on('presence', (p) => console.log(`* ${p.agent.id} ${p.online ? 'online' : 'offline'}`));
    console.log(`listening as ${c.agent.id}`); break;
  }
  case 'mcp': await runMcpBridge(); break;
  default:
    console.log(`lah <command>
  hub    [--port 7788] [--token T]     run the hub
  agents                               list agents
  send   <to> <text...>                send (to = id | #topic | *)
  listen [--id X] [--topics a,b]       print incoming messages
  mcp                                  MCP stdio bridge (for Claude Code)
common: --url http://host:7788 --token T (or LAH_URL / LAH_TOKEN; hub auto-discovered via mDNS)`);
}
