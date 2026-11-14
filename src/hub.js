import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Bonjour } from 'bonjour-service';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

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
export function createHub({ port = DEFAULT_PORT, host = '0.0.0.0', token = null, advertise = true, inviteOnly = false, invitesFile = null, joinRequests = true, joinTtlMs = 10 * 60_000, log = () => {} } = {}) {
  inviteOnly = inviteOnly && !!token; // without a token there is nothing to restrict
  joinRequests = joinRequests && !!token;
  /** @type {Map<string, {info:object, ws:import('ws').WebSocket|null, lastSeen:number, topics:Set<string>}>} */
  const agents = new Map();
  /** @type {Map<string, object[]>} offline/HTTP mailboxes */
  const mailboxes = new Map();

  /** recent routed messages, newest last */
  const log_ = [];
  const sseClients = new Set();
  const startedAt = Date.now();

  // ---- invites: per-agent credentials. The admin `token` manages them; an invite code only lets
  // its holder act as one agent id. Only a SHA-256 of each code is stored (shown once at creation).
  const hashCode = (c) => createHash('sha256').update(c).digest('hex');
  /** @type {Map<string,{agentId:string,name:string,hash:string,createdAt:string,lastUsedAt:string|null}>} by agentId */
  const invites = new Map();
  /** @type {Map<string,object>} by code hash */
  const inviteByHash = new Map();
  if (invitesFile && existsSync(invitesFile)) {
    try { for (const i of JSON.parse(readFileSync(invitesFile, 'utf8'))) { invites.set(i.agentId, i); inviteByHash.set(i.hash, i); } }
    catch (e) { log(`could not read ${invitesFile}: ${e.message}`); }
  }
  const saveInvites = () => {
    if (!invitesFile) return;
    mkdirSync(dirname(invitesFile), { recursive: true });
    writeFileSync(invitesFile, JSON.stringify([...invites.values()], null, 2), { mode: 0o600 });
  };

  // ---- join requests: an unauthenticated device asks to join; the owner approves from the dashboard/CLI,
  // which mints an invite and hands the code back to the waiting requester exactly once.
  const MAX_PENDING = 20, MAX_PENDING_PER_IP = 3, RATE_PER_MIN = 10;
  /** @type {Map<string,{id:string,secret:string,agentId:string,name:string,ip:string,createdAt:number,status:'pending'|'approved'|'denied',code?:string}>} by public id */
  const joins = new Map();
  const rate = new Map(); // ip -> request timestamps
  const joinBySecret = (secret) => [...joins.values()].find((j) => j.secret === secret);
  const sweepJoins = () => { let n = 0; for (const [k, j] of joins) if (Date.now() - j.createdAt > joinTtlMs) { joins.delete(k); n++; } if (n) changed(); };
  const rateLimited = (ip) => {
    const now = Date.now(); const t = (rate.get(ip) ?? []).filter((x) => now - x < 60_000);
    t.push(now); rate.set(ip, t);
    if (rate.size > 500) for (const [k, v] of rate) if (!v.some((x) => now - x < 60_000)) rate.delete(k);
    return t.length > RATE_PER_MIN;
  };
  const mintInvite = (agentId, name) => {
    const code = 'lah_' + randomBytes(18).toString('base64url');
    const inv = { agentId, name: String(name ?? agentId).slice(0, 80), hash: hashCode(code), createdAt: new Date().toISOString(), lastUsedAt: null };
    invites.set(agentId, inv); inviteByHash.set(inv.hash, inv); saveInvites(); changed();
    return { inv, code };
  };
  const publicJoin = (j) => ({ id: j.id, agentId: j.agentId, name: j.name, ip: j.ip, createdAt: new Date(j.createdAt).toISOString() });
  const publicInvite = (i) => ({ agentId: i.agentId, name: i.name, createdAt: i.createdAt, lastUsedAt: i.lastUsedAt });
  let timer = null;

  const preview = (m) => { const b = m.content?.body; const t = typeof b === 'string' ? b : JSON.stringify(b); return t.length > 160 ? t.slice(0, 160) + '…' : t; };
  const pendingIds = () => new Set([...mailboxes.values()].flat().map((m) => m.id));

  function state() {
    sweepJoins();
    const pend = pendingIds();
    return {
      now: new Date().toISOString(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), auth: !!token, inviteOnly, v: PROTOCOL_VERSION,
      invites: [...invites.values()].map(publicInvite), joinRequests,
      joins: [...joins.values()].filter((j) => j.status === 'pending').map(publicJoin),
      agents: [...agents.values()].map((a) => ({
        ...publicAgent(a), invited: invites.has(a.info.id),
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

  /** Who is calling? null = rejected; {role:'admin'} = hub token (or no auth); {role:'agent', agentId} = invite code. */
  const identify = (req, url) => {
    if (!token) return { role: 'admin' };
    const h = req.headers.authorization;
    for (const c of [h?.startsWith('Bearer ') ? h.slice(7) : null, url.searchParams.get('token')]) {
      if (!c) continue;
      if (c === token) return { role: 'admin' };
      const inv = inviteByHash.get(hashCode(c));
      if (inv) return { role: 'agent', agentId: inv.agentId, invite: inv };
    }
    return null;
  };
  /** May this caller send/receive as agent `id`? Invite holders only as themselves; the hub token not at all when inviteOnly. */
  const canActAs = (cred, id) => (cred.role === 'agent' ? cred.agentId === id : !inviteOnly);

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
  const readBody = (req, max = 1e6) => new Promise((res, rej) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
  });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(UI_HTML); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/health') return json(res, 200, { ok: true, v: PROTOCOL_VERSION });
    // Public on purpose: a newcomer has no credential yet. Guarded by caps, rate limits, expiry, and an unguessable poll secret.
    if (url.pathname === '/join' || url.pathname.startsWith('/join/')) {
      if (!joinRequests) return json(res, 404, { error: 'join requests are disabled on this hub' });
      sweepJoins();
      try {
        if (req.method === 'POST' && url.pathname === '/join') {
          const ip = req.socket.remoteAddress ?? '?';
          if (rateLimited(ip)) return json(res, 429, { error: 'too many requests' });
          const b = await readBody(req, 2000);
          if (!validAgentId(b.agentId)) return json(res, 400, { error: 'bad agent id' });
          if (invites.has(b.agentId) || agents.has(b.agentId)) return json(res, 409, { error: 'that agent id is already taken; pick another' });
          if ([...joins.values()].some((j) => j.agentId === b.agentId)) return json(res, 409, { error: 'a request for that agent id is already pending' });
          const mine = [...joins.values()].filter((j) => j.ip === ip && j.status === 'pending').length;
          if (joins.size >= MAX_PENDING || mine >= MAX_PENDING_PER_IP) return json(res, 429, { error: 'too many pending requests' });
          const j = { id: randomBytes(4).toString('hex'), secret: randomBytes(18).toString('base64url'), agentId: b.agentId, name: String(b.name ?? b.agentId).slice(0, 80), ip, createdAt: Date.now(), status: 'pending' };
          joins.set(j.id, j); changed(); log(`join request ${j.id}: ${j.agentId} from ${ip}`);
          return json(res, 202, { secret: j.secret, status: 'pending', expiresInSec: Math.round(joinTtlMs / 1000) });
        }
        const jm = url.pathname.match(/^\/join\/([^/]+)$/);
        if (req.method === 'GET' && jm) { // poll; an approved code is handed over once, then forgotten
          const j = joinBySecret(jm[1]);
          if (!j) return json(res, 404, { error: 'unknown or expired request' });
          if (j.status === 'pending') return json(res, 200, { status: 'pending' });
          joins.delete(j.id); changed();
          return json(res, 200, j.status === 'approved' ? { status: 'approved', agentId: j.agentId, code: j.code } : { status: 'denied' });
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
    }
    const cred = identify(req, url);
    if (!cred) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname.startsWith('/api/') && cred.role !== 'admin') return json(res, 403, { error: 'admin token required' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/invites') return json(res, 200, [...invites.values()].map(publicInvite));
      if (req.method === 'POST' && url.pathname === '/api/invites') {
        if (!token) return json(res, 400, { error: 'invites need a hub token (start the hub with --token)' });
        const body = await readBody(req);
        if (!validAgentId(body.agentId)) return json(res, 400, { error: 'bad agent id' });
        if (invites.has(body.agentId)) return json(res, 409, { error: 'an invite for this agent already exists; revoke it first' });
        const { inv, code } = mintInvite(body.agentId, body.name);
        log(`invite created for ${inv.agentId}`);
        return json(res, 201, { ...publicInvite(inv), code });
      }
      if (req.method === 'GET' && url.pathname === '/api/joins') sweepJoins();
      if (req.method === 'GET' && url.pathname === '/api/joins') return json(res, 200, [...joins.values()].filter((j) => j.status === 'pending').map(publicJoin));
      let m2 = url.pathname.match(/^\/api\/joins\/([^/]+)\/(approve|deny)$/);
      if (req.method === 'POST' && m2) {
        sweepJoins();
        const j = joins.get(m2[1]);
        if (!j || j.status !== 'pending') return json(res, 404, { error: 'no such pending request (expired?)' });
        if (m2[2] === 'deny') { j.status = 'denied'; changed(); return json(res, 200, { ok: true }); }
        if (invites.has(j.agentId) || agents.has(j.agentId)) { joins.delete(j.id); changed(); return json(res, 409, { error: 'that agent id was taken meanwhile' }); }
        const { code } = mintInvite(j.agentId, j.name);
        j.status = 'approved'; j.code = code; changed(); log(`join request ${j.id} approved: ${j.agentId}`);
        return json(res, 200, { ok: true, agentId: j.agentId });
      }
      m2 = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
      if (req.method === 'DELETE' && m2) { // revoke: disconnect, forget the agent, drop its queued mail
        const id = decodeURIComponent(m2[1]); const inv = invites.get(id);
        if (!inv) return json(res, 404, { error: 'no such invite' });
        invites.delete(id); inviteByHash.delete(inv.hash); saveInvites();
        const rec = agents.get(id);
        if (rec) { const ws = rec.ws; rec.ws = null; broadcastPresence(id, false); agents.delete(id); mailboxes.delete(id); ws?.close(4001, 'invite revoked'); }
        changed(); log(`invite revoked for ${id}`);
        return json(res, 200, { ok: true });
      }
      m2 = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (req.method === 'DELETE' && m2) { // forget an OFFLINE agent: drop its record and queued mail, and revoke its invite if it has one
        const id = decodeURIComponent(m2[1]); const rec = agents.get(id); const inv = invites.get(id);
        if (!rec && !inv) return json(res, 404, { error: 'unknown agent' });
        if (rec?.ws) return json(res, 409, { error: 'agent is online; kick it first' });
        if (inv) { invites.delete(id); inviteByHash.delete(inv.hash); saveInvites(); }
        agents.delete(id); mailboxes.delete(id); changed(); log(`forgot ${id}${inv ? ' (invite revoked)' : ''}`);
        return json(res, 200, { ok: true, revokedInvite: !!inv });
      }
      m2 = url.pathname.match(/^\/api\/agents\/([^/]+)\/kick$/);
      if (req.method === 'POST' && m2) { // disconnect only; with a shared token the agent may reconnect, an invite holder too until revoked
        const rec = agents.get(decodeURIComponent(m2[1]));
        if (!rec) return json(res, 404, { error: 'unknown agent' });
        const was = !!rec.ws; rec.ws?.close(4002, 'kicked by hub owner');
        return json(res, 200, { ok: true, wasOnline: was });
      }
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
        if (!canActAs(cred, info.id)) return json(res, 403, { error: 'not allowed to act as this agent' });
        register(info, null); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const body = await readBody(req);
        const msg = body.type === 'message' ? body : makeMessage({ from: body.from, to: body.to, content: body.content, topic: body.topic, thread: body.thread, inReplyTo: body.inReplyTo });
        if (cred.role === 'agent') msg.from = cred.agentId; // invite holders can only speak as themselves
        if (!validAgentId(msg.from)) return json(res, 400, { error: 'bad "from"' });
        if (!canActAs(cred, msg.from)) return json(res, 403, { error: 'hub is invite-only: use an invite code to act as an agent' });
        const err = validateMessage(msg); if (err) return json(res, 400, { error: err });
        const r = route(msg);
        if (r.unknown) return json(res, 404, { error: 'unknown recipient', ...r });
        return json(res, 202, { id: msg.id, ...r });
      }
      const m = url.pathname.match(/^\/inbox\/([^/]+)$/);
      if (req.method === 'GET' && m) { // poll & drain
        const id = decodeURIComponent(m[1]);
        if (!canActAs(cred, id)) return json(res, 403, { error: 'not allowed to read this inbox' });
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
    const cred = url.pathname === '/ws' ? identify(req, url) : null;
    if (!cred || (cred.role === 'admin' && inviteOnly)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, cred));
  });

  wss.on('connection', (ws, cred) => {
    let id = null;
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw); } catch { return send({ type: 'error', error: 'invalid JSON' }); }
      if (!id) {
        if (f.type !== 'hello' || !f.agent || (cred.role !== 'agent' && !validAgentId(f.agent.id))) { send({ type: 'error', error: 'first frame must be hello with valid agent.id' }); return ws.close(); }
        if (cred.role === 'agent') { // an invite fixes the identity; whatever id the client asked for is replaced
          f.agent.id = cred.agentId; cred.invite.lastUsedAt = new Date().toISOString(); saveInvites();
        }
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
        bonjour.publish({ name: `lan-agent-hub@${hostname()}`, type: SERVICE_TYPE, port: actual, txt: { v: String(PROTOCOL_VERSION), auth: token ? '1' : '0', invite: inviteOnly ? '1' : '0', join: joinRequests ? '1' : '0' } });
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
