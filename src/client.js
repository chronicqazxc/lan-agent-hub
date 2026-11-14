import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { Bonjour } from 'bonjour-service';
import { makeMessage, SERVICE_TYPE } from './protocol.js';

/** Find all hubs on the LAN via mDNS. Resolves to [{ name, url, auth }] after timeoutMs. */
export function discoverHubs(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const b = new Bonjour();
    const found = new Map();
    const browser = b.find({ type: SERVICE_TYPE }, (svc) => {
      const addr = svc.addresses?.find((a) => a.includes('.')) ?? svc.host;
      const url = `http://${addr}:${svc.port}`;
      const flag = (v) => v === '1' || v === 1;
      found.set(url, { name: svc.name, url, auth: flag(svc.txt?.auth), inviteOnly: flag(svc.txt?.invite) });
    });
    setTimeout(() => { browser.stop(); b.destroy(); resolve([...found.values()]); }, timeoutMs);
  });
}

/** Find a hub on the LAN via mDNS. Resolves to "http://host:port" (first found) or null. */
export async function discoverHub(timeoutMs = 3000) {
  return (await discoverHubs(timeoutMs))[0]?.url ?? null;
}

/**
 * Ask a hub's owner for admission. Resolves to { status:'approved', agentId, code } | { status:'denied' } | { status:'timeout' }.
 * `onPending` is called once the request is registered. Rejects if the hub refuses the request.
 */
export async function requestJoin(url, { agentId, name, timeoutMs = 10 * 60_000, pollMs = 2000, onPending } = {}) {
  const base = url.replace(/\/$/, '');
  const r = await fetch(`${base}/join`, { method: 'POST', body: JSON.stringify({ agentId, name }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status}: ${j.error ?? 'join request refused'}`);
  onPending?.(j);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, pollMs));
    const p = await fetch(`${base}/join/${j.secret}`).catch(() => null);
    if (!p) continue; // hub briefly unreachable
    if (p.status === 404) return { status: 'denied', reason: 'request expired or was removed' };
    const b = await p.json();
    if (b.status !== 'pending') return b;
  }
  return { status: 'timeout' };
}

/**
 * Hub client. Emits: 'message' (envelope), 'presence', 'open', 'close'.
 * Keeps a local `inbox` buffer so pull-style hosts (e.g. MCP tools) can drain it.
 */
export class HubClient extends EventEmitter {
  /** `rediscover` (optional): async () => new hub URL | null, consulted before each reconnect attempt. */
  constructor({ url, token, id, name, kind, description, capabilities = [], subscribe = [], rediscover = null }) {
    super();
    this.token = token;
    this.rediscover = rediscover;
    this.#setUrl(url);
    this.agent = { id, name, kind, description, capabilities, subscribe };
    this.inbox = [];
    this.pending = new Map();
    this.reconnect = true;
  }
  #setUrl(url) {
    this.url = url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws' + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
  }
  #scheduleReconnect() {
    if (!this.reconnect) return;
    setTimeout(async () => {
      if (!this.reconnect) return;
      const u = this.rediscover ? await this.rediscover().catch(() => null) : null;
      if (u) this.#setUrl(u);
      this.connect().catch(() => this.#scheduleReconnect());
    }, 2000);
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url));
      let first = true;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', agent: this.agent })));
      ws.on('error', (e) => {
        if (/\b401\b/.test(e.message)) { this.reconnect = false; this.emit('denied', e); } // bad/revoked credential: stop retrying
        if (first) reject(e);
      });
      ws.on('message', (raw) => {
        const f = JSON.parse(raw);
        if (f.type === 'welcome') { this.agents = f.agents; if (f.agent?.id) this.agent.id = f.agent.id; /* an invite fixes the id */ if (first) { first = false; resolve(f); } this.emit('open', f); }
        else if (f.type === 'message') { this.inbox.push(f); this.emit('message', f); }
        else if (f.type === 'presence') this.emit('presence', f);
        else if ((f.type === 'ack' || f.type === 'agents' || f.type === 'error') && this.pending.has(f.ref)) { this.pending.get(f.ref)(f); this.pending.delete(f.ref); }
      });
      ws.on('close', (code) => {
        if (code === 4001 || code === 4002) { this.reconnect = false; this.emit('denied', new Error(code === 4001 ? 'invite revoked' : 'kicked by hub owner')); }
        this.emit('close');
        if (first) reject(new Error('connection closed (bad token or id?)'));
        else this.#scheduleReconnect();
      });
    });
  }
  #request(frame) {
    frame.id ??= makeMessage({}).id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(frame.id); reject(new Error('timeout')); }, 5000);
      this.pending.set(frame.id, (r) => { clearTimeout(t); resolve(r); });
      this.ws.send(JSON.stringify(frame));
    });
  }
  send(to, content, opts = {}) { return this.#request(makeMessage({ from: this.agent.id, to, content, ...opts })); }
  list() { return this.#request({ type: 'list' }).then((r) => r.agents); }
  subscribe(...topics) { return this.#request({ type: 'subscribe', topics }); }
  drain() { const m = this.inbox; this.inbox = []; return m; }
  close() { this.reconnect = false; this.ws?.close(); }
}
