import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Bonjour } from 'bonjour-service';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';

const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
const LOG_MAX = 200;
import {
  PROTOCOL_VERSION, SERVICE_TYPE, DEFAULT_PORT,
  makeMessage, validAgentId, validateMessage,
} from './protocol.js';

const MAX_QUEUE = 500;

/**
 * Central hub: registry + router + offline mailboxes.
 * Agents connect via WebSocket (live) or plain HTTP (poll/POST) — no LLM-specific format anywhere.
 */
export function createHub({ port = DEFAULT_PORT, host = '0.0.0.0', token = null, advertise = true, log = () => {} } = {}) {
  /** @type {Map<string, {info:object, ws:import('ws').WebSocket|null, lastSeen:number, topics:Set<string>}>} */
  const agents = new Map();
  /** @type {Map<string, object[]>} offline/HTTP mailboxes */
  const mailboxes = new Map();

  /** recent routed messages, newest last */
  const log_ = [];
  const sseClients = new Set();
  const startedAt = Date.now();
  let timer = null;

  const preview = (m) => { const b = m.content?.body; const t = typeof b === 'string' ? b : JSON.stringify(b); return t.length > 160 ? t.slice(0, 160) + '…' : t; };
  const pendingIds = () => new Set([...mailboxes.values()].flat().map((m) => m.id));

  function state() {
    const pend = pendingIds();
    return {
      now: new Date().toISOString(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), auth: !!token, v: PROTOCOL_VERSION,
      agents: [...agents.values()].map((a) => ({
        ...publicAgent(a),
        connectedAt: a.connectedAt ? new Date(a.connectedAt).toISOString() : null,
        sent: a.sent ?? 0, received: a.received ?? 0,
        queue: (mailboxes.get(a.info.id) ?? []).map((m) => ({ id: m.id, from: m.from, ts: m.ts, preview: preview(m) })),
      })),
      messages: log_.map((e) => ({ ...e, status: e.unknown ? 'unknown' : e.direct ? (pend.has(e.id) ? 'queued' : e.delivered.length ? 'delivered' : 'flushed') : e.delivered.length ? 'delivered' : 'no-listeners' })),
    };
  }
  /** debounced push of full state to dashboards */
  function changed() {
    if (!sseClients.size || timer) return;
    timer = setTimeout(() => { timer = null; const d = `data: ${JSON.stringify(state())}\n\n`; for (const r of sseClients) r.write(d); }, 40);
  }

  const authOk = (req, url) => {
    if (!token) return true;
    const h = req.headers.authorization;
    return h === `Bearer ${token}` || url.searchParams.get('token') === token;
  };

  const publicAgent = (a) => ({ ...a.info, online: !!a.ws, topics: [...a.topics], lastSeen: new Date(a.lastSeen).toISOString() });
  const listAgents = () => [...agents.values()].map(publicAgent);

  function enqueue(id, msg) {
    const q = mailboxes.get(id) ?? [];
    q.push(msg);
    if (q.length > MAX_QUEUE) q.shift();
    mailboxes.set(id, q);
    changed();
  }

  function deliverTo(id, msg) {
    const a = agents.get(id);
    if (a?.ws?.readyState === 1) a.ws.send(JSON.stringify(msg));
    else enqueue(id, msg);
  }

  /** Route a message; returns {delivered: string[], queued: string[]}. */
  function route(msg) {
    const out = { delivered: [], queued: [] };
    let targets;
    if (msg.to === '*') targets = [...agents.keys()].filter((id) => id !== msg.from);
    else if (msg.to.startsWith('#')) {
      const t = msg.to.slice(1);
      targets = [...agents].filter(([id, a]) => id !== msg.from && a.topics.has(t)).map(([id]) => id);
    } else targets = [msg.to];

    for (const id of targets) {
      if (msg.to === '*' || msg.to.startsWith('#')) {
        // broadcasts/topics: live agents only, don't pile up mailboxes
        const a = agents.get(id);
        if (a?.ws?.readyState === 1) { a.ws.send(JSON.stringify(msg)); out.delivered.push(id); }
      } else {
        if (!agents.has(id)) { out.unknown = true; continue; }
        const live = agents.get(id).ws?.readyState === 1;
        deliverTo(id, msg);
        (live ? out.delivered : out.queued).push(id);
      }
    }
    const sender = agents.get(msg.from); if (sender) sender.sent = (sender.sent ?? 0) + 1;
    for (const id of [...out.delivered, ...out.queued]) { const r = agents.get(id); if (r && out.delivered.includes(id)) r.received = (r.received ?? 0) + 1; }
    log_.push({ id: msg.id, ts: msg.ts, from: msg.from, to: msg.to, mime: msg.content?.mime, preview: preview(msg), direct: !msg.to.startsWith('#') && msg.to !== '*', ...out });
    if (log_.length > LOG_MAX) log_.shift();
    changed();
    return out;
  }

  function broadcastPresence(agentId, online) {
    const evt = { v: PROTOCOL_VERSION, type: 'presence', agent: agents.get(agentId) ? publicAgent(agents.get(agentId)) : { id: agentId }, online };
    for (const [id, a] of agents) if (id !== agentId && a.ws?.readyState === 1) a.ws.send(JSON.stringify(evt));
    changed();
  }

  function register(info, ws) {
    const existing = agents.get(info.id);
    if (existing?.ws && existing.ws !== ws) existing.ws.close(4000, 'replaced by new connection');
    const rec = existing ?? { info, ws: null, lastSeen: 0, topics: new Set() };
    rec.info = { id: info.id, name: info.name ?? info.id, kind: info.kind ?? 'agent', capabilities: info.capabilities ?? [], description: info.description ?? '' };
    rec.ws = ws;
    if (ws) rec.connectedAt = Date.now();
    rec.lastSeen = Date.now();
    for (const t of info.subscribe ?? []) rec.topics.add(t);
    agents.set(info.id, rec);
    return rec;
  }

  // ---------- HTTP (works for any agent, even curl) ----------
  const readBody = (req) => new Promise((res, rej) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
  });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(UI_HTML); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/health') return json(res, 200, { ok: true, v: PROTOCOL_VERSION });
    if (!authOk(req, url)) return json(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/agents') return json(res, 200, listAgents());
      if (req.method === 'POST' && url.pathname === '/agents') { // HTTP-only agents register here
        const info = await readBody(req);
        if (!validAgentId(info.id)) return json(res, 400, { error: 'bad agent id' });
        register(info, null); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const body = await readBody(req);
        const msg = body.type === 'message' ? body : makeMessage({ from: body.from, to: body.to, content: body.content, topic: body.topic, thread: body.thread, inReplyTo: body.inReplyTo });
        if (!validAgentId(msg.from)) return json(res, 400, { error: 'bad "from"' });
        const err = validateMessage(msg); if (err) return json(res, 400, { error: err });
        const r = route(msg);
        if (r.unknown) return json(res, 404, { error: 'unknown recipient', ...r });
        return json(res, 202, { id: msg.id, ...r });
      }
      const m = url.pathname.match(/^\/inbox\/([^/]+)$/);
      if (req.method === 'GET' && m) { // poll & drain
        const id = decodeURIComponent(m[1]);
        const a = agents.get(id); if (a) a.lastSeen = Date.now();
        const q = mailboxes.get(id) ?? []; mailboxes.set(id, []);
        if (a) a.received = (a.received ?? 0) + q.length;
        changed();
        return json(res, 200, q);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: String(e.message ?? e) }); }
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !authOk(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    let id = null;
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw); } catch { return send({ type: 'error', error: 'invalid JSON' }); }
      if (!id) {
        if (f.type !== 'hello' || !validAgentId(f.agent?.id)) { send({ type: 'error', error: 'first frame must be hello with valid agent.id' }); return ws.close(); }
        id = f.agent.id;
        const rec = register({ ...f.agent }, ws);
        log(`+ ${id} connected`);
        send({ v: PROTOCOL_VERSION, type: 'welcome', agent: publicAgent(rec), agents: listAgents() });
        for (const m of mailboxes.get(id) ?? []) send(m); // flush offline mail
        for (const m of mailboxes.get(id) ?? []) rec.received = (rec.received ?? 0) + 1;
        mailboxes.set(id, []);
        return broadcastPresence(id, true);
      }
      const rec = agents.get(id); rec.lastSeen = Date.now();
      switch (f.type) {
        case 'message': {
          f.from = id; f.id ??= makeMessage({}).id; f.ts ??= new Date().toISOString(); f.v = PROTOCOL_VERSION;
          const err = validateMessage(f); if (err) return send({ type: 'error', ref: f.id, error: err });
          const r = route(f);
          return send({ type: 'ack', ref: f.id, ...r, ...(r.unknown && { error: 'unknown recipient' }) });
        }
        case 'subscribe': (f.topics ?? []).forEach((t) => rec.topics.add(t)); return send({ type: 'ack', ref: f.id, topics: [...rec.topics] });
        case 'unsubscribe': (f.topics ?? []).forEach((t) => rec.topics.delete(t)); return send({ type: 'ack', ref: f.id, topics: [...rec.topics] });
        case 'list': return send({ type: 'agents', ref: f.id, agents: listAgents() });
        case 'ping': return send({ type: 'pong' });
        default: return send({ type: 'error', error: `unknown type ${f.type}` });
      }
    });
    ws.on('close', () => {
      if (!id) return;
      const rec = agents.get(id);
      if (rec && rec.ws === ws) { rec.ws = null; rec.lastSeen = Date.now(); log(`- ${id} disconnected`); broadcastPresence(id, false); }
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 15000);
  hb.unref();

  let bonjour;
  return {
    agents, route,
    start: () => new Promise((resolve) => server.listen(port, host, () => {
      const actual = server.address().port;
      if (advertise) {
        bonjour = new Bonjour();
        bonjour.publish({ name: `lan-agent-hub@${hostname()}`, type: SERVICE_TYPE, port: actual, txt: { v: String(PROTOCOL_VERSION), auth: token ? '1' : '0' } });
      }
      resolve(actual);
    })),
    stop: () => new Promise((resolve) => {
      clearInterval(hb); for (const r of sseClients) r.end(); bonjour?.unpublishAll(() => bonjour.destroy());
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
    }),
  };
}
