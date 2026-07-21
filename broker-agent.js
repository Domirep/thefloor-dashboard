#!/usr/bin/env node
// broker-agent — watch a StonkBroker's ERC-6551 wallet for trades and post each one to X.
//
// The missing half of the loop. The MCP can already READ a broker and BUILD an unsigned trade
// (prepare_broker_trade); this watches what the wallet actually did on-chain and announces it.
//
//   node broker-agent.js --id 1                     # dry run: prints what it WOULD post
//   node broker-agent.js --id 1 --post              # actually posts
//   node broker-agent.js --id 1 --post --watch      # keep watching (default every 90s)
//   node broker-agent.js --id 1 --verify            # whose X account are these keys?
//
// DRY RUN IS THE DEFAULT, deliberately. A watcher pointed at a wallet with history will happily
// announce a hundred old trades the first time it runs; you want to see that list before your
// timeline does.
//
// CREDENTIALS. Posting uses the BROKER OWNER'S own X app, not the dashboard's. Put them in a file
// this script only reads (default .env.broker, override with --creds):
//     X_API_KEY=...
//     X_API_SECRET=...
//     X_ACCESS_TOKEN=...
//     X_ACCESS_SECRET=...
// Never commit it. This repo is public; .env* is gitignored, keep it that way.
//
// This script does NOT sign or send transactions and holds no private key. Trading is the owner's
// signature on calldata from prepare_broker_trade. This only reports what already happened.
const fs = require('fs');
const path = require('path');

const RPC = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const API = process.env.FLOOR_API || 'https://thefloor-dashboard-production.up.railway.app';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
// Uniswap V3 Swap(address indexed sender, address indexed recipient, int256, int256, uint160, uint128, int24)
const TOPIC_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i > -1 && args[i + 1] ? args[i + 1] : d; };

const ID = parseInt(val('id', ''), 10);
const DO_POST = flag('post');
const WATCH = flag('watch');
const EVERY = Math.max(30, parseInt(val('every', '90'), 10)) * 1000;
const MAX_FIRST = parseInt(val('max-first', '3'), 10);   // cap the backlog announced on first run
const CREDS_FILE = val('creds', '.env.broker');
const STATE_FILE = path.join(__dirname, '.broker-agent-state.json');

if (!(ID >= 1 && ID <= 4444)) {
  console.error('usage: node broker-agent.js --id <1-4444> [--post] [--watch] [--every 90] [--creds .env.broker] [--verify]');
  process.exit(1);
}

const hex = n => '0x' + n.toString(16);
const addrOf = topic => '0x' + topic.slice(26).toLowerCase();
const short = a => a.slice(0, 6) + '…' + a.slice(-4);

async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j && j.result !== undefined) return j.result;
    } catch (_) {}
    await new Promise(s => setTimeout(s, 1200 * (i + 1)));
  }
  return null;
}

// State is keyed by wallet, so several brokers can share one file without clobbering each other.
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { console.error('  (could not persist state:', e.message + ')'); } }

// Token metadata straight from the chain, cached in-process. Symbols make the post readable and
// decimals decide whether the amount is right — getting decimals wrong misreports the trade size.
const meta = {};
async function tokenMeta(addr) {
  if (meta[addr]) return meta[addr];
  const [sym, dec] = await Promise.all([
    rpc('eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest']),   // symbol()
    rpc('eth_call', [{ to: addr, data: '0x313ce567' }, 'latest']),   // decimals()
  ]);
  let symbol = '???';
  if (sym && sym.length > 130) {
    try {
      const len = parseInt(sym.slice(66, 130), 16);
      symbol = Buffer.from(sym.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '') || '???';
    } catch (_) {}
  }
  const decimals = dec ? parseInt(dec, 16) : 18;
  meta[addr] = { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
  return meta[addr];
}

const fmtAmt = (raw, decimals) => {
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit, frac = v % unit;
  const f = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (f ? '.' + f : '');
};

async function brokerInfo(id) {
  const r = await fetch(API + '/api/broker?id=' + id).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}

// One Swap log -> a human sentence. Uniswap reports amount0/amount1 signed from the POOL's side:
// positive means the pool received it (the trader sold it), negative means the pool paid it out.
async function describeSwap(log, wallet) {
  const d = log.data.replace(/^0x/, '');
  const sgn = h => { const v = BigInt('0x' + h); return v >> 255n ? v - (1n << 256n) : v; };
  const a0 = sgn(d.slice(0, 64)), a1 = sgn(d.slice(64, 128));
  const [t0, t1] = await Promise.all([
    rpc('eth_call', [{ to: log.address, data: '0x0dfe1681' }, 'latest']),   // token0()
    rpc('eth_call', [{ to: log.address, data: '0xd21220a7' }, 'latest']),   // token1()
  ]);
  if (!t0 || !t1) return null;
  const [m0, m1] = await Promise.all([tokenMeta('0x' + t0.slice(26)), tokenMeta('0x' + t1.slice(26))]);
  const soldIs0 = a0 > 0n;
  const sold = { m: soldIs0 ? m0 : m1, amt: soldIs0 ? a0 : a1 };
  const bought = { m: soldIs0 ? m1 : m0, amt: soldIs0 ? -a1 : -a0 };
  return {
    tx: log.transactionHash,
    block: parseInt(log.blockNumber, 16),
    sold: fmtAmt(sold.amt, sold.m.decimals) + ' ' + sold.m.symbol,
    bought: fmtAmt(bought.amt, bought.m.decimals) + ' ' + bought.m.symbol,
    wallet,
  };
}

