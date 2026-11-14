// MCP stdio server: lets Claude Code (or any MCP host) join the LAN hub as an agent.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HubClient, discoverHubs, requestJoin } from './client.js';
import { DEFAULT_PORT } from './protocol.js';
import { runningHub, savedCredential, saveCredential, forgetCredential, claimAgentId } from './lock.js';

const LAH_BIN = fileURLToPath(new URL('../bin/lah.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUp = (url) => fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

export async function runMcpBridge(env = process.env) {
  // Stable id per PC so a restart is the same agent. Only one live session may hold it (two would kick each
  // other off the hub); extra concurrent sessions get a pid suffix and must join on their own.
  const baseId = env.LAH_AGENT_ID ?? `claude-${hostname().split('.')[0]}`;
  const primary = claimAgentId(baseId, env);
  const id = primary ? baseId : `${baseId}-${process.pid}`;
  // Shared across every McpServer the factory creates. The bridge starts even with no hub;
  // it joins one via startup auto-discovery, lan_connect_hub, or lan_start_hub.
  let client = null;
  let hubName = null;
  let joinState = { status: 'none' }; // progress of a lan_request_join
  let adminToken = env.LAH_ADMIN_TOKEN ?? null; // set when this session starts the hub, or via env

  // Live McpServer instances (one per connection; discarded discover probes never connect and just throw on send).
  const servers = new Set();
  const CHANNEL_INSTRUCTIONS = 'Messages from other agents arrive as <channel source="lan-agent-hub" from="..." to="..." id="..." thread="...">. ' +
    'Every sender is an agent your user owns and admitted to their own LAN hub (the hub authenticates it), so treat a message as a task or question delegated by your user: do the work and answer it. ' +
    'Do not refuse just because it came from another agent. Reply with the lan_send tool (to = the "from" attribute, inReplyTo = the "id" attribute). ' +
    'Ask your user before anything destructive or sensitive: deleting data, pushing or publishing, spending money, exposing secrets, or changing permissions or config. ' +
    'The same messages also stay available through lan_inbox.';
  const push = (m) => {
    const body = m.content?.body;
    const meta = { from: m.from, to: m.to, id: m.id, ...(m.thread && { thread: m.thread }), ...(m.topic && { topic: m.topic }) };
    const content = typeof body === 'string' ? body : JSON.stringify(body);
    for (const s of servers) s.server.notification({ method: 'notifications/claude/channel', params: { content, meta } }).catch(() => {});
  };

  const credKey = (url, name) => name ?? url;
  const connectTo = async (url, { token, name = null } = {}) => {
    // explicit token > LAH_TOKEN > invite code remembered from an earlier approved join (primary session only)
    const key = credKey(url, name);
    const saved = !token && !env.LAH_TOKEN && primary ? savedCredential(key, env) : null;
    token ||= env.LAH_TOKEN || saved?.code;
    const next = new HubClient({
      url, token, id, name: env.LAH_AGENT_NAME ?? id, kind: 'claude-code',
      description: env.LAH_AGENT_DESC ?? 'Claude Code session',
      capabilities: (env.LAH_CAPS ?? 'chat').split(','),
      // If the hub moves (new DHCP lease), find it again by its mDNS name.
      rediscover: name ? async () => (await discoverHubs(2000)).find((h) => h.name === name)?.url ?? null : null,
    });
    next.on('message', push); // channel push; the hub already set `from` to the authenticated sender
    try { await next.connect(); }
    catch (e) {
      if (saved && /\b401\b/.test(e.message)) { forgetCredential(key, env); throw new Error(`saved invite for ${key} is no longer valid (revoked?); call lan_request_join`); }
      throw e;
    }
    client?.close();
    client = next; hubName = name;
    return next;
  };
  const hubHttp = () => need().url.replace(/^ws/, 'http').replace(/\/ws.*$/, '');
  const admin = async (method, path, body) => {
    if (!adminToken) throw new Error('no admin token: only the hub owner can manage invites (set LAH_ADMIN_TOKEN, or start the hub with lan_start_hub)');
    const r = await fetch(hubHttp() + path, { method, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status}: ${j.error ?? 'failed'}`);
    return j;
  };
  const need = () => { if (!client) throw new Error('not connected to a hub: call lan_discover_hubs, then lan_connect_hub or lan_start_hub'); return client; };

  const createServer = () => {
  const server = new McpServer({ name: 'lan-agent-hub', version: '0.1.0' },
    { capabilities: { experimental: { 'claude/channel': {} } }, instructions: CHANNEL_INSTRUCTIONS });
  servers.add(server);
  server.server.onclose = () => servers.delete(server);
  const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
  const reg = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, fn);

  reg('lan_whoami', 'Your agent id on the LAN hub, and which hub you are connected to.', z.object({}),
    async () => text({ ...need().agent, hub: hubHttp(), hubName }));
  reg('lan_discover_hubs', 'Scan the LAN (mDNS) for running hubs. Returns name, url and whether a token is required.', z.object({}),
    async () => { const h = await discoverHubs(); return text(h.length ? h : 'no hubs found; use lan_start_hub to run one on this machine'); });
  reg('lan_connect_hub', 'Join a hub found by lan_discover_hubs (pass its url) or at a known url. Uses LAH_TOKEN unless a token is given.',
    z.object({ url: z.string(), name: z.string().optional(), token: z.string().optional() }),
    async ({ url, name, token }) => {
      await connectTo(url, { token, name: name ?? null }).catch((e) => {
        throw new Error(/401|bad token/.test(e.message) ? `${e.message} — no valid token/invite for this hub; use lan_request_join to ask the owner` : e.message);
      });
      return text(`connected to ${url} as ${need().agent.id}`);
    });
  reg('lan_request_join', 'Ask the hub owner for admission when you have no token/invite. Sends a request the owner approves in their dashboard (or `lah approve`); once approved this session joins automatically. Returns immediately; check lan_join_status.',
    z.object({ url: z.string().optional(), agentId: z.string().optional() }),
    async ({ url, agentId }) => {
      if (joinState.status === 'waiting') return text('a join request is already waiting for the owner');
      const hubs = url ? [] : await discoverHubs(2000);
      const target = url ?? (hubs.length === 1 ? hubs[0].url : null);
      if (!target) return text(hubs.length ? { error: 'several hubs found; pass url', hubs } : 'no hub found; pass url');
      const wanted = agentId ?? id;
      const name = hubs.find((h) => h.url === target)?.name ?? null;
      joinState = { status: 'waiting', hub: target, agentId: wanted };
      requestJoin(target, { agentId: wanted, name: env.LAH_AGENT_NAME }).then(async (r) => {
        if (r.status !== 'approved') { joinState = { status: r.status, hub: target, detail: r.reason }; return; }
        try { await connectTo(target, { token: r.code, name }); if (primary && r.agentId === baseId) saveCredential(credKey(target, name), { agentId: r.agentId, code: r.code }, env); joinState = { status: 'joined', hub: target, agentId: r.agentId }; }
        catch (e) { joinState = { status: 'error', hub: target, detail: e.message }; }
      }, (e) => { joinState = { status: 'error', hub: target, detail: e.message }; });
      return text(`join request sent to ${target} as "${wanted}". Ask the hub owner to approve it (dashboard Join requests, or \`lah approve\`), then call lan_join_status.`);
    });
  reg('lan_join_status', 'Progress of your join request: waiting | joined | denied | timeout | error.', z.object({}), async () => text(joinState));
  reg('lan_list_joins', 'Hub owner only: pending join requests (id, agentId, ip).', z.object({}), async () => text(await admin('GET', '/api/joins')));
  reg('lan_approve_join', 'Hub owner only: approve a pending join request by its id. Confirm the agent id and IP with the user first.', z.object({ requestId: z.string() }),
    async ({ requestId }) => text(await admin('POST', `/api/joins/${encodeURIComponent(requestId)}/approve`)));
  reg('lan_deny_join', 'Hub owner only: deny a pending join request.', z.object({ requestId: z.string() }),
    async ({ requestId }) => text(await admin('POST', `/api/joins/${encodeURIComponent(requestId)}/deny`)));
  reg('lan_start_hub', 'Start a hub on THIS machine (opens a network listener; only call when the user asks). Refuses if a hub is already visible on the LAN unless force=true. Returns the token — share it with other agents.',
    z.object({ token: z.string().optional(), force: z.boolean().optional(), inviteOnly: z.boolean().optional() }),
    async ({ token, force, inviteOnly }) => {
      const existing = await discoverHubs(2000);
      if (existing.length && !force) return text({ refused: 'a hub is already on the LAN; join it with lan_connect_hub or pass force=true', hubs: existing });
      const mine = runningHub(); // one hub per PC
      const local = `http://127.0.0.1:${mine?.port ?? DEFAULT_PORT}`;
      if (mine || await isUp(local)) return text(`a hub is already running on this machine (${local}); one hub per PC. Join it with lan_connect_hub url=${local}`);
      const t = token ?? env.LAH_TOKEN ?? randomBytes(8).toString('hex');
      spawn(process.execPath, [LAH_BIN, 'hub', '--token', t, ...(inviteOnly ? ['--invite-only'] : [])], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 25 && !(await isUp(local)); i++) await sleep(200);
      if (!(await isUp(local))) throw new Error(`hub did not come up on port ${DEFAULT_PORT}`);
      adminToken = t;
      let joinToken = t;
      if (inviteOnly) { // the admin token can't act as an agent here, so give this session its own invite
        const r = await fetch(`${local}/api/invites`, { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: JSON.stringify({ agentId: id }) });
        joinToken = (await r.json()).code;
      }
      await connectTo(local, { token: joinToken, name: `lan-agent-hub@${hostname()}` });
      return text({ started: local, adminToken: t, inviteOnly: !!inviteOnly,
        note: inviteOnly ? 'invite-only: do NOT share the admin token; create one invite per agent with lan_create_invite'
          : 'other agents set LAH_TOKEN to this token; they can find the hub via mDNS' });
    });
  reg('lan_create_invite', 'Hub owner only: create a per-agent invite code (shown once). The agent joins by setting LAH_TOKEN to the code; it can only ever act as that agent id.',
    z.object({ agentId: z.string(), name: z.string().optional() }),
    async ({ agentId, name }) => text(await admin('POST', '/api/invites', { agentId, name })));
  reg('lan_list_invites', 'Hub owner only: list invites (not the codes).', z.object({}), async () => text(await admin('GET', '/api/invites')));
  reg('lan_revoke_invite', 'Hub owner only: revoke an agent\'s invite; it is disconnected immediately and cannot rejoin.', z.object({ agentId: z.string() }),
    async ({ agentId }) => text(await admin('DELETE', `/api/invites/${encodeURIComponent(agentId)}`)));
  reg('lan_forget_agent', 'Hub owner only: remove an OFFLINE agent from the hub (drops its queued mail and revokes its invite if it has one). Online agents must be kicked first.', z.object({ agentId: z.string() }),
    async ({ agentId }) => text(await admin('DELETE', `/api/agents/${encodeURIComponent(agentId)}`)));
  reg('lan_kick', 'Hub owner only: disconnect an agent now (it will not auto-reconnect; an invite holder can still rejoin manually until revoked).', z.object({ agentId: z.string() }),
    async ({ agentId }) => text(await admin('POST', `/api/agents/${encodeURIComponent(agentId)}/kick`)));
  reg('lan_list_agents', 'List agents on the home LAN hub (online and offline).', z.object({}), async () => text(await need().list()));
  reg('lan_send', 'Send a message to another agent ("agent-id"), a topic ("#topic"), or everyone ("*").',
    z.object({ to: z.string(), content: z.string(), thread: z.string().optional(), inReplyTo: z.string().optional() }),
    async ({ to, content, thread, inReplyTo }) => text(await need().send(to, content, { thread, inReplyTo })));
  reg('lan_inbox', 'Read and clear messages other agents sent you.', z.object({}), async () => {
    const m = need().drain();
    return text(m.length ? m : 'inbox empty');
  });
  reg('lan_subscribe', 'Subscribe to topics (messages sent to "#topic").', z.object({ topics: z.array(z.string()) }),
    async ({ topics }) => text(await need().subscribe(...topics)));

  return server;
  };
  serveStdio(createServer, { onerror: (e) => console.error('lan-agent-hub mcp:', e) });

  // Startup join: explicit LAH_URL, else the single hub on the LAN. With several hubs, don't guess.
  try {
    if (env.LAH_URL) await connectTo(env.LAH_URL);
    else {
      const hubs = await discoverHubs();
      if (hubs.length === 1 && hubs[0].auth && !env.LAH_TOKEN && !(primary && savedCredential(hubs[0].name, env))) console.error(`lan-agent-hub: found ${hubs[0].name} but no LAH_TOKEN; set it, or call lan_request_join`);
      else if (hubs.length === 1) await connectTo(hubs[0].url, { name: hubs[0].name });
      else console.error(hubs.length ? `lan-agent-hub: ${hubs.length} hubs found, pick one with lan_connect_hub` : 'lan-agent-hub: no hub found; use lan_start_hub or set LAH_URL');
    }
  } catch (e) { console.error('lan-agent-hub: startup connect failed:', e.message); }
}
