---
paths:
  - "src/ui.html"
---
# Dashboard rules

- Single self-contained file: no external scripts, fonts, or CDNs (it must work offline on a LAN).
- Build DOM with `textContent`/`createElement`; never `innerHTML` with message or agent data (it is untrusted input from other agents).
- Support light and dark via CSS variables and `prefers-color-scheme`; keep it usable at phone width.
- State arrives as a full snapshot over SSE (`/api/events`); render from the snapshot rather than patching incrementally.
- After UI changes, verify visually against a hub with sample traffic (online + offline agents, queued messages) before committing.
