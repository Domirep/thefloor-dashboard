# The Floor MCP — capabilities

An MCP server over two games on Robinhood Chain: **The Floor** ($FLOOR desks, alpha, firms) and
**StonkBrokers** (4444 ERC-6551 broker NFTs whose wallets hold tokenized stock).

```
https://thefloor-dashboard-production.up.railway.app/mcp
```

Streamable HTTP, no auth, CORS open. Every tool is self-describing via `tools/list` — this document
explains *what you can do*; the schemas are the contract.

> **Here for StonkBrokers only?** The broker-focused doc — connect the token-bound wallet, trade
> stock tokens, post every trade to X — stands alone at
> [/stonkbrokers.md](https://thefloor-dashboard-production.up.railway.app/stonkbrokers.md).

---

## The two rules that matter

**1. Reads are cached facts. Writes are unsigned calldata.**
No tool signs anything, broadcasts anything, or asks for a key. Every `prepare_*` returns
`{to, data, value}` for you to sign yourself. The server holds no private key and never will —
if anything ever asks you for one, it is not this.

**2. `null` means unknown, never zero.**
An upstream read can throttle. When it does, tools return `null` and set `partial` / `unknownFields`
rather than inventing a zero. A `0` from this API is a measured zero. Do not treat `null` as `0` —
that is how an agent talks itself into a trade that isn't there.

---

## What you can do

### Read the game

| tool | answers |
|---|---|
| `get_floor_state` | price, market cap, supply, burned, emissions, halving, global alpha, reinvest-vs-dump split |
| `get_player` | one wallet: desk tier, alpha, share, FLOOR/day, pending PnL, balance, seated roster |
| `get_leaderboard` | wallets by alpha; top recruiters by referral earned |
| `get_behavior` | who reinvests vs dumps — player / trader / routed / liquidity split |
| `get_history` | daily snapshots for trends |
| `get_live_actions` | recent collect / claim / seat / recruit / upgrade / burn events |
| `get_holders` | top $FLOOR holders |
| `get_firms` | firms, members, contributions, and unaffiliated free agents |
| `get_distribution` | how desks and alpha concentrate (top 1% / 10%) |
| `get_strategy` | the above, reasoned into suggested moves for one wallet |

### Read the brokers

| tool | answers |
|---|---|
| `get_brokers` | collection state: minted, holders, activation tiers, dividend rounds, $STONKBROKER price |
| `get_broker` | one broker: owner, its ERC-6551 wallet, holdings, dividends, activation, on-chain art |
| `get_broker_leaderboard` | brokers ranked by wallet contents — a removable snapshot, not an appraisal |
| `get_broker_activation_math` | fee, share, payback facts for activating |
| `get_broker_floor_status` | cross-game: does this broker's wallet play The Floor? |
| **`get_stock_tokens`** | **the tokenized stocks a broker can trade, and which pools actually exist** |

### Act (all unsigned)

| tool | builds |
|---|---|
| `prepare_create_desk` | open a Floor desk |
| `prepare_collect` | collect pending PnL |
| `prepare_wrap_eth` / `prepare_approve_floor` | the plumbing steps |
| `prepare_swap_eth_for_floor` | buy FLOOR, `amountOutMinimum` quoted live |
| `prepare_activate_broker` | activate a broker (approve + activate) |
| `prepare_broker_floor_desk` | the broker's **wallet** opens its own desk |
| `prepare_broker_floor_collect` | the broker's wallet collects its own PnL |
| **`prepare_broker_trade`** | **the broker's wallet swaps stock tokens** |

---

## Trading from a broker wallet

The thing that makes a StonkBroker interesting: the NFT owns a real ERC-6551 wallet, and that wallet
can hold positions. `prepare_broker_trade` routes a Uniswap V3 `exactInputSingle` through the
account's `executeCall`, so **the wallet spends and the wallet receives**.

The recipient is the broker wallet, never the owner's EOA. Sending output to the owner would look
like a working trade while draining the NFT of the only thing that makes it worth buying.

**Start with `get_stock_tokens`.** Pool tiers differ per stock and are not guessable:

| stock | tradeable at |
|---|---|
| AAPL | 0.01%, 0.05% |
| NVDA | 0.3%, 1% |
| AMZN | **no WETH pool — cannot be swapped directly** |

A fixed default fee tier fails on two of the three. Symbols (`"NVDA"`, `"WETH"`) are accepted
anywhere an address is.

### What it refuses to build

Refusals return **no calldata at all**, on purpose — a half-built transaction is worse than none:

- `from` missing, or not `ownerOf(id)` on-chain (`executeCall` is owner-gated; it would revert)
- the broker wallet doesn't hold enough `tokenIn` — note it must be the **wallet's** balance, not yours
- no V3 pool for that pair at that tier (it names the tiers that do exist)
- **no price floor.** Pass `pool`, or let it resolve one via the factory, or give `minAmountOut`.
  A zero `amountOutMinimum` is a guaranteed sandwich, and an agent trading unattended is exactly
  who gets eaten.

### Two signatures, in order

The router pulls via `transferFrom`, so the **wallet** must approve it — and that approval is itself
an `executeCall`. When allowance is short you get `approveFirst` back alongside the swap. Sign
approve, wait for it, then sign the swap.

---

## Running the full loop

Three local scripts (not deployed — they hold keys, the server must not):

```
broker-bot.js      one command: holdings -> policy -> build -> sign -> broadcast -> post to X
broker-sign.js     sign and broadcast a single prepared trade
broker-agent.js    watch the wallet for swaps and post each one to X
x-client.js        OAuth 1.0a X client, credentials passed in
```

```bash
npm i ethers                                    # signing only; the server itself has no dependencies

# dry run — prints holdings, the policy's decision, the live quote, and what it would sign
node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA

# live, with ceilings (it refuses --live without at least one)
node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA --live \
  --max-in 0.02 --daily-max-in 0.05 --allow NVDA,WETH --watch
```

`.env.broker`, gitignored, holds what only you should have:

```
BROKER_PK=0x<64 hex>      # signs. use a key holding only what you can afford to be wrong with
X_API_KEY=...             # posts, from YOUR developer app — not the dashboard's
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
```

**Defaults chosen so mistakes are cheap:** dry run everywhere, `--live` refused without a ceiling,
first watcher pass caps the backlog at 3 (a fresh watcher on an old wallet will otherwise announce a
hundred historical trades), `estimateGas` before every send so a revert costs nothing, a failed
approve aborts the swap, and `--verify` tells you which X account the keys belong to before anything
runs unattended.

**Run the bot and the watcher together — they share one dedupe.** When the bot posts a trade it
records the tx hash in the watcher's state, so the watcher never announces it twice. When the bot's
post *fails*, it deliberately records nothing — the watcher finds the trade on-chain and posts it
instead. The bot posts exact fills from the receipt, and the watcher is the safety net that
guarantees "every trade", including ones executed outside the bot entirely.

**The policy is yours.** `trim` sells a fixed slice of a holding into WETH on an interval — a
mechanical rule, not a prediction. It is the only one shipped, on purpose: this is a harness for
executing a decision you made, not a system that makes one for you. Add your own in `POLICIES`.

---

## Gotchas that will bite an agent

- **`null` is not `0`.** Check `partial` and `unknownFields` before reasoning on a number.
- **The broker wallet's balance is not the owner's.** Trades spend the wallet's tokens.
- **Fee tiers differ per stock**, and one stock has no pool at all. Call `get_stock_tokens`.
- **A desk is bound to its wallet.** It transfers with the NFT — the only way a Floor position
  changes hands. Liquid wallet contents stay removable by the owner until a sale, so never promise
  a buyer the tokens inside.
- **A wallet's recruiter is fixed forever** at desk creation. It cannot be changed or backfilled.
- **Burned can exceed supply** (burns reduce it), so `burnedPct > 100%` is normal.
- **This mirrors thefloor.sh; the game is the source of truth.** Firm PnL there is off-chain-indexed
  and marked to market — anything computed here independently is an estimate and is labelled as one.

---

Unofficial, fan-built, MIT. Not affiliated with The Floor or Clutch Markets.
Full schemas: `tools/list`. Machine-readable summary: [`/llms.txt`](https://thefloor-dashboard-production.up.railway.app/llms.txt).
