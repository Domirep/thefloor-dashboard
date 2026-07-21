#!/usr/bin/env node
// broker-bot — one command: a StonkBroker's own wallet trades stock tokens, and every trade is
// posted to X. This is the whole loop; broker-sign.js and broker-agent.js are its halves.
//
//   node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA          # dry run, prints everything
//   node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA --live   # sign, broadcast, post
//   node broker-bot.js --id 1 --policy trim --pct 10 --stock NVDA --live --watch
//
// WHAT IT DOES EACH PASS
//   1. reads the broker's ERC-6551 wallet holdings from the MCP
//   2. asks the declared policy what, if anything, to trade
//   3. has the MCP build the swap (owner-gated, balance-checked, quoted live from the real pool)
//   4. signs with the OWNER'S key and broadcasts
//   5. posts the executed trade to the OWNER'S X account
//
// THE POLICY IS YOURS, AND IT IS DELIBERATELY DULL. `trim` sells a fixed percentage of a stock
// holding into WETH, once per interval. It is a mechanical rule, not a prediction, and it is the
// only one shipped on purpose: this is a harness for executing a decision you have made, not a
// system that decides for you. Add your own in POLICIES below.
//
// KEYS ARE YOURS. .env.broker holds BROKER_PK (signing) and the four X_* values (posting). It is
// gitignored; this repo is public. Nothing here prints, logs or transmits either.
//
// LIMITS. --max-in, --daily-max-in and --allow are enforced before anything is built or signed, and
// the bot refuses to run --live without at least one ceiling.
const fs = require('fs');
const path = require('path');

const API = process.env.FLOOR_API || 'https://thefloor-dashboard-production.up.railway.app';
const RPC = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const STATE = path.join(__dirname, '.broker-bot-state.json');
// broker-agent.js's state file. The bot records every tx it successfully POSTS in there, so running
// both never announces a trade twice — and a trade the bot failed to post is deliberately NOT
// recorded, so the watcher picks it up from the chain and posts it instead. The watcher is the
// safety net, not a second megaphone.
const AGENT_STATE = path.join(__dirname, '.broker-agent-state.json');
const TOPIC_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i > -1 && args[i + 1] ? args[i + 1] : d; };

const ID = parseInt(val('id', ''), 10);
const LIVE = flag('live');
const WATCH = flag('watch');
const EVERY = Math.max(60, parseInt(val('every', '3600'), 10)) * 1000;
const POLICY = val('policy', 'trim');
const PCT = Number(val('pct', '10'));
const STOCK = String(val('stock', '')).toUpperCase();
const FEE = val('fee', null);
const SLIP = Number(val('slippage', '2'));
const MAX_IN = Number(val('max-in', '0'));
const DAILY = Number(val('daily-max-in', '0'));
const ALLOW = String(val('allow', '')).toUpperCase().split(',').filter(Boolean);
const CREDS = val('creds', '.env.broker');

if (!(ID >= 1 && ID <= 4444)) {
  console.error('usage: node broker-bot.js --id <1-4444> --policy trim --pct 10 --stock NVDA [--live] [--watch]');
  console.error('       [--fee 3000] [--slippage 2] [--max-in n] [--daily-max-in n] [--allow NVDA,WETH] [--every 3600]');
  process.exit(1);
}
if (LIVE && !MAX_IN && !DAILY) {
  console.error('refusing --live with no ceiling: set --max-in and/or --daily-max-in.');
  console.error('an unattended loop holding a key with no cap is the entire risk of this design.');
  process.exit(1);
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (_) {} };

async function mcp(name, a) {
  const r = await fetch(API + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a || {} } }) });
  const j = await r.json();
  const c = j && j.result && j.result.content && j.result.content[0];
  if (!c) throw new Error('MCP returned nothing usable');
  return JSON.parse(c.text);
}

/* Policies take (holdings, stocks) and return {stock, pct} or null for "do nothing".
   Returning null is a normal outcome and must stay cheap — most passes should do nothing. */
const POLICIES = {
  // Sell a fixed slice of one holding into WETH. Mechanical, no view on price.
  trim: (holdings, stocks) => {
    const target = STOCK || (holdings[0] && holdings[0].symbol);
    if (!target) return null;
    const h = holdings.find(x => (x.symbol || '').toUpperCase() === target);
    if (!h || !(h.amount > 0)) return { skip: 'wallet holds no ' + target };
    const s = stocks.find(x => (x.symbol || '').toUpperCase() === target);
    if (!s) return { skip: target + ' is not a known stock token' };
    if (!s.tradeable) return { skip: target + ' has no WETH pool — it cannot be swapped directly' };
    return { stock: target, amount: h.amount * (PCT / 100), token: s };
  },
};

