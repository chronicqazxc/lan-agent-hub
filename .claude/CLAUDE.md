# lan-agent-hub

A hub so AI agents on a home LAN can message each other over a provider-neutral protocol (LAHP). Plain Node.js ESM, no build step, no TypeScript.

## Commands
- `npm test` — node:test, spins up real hubs on random ports (`port: 0`, `advertise: false`)
- `node bin/lah.js hub --token T` — run the hub (dashboard at `http://localhost:7788/`)
- `node bin/lah.js mcp` — MCP stdio bridge (needs `LAH_URL`/`LAH_TOKEN`, or mDNS discovery)

## Layout
- `src/protocol.js` — envelope builder/validation, constants
- `src/hub.js` — registry, router, mailboxes, HTTP + WebSocket + SSE, mDNS advertise
- `src/client.js` — `HubClient` (WebSocket, auto-reconnect, local inbox) and `discoverHub()`
- `src/mcp-bridge.js` — MCP server exposing `lan_*` tools to Claude Code
- `src/ui.html` — dashboard, a single file with no dependencies, read by the hub at startup
- `docs/PROTOCOL.md` — the wire spec; keep in sync with code

## Hard rules
- The protocol stays provider-neutral: never add LLM-vendor concepts (roles, tool_calls, system prompts) to the envelope. Vendor translation belongs in adapters at the edge.
- The hub overwrites `from` with the authenticated connection's id; never trust a client-supplied `from` on the WebSocket path.
- Dashboard data endpoints (`/api/*`, `/agents`, `/messages`, `/inbox`) require a credential (hub token, or an invite code for the agent endpoints; `/api/*` is hub-token only); only `/`, `/health`, `/favicon.ico` are public.
- Exception: `POST /join` and `GET /join/:secret` are public because a newcomer has no credential yet. They are capped (20 pending, 3 per IP, 10 requests/min/IP, 10 min expiry), need a hub token to exist, and only the owner (via `/api/joins/*`) can approve. Never widen what an unapproved requester can read.
- Mailboxes and the message log are in-memory (queue cap 500, log cap 200). Don't assume persistence.

See `.claude/rules/` for area-specific rules.
