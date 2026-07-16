# Listing the MCP on registries

The MCP is at `https://thefloor-dashboard-production.up.railway.app/mcp` (streamable HTTP).
`server.json` in this repo is the manifest for the official registry.

Registry submission is a **one-time authenticated developer action**, not a recurring "post" —
so it's done by hand / CLI, not automated. Effort is ~10–20 min total.

## 1. Official MCP Registry (highest value — source of truth)
Uses `server.json` (already written) + the `mcp-publisher` CLI. Namespace `io.github.domirep/*`
authenticates as GitHub user **Domirep** (no domain/DNS needed).

```
# install the CLI (Go) — see modelcontextprotocol.io/registry/quickstart for the current install line
mcp-publisher login github        # opens GitHub OAuth — YOUR auth, must be done by you
mcp-publisher publish             # reads ./server.json and publishes
```

Only the `login` step needs your personal GitHub auth. Everything else is in `server.json`.

## 2. Smithery (smithery.ai) — the "Docker Hub" of MCP
Add a remote server via their site: New Server → Remote → paste the `/mcp` URL. Account required.

## 3. mcp.so — largest directory
Submit via their "Submit" form with the `/mcp` URL + description (reuse `server.json`'s description).

## 4. awesome-mcp-servers (GitHub)
A one-line PR to `punkpeye/awesome-mcp-servers` under an on-chain/crypto or "remote servers" section.
`gh` CLI can open it directly.

## Keeping it fresh
The tool surface is self-describing via `tools/list`, so registries that re-index stay current on their
own. If `server.json`'s version or description changes, re-run `mcp-publisher publish`.

## What Cyprus is good for here (NOT submission)
Submission is one-shot + needs your auth, so Cyprus doesn't help there. Where it fits: **monitoring** —
poll `/admin/stats` (the `mcp` block: connects/calls/writes/clients) and Telegram-ping when agents start
connecting or when one prepares a real transaction. That's recurring + notification-shaped = Cyprus's lane.
