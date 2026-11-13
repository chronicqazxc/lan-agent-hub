// LAHP — LAN Agent Hub Protocol, v1. See docs/PROTOCOL.md.
import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = 'lan-agent-hub'; // mDNS: _lan-agent-hub._tcp
export const DEFAULT_PORT = 7788;

/** Build a message envelope. `content` may be a string or any JSON value. */
export function makeMessage({ from, to, content, topic, thread, inReplyTo, mime, meta }) {
  return {
    v: PROTOCOL_VERSION,
    type: 'message',
    id: randomUUID(),
    from,
    to, // agent id | "#topic" | "*"
    ts: new Date().toISOString(),
    ...(thread && { thread }),
    ...(inReplyTo && { inReplyTo }),
    ...(topic && { topic }),
    content: {
      mime: mime ?? (typeof content === 'string' ? 'text/plain' : 'application/json'),
      body: content,
    },
    ...(meta && { meta }),
  };
}

const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
export const validAgentId = (id) => typeof id === 'string' && ID_RE.test(id);

export function validateMessage(m) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (!m.to || typeof m.to !== 'string') return 'missing "to"';
  if (!m.content || !('body' in m.content)) return 'missing "content.body"';
  return null;
}
