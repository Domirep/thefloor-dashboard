# StonkBrokers MCP — agent trading from the broker's own wallet

StonkBrokers are **4,444 ERC-6551 NFTs on Robinhood Chain**. Each one owns a real token-bound
wallet, seeded with tokenized stock (AAPL / AMZN / NVDA), earning stock-dividend drops roughly
every 10 minutes. This MCP turns that wallet into an account an agent can operate: **read it,
trade stock tokens from it, and post every trade to X.**

```
https://thefloor-dashboard-production.up.railway.app/mcp
```

Streamable HTTP, no auth, CORS open. Tools are self-describing via `tools/list`.

---

## The loop

**Connect** → `get_broker(id)` resolves any NFT to its token-bound wallet: owner, holdings with
USD values, per-stock dividends received, activation tier, on-chain art.

**Trade** → `get_stock_tokens()` tells the agent what is actually tradeable, then
`prepare_broker_trade(...)` builds the swap — **the wallet spends, and the output lands back in
the wallet**, so the position stays with the NFT.

**Post** → companion scripts sign with the owner's key, broadcast, and post the **exact fill** to
the owner's X account — every trade, exactly once.

---

## Connect the wallet to an agent

| tool | gives you |
|---|---|
| `get_broker` `(id)` | owner, ERC-6551 wallet, holdings + USD, dividends per stock, activation tier, art |
| `get_brokers` `()` | collection state: minted, holders, tier census, dividend rounds, token price |
| `get_broker_leaderboard` `(limit)` | brokers ranked by wallet contents in USD |
| `get_broker_activation_math` `(id, tier)` | activation fee, dividend-pool share after dilution, est. payback |
| `prepare_activate_broker` `(id, tier, from)` | unsigned activation (upgrades credit what was already paid) |

Reads work on **any** broker. Writes only work on a broker **your wallet owns** — the 6551
`executeCall` is owner-gated, and every write tool verifies `from == ownerOf(id)` on-chain before
returning calldata. An agent can act on its own broker, never someone else's.

## Trade stock tokens

**Start with `get_stock_tokens()`.** It reads the tradeable set from the chain and, per stock, every
Uniswap V3 pool that has real liquidity — with its fee tier **and quote asset**. Neither is
guessable, and these are RWA tokens: they do not all quote against WETH.

| stock | live pools | USD |
|---|---|---|
| AAPL | USDG 0.3%, USDG 1% | ~$324 |
| AMZN | USDG 0.3%, USDG 1% | ~$247 |
| NVDA | USDG 0.05%, USDG 0.3%, WETH 0.3% | ~$209 |

**USDG is the stablecoin these actually trade against.** Assume WETH and you will find no market for
AMZN at all, and route AAPL into empty pools. Empty pools are filtered out, and so are pools against
copycat tokens (`AMZNAMZN`, `AMZNC`, `AMZNUSDG` all exist with large nominal liquidity) — pricing
off one of those would be confidently wrong, which is worse than reporting nothing.

**`prepare_broker_trade(id, from, tokenIn, tokenOut, amountIn, ...)`** routes an
`exactInputSingle` through the wallet's own `executeCall`:

- **the wallet is the recipient** — proceeds belong to the NFT, never the owner's EOA
- symbols accepted (`"NVDA"`, `"WETH"`) as well as addresses
- pool auto-resolved from the V3 factory; quote taken live from `slot0`
- when the wallet's allowance is short, an `approveFirst` transaction comes back too —
  two signatures, in order

**What it refuses to build** (refusals return *no calldata at all*):

- `from` missing or not the broker's on-chain owner — the swap would revert
- the wallet doesn't hold enough `tokenIn` (the **wallet's** balance, not yours)
- no pool at that fee tier — it names the tiers that do exist
- **no price floor** — a zero `amountOutMinimum` is a guaranteed sandwich, and an agent trading
  unattended is exactly who gets eaten

Everything is **unsigned**. The server holds no key, ever.

## Post every trade to X

Three local scripts close the loop (local because they hold keys, and the server must not):

```
broker-bot.js     one command: holdings → policy → build → sign → broadcast → post
broker-agent.js   watch the wallet on-chain and post every swap it receives
broker-sign.js    sign and broadcast a single prepared trade
x-client.js       OAuth 1.0a X client — the owner's own app, credentials passed in
```

```bash
npm i ethers          # signing only — the server itself is dependency-free

# dry run: prints holdings, the decision, the live quote, what it would sign
node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA

# live, with ceilings (refused without at least one)
node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA --live \
  --max-in 0.02 --daily-max-in 0.05 --allow NVDA,WETH --watch
```

**The owner provides both keys.** `.env.broker` (gitignored) holds `BROKER_PK` — the broker
owner's signing key — and the four `X_*` credentials from the owner's own X developer app, so
posts come from the owner's account. Nothing here prints, logs, or transmits either.

**Every trade posts exactly once.** The bot decodes the exact fill from the swap receipt
("sold 0.016293 NVDA → bought 0.001923 WETH") and records the tx hash in the watcher's state so
it never double-announces. If the bot's post fails, it records nothing — the watcher finds the
trade on-chain and posts it instead. The watcher also catches trades executed outside the bot,
which is what makes "every trade" true rather than aspirational.

**Defaults chosen so mistakes are cheap:** dry run everywhere · `--live` refused without a
ceiling · `--allow` token allowlist · first watcher pass caps historical backlog at 3 ·
`estimateGas` before every send so a revert costs nothing · a failed approve aborts the swap ·
`--verify` prints which X account the keys belong to before anything runs unattended.

---

## Gotchas for agents

- **`null` means unknown, never zero.** A throttled read returns `null` and flags `partial` —
  treat it as missing, not as 0.
- **The broker wallet's balance is not the owner's.** Trades spend the wallet's tokens.
- **Fee tiers differ per stock**, and one stock has no pool at all. Call `get_stock_tokens` first.
- **Wallet contents are a snapshot, not an appraisal** — liquid contents remain removable by the
  current owner until a sale settles.

---

Unofficial, fan-built, MIT. Not affiliated with Clutch Markets.
Full schemas: `tools/list` on the endpoint above.