function composePost(id, s) {
  return [
    `StonkBroker #${id} traded`,
    ``,
    `sold ${s.sold}`,
    `bought ${s.bought}`,
    ``,
    `wallet ${short(s.wallet)} (the NFT's own ERC-6551 account — the position belongs to the broker)`,
    `${EXPLORER}/tx/${s.tx}`,
  ].join('\n');
}

async function scan(x) {
  const info = await brokerInfo(ID);
  if (!info || !info.wallet) { console.error('could not resolve broker #' + ID + "'s wallet from " + API); return; }
  const wallet = info.wallet.toLowerCase();

  const state = readState();
  const st = state[wallet] || { lastBlock: 0, posted: [] };
  const latest = await rpc('eth_blockNumber', []);
  if (!latest) { console.error('RPC would not give a block number — skipping this pass'); return; }
  const head = parseInt(latest, 16);
  const from = st.lastBlock ? st.lastBlock + 1 : Math.max(0, head - 50000);

  // recipient is the 3rd topic of a V3 Swap — trades the wallet received the output of
  const logs = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(head),
    topics: [TOPIC_SWAP, null, '0x' + wallet.replace(/^0x/, '').padStart(64, '0')] }]);
  if (logs === null) { console.error('getLogs failed (throttled) — keeping state, will retry'); return; }

  console.log(`broker #${ID} wallet ${wallet} · blocks ${from}-${head} · ${logs.length} swap(s)`);
  const fresh = logs.filter(l => !st.posted.includes(l.transactionHash));

  let toAnnounce = fresh;
  if (!st.lastBlock && fresh.length > MAX_FIRST) {
    console.log(`  first run: ${fresh.length} historical trades found, announcing only the newest ${MAX_FIRST} (--max-first to change)`);
    toAnnounce = fresh.slice(-MAX_FIRST);
  }

  for (const log of toAnnounce) {
    const s = await describeSwap(log, wallet);
    if (!s) { console.error('  could not decode a swap — skipping, not marking posted'); continue; }
    const text = composePost(ID, s);
    if (!DO_POST) {
      console.log('\n--- would post (dry run) ---\n' + text + '\n');
    } else {
      const r = await x.tweet(text);
      if (!r.ok) { console.error('  POST FAILED', r.status, JSON.stringify(r.body).slice(0, 200), '— not marking posted, will retry'); continue; }
      console.log('  posted https://x.com/i/status/' + (r.body.data && r.body.data.id));
      await new Promise(s2 => setTimeout(s2, 2000));       // stay under the write limit
    }
    st.posted.push(log.transactionHash);
  }

  // Only advance the watermark on a clean pass, so a failed post is retried rather than skipped.
  st.lastBlock = head;
  st.posted = st.posted.slice(-500);
  state[wallet] = st;
  if (DO_POST) writeState(state);
  else console.log('(dry run — state not advanced, so this repeats identically until you pass --post)');
}

(async () => {
  let x = { tweet: async () => ({ ok: false, status: 0, body: { error: 'no credentials loaded' } }) };
  if (DO_POST || flag('verify')) {
    const { xClient, loadCreds } = require('./x-client');
    let creds;
    try { creds = loadCreds(path.isAbsolute(CREDS_FILE) ? CREDS_FILE : path.join(__dirname, CREDS_FILE)); }
    catch (e) { console.error('credentials: ' + e.message); console.error('create it with X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET from the OWNER\'s X developer app.'); process.exit(1); }
    x = xClient(creds);
    const who = await x.verify();
    if (!who.ok) { console.error('X credentials rejected:', who.status, JSON.stringify(who.body).slice(0, 200)); process.exit(1); }
    const handle = who.body.data && who.body.data.username;
    console.log('posting as @' + handle + ' — confirm that is the account you meant before this runs unattended.');
    if (flag('verify')) return;
  } else {
    console.log('DRY RUN (no --post): nothing will be sent to X.');
  }

  await scan(x);
  if (WATCH) {
    console.log(`watching every ${EVERY / 1000}s — ctrl-c to stop`);
    setInterval(() => scan(x).catch(e => console.error('pass failed:', e.message)), EVERY);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
