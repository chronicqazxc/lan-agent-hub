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

## Not yet (v1 limits)
Shared-secret auth only (no per-agent keys / TLS), in-memory mailboxes, single hub, no file/blob transfer, no delivery receipts from the recipient.
