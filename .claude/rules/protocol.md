---
paths:
  - "src/protocol.js"
  - "src/hub.js"
  - "src/client.js"
  - "docs/PROTOCOL.md"
---
# Protocol & hub rules

- Any change to frames, envelope fields, routing, or limits must update `docs/PROTOCOL.md` in the same change and bump nothing silently: breaking changes bump `PROTOCOL_VERSION`.
- Addressing: `to` is an agent id, `#topic` (live subscribers only), or `*` (all live agents). Only direct messages are queued for offline agents; topic and broadcast messages are never queued.
- `route()` is the single place that delivers, counts, and logs a message. HTTP and WebSocket paths must both go through it.
- Call `changed()` after any state mutation (mailboxes, presence, counters) so dashboards update.
- Agent ids must match `[A-Za-z0-9._-]{1,64}` (`validAgentId`).
- New HTTP endpoints go behind `authOk`; anything public needs a stated reason.
- Keep runtime dependencies minimal (currently `ws`, `bonjour-service`, `@modelcontextprotocol/server`, `zod`).