async function pass(signer, xc) {
  const info = await (await fetch(API + '/api/broker?id=' + ID)).json().catch(() => null);
  if (!info || !info.wallet) { console.error('could not read broker #' + ID); return; }
  const sres = await mcp('get_stock_tokens');
  const stocks = sres.stocks || [];
  /* An empty list means the MCP could not tell us what is tradeable — not that the symbol is wrong.
     Saying "NVDA is not a known stock token" when the real problem is a stale server sends you
     debugging the wrong thing. */
  if (!stocks.length) { console.error('  could not read the stock-token list from ' + API + (sres.error ? ' (' + sres.error + ')' : ' — is get_stock_tokens deployed there?')); return; }
  const holdings = (info.holdings || []).map(h => ({ symbol: h.symbol, amount: h.amount, usd: h.usd }));
  console.log('\nbroker #' + ID + ' ' + info.wallet);
  console.log('  holdings: ' + (holdings.map(h => h.amount.toFixed(4) + ' ' + h.symbol + ' ($' + (h.usd || 0).toFixed(2) + ')').join(', ') || 'none'));

  const p = POLICIES[POLICY];
  if (!p) { console.error('unknown policy: ' + POLICY + ' (have: ' + Object.keys(POLICIES).join(', ') + ')'); return; }
  const want = p(holdings, stocks);
  if (!want) { console.log('  policy ' + POLICY + ': nothing to do'); return; }
  if (want.skip) { console.log('  policy ' + POLICY + ': ' + want.skip); return; }

  if (ALLOW.length && !ALLOW.includes(want.stock)) { console.log('  BLOCKED by --allow: ' + want.stock); return; }
  if (MAX_IN > 0 && want.amount > MAX_IN) { console.log(`  BLOCKED by --max-in: ${want.amount} > ${MAX_IN}`); return; }
  const st = readState(); const key = info.wallet.toLowerCase() + ':' + want.stock;
  const recent = (st[key] || []).filter(e => e.at > Date.now() - 86400000);
  const spent = recent.reduce((s, e) => s + e.amt, 0);
  if (DAILY > 0 && spent + want.amount > DAILY) { console.log(`  BLOCKED by --daily-max-in: ${spent}+${want.amount} > ${DAILY}`); return; }

  const fee = FEE != null ? parseInt(FEE, 10) : (want.token.pools[want.token.pools.length - 1] || {}).fee;
  console.log(`  policy ${POLICY}: sell ${want.amount.toFixed(6)} ${want.stock} -> WETH at the ${fee} tier`);

  const tx = await mcp('prepare_broker_trade', {
    id: ID, from: signer ? signer.address : info.owner, tokenIn: want.stock, tokenOut: 'WETH',
    amountIn: want.amount, fee, slippagePct: SLIP });
  if (tx.error) { console.log('  server refused: ' + tx.error); return; }
  console.log('  quote: ' + (tx.verified && tx.verified.quote));

  if (!LIVE) {
    console.log('  DRY RUN — would sign ' + (tx.approveFirst ? '2 transactions (approve, swap)' : '1 transaction') + ' and post the result to X.');
    return;
  }

  const ethers = require('ethers');
  const provider = new ethers.JsonRpcProvider(RPC);
  const w = signer.connect(provider);
  const steps = tx.approveFirst ? [{ l: 'approve', t: tx.approveFirst }, { l: 'swap', t: tx }] : [{ l: 'swap', t: tx }];
  let swapHash = null, swapRec = null;
  for (const s of steps) {
    const req = { to: s.t.to, data: s.t.data, value: s.t.value && s.t.value !== '0x0' ? BigInt(s.t.value) : 0n };
    try { req.gasLimit = (await provider.estimateGas({ ...req, from: w.address })) * 12n / 10n; }
    catch (e) { console.log('  ' + s.l + ' would revert: ' + (e.shortMessage || e.message)); return; }
    const sent = await w.sendTransaction(req);
    const rec = await sent.wait();
    if (!rec || rec.status !== 1) { console.log('  ' + s.l + ' FAILED on-chain — stopping'); return; }
    console.log('  ' + s.l + ' ok ' + sent.hash);
    if (s.l === 'swap') { swapHash = sent.hash; swapRec = rec; }
  }

  recent.push({ at: Date.now(), amt: want.amount }); st[key] = recent; writeState(st);

  /* The receipt already contains the exact fill — post actuals, not the pre-trade estimate. In the
     V3 Swap log the amounts are signed from the POOL's side: the negative one is what the pool paid
     out, i.e. what the broker wallet received. (Every token here is 18-decimals; checked on-chain.) */
  let boughtAmt = null;
  for (const lg of (swapRec && swapRec.logs) || []) {
    if (!lg.topics || String(lg.topics[0]).toLowerCase() !== TOPIC_SWAP) continue;
    if (String(lg.topics[2] || '').slice(-40).toLowerCase() !== info.wallet.slice(2).toLowerCase()) continue;
    const d = String(lg.data).replace(/^0x/, '');
    const sgn = h => { const v = BigInt('0x' + h); return v >> 255n ? v - (1n << 256n) : v; };
    const a0 = sgn(d.slice(0, 64)), a1 = sgn(d.slice(64, 128));
    const neg = a0 < 0n ? a0 : (a1 < 0n ? a1 : null);
    if (neg != null) boughtAmt = Number(-neg) / 1e18;
    break;
  }

  const text = [`StonkBroker #${ID} traded`, ``,
    `sold ${want.amount.toFixed(6)} ${want.stock}` + (boughtAmt != null ? ` → bought ${boughtAmt.toFixed(6)} WETH` : ' for WETH'),
    ``, `wallet ${info.wallet.slice(0, 6)}…${info.wallet.slice(-4)} — the NFT's own ERC-6551 account, so the position belongs to the broker`,
    `${EXPLORER}/tx/${swapHash}`].join('\n');
  const r = await xc.tweet(text);
  if (r.ok) {
    console.log('  posted https://x.com/i/status/' + (r.body.data && r.body.data.id));
    markPostedForAgent(info.wallet, swapHash);
  } else {
    console.log('  X POST FAILED ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
    console.log('  (not recorded as posted — broker-agent.js will find the trade on-chain and announce it)');
  }
}

// Shared dedupe with the watcher: a hash in its posted list is a trade it must not announce again.
function markPostedForAgent(wallet, hash) {
  if (!hash) return;
  let s = {}; try { s = JSON.parse(fs.readFileSync(AGENT_STATE, 'utf8')); } catch (_) {}
  const k = wallet.toLowerCase();
  const e = s[k] || { lastBlock: 0, posted: [] };
  if (!e.posted.includes(hash)) e.posted.push(hash);
  e.posted = e.posted.slice(-500);
  s[k] = e;
  try { fs.writeFileSync(AGENT_STATE, JSON.stringify(s, null, 1)); } catch (_) {}
}

(async () => {
  let signer = null, xc = { tweet: async () => ({ ok: false, status: 0, body: { error: 'dry run' } }) };
  if (LIVE) {
    const { xClient, loadCreds } = require('./x-client');
    const ethers = require('ethers');
    const file = path.isAbsolute(CREDS) ? CREDS : path.join(__dirname, CREDS);
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('cannot read ' + file + ' — it needs BROKER_PK and the four X_* values'); process.exit(1); }
    const pkLine = raw.split(/\r?\n/).find(l => l.startsWith('BROKER_PK='));
    const pk = pkLine ? pkLine.slice('BROKER_PK='.length).trim() : '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error(file + ': BROKER_PK must be 0x + 64 hex'); process.exit(1); }
    signer = new ethers.Wallet(pk);
    xc = xClient(loadCreds(file));
    const who = await xc.verify();
    if (!who.ok) { console.error('X credentials rejected: ' + who.status); process.exit(1); }
    console.log('signing as ' + signer.address + ' · posting as @' + (who.body.data && who.body.data.username));
    console.log('limits: max-in=' + (MAX_IN || 'none') + ' daily=' + (DAILY || 'none') + ' allow=' + (ALLOW.join(',') || 'any'));
  } else {
    console.log('DRY RUN (no --live): nothing will be signed, broadcast or posted.');
  }
  await pass(signer, xc);
  if (WATCH) { console.log('\nwatching every ' + EVERY / 1000 + 's — ctrl-c to stop'); setInterval(() => pass(signer, xc).catch(e => console.error('pass failed: ' + e.message)), EVERY); }
})().catch(e => { console.error('FAILED: ' + (e.shortMessage || e.message)); process.exit(1); });
