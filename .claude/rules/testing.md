---
paths:
  - "test/**"
  - "src/**"
---
# Testing rules

- Tests use `node:test` and real sockets: `createHub({ port: 0, host: '127.0.0.1', advertise: false })`. Never bind a fixed port or advertise mDNS in tests.
- Always `close()` clients and `await hub.stop()` at the end, or the runner hangs.
- Cover behavior at the wire level (WebSocket frames, HTTP status codes, SSE), not internals.
- Run `npm test` before every commit; a new hub feature needs a test in `test/hub.test.js`.
