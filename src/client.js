import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { Bonjour } from 'bonjour-service';
import { makeMessage, SERVICE_TYPE } from './protocol.js';

/** Find a hub on the LAN via mDNS. Resolves to "http://host:port" or null. */
export function discoverHub(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const b = new Bonjour();
    const done = (v) => { clearTimeout(t); browser.stop(); b.destroy(); resolve(v); };
    const browser = b.find({ type: SERVICE_TYPE }, (svc) => {
      const addr = svc.addresses?.find((a) => a.includes('.')) ?? svc.host;
      done(`http://${addr}:${svc.port}`);
    });
    const t = setTimeout(() => done(null), timeoutMs);
  });
}

/**
 * Hub client. Emits: 'message' (envelope), 'presence', 'open', 'close'.
 * Keeps a local `inbox` buffer so pull-style hosts (e.g. MCP tools) can drain it.
 */
export class HubClient extends EventEmitter {
  constructor({ url, token, id, name, kind, description, capabilities = [], subscribe = [] }) {
    super();
    this.url = url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws' + (token ? `?token=${encodeURIComponent(token)}` : '');
    this.agent = { id, name, kind, description, capabilities, subscribe };
    this.inbox = [];
    this.pending = new Map();
    this.reconnect = true;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url));
      let first = true;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', agent: this.agent })));
      ws.on('error', (e) => { if (first) reject(e); });
      ws.on('message', (raw) => {
        const f = JSON.parse(raw);
        if (f.type === 'welcome') { this.agents = f.agents; if (first) { first = false; resolve(f); } this.emit('open', f); }
        else if (f.type === 'message') { this.inbox.push(f); this.emit('message', f); }
        else if (f.type === 'presence') this.emit('presence', f);
        else if ((f.type === 'ack' || f.type === 'agents' || f.type === 'error') && this.pending.has(f.ref)) { this.pending.get(f.ref)(f); this.pending.delete(f.ref); }
      });
      ws.on('close', () => {
        this.emit('close');
        if (this.reconnect && !first) setTimeout(() => this.connect().catch(() => {}), 2000);
        else if (first) reject(new Error('connection closed (bad token or id?)'));
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
