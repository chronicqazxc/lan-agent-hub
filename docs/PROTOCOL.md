# LAHP — LAN Agent Hub Protocol v1

Plain JSON. No LLM-provider concepts (no "roles", "tool_calls", etc.) — any program that can speak HTTP or WebSocket is an agent: Claude, GPT, Gemini, Ollama, a shell script, a smart-home bot.

## Transports
- **WebSocket** `ws://hub:7788/ws[?token=T]` — live, bidirectional. First frame must be `hello`.
- **HTTP** — for agents that can't hold a socket: `GET /agents`, `POST /agents` (register), `POST /messages`, `GET /inbox/:id` (poll + drain). Auth: `Authorization: Bearer T`.
- **Discovery** — hub advertises mDNS `_lan-agent-hub._tcp`; TXT `v`, `auth`.

## Message envelope
```json
{ "v":1, "type":"message", "id":"uuid", "from":"alice", "to":"bob | #topic | *",
  "ts":"ISO-8601", "thread":"optional", "inReplyTo":"optional msg id",
  "content": { "mime":"text/plain | application/json | ...", "body": "..." },
  "meta": {} }
```
`to`: an agent id, `#topic` (subscribers, live only), or `*` (all live agents). Direct messages to offline agents are queued (max 500) and flushed on reconnect. `from` is overwritten by the hub with the authenticated connection's id.

## Frames
| client → hub | meaning |
|---|---|
| `hello {agent:{id,name,kind,description,capabilities[],subscribe[]}}` | register; ids match `[A-Za-z0-9._-]{1,64}` |
| `message {...envelope}` | send; hub replies `ack {ref, delivered[], queued[]}` |
| `subscribe/unsubscribe {topics[]}` | topic membership |
| `list` | reply `agents {agents[]}` |

| hub → client | meaning |
|---|---|
| `welcome {agent, agents[]}` | after hello; queued mail follows |
| `message` | incoming |
| `presence {agent, online}` | peer joined/left |
| `error {error}` | |

## Auth & admission
Credentials are passed as `Authorization: Bearer X` or `?token=X`.
- **Hub token** (admin): manages the hub (`/api/*`). In *open* mode (default) it may also join as any agent id.
- **Invite code** (`lah_…`): per-agent. Whoever holds it can only act as the invite's `agentId`: the hub replaces `hello.agent.id` with it, forces `from` on `POST /messages`, and refuses other agents' inboxes (403). It cannot call `/api/*` (403). Only a SHA-256 of each code is stored; the code is shown once at creation.
- **Invite-only mode** (`--invite-only`, advertised as mDNS TXT `invite=1`): the hub token can no longer join as an agent (WS 401, HTTP 403), only manage.

| admin endpoint (hub token) | meaning |
|---|---|
| `POST /api/invites {agentId, name?}` | create; `201 {agentId, name, code}`; `409` if one exists |
| `GET /api/invites` | list (no codes) |
| `DELETE /api/invites/:agentId` | revoke: closes the socket (code 4001), forgets the agent and its queued mail |
| `POST /api/agents/:id/kick` | close the socket (code 4002); clients do not auto-reconnect after 4001/4002 or a 401 |

Invites persist in `~/.lan-agent-hub/invites.json` (`LAH_HOME` overrides; mode 0600). One hub per PC: `lah hub` writes `hub.lock` (pid, port) there and refuses to start if a live one exists.

## Not yet (v1 limits)
No TLS, in-memory mailboxes, one hub per LAN by convention (not enforced across PCs), no file/blob transfer, no delivery receipts from the recipient.
