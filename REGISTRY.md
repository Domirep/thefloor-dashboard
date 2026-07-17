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

## Copy-paste submission content

**awesome-mcp-servers** — easiest path is the GitHub web editor (auto-forks + opens a PR):
open https://github.com/punkpeye/awesome-mcp-servers/edit/main/README.md , find the `### 🎮 Gaming`
section, add this line at the end of it, and title the PR with `🤖🤖🤖` at the end (their fast-track
opt-in for agent PRs):

```
- [The Floor (companion)](https://thefloor-dashboard-production.up.railway.app/mcp) 📇 ☁️ - Unofficial companion to the on-chain strategy game The Floor (Robinhood Chain). Read live desks, alpha, emissions and reinvest-vs-dump analytics; get per-wallet strategy math; and prepare unsigned transactions to join, recruit, upgrade, collect PnL, and swap ETH↔FLOOR. Reads are safe; writes return unsigned calldata for your own signer.
```

**mcp.so / Smithery / Glama form blurb** (reuse for the description field):
> The Floor (companion) — agent-readable and agent-playable data for The Floor, an on-chain strategy
> game on Robinhood Chain. 22 tools: read live desks/alpha/emissions/behavior + per-wallet strategy math;
> prepare unsigned transactions to join, recruit, upgrade, collect, and swap ETH↔FLOOR. Remote
> (streamable HTTP), no install, no keys held. Unofficial companion to thefloor.sh.
> URL: https://thefloor-dashboard-production.up.railway.app/mcp

**Official registry** (needs Go + your GitHub OAuth — see modelcontextprotocol.io/registry/quickstart):
```
mcp-publisher login github     # your GitHub — I can't do this part
mcp-publisher publish          # reads ./server.json from this repo
```

## Keeping it fresh
The tool surface is self-describing via `tools/list`, so registries that re-index stay current on their
own. If `server.json`'s version or description changes, re-run `mcp-publisher publish`.

## What Cyprus is good for here (NOT submission)
Submission is one-shot + needs your auth, so Cyprus doesn't help there. Where it fits: **monitoring** —
poll `/admin/stats` (the `mcp` block: connects/calls/writes/clients) and Telegram-ping when agents start
connecting or when one prepares a real transaction. That's recurring + notification-shaped = Cyprus's lane.
