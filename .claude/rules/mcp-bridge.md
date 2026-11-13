---
paths:
  - "src/mcp-bridge.js"
---
# MCP bridge rules

- Use `@modelcontextprotocol/server` (v2) and start with `serveStdio(createServer)`. Do NOT use `server.connect(new StdioServerTransport())` — it only serves 2025-era clients and skips `server/discover` (spec 2026-07-28).
- `createServer` is called repeatedly (including for discarded discover probes) and must return a fresh `McpServer` each time. Share state (the single `HubClient`) via closure outside the factory.
- Register tools with `registerTool` and `z.object(...)` schemas (zod 4). Never write to stdout from this process — stdout is the protocol channel; log to stderr.
- Verify changes against both clients: legacy `initialize` handshake and a 2026-07-28 `server/discover` call carrying `io.modelcontextprotocol/{protocolVersion,clientCapabilities,clientInfo}` in `_meta`.
- MCP is pull-based: new messages are only seen when the model calls `lan_inbox`. Don't claim push delivery.
