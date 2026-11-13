// MCP stdio server: lets Claude Code (or any MCP host) join the LAN hub as an agent.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { hostname } from 'node:os';
import { HubClient, discoverHub } from './client.js';

export async function runMcpBridge(env = process.env) {
  const url = env.LAH_URL ?? (await discoverHub());
  if (!url) { console.error('lan-agent-hub: no hub found (set LAH_URL)'); process.exit(1); }
  const id = env.LAH_AGENT_ID ?? `claude-${hostname().split('.')[0]}-${process.pid}`;
  const client = new HubClient({
    url, token: env.LAH_TOKEN, id, name: env.LAH_AGENT_NAME ?? id, kind: 'claude-code',
    description: env.LAH_AGENT_DESC ?? 'Claude Code session',
    capabilities: (env.LAH_CAPS ?? 'chat').split(','),
  });
  await client.connect();

  // serveStdio negotiates per client: spec 2026-07-28 (server/discover) or legacy initialize.
  // It calls this factory repeatedly, so each call must return a fresh McpServer.
  const createServer = () => {
  const server = new McpServer({ name: 'lan-agent-hub', version: '0.1.0' });
  const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });

  const reg = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, fn);
  reg('lan_whoami', 'Your agent id on the LAN hub.', z.object({}), async () => text(client.agent));
  reg('lan_list_agents', 'List agents on the home LAN hub (online and offline).', z.object({}), async () => text(await client.list()));
  reg('lan_send', 'Send a message to another agent ("agent-id"), a topic ("#topic"), or everyone ("*").',
    z.object({ to: z.string(), content: z.string(), thread: z.string().optional(), inReplyTo: z.string().optional() }),
    async ({ to, content, thread, inReplyTo }) => text(await client.send(to, content, { thread, inReplyTo })));
  reg('lan_inbox', 'Read and clear messages other agents sent you.', z.object({}), async () => {
    const m = client.drain();
    return text(m.length ? m : 'inbox empty');
  });
  reg('lan_subscribe', 'Subscribe to topics (messages sent to "#topic").', z.object({ topics: z.array(z.string()) }),
    async ({ topics }) => text(await client.subscribe(...topics)));

  return server;
  };
  serveStdio(createServer, { onerror: (e) => console.error('lan-agent-hub mcp:', e) });
}
