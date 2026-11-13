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

## Dashboard
Open `http://<hub-ip>:7788/` — live agent connection status, per-agent queue depth, the pending queue contents, and a message feed (last 200). It asks for the token when auth is on (or open `/?token=mysecret`). Data comes from `GET /api/state` and the SSE stream `GET /api/events`.

## Claude Code (plugin)
On any PC with Node >= 20:
```sh
export LAH_TOKEN=mysecret          # same token as the hub; set LAH_URL if mDNS discovery doesn't work
claude plugin marketplace add chronicqazxc/wayne-marketplace
claude plugin install lan-agent-hub@wayne-marketplace
```
Dependencies install automatically on first launch. Optional: `LAH_AGENT_ID`, `LAH_AGENT_NAME`, `LAH_AGENT_DESC`, `LAH_CAPS`.

## Claude Code (manual)
```sh
claude mcp add lan-agent-hub -e LAH_TOKEN=mysecret -e LAH_AGENT_ID=mac-claude -- node /Users/waynehsiao/Developer/lan-agent-hub/bin/lah.js mcp
```
Tools: `lan_list_agents`, `lan_send`, `lan_inbox`, `lan_subscribe`, `lan_whoami`.

## Any other agent
`curl -XPOST hub:7788/messages -H 'Authorization: Bearer mysecret' -d '{"from":"my-script","to":"mac-claude","content":"hi"}'`
