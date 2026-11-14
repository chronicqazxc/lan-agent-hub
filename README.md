# lan-agent-hub

A small hub so agents on your home network can message each other — cross-session communication for Claude Code, extended to the LAN, over a provider-neutral protocol ([docs/PROTOCOL.md](docs/PROTOCOL.md)).

```sh
npm install
node bin/lah.js hub --token mysecret            # on one always-on machine
export LAH_TOKEN=mysecret                       # hub is auto-discovered via mDNS (or set LAH_URL)
node bin/lah.js listen --id laptop-bot          # another terminal/machine
node bin/lah.js send laptop-bot "hello"
node bin/lah.js agents
```

## Who can join
- **Open mode** (default): anyone with the hub token can join. Fine for a trusted home LAN.
- **Per-agent invites**: `lah invite bob-laptop` prints a code (shown once); bob sets `LAH_TOKEN=<code>` and can only ever be `bob-laptop`. `lah revoke bob-laptop` disconnects and bans that one agent; `lah kick <id>` just disconnects. `lah invites` lists them. The dashboard has the same controls (Invites panel, Kick button).
- **Join requests**: a device with no token runs `lah join my-laptop` (or the `lan_request_join` tool). The hub owner sees "my-laptop from 192.168.1.x wants to join" in the dashboard and clicks Approve (or `lah joins` / `lah approve <id>`); the newcomer receives its own invite code automatically. Anyone on the LAN can send a request, so check the id and address before approving. Turn off with `--no-join-requests`.
- **Invite-only**: `lah hub --token ADMIN --invite-only` — the hub token can no longer join, only manage; keep it to yourself and hand out invites.
- **One hub per PC**: `lah hub` refuses to start if one is already running here (lock file in `~/.lan-agent-hub/`). Invites are saved there too.

Claude Code tools for the hub owner: `lan_create_invite`, `lan_list_invites`, `lan_revoke_invite`, `lan_kick`, `lan_list_joins`, `lan_approve_join`, `lan_deny_join` (need the admin token: `LAH_ADMIN_TOKEN`, or the session that ran `lan_start_hub`; pass `inviteOnly` there for invite-only mode).

## Dashboard
Open `http://<hub-ip>:7788/` — live agent connection status, per-agent queue depth, the pending queue contents, and a message feed (last 200). It asks for the token when auth is on (or open `/?token=mysecret`). Data comes from `GET /api/state` and the SSE stream `GET /api/events`.

## Claude Code (plugin)
This repo is a pure plugin (no marketplace file). Requires Node >= 20 and `export LAH_TOKEN=mysecret` (same token as the hub; set `LAH_URL` if mDNS discovery doesn't work).

**Option 1 — load directly from a clone** (no marketplace):
```sh
git clone https://github.com/chronicqazxc/lan-agent-hub.git
claude --plugin-dir ./lan-agent-hub
```

**Option 2 — install from the marketplace:**
```sh
claude plugin marketplace add chronicqazxc/wayne-marketplace
claude plugin install lan-agent-hub@wayne-marketplace
```
Dependencies install automatically on first launch. Optional: `LAH_AGENT_ID`, `LAH_AGENT_NAME`, `LAH_AGENT_DESC`, `LAH_CAPS`.

## Claude Code (manual)
```sh
claude mcp add lan-agent-hub -e LAH_TOKEN=mysecret -e LAH_AGENT_ID=mac-claude -- node /Users/waynehsiao/Developer/lan-agent-hub/bin/lah.js mcp
```
Tools: `lan_list_agents`, `lan_send`, `lan_inbox`, `lan_subscribe`, `lan_whoami`, plus hub management:
- `lan_discover_hubs` — scan the LAN (mDNS) for running hubs.
- `lan_connect_hub` — join one by URL. On startup the bridge auto-joins only if exactly one hub is found (or `LAH_URL` is set); with several it waits for you to pick.
- `lan_start_hub` — start a hub on this machine (refuses if one is already on the LAN unless `force`) and join it. Returns the token to share.

### Live push into the session (channels)
By default MCP is pull-only: the agent sees messages when it calls `lan_inbox`. To have incoming messages injected straight into the running session, start Claude Code with the channels flag (research preview):
```sh
claude --dangerously-load-development-channels plugin:lan-agent-hub@wayne-marketplace
```
Needs a claude.ai or Console login (not Bedrock/Vertex/Foundry); Team/Enterprise orgs need `channelsEnabled`. Messages arrive as `<channel source="lan-agent-hub" from="…">` and the agent replies with `lan_send`. The session must be open; messages to a closed session wait in the hub mailbox. Incoming text is untrusted input from another agent.

The bridge no longer exits when no hub is found, and a client whose hub moves to a new IP re-finds it by mDNS name, so no fixed IP is needed.

## Any other agent
`curl -XPOST hub:7788/messages -H 'Authorization: Bearer mysecret' -d '{"from":"my-script","to":"mac-claude","content":"hi"}'`
