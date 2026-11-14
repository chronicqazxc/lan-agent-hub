---
paths:
  - "src/mcp-bridge.js"
---
# MCP bridge rules

- Use `@modelcontextprotocol/server` (v2) and start with `serveStdio(createServer)`. Do NOT use `server.connect(new StdioServerTransport())` — it only serves 2025-era clients and skips `server/discover` (spec 2026-07-28).
- `createServer` is called repeatedly (including for discarded discover probes) and must return a fresh `McpServer` each time. Share state (the single `HubClient`) via closure outside the factory.
- Register tools with `registerTool` and `z.object(...)` schemas (zod 4). Never write to stdout from this process — stdout is the protocol channel; log to stderr.
- Verify changes against both clients: legacy `initialize` handshake and a 2026-07-28 `server/discover` call carrying `io.modelcontextprotocol/{protocolVersion,clientCapabilities,clientInfo}` in `_meta`.
- Push routes (`push()` in the bridge, `LAH_PUSH=auto|socket|channel|both|off`): `socket` writes `{"type":"auth",token}` + `{"type":"user","message":{role,content}}` NDJSON to `CLAUDE_CODE_MESSAGING_SOCKET` (own session's inbox; undocumented frame from anthropics/claude-code#93720, verified on a real session in v0.6.0 work, may change); `channel` emits `notifications/claude/channel` and only works when Claude Code is launched with `--dangerously-load-development-channels plugin:lan-agent-hub@wayne-marketplace`. `auto` = socket if the env var exists, else channel. Never send both by default (duplicates). Messages always stay in the inbox, so never claim push is guaranteed.
- `.mcp.json` sets `MCP_PROTOCOL_NEGOTIATION=legacy`: a server that negotiates 2026-07-28 is silently NOT registered as a channel (only matters for the channel route). Keep the legacy handshake working.
- Channel `instructions` treat hub-authenticated senders as the user's own delegated agents (do the work, don't refuse for being from another agent) but require asking the user before destructive/sensitive actions. No per-id trust list on purpose: devices change. Only push messages that came through the hub (it overwrites `from`).
- Identity: default id is `claude-<hostname>` (no pid) so restarts are the same agent; `claimAgentId` (src/lock.js) allows one live session per id per PC, because two sessions with one id kick each other (hub closes the older with 4000, which the client treats as terminal). Approved invite codes are saved in `~/.lan-agent-hub/credentials.json` and saved under both the hub name and its URL (with the URL, so startup can reconnect when mDNS finds nothing), and only used by the primary session. A lost code is recovered by the owner's reissue (`POST /api/invites/:id/reissue`), never by a join request for an existing id. Empty-string env vars must count as unset (`||`, not `??`).
