#!/usr/bin/env node
import { createHub } from '../src/hub.js';
import { HubClient, discoverHub } from '../src/client.js';
import { DEFAULT_PORT } from '../src/protocol.js';
import { runMcpBridge } from '../src/mcp-bridge.js';
import { runningHub, writeHubLock, homeDir } from '../src/lock.js';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) { pos.push(rest[i]); continue; }
  const bool = rest[i] === '--invite-only'; // value-less flags
  flags[rest[i].slice(2)] = bool ? true : rest[++i];
}
const token = flags.token ?? process.env.LAH_TOKEN;
const hubUrl = async () => flags.url ?? process.env.LAH_URL ?? (await discoverHub()) ?? (console.error('no hub found; use --url'), process.exit(1));
const mk = async (id) => { const c = new HubClient({ url: await hubUrl(), token, id: flags.id ?? id, kind: 'cli' }); await c.connect(); return c; };

switch (cmd) {
  case 'hub': {
    const other = runningHub();
    if (other) { console.error(`a hub is already running on this PC (pid ${other.pid}, port ${other.port}); one hub per PC. Stop it first.`); process.exit(1); }
    const inviteOnly = 'invite-only' in flags;
    if (inviteOnly && !token) { console.error('--invite-only needs --token (the admin token)'); process.exit(1); }
    const hub = createHub({ port: Number(flags.port ?? DEFAULT_PORT), token, inviteOnly, advertise: flags.advertise !== '0', invitesFile: join(homeDir(), 'invites.json'), log: console.log });
    const p = await hub.start();
    writeHubLock(p);
    console.log(`lan-agent-hub listening on :${p}${token ? ' (token auth)' : ' (NO AUTH — use --token)'}${inviteOnly ? ' [invite-only]' : ''}`);
    break;
  }
  case 'invite': case 'invites': case 'revoke': case 'kick': {
    if (!token) { console.error('admin commands need the hub token (--token or LAH_TOKEN)'); process.exit(1); }
    const base = await hubUrl(); const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: h, body: body && JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) { console.error(`${r.status}: ${j.error ?? 'failed'}`); process.exit(1); } return j; };
    if (cmd === 'invites') console.table(await call('GET', '/api/invites'));
    else if (!pos[0]) { console.error(`usage: lah ${cmd} <agent-id>`); process.exit(1); }
    else if (cmd === 'invite') {
      const r = await call('POST', '/api/invites', { agentId: pos[0], name: flags.name });
      console.log(`Invite for "${r.agentId}" (shown once):\n  LAH_TOKEN=${r.code}\n  LAH_URL=${base}   (optional if mDNS works)`);
    } else if (cmd === 'revoke') { await call('DELETE', `/api/invites/${encodeURIComponent(pos[0])}`); console.log(`revoked ${pos[0]}`); }
    else console.log(await call('POST', `/api/agents/${encodeURIComponent(pos[0])}/kick`));
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
  hub    [--port 7788] [--token T] [--invite-only]   run the hub (one per PC)
  invite <agent-id> [--name N]         create a per-agent invite code (admin token)
  invites | revoke <id> | kick <id>    list / remove / disconnect (admin token)
  agents                               list agents
  send   <to> <text...>                send (to = id | #topic | *)
  listen [--id X] [--topics a,b]       print incoming messages
  mcp                                  MCP stdio bridge (for Claude Code)
common: --url http://host:7788 --token T (or LAH_URL / LAH_TOKEN; hub auto-discovered via mDNS)`);
}
