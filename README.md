# The Floor — companion dashboard + MCP

An **unofficial, community-built** companion for games on [Robinhood Chain](https://robinhood.com/us/en/chain/):
**The Floor** (`thefloor.sh`) and **StonkBrokers** (Clutch Markets). It is a live analytics dashboard
for humans and a **Model Context Protocol (MCP) server** for AI agents, reading everything straight
from the chain's verified contracts.

Not affiliated with The Floor, Clutch Markets, StonkBrokers, or Robinhood. The games' own sites and
contracts are the source of truth. Nothing here is an appraisal or financial advice.

**Live:** https://thefloor-dashboard-production.up.railway.app
· dashboard `/` · brokers `/brokers` · how-to `/play` · agent endpoint `/mcp`

## For agents (MCP)

Point an MCP client at the endpoint and ask about either game in plain language:

```
claude mcp add --transport http the-floor https://thefloor-dashboard-production.up.railway.app/mcp
```

Also machine-readable: `/llms.txt` (orientation), `/api` (discovery index), `/api/summary` (one-call state).

### What it can do — every action is one of two kinds

The authoritative, always-current list is the MCP `tools/list` call. By category:

- **Read tools** (`get_*`, `list_*`) — cached public chain data: token/game state, a wallet's desk and
  earnings, leaderboards, behavior splits, firms, history, live actions, swap info, and the
  StonkBrokers collection (broker wallets, activation math, dividends, contents leaderboard).
  Read-only, safe to call.
- **Write tools** (`prepare_*`) — build an **UNSIGNED** transaction (`{to, value, data}`) for **your**
  wallet to sign. They cover: opening/upgrading a desk, recruiting/seating operators, collecting PnL,
  approving/swapping FLOOR, activating a broker, and the cross-game move (a broker's ERC-6551 wallet
  opening/collecting a Floor desk). **This server never holds keys, never signs, never broadcasts.**

Broker write tools are **verification-gated and fail closed** — they return an error and no calldata
unless ownership, activation, desk state, and quotes all check out live on-chain.

## Conventions (read before trusting a number)

- Amounts are human units (already `/1e18`) unless a field ends in `_raw`.
- Addresses are lowercase hex; compare case-insensitively.
- `ageMs` = milliseconds since the cached data last refreshed.
- **`null` means UNKNOWN, never zero.** Check `partial` / `unknownFields` before reporting a value.

## Architecture

Zero-dependency Node (`server.js`) serving static HTML + a JSON API + the MCP endpoint. State is read
from the chain via JSON-RPC (topic-filtered `eth_getLogs` + `eth_call`) and cached to disk; prices via
GeckoTerminal. No database. See [`SECURITY.md`](./SECURITY.md) for the threat model and custody posture.

## Security

No custody, no keys, unsigned calldata only, verification-gated writes. Full posture and the internal
review log are in [`SECURITY.md`](./SECURITY.md). Found an issue? Open one here.

## License

MIT — see [`LICENSE`](./LICENSE).
