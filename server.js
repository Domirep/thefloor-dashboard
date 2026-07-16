// Static server + lightweight, privacy-respecting telemetry for the dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const PORT = process.env.PORT || 4319;
const ADMIN_KEY = process.env.ADMIN_KEY || 'floor-admin';
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml',
  '.png':'image/png', '.ico':'image/x-icon', '.json':'application/json', '.woff2':'font/woff2' };

// in-memory event buffer (resets on redeploy — Railway logs are the durable record)
const BOOT = Date.now();
const events = [];
const MAX = 8000;
const counts = {};

// owner-controlled "deals live" broadcast
let dealsStatus = { live: false, msg: '', ts: 0 };

// ---- persistence across deploys (Railway volume) ----
// Railway injects RAILWAY_VOLUME_MOUNT_PATH when a volume is attached; falls back to a local
// (ephemeral) dir when running without one.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data-local');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const DEALS_FILE = path.join(DATA_DIR, 'deals.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const HOLDERS_FILE = path.join(DATA_DIR, 'holders.json');
const DIST_FILE = path.join(DATA_DIR, 'distribution.json');
let dirty = false;
try {
  const arr = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  if (Array.isArray(arr)) { for (const e of arr.slice(-MAX)) { events.push(e); counts[e.t] = (counts[e.t] || 0) + 1; } console.log('LOADED ' + events.length + ' events from ' + DATA_DIR); }
} catch (_) { console.log('No prior events at ' + DATA_DIR + ' (fresh)'); }
try { const d = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8')); if (d && typeof d.live === 'boolean') dealsStatus = d; } catch (_) {}
function saveDeals() { try { fs.writeFile(DEALS_FILE, JSON.stringify(dealsStatus), () => {}); } catch (_) {} }
setInterval(() => { if (!dirty) return; dirty = false; try { fs.writeFile(EVENTS_FILE, JSON.stringify(events), () => {}); } catch (_) {} }, 15000);
process.on('SIGTERM', () => { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events)); } catch (_) {} process.exit(0); });

// ---- shared, cached FLOOR token stats (server fetches for ALL visitors) ----
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const FLOOR_ADDR = '0xA80Ba06F0a0327E68dA6BedE67eB35ac023D6e62';
const DEAD_ADDR = '0x000000000000000000000000000000000000dead';
let tokenStats = null;      // last good snapshot
let tokenStatsAt = 0;       // ms of last successful refresh
let refreshing = null;      // in-flight guard
try { const p = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); if (p && p.stats) { tokenStats = p.stats; tokenStatsAt = p.at || 0; console.log('LOADED token stats from volume'); } } catch (_) {}

async function sfetch(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const t = await r.text();
      if (!r.ok || !t) { await new Promise(s => setTimeout(s, 500 * (i + 1))); continue; }
      return JSON.parse(t);
    } catch (_) { await new Promise(s => setTimeout(s, 400)); }
  }
  throw new Error('sfetch failed ' + url);
}

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
// Resilient JSON-RPC batch. Railway's egress IP gets throttled hard at boot — a throttled response
// is a single error object or an array of error items, not the full result set. Retry with backoff.
// Returns a {id: result} map on success, or null if still throttled after all tries.
async function rpcBatch(body, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (Array.isArray(j) && j.length === body.length && j.every(x => x && ('result' in x))) {
        const byId = {}; j.forEach(x => { byId[x.id] = x.result; }); return byId;
      }
    } catch (_) {}
    await new Promise(s => setTimeout(s, 600 * (i + 1)));   // 0.6s, 1.2s … 3.6s
  }
  return null;
}

// Live DEX market data from GeckoTerminal (highest-liquidity FLOOR pool). Returns null on failure.
async function geckoMarket() {
  try {
    const j = await sfetch('https://api.geckoterminal.com/api/v2/search/pools?query=' + FLOOR_ADDR, 3);
    const fa = FLOOR_ADDR.toLowerCase(); let best = null;
    for (const p of (j.data || [])) {
      const a = p.attributes || {}, rel = p.relationships || {};
      const baseId = (rel.base_token && rel.base_token.data && rel.base_token.data.id || '').toLowerCase();
      const quoteId = (rel.quote_token && rel.quote_token.data && rel.quote_token.data.id || '').toLowerCase();
      let price = null;
      if (baseId.endsWith(fa)) price = parseFloat(a.base_token_price_usd);
      else if (quoteId.endsWith(fa)) price = parseFloat(a.quote_token_price_usd);
      const liq = parseFloat(a.reserve_in_usd) || 0;
      if (price > 0 && (!best || liq > best.liq)) best = { price, liq, a };
    }
    if (!best) return null;
    const a = best.a, tx = a.transactions || {}, pc = a.price_change_percentage || {}, vol = a.volume_usd || {};
    const tf = k => ({ buys: (tx[k] && tx[k].buys) || 0, sells: (tx[k] && tx[k].sells) || 0 });
    return { price: best.price, reserveUsd: best.liq, vol24: parseFloat(vol.h24) || 0,
      change1: parseFloat(pc.h1) || 0, change6: parseFloat(pc.h6) || 0, change24: parseFloat(pc.h24) || 0,
      tx1: tf('h1'), tx6: tf('h6'), tx24: tf('h24') };
  } catch (_) { return null; }
}

const EMISSIONS_POOL = 17024000;
// Game v1 (0x9622c4A80E64A32CCDDbFa796f0eca882567F67A) is retired — its totals are frozen, so they're
// hardcoded instead of costing two eth_calls per refresh (read once from the contract 2026-07-11).
const V1_BURNED = 905756.25;
const V1_EMITTED = 2028777.0005;
// authoritative on-chain economy numbers from the game contract (one batched RPC call)
// Token-level total burned: sum of every FLOOR Transfer to 0x0 (captures game v1 + v2 + firm burns — everything).
// Verified: minted(from 0x0) − burned(to 0x0) === totalSupply exactly.
async function tokenBurnTotal() {
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const Z = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: FLOOR_ADDR, fromBlock: '0x0', toBlock: 'latest', topics: [T, null, Z] }] }) });
  const logs = (await r.json()).result;
  if (!Array.isArray(logs) || !logs.length) throw new Error('burn logs unavailable');
  return logs.reduce((s, l) => s + Number(BigInt(l.data)) / 1e18, 0);
}

async function gameEconomy() {
  const G = '0x89d40f5e4d260577691d05e681d47519eb44f113';
  const body = [
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: G, data: '0xa4842424' }, 'latest'] }, // totalFloorBurned()
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: G, data: '0xdf0244b1' }, 'latest'] }, // totalEmitted()
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: G, data: '0x76671808' }, 'latest'] }, // currentEpoch()
    { jsonrpc: '2.0', id: 4, method: 'eth_call', params: [{ to: G, data: '0xec98557e' }, 'latest'] }, // globalAlphaPower()
    { jsonrpc: '2.0', id: 5, method: 'eth_call', params: [{ to: G, data: '0x96afc450' }, 'latest'] }, // emissionRate()
    { jsonrpc: '2.0', id: 6, method: 'eth_call', params: [{ to: G, data: '0x294867b9' }, 'latest'] }, // nextHalvingTime()
    { jsonrpc: '2.0', id: 7, method: 'eth_call', params: [{ to: FLOOR_ADDR, data: '0x70a08231' + DEAD_ADDR.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }, // FLOOR.balanceOf(dead) — parked, not circulating
  ];
  let byId = await rpcBatch(body, 2);
  if (!byId) {                                                 // RPC throttles batch arrays harder than singles — fall back to one-by-one
    byId = {};
    for (const c of body) {
      try {
        const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...c }) });
        const j = await r.json();
        if (j && j.result) byId[c.id] = j.result;
      } catch (_) {}
      await new Promise(s => setTimeout(s, 150));
    }
    if (!byId[4] && !byId[1]) throw new Error('rpc throttled (batch + singles)');   // keep last-good
  }
  const big = h => { try { return BigInt(h || '0x0'); } catch { return 0n; } };
  const globalAlpha = Number(big(byId[4]));
  const emissionRate = Number(big(byId[5])) / 1e18;                              // FLOOR per second
  const perAlphaDay = globalAlpha > 0 ? emissionRate * 86400 / globalAlpha : 0;  // FLOOR/day per 1 alpha
  return { burned: Number(big(byId[1])) / 1e18, emitted: Number(big(byId[2])) / 1e18, epoch: Number(big(byId[3])), globalAlpha, emissionRate, perAlphaDay, halveAt: Number(big(byId[6])) * 1000, deadBal: Number(big(byId[7])) / 1e18 };
}

function refreshTokenStats() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const t = await sfetch(`${EXPLORER}/api/v2/tokens/${FLOOR_ADDR}`);
      const supply = Number(t.total_supply) / 1e18;
      let fresh = null;
      try { fresh = await gameEconomy(); } catch (_) {}          // authoritative burned/emitted/epoch/alpha
      // On a throttled RPC read, keep the last-good on-chain economy instead of poisoning the cache with zeros.
      const prev = tokenStats || {};
      const ecoOk = fresh && (fresh.burned > 0 || fresh.globalAlpha > 0);
      const eco = ecoOk ? fresh : {
        burned: prev.burnedV2 || 0, emitted: prev.emittedV2 || 0, epoch: prev.epoch || 0, halveAt: prev.halveAt || 0,
        globalAlpha: prev.globalAlpha || 0, emissionRate: prev.emissionRate || 0, perAlphaDay: prev.perAlphaDay || 0,
        deadBal: prev.deadBal || 0 };
      // Total destroyed = every FLOOR ever sent to 0x0 on the token itself (game v1 + v2 + firm burns).
      // The game contracts' own counters miss firm-founding burns, so the token ledger is the truth.
      let destroyed = 0;
      try { destroyed = await tokenBurnTotal(); } catch (_) { destroyed = prev.burned || 0; }   // last-good on throttle
      const burnedGame = V1_BURNED + (eco.burned || 0);            // spend-driven burns only (for the reinvested estimate)
      const emittedAll = V1_EMITTED + (eco.emitted || 0);          // both game eras draw from the same 17.02M pool
      const gm = await geckoMarket();                              // fresh DEX price + buy/sell/volume
      const price = (gm && gm.price) || parseFloat(t.exchange_rate) || 0;   // fall back to Blockscout
      const priceSource = (gm && gm.price) ? 'geckoterminal' : 'blockscout';
      tokenStats = { price, priceSource, supply, market: gm || null,
        burned: destroyed, burnedGame, burnedV2: eco.burned || 0, emittedV2: eco.emitted || 0,
        emitted: emittedAll, epoch: eco.epoch, halveAt: eco.halveAt || 0,
        globalAlpha: eco.globalAlpha, emissionRate: eco.emissionRate, perAlphaDay: eco.perAlphaDay,
        burnedPct: supply > 0 ? destroyed / supply * 100 : 0,      // the headline: burned vs what exists today
        emittedPct: EMISSIONS_POOL ? emittedAll / EMISSIONS_POOL * 100 : 0,
        deadBal: eco.deadBal || 0,
        circulating: Math.max(0, supply - (eco.deadBal || 0)),                 // true circulating: burns already reduce supply; dead-parked tokens excluded
        marketCap: price * Math.max(0, supply - (eco.deadBal || 0)),
        holders: +t.holders_count || 0,
        volume24h: (gm && gm.vol24) || parseFloat(t.volume_24h) || 0, updatedAt: Date.now() };
      tokenStatsAt = Date.now();
      try { fs.writeFile(STATS_FILE, JSON.stringify({ stats: tokenStats, at: tokenStatsAt }), () => {}); } catch (_) {}
      console.log('STATS ok price=' + price + ' (' + priceSource + ') supply=' + Math.round(supply) + ' destroyed=' + Math.round(destroyed) + ' epoch=' + eco.epoch + (ecoOk ? '' : ' [eco:last-good, rpc throttled]'));
    } catch (e) { console.log('STATS refresh failed (keeping last good): ' + e.message); }
    finally { refreshing = null; }
  })();
  return refreshing;
}
refreshTokenStats();                          // warm on boot
setInterval(refreshTokenStats, 150000);       // every 2.5 min — one explorer hit for everyone

// ---- per-address player lookup (server does pagination once, caches per wallet) ----
const FLOOR_POOL = '0x73ed66f4e5e7e59e279cab050074bfeaec5c55a2'; // FLOOR/WETH pool (sells route here)
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const GAME_CONTRACT = '0x89d40f5e4d260577691d05e681d47519eb44f113'; // desk upgrades + operator recruits
const OP_COST = {25:'Retail Analyst',60:'Junior Broker',100:'Chart Intern',175:'Cold Caller',300:'Options Degen',500:'Market Maker',800:'ETF Boomer',1250:'Sell-Side Analyst',1900:'Compliance Guy',2800:'Quant Goblin',4200:'Dark Pool Dealer',6500:'Prop Desk Killer',10000:'Activist Whale',15000:'Terminal Wizard',25000:'The Closer'};
// [name, baseAlpha, bandwidth] — each bandwidth is unique, so seated operators can be reconstructed from getDesk's bwUsed + alpha
const OPS_STAT = [['Retail Analyst',10,5],['Junior Broker',25,10],['Chart Intern',40,15],['Cold Caller',70,20],['Options Degen',120,30],['Market Maker',200,45],['ETF Boomer',320,60],['Sell-Side Analyst',500,80],['Compliance Guy',750,100],['Quant Goblin',1100,130],['Dark Pool Dealer',1600,170],['Prop Desk Killer',2400,220],['Activist Whale',3600,280],['Terminal Wizard',5200,350],['The Closer',8000,450]];
// find `seats` operators whose bandwidths sum to bwUsed (and alphas ~= baseAlpha). Returns names[] or null.
function inferRoster(bwUsed, seats, baseAlpha) {
  if (!seats || seats < 0 || seats > 40 || bwUsed <= 0) return null;
  const tol = Math.max(2, Math.round((baseAlpha || 0) * 0.02));
  let steps = 0; const CAP = 200000; const pick = [];
  function bt(maxi, seatsLeft, bwLeft, alphaLeft, useAlpha) {
    if (++steps > CAP) return false;
    if (seatsLeft === 0) return bwLeft === 0 && (!useAlpha || Math.abs(alphaLeft) <= tol);
    if (bwLeft <= 0) return false;
    for (let i = maxi; i >= 0; i--) {
      const b = OPS_STAT[i][2], a = OPS_STAT[i][1];
      if (b > bwLeft) continue;
      if (b * seatsLeft > bwLeft && OPS_STAT[0][2] * seatsLeft > bwLeft) { /* smallest can't fill */ }
      pick.push(i);
      if (bt(i, seatsLeft - 1, bwLeft - b, alphaLeft - a, useAlpha)) return true;
      pick.pop();
    }
    return false;
  }
  if (bt(OPS_STAT.length - 1, seats, bwUsed, baseAlpha, true)) return pick.map(i => OPS_STAT[i][0]);
  steps = 0; pick.length = 0;                                   // relax the alpha constraint (firm/intern boosts)
  if (bt(OPS_STAT.length - 1, seats, bwUsed, 0, false)) return pick.map(i => OPS_STAT[i][0]);
  return null;
}
const PLAYER_TTL = 240000; // 4 min
const playerCache = new Map();
const playerInflight = new Map();

// ---- direct on-chain state via the game contract (one batched JSON-RPC call) ----
const SEL = { hasDesk:'0xa223fb21', pendingPnL:'0x99ef54a1', userAlpha:'0xd53c636f', globalAlpha:'0xec98557e', emissionRate:'0x96afc450', getDesk:'0x3656bc36', balanceOf:'0x70a08231' };
const addrArg = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toBig = h => { try { return BigInt(h || '0x0'); } catch { return 0n; } };

async function rpcState(addr) {
  const a = addrArg(addr);
  const calls = [
    { to: GAME_CONTRACT, data: SEL.hasDesk + a },
    { to: GAME_CONTRACT, data: SEL.pendingPnL + a },
    { to: GAME_CONTRACT, data: SEL.userAlpha + a },
    { to: GAME_CONTRACT, data: SEL.globalAlpha },
    { to: GAME_CONTRACT, data: SEL.emissionRate },
    { to: GAME_CONTRACT, data: SEL.getDesk + a },
    { to: FLOOR_ADDR, data: SEL.balanceOf + a },
  ];
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [c, 'latest'] }));
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('rpc ' + r.status);
  const j = await r.json();
  const byId = {}; (Array.isArray(j) ? j : []).forEach(x => { byId[x.id] = x.result; });
  const pendingPnL = Number(toBig(byId[1])) / 1e18;
  const userAlpha = Number(toBig(byId[2]));
  const globalAlpha = Number(toBig(byId[3]));
  const emissionRate = Number(toBig(byId[4])) / 1e18;                 // FLOOR per second
  // getDesk() struct: [level, name-offset, totalSeats, totalBandwidth, seatsUsed, bwUsed, alpha, prestigeBps, ...]
  const gd = byId[5] || '0x';
  const gword = i => (gd.length >= 2 + 64 * (i + 1)) ? Number(BigInt('0x' + gd.slice(2 + 64 * i, 2 + 64 * (i + 1)))) : 0;
  const deskLevel = gword(0), deskSeats = gword(2), deskBandwidth = gword(3), seatsUsed = gword(4), bwUsed = gword(5), prestigeBps = gword(7);
  const balance = Number(toBig(byId[6])) / 1e18;
  const hasDesk = toBig(byId[0]) !== 0n;
  const share = globalAlpha > 0 ? userAlpha / globalAlpha : 0;
  const perDay = emissionRate * share * 86400;
  const roster = inferRoster(bwUsed, seatsUsed, prestigeBps > 0 ? Math.round(userAlpha * 10000 / prestigeBps) : userAlpha);
  return { hasDesk, pendingPnL, userAlpha, globalAlpha, emissionRate, deskLevel, deskSeats, deskBandwidth, seatsUsed, bwUsed, prestigeBps, seatedRoster: roster, balance, share, perDay };
}

// Which pool transactions were liquidity moves rather than trades. Cached ~10min and shared, so a
// per-wallet lookup doesn't rescan the pool every time. Keeps its last good set on an RPC failure.
let lpTx = { add: new Set(), rem: new Set(), at: 0 };
async function lpTxSets() {
  if (Date.now() - lpTx.at < 600000 && (lpTx.add.size || lpTx.rem.size)) return lpTx;
  const logs = await ethGetLogs({ address: FLOOR_POOL, topics: [[POOL_MINT_TOPIC, POOL_BURN_TOPIC, POOL_COLLECT_TOPIC]] });
  if (!logs) return lpTx;
  const add = new Set(), rem = new Set();
  logs.forEach(l => { (l.topics[0] === POOL_MINT_TOPIC ? add : rem).add(l.transactionHash); });
  lpTx = { add, rem, at: Date.now() };
  return lpTx;
}

// A wallet's lifetime FLOOR flow, read straight from the chain.
//
// Was: Blockscout's paginated token-transfers, leaning on its decoded `method` string to name purchases.
// That endpoint has been failing (503/rate-limit), which silently emptied this route and the MCP's
// get_player. Robinscout can't replace it either — it exposes address SUMMARY and single-tx only, no
// transfer list (its address page is server-rendered), and routing every lookup through its LLM agent
// would be slow, non-deterministic and on someone else's bill.
//
// So: the RPC is the authoritative source. Two topic-filtered getLogs give every FLOOR transfer in/out
// with no pagination and no 15-page truncation, and the game contract's OWN events name each purchase
// (joined by tx hash) — strictly better than trusting an explorer's method-string decoding.
async function fetchPlayer(addr) {
  const A = addr.toLowerCase();
  const pad = a => '0x' + a.replace(/^0x/, '').padStart(64, '0');
  const amtOf = d => { try { return Number(BigInt(d)) / 1e18; } catch { return 0; } };
  const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;

  const [inLogs, outLogs, gameLogs] = await Promise.all([
    ethGetLogs({ address: FLOOR_ADDR, topics: [TRANSFER_TOPIC, null, pad(A)] }),
    ethGetLogs({ address: FLOOR_ADDR, topics: [TRANSFER_TOPIC, pad(A)] }),
    ethGetLogs({ address: GAME_CONTRACT, topics: [null, pad(A)] }),   // this wallet's game actions
  ]);
  // Throw rather than return zeros: the caller turns this into null + unknownFields, because "sold 0"
  // and "we couldn't find out" are different claims and an agent will repeat whichever it's handed.
  if (!inLogs || !outLogs) throw new Error('transfer logs unavailable');

  // A transfer to the pool is NOT automatically a sell — providing liquidity moves tokens there too, and
  // conflating the two is what made this site report its own LP as the single biggest player dump.
  const lp = await lpTxSets();
  let mint = 0, inOther = 0, out = 0, sold = 0, bought = 0, lpAdded = 0, lpWithdrawn = 0, gameSpend = 0;
  inLogs.forEach(l => {
    const from = addrOf(l.topics[1]), v = amtOf(l.data);
    if (from === ZERO_ADDR) { mint += v; return; }
    inOther += v;
    if (from === FLOOR_POOL) { lp.rem.has(l.transactionHash) ? lpWithdrawn += v : bought += v; }
  });
  const spends = [];
  outLogs.forEach(l => {
    const to = addrOf(l.topics[2]), v = amtOf(l.data);
    out += v;
    if (to === FLOOR_POOL) { lp.add.has(l.transactionHash) ? lpAdded += v : sold += v; }
    if (to === GAME_CONTRACT) { gameSpend += v; spends.push({ amt: Math.round(v), tx: l.transactionHash, block: parseInt(l.blockNumber, 16) }); }
  });

  // name each purchase from the game event emitted in the same transaction
  const kindByTx = {};
  (gameLogs || []).forEach(l => { const k = LIVE_TOPICS[l.topics[0]]; if (k) kindByTx[l.transactionHash] = k; });
  spends.sort((a, b) => a.block - b.block);
  const recent = spends.slice(-60);
  const blocks = [...new Set(recent.map(s => s.block))].slice(0, 60);
  const ts = {};
  if (blocks.length) {
    const b = await rpcBatch(blocks.map((n, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] })), 4);
    if (b) blocks.forEach((n, i) => { const blk = b[i]; if (blk && blk.timestamp) ts[n] = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(); });
  }
  let deskLevel = 0; const operators = {}; const purchases = [];
  for (const s of recent) {
    const kind = kindByTx[s.tx];
    if (kind === 'upgrade') { deskLevel++; purchases.push({ amt: s.amt, what: 'Desk upgrade', ts: ts[s.block] || null }); }
    else if (kind === 'recruit' || kind === 'starter') {
      const name = OP_COST[s.amt] || ('Operator (' + s.amt + ')');
      operators[name] = (operators[name] || 0) + 1;
      purchases.push({ amt: s.amt, what: name, ts: ts[s.block] || null });
    } else purchases.push({ amt: s.amt, what: kind || 'game action', ts: ts[s.block] || null });
  }
  const count = inLogs.length + outLogs.length;
  // in − out is the exact balance when every transfer is accounted for, which topic-filtered logs are.
  // It doubles as a self-check: if this drifts from balanceOf, the scan missed something.
  const bal = Math.max(0, mint + inOther - out);
  return { addr: A, mint, inOther, out, sold, bought, lpAdded, lpWithdrawn, bal, count,
    partial: false, earnedKnown: true, spend: gameSpend, deskLevel, operators, purchases,
    spendKnown: true, source: 'rpc', updatedAt: Date.now() };
}

// ---- top holders leaderboard (cached) ----
let holders = null, holdersAt = 0;
const opArtCache = {};
try { const p = JSON.parse(fs.readFileSync(HOLDERS_FILE, 'utf8')); if (p && Array.isArray(p.holders)) { holders = p.holders; holdersAt = p.at || 0; console.log('LOADED holders from volume'); } } catch (_) {}
async function refreshHolders() {
  try {
    if (!tokenStats) await refreshTokenStats();          // ensure supply is known for % calc
    const h = await sfetch(`${EXPLORER}/api/v2/tokens/${FLOOR_ADDR}/holders`);
    const supply = tokenStats ? tokenStats.supply : 0;
    holders = (h.items || []).slice(0, 25).map(x => ({
      address: x.address.hash, name: x.address.name || null, isContract: !!x.address.is_contract,
      value: Number(x.value) / 1e18, pct: supply ? (Number(x.value) / 1e18 / supply * 100) : 0
    }));
    holdersAt = Date.now();
    try { fs.writeFile(HOLDERS_FILE, JSON.stringify({ holders, at: holdersAt }), () => {}); } catch (_) {}
    console.log('HOLDERS ok (' + holders.length + ')');
  } catch (e) { console.log('HOLDERS refresh failed: ' + e.message); }
}
refreshHolders();
setInterval(refreshHolders, 180000);          // every 3 min

// ---- player distribution: desk-tier histogram + alpha concentration (heavy; cached ~45 min) ----
let distribution = null, distAt = 0, distBusy = false;
const seenPlayers = new Set();   // cumulative across runs — converges even if a pagination pass hiccups
let codeCache = {};              // addr -> 1 (contract) | 0 (EOA); persisted — each addr is screened once ever
try { const p = JSON.parse(fs.readFileSync(DIST_FILE, 'utf8')); if (p && p.dist) { distribution = p.dist; distAt = p.at || 0; (p.players || []).forEach(a => seenPlayers.add(a)); codeCache = p.codeCache || {}; console.log('LOADED distribution from volume (' + seenPlayers.size + ' known players)'); } } catch (_) {}
async function refreshDistribution() {
  if (distBusy) return; distBusy = true;
  const RPC = 'https://rpc.mainnet.chain.robinhood.com', G = '0x89d40f5e4d260577691d05e681d47519eb44f113';
  const GET_DESK = '0x3656bc36', USER_ALPHA = '0xd53c636f', PENDING = '0x99ef54a1';
  const argOf = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  try {
    // 1) enumerate players from the game contract's full event history via one eth_getLogs call.
    //    The player address is topics[1] on every event. Fast (~1s) and reliable — Blockscout's
    //    tx pagination 500s under load; the RPC has no block-range cap here (~3k logs total).
    const topicAddr = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
    const players = new Set();
    let logs = [];
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: G, fromBlock: '0x0', toBlock: 'latest' }] }) });
      logs = (await r.json()).result || [];
    } catch (_) {}
    logs.forEach(l => { const a = topicAddr(l.topics && l.topics[1]); if (a && a !== '0x0000000000000000000000000000000000000000') players.add(a); });
    players.forEach(a => seenPlayers.add(a));        // union into cumulative set (survives an empty log fetch)
    const list = [...seenPlayers];                   // read desk/alpha for every player ever seen
    console.log('DIST enumerated ' + players.size + ' from ' + logs.length + ' logs, ' + list.length + ' cumulative');
    // 2) batch getDesk (level) + userAlphaPower for each via JSON-RPC batches (20 addrs = 40 calls; larger batches get rejected as one error obj)
    const byLevel = {}; const alphas = []; let badBatches = 0, unclaimed = 0;
    const readChunk = async (chunk) => {
      const calls = [];
      chunk.forEach(a => { calls.push({ to: G, data: GET_DESK + argOf(a) }); calls.push({ to: G, data: USER_ALPHA + argOf(a) }); calls.push({ to: G, data: PENDING + argOf(a) }); });
      const body = calls.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [c, 'latest'] }));
      const byId = await rpcBatch(body, 6);
      if (!byId) return false;
      const res = calls.map((_, k) => byId[k]);
      for (let k = 0; k < chunk.length; k++) {
        const desk = res[k * 3], ua = res[k * 3 + 1], pen = res[k * 3 + 2];
        const hasStruct = desk && desk.length > 66;      // full getDesk struct = real player (not a stray topic addr)
        let lvl = 0, a = 0;
        try { if (hasStruct) lvl = Number(BigInt('0x' + desk.slice(2, 66))); } catch (_) {}
        try { if (ua && ua.length >= 66) a = Number(BigInt(ua)); } catch (_) {}
        try { if (pen && pen.length >= 66) unclaimed += Number(BigInt(pen)) / 1e18; } catch (_) {}
        if (hasStruct || a > 0) { if (lvl >= 0 && lvl <= 10) byLevel[lvl] = (byLevel[lvl] || 0) + 1; if (a > 0) alphas.push({ addr: chunk[k], v: a }); }
      }
      return true;
    };
    const failedChunks = [];
    for (let i = 0; i < list.length; i += 15) {
      const chunk = list.slice(i, i + 15);
      if (!(await readChunk(chunk))) failedChunks.push(chunk);
      await new Promise(s => setTimeout(s, 80));
    }
    if (failedChunks.length) {                            // second pass after a cooldown — a dropped chunk means missing players.
      await new Promise(s => setTimeout(s, 2500));        // retry in 5-addr slices: heavy throttling rejects big batches but lets small ones through
      for (const chunk of failedChunks) {
        for (let j = 0; j < chunk.length; j += 5) {
          if (!(await readChunk(chunk.slice(j, j + 5)))) badBatches++;
          await new Promise(s => setTimeout(s, 250));
        }
      }
    }
    alphas.sort((a, b) => b.v - a.v);
    // verify earners are real player wallets (EOAs), not pools/contracts — screen EVERY alpha wallet,
    // cached persistently (an address's contract-ness never flips), so each addr costs one eth_getCode ever
    const unknown = alphas.map(r => r.addr).filter(a => !(a in codeCache));
    for (let i = 0; i < unknown.length; i += 15) {
      const chunk = unknown.slice(i, i + 15);
      const codeBody = chunk.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getCode', params: [a, 'latest'] }));
      const codes = await rpcBatch(codeBody, 5);
      if (!codes) continue;                                 // unknowns stay unknown; re-checked next run
      // EIP-7702 delegated EOAs (code = 0xef0100 + addr) are real players on a smart wallet — only true contracts are excluded
      chunk.forEach((a, k) => { const c = codes[k] || '0x'; codeCache[a] = (c !== '0x' && !c.startsWith('0xef0100')) ? 1 : 0; });
      await new Promise(s => setTimeout(s, 80));
    }
    alphas.forEach(r => { if (codeCache[r.addr] === 1) r.isContract = true; });
    const contractsExcluded = alphas.filter(r => r.isContract).length;
    const clean = alphas.filter(r => !r.isContract);
    const totalAlpha = clean.reduce((s, r) => s + r.v, 0) || 1;
    const top = n => clean.slice(0, n).reduce((s, r) => s + r.v, 0);
    const withDesk = Object.values(byLevel).reduce((s, n) => s + n, 0);
    const fresh = { players: list.length, withDesk, byLevel, alphaPlayers: clean.length, totalAlpha,
      top10Pct: top(10) / totalAlpha * 100, topPct: (clean[0] ? clean[0].v : 0) / totalAlpha * 100,
      top1Pct: top(Math.max(1, Math.ceil(clean.length * 0.01))) / totalAlpha * 100,
      contractsExcluded, unclaimed: Math.round(unclaimed), updatedAt: Date.now() };
    const priorWithDesk = (distribution && distribution.withDesk) || 0;
    // healthy = we read desks for most of the players we ourselves enumerated (list.length is the ground truth),
    // AND we didn't shrink >50% vs the last good run. A throttled run fails this even with an empty prior cache.
    const healthy = withDesk >= Math.max(1, priorWithDesk * 0.5, Math.ceil(list.length * 0.6));
    if (healthy) {
      distribution = fresh; distAt = Date.now();
      try { fs.writeFile(DIST_FILE, JSON.stringify({ dist: distribution, at: distAt, players: list, codeCache }), () => {}); } catch (_) {}
      console.log('DIST ok players=' + list.length + ' withDesk=' + withDesk + ' top10=' + fresh.top10Pct.toFixed(1) + '% badBatches=' + badBatches);
    } else {
      console.log('DIST skip (throttled): withDesk=' + withDesk + ' < prior ' + priorWithDesk + ' badBatches=' + badBatches + ' — keeping last good, retry in 5m');
      setTimeout(refreshDistribution, 300000);           // self-heal well before the 45-min interval
    }
  } catch (e) { console.log('DIST refresh failed: ' + e.message + ' — retry in 5m'); setTimeout(refreshDistribution, 300000); }
  finally { distBusy = false; }
}
setTimeout(refreshDistribution, 20000);       // stagger 20s after boot so token-stats' RPC read settles first
setInterval(refreshDistribution, 2700000);    // every 45 min

// ---- player vs trader behavior: what desk owners do with $FLOOR vs pure traders (cached ~1h) ----
const BEHAVIOR_FILE = path.join(DATA_DIR, 'behavior.json');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Uniswap-V3 pool lifecycle events. A FLOOR Transfer in/out of the pool inside one of these txs is a
// LIQUIDITY move, not a trade — counting them as sells/buys is wrong (verified 2026-07-16: 142 LP adds
// = 1,374,969 FLOOR were being reported as "player sells", 984,344 of it from a single LP that has
// never sold a token). Mint = add liquidity; Burn+Collect = withdraw principal / claim fees.
const POOL_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const POOL_BURN_TOPIC = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';
const POOL_COLLECT_TOPIC = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0';
let behavior = null, behaviorAt = 0, behaviorBusy = false;

// ---- shared address screening. Fills the persistent `codeCache` declared with the distribution job
// (addr -> 1 contract | 0 EOA); contract-ness never flips, so each address costs one eth_getCode ever
// and both jobs share the result. Uses the SAME rule as refreshDistribution: an EIP-7702 delegated EOA
// (code = 0xef0100 + addr) is a real player on a smart wallet, NOT a contract — on this chain that's
// 62 wallets / ~455k FLOOR of sell volume that must not be written off as bot flow. ----
// codeCache is declared with the distribution job, but that job only persists the alpha wallets it
// happens to see (inside DIST_FILE). The pool counterparties screened here must be persisted too —
// without this the job re-screens ~1,850 addresses on EVERY boot, never finishes under a throttling
// RPC, and every unresolved address silently lands in `routed`, deflating the attributable share.
const CODE_FILE = path.join(DATA_DIR, 'codecache.json');
// Seed shipped in the repo so a fresh volume (or a new Railway deploy) starts warm. Without it the first
// run must screen ~2,000 addresses against an endpoint that throttles at boot, and until it converges the
// job correctly HOLDS — meaning prod would keep serving the old, wrong number for however long that takes.
// Contract-ness is immutable, so a stale seed can never be wrong; the volume copy just layers on top.
try { const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'codecache.seed.json'), 'utf8')); if (s && typeof s === 'object') Object.assign(codeCache, s); } catch (_) {}
try { const c = JSON.parse(fs.readFileSync(CODE_FILE, 'utf8')); if (c && typeof c === 'object') Object.assign(codeCache, c); } catch (_) {}
console.log('SCREENED addresses known at boot: ' + Object.keys(codeCache).length);
function saveCodeCache() { try { fs.writeFile(CODE_FILE, JSON.stringify(codeCache), () => {}); } catch (_) {} }
// Degrades gracefully: a batch the RPC throttles is left unknown and retried on the next run, and an
// unknown address is treated as unattributed rather than guessed — so a partial screen publishes a
// conservative number instead of a wrong one, and self-heals as the cache fills.
async function screenAddrs(list) {
  const unknown = [...new Set(list)].filter(a => a && !(a in codeCache));
  if (!unknown.length) return;
  console.log('SCREEN ' + unknown.length + ' new addresses (batched, cached forever)…');
  let done = 0, unresolved = 0;
  for (let i = 0; i < unknown.length; i += 25) {
    const chunk = unknown.slice(i, i + 25);
    const codes = await rpcBatch(chunk.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getCode', params: [a, 'latest'] })), 5);
    if (!codes) { unresolved += chunk.length; continue; }  // stays unknown; re-checked next run
    chunk.forEach((a, k) => { const c = codes[k] || '0x'; codeCache[a] = (c !== '0x' && !c.startsWith('0xef0100')) ? 1 : 0; });
    done += chunk.length;
    if (done % 500 < 25) saveCodeCache();                  // checkpoint: a slow run must not lose its work
    await new Promise(s => setTimeout(s, 80));
  }
  saveCodeCache();
  console.log('SCREEN done=' + done + ' unresolved=' + unresolved + ' known=' + Object.keys(codeCache).length);
}
try { const p = JSON.parse(fs.readFileSync(BEHAVIOR_FILE, 'utf8')); if (p && p.behavior) { behavior = p.behavior; behaviorAt = p.at || 0; console.log('LOADED behavior from volume'); } } catch (_) {}
// Patient by design: Railway's egress IP gets rate-limited, and a single give-up here fails the whole
// behavior job ("flow logs unavailable"), which then holds the stat on its last — wrong — value.
// ~25s of backoff per scan is cheap for an hourly background job.
async function ethGetLogs(filter) {
  for (let i = 0; i < 7; i++) {
    try {
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...filter, fromBlock: '0x0', toBlock: 'latest' }] }) });
      const j = await r.json();
      if (Array.isArray(j.result)) return j.result;
    } catch (_) {}
    await new Promise(s => setTimeout(s, 1200 * (i + 1)));
  }
  return null;
}
async function refreshBehavior() {
  if (behaviorBusy) return; behaviorBusy = true;
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
  const amt = d => { try { return Number(BigInt(d)) / 1e18; } catch { return 0; } };
  try {
    // Desk owners = wallets that ever transacted with the game contract (topics[1] on its events).
    // Contracts get filtered out: routers/MM bots touch the game contract too, and counting them as
    // "desk owners" attributes bot volume to players (10 of 233 were contracts before this filter).
    console.log('BEHAVIOR start…');
    const gl = await ethGetLogs({ address: GAME_CONTRACT });
    if (!gl) throw new Error('game logs unavailable');
    const cand = new Set();
    gl.forEach(l => { const a = addrOf(l.topics && l.topics[1]); if (a && a !== '0x0000000000000000000000000000000000000000') cand.add(a); });

    // FLOOR flows, targeted by counterparty: to pool = SELL, from pool = BUY, to game = REINVEST(75% burns)
    const sells = await ethGetLogs({ address: FLOOR_ADDR, topics: [TRANSFER_TOPIC, null, pad(FLOOR_POOL)] });
    const buys = await ethGetLogs({ address: FLOOR_ADDR, topics: [TRANSFER_TOPIC, pad(FLOOR_POOL)] });
    const spends = await ethGetLogs({ address: FLOOR_ADDR, topics: [TRANSFER_TOPIC, null, pad(GAME_CONTRACT)] });
    // Liquidity txs — their pool transfers are LP moves, not trades. Verified: no LP tx also contains a
    // swap, so excluding the whole tx drops zero real trade volume. Fetched as ONE topic-OR query: this
    // job already leans on a rate-limited RPC, and three separate scans was enough extra load to make it
    // fail outright from Railway's egress ("flow logs unavailable").
    const lpLogs = await ethGetLogs({ address: FLOOR_POOL, topics: [[POOL_MINT_TOPIC, POOL_BURN_TOPIC, POOL_COLLECT_TOPIC]] });
    if (!sells || !buys || !spends || !lpLogs) throw new Error('flow logs unavailable');
    const lpInTx = new Set(lpLogs.filter(l => l.topics[0] === POOL_MINT_TOPIC).map(l => l.transactionHash));
    const lpOutTx = new Set(lpLogs.filter(l => l.topics[0] !== POOL_MINT_TOPIC).map(l => l.transactionHash));

    // Screen every wallet we're about to classify in one batched pass (cached forever), then bucket.
    const cpsOf = (arr, side) => arr.map(l => addrOf(side === 'from' ? l.topics[1] : l.topics[2])).filter(Boolean);
    await screenAddrs([...cand, ...cpsOf(sells, 'from'), ...cpsOf(buys, 'to'), ...cpsOf(spends, 'from')]);
    const players = new Set([...cand].filter(a => codeCache[a] === 0));   // desk owners = screened humans only
    if (!players.size) throw new Error('player set empty (code screening failed?)');

    // Buckets, because a swap routed through an aggregator/bot arrives from the CONTRACT, not the human —
    // most pool sell volume does. Calling those "traders" invented a precision we don't have.
    // `unscreened` is deliberately NOT folded into `routed`: "this is a bot" and "we failed to look it up"
    // are different claims, and conflating them is what silently published a 14% attributable share off a
    // half-finished screen. It gates publication below instead.
    const bucket = (arr, side, lpTx) => {
      let player = 0, trader = 0, routed = 0, lp = 0, unscreened = 0;
      for (const l of arr) {
        const v = amt(l.data);
        if (lpTx.has(l.transactionHash)) { lp += v; continue; }
        const cp = addrOf(side === 'from' ? l.topics[1] : l.topics[2]);
        const kind = cp ? codeCache[cp] : undefined;
        if (kind === undefined) { unscreened += v; continue; }
        if (kind === 1) { routed += v; continue; }
        players.has(cp) ? player += v : trader += v;
      }
      return { player, trader, routed, lp, unscreened };
    };
    const NO_LP = new Set();
    const S = bucket(sells, 'from', lpInTx);
    const B = bucket(buys, 'to', lpOutTx);
    const R = bucket(spends, 'from', NO_LP);
    const attributable = S.player + S.trader;          // real swap sells we can tie to a wallet
    const sellVol = attributable + S.routed;
    // How much sell volume we simply couldn't classify this run. Publishing while this is high would
    // understate the attributable share and overstate bot flow, so it blocks the commit below.
    const unscreenedShare = (sellVol + S.unscreened) > 0 ? S.unscreened / (sellVol + S.unscreened) : 0;
    const fresh = {
      players: players.size,
      player: { reinvested: Math.round(R.player), sold: Math.round(S.player), bought: Math.round(B.player), net: Math.round(B.player - S.player) },
      trader: { sold: Math.round(S.trader), bought: Math.round(B.trader), net: Math.round(B.trader - S.trader) },
      routed: { sold: Math.round(S.routed), bought: Math.round(B.routed) },          // via aggregator/bot — no human attributable
      liquidity: { added: Math.round(S.lp), withdrawn: Math.round(B.lp) },           // excluded from buy/sell entirely
      playerSellShare: attributable > 0 ? S.player / attributable * 100 : 0,         // % of ATTRIBUTABLE sells from desk owners
      attributableShare: sellVol > 0 ? attributable / sellVol * 100 : 0,             // how much of sell volume we can attribute at all
      v: 2,
      updatedAt: Date.now(),
    };
    // Sanity-floor against a partial scrape, but only vs a same-schema prior: v1 totals counted LP and
    // bot volume as player activity, so comparing v2 against them would skip-and-retry forever.
    const priorReinv = (behavior && behavior.v === 2 && behavior.player && behavior.player.reinvested) || 0;
    const healthy = fresh.player.reinvested >= Math.max(1, priorReinv * 0.5) && sellVol > 0;
    if (healthy && unscreenedShare <= 0.02) {                                        // healthy — commit
      behavior = fresh; behaviorAt = Date.now();
      try { fs.writeFile(BEHAVIOR_FILE, JSON.stringify({ behavior, at: behaviorAt }), () => {}); } catch (_) {}
      console.log('BEHAVIOR ok players=' + players.size + ' reinvest=' + fresh.player.reinvested + ' playerSellShare=' + fresh.playerSellShare.toFixed(1) + '% attributable=' + fresh.attributableShare.toFixed(1) + '%');
    } else if (!healthy) {
      console.log('BEHAVIOR skip (partial): reinvest=' + fresh.player.reinvested + ' sellVol=' + Math.round(sellVol) + ' — retry 5m');
      setTimeout(refreshBehavior, 300000);
    } else {
      // Screening incomplete (throttled RPC). Keep the last good number rather than publish a wrong one;
      // the code cache is persisted, so each retry resumes where this one stopped.
      console.log('BEHAVIOR hold: ' + (unscreenedShare * 100).toFixed(1) + '% of sell volume unscreened — retry 5m');
      setTimeout(refreshBehavior, 300000);
    }
  } catch (e) { console.log('BEHAVIOR failed: ' + e.message + ' — retry 5m'); setTimeout(refreshBehavior, 300000); }
  finally { behaviorBusy = false; }
}
// Runs late: this job is RPC-hungry (7 log scans + a one-time screen of ~1,850 addresses) and the boot
// stampede (live/stats/holders/dist) gets the endpoint throttling, which starves its batches.
setTimeout(refreshBehavior, 180000);
setInterval(refreshBehavior, 3600000);        // hourly

// ---- firms & free agents: recruiting board (firm contract 0x26c615..; cached ~1h) ----
const FIRM_CONTRACT = '0x26c615b58cf162a00ed5ae009e16ed8ab4265b36';
const FIRM_FILE = path.join(DATA_DIR, 'firms.json');
const TOPIC_JOIN_REQ = '0x45a9395af8803805c830b5c9f65e10cd8f75706b5220931c11184880350d489e';
const TOPIC_JOIN_APP = '0xc3685ccc1089f78aab412b6ade28f0c9ff18ac60ae601e9d4bd8f34e875a65bf';
async function rpcCall(to, data) { const b = await rpcBatch([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to, data }, 'latest'] }], 4); return b ? b[0] : null; }
let firms = null, firmsAt = 0, firmsBusy = false;
try { const p = JSON.parse(fs.readFileSync(FIRM_FILE, 'utf8')); if (p && p.firms) { firms = p.firms; firmsAt = p.at || 0; console.log('LOADED firms from volume'); } } catch (_) {}
async function refreshFirms() {
  if (firmsBusy) return; firmsBusy = true;
  const F = FIRM_CONTRACT, G = GAME_CONTRACT;
  const SELc = { firmCount: '0xba85e2f6', getFirm: '0x73934ceb', firmOf: '0x78993074', contributedOf: '0xbc4849ec', userAlpha: '0xd53c636f', getDesk: '0x3656bc36' };
  const argA = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const argN = n => BigInt(n).toString(16).padStart(64, '0');
  const big = h => { try { return BigInt(h || '0x0'); } catch { return 0n; } };
  const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
  const decStr = (hex, wordOffset) => {                       // decode a dynamic string in an ABI blob at word offset
    try { const off = Number(big('0x' + hex.slice(2 + wordOffset * 64, 2 + wordOffset * 64 + 64))); const lenPos = 2 + off * 2; const len = Number(big('0x' + hex.slice(lenPos, lenPos + 64))); const data = hex.slice(lenPos + 64, lenPos + 64 + len * 2); return Buffer.from(data, 'hex').toString('utf8'); } catch { return ''; }
  };
  try {
    const count = Number(big(await rpcCall(F, SELc.firmCount)));
    if (!count) throw new Error('firmCount 0');
    // read each firm (getFirm returns: string name, address principal, uint64 createdAt, uint32 memberCount, uint256 totalContributed, uint256 officeTier, uint256 boostBps, uint32 memberCap)
    const firmList = [];
    for (let id = 1; id <= count; id++) {
      const raw = await rpcCall(F, SELc.getFirm + argN(id));
      if (!raw || raw.length < 66 * 8) continue;
      const hex = raw;
      const word = i => big('0x' + hex.slice(2 + i * 64, 2 + i * 64 + 64));
      firmList.push({
        id, name: decStr(hex, 0) || ('Firm ' + id),
        leader: '0x' + hex.slice(2 + 1 * 64 + 24, 2 + 2 * 64),
        members: Number(word(3)), totalContributed: Math.round(Number(word(4)) / 1e18),
        officeTier: Number(word(5)), boostPct: Number(word(6)) / 100, cap: Number(word(7)),
      });
    }
    // pending join requests = JoinRequested minus JoinApproved
    const reqLogs = await ethGetLogs({ address: F, topics: [TOPIC_JOIN_REQ] });
    const appLogs = await ethGetLogs({ address: F, topics: [TOPIC_JOIN_APP] });
    if (!reqLogs || !appLogs) throw new Error('join logs unavailable');
    const approved = new Set(); appLogs.forEach(l => approved.add(BigInt(l.topics[1]).toString() + ':' + addrOf(l.topics[2])));
    const pendByFirm = {}; const pendSet = new Set();
    reqLogs.forEach(l => { const f = BigInt(l.topics[1]).toString(), u = addrOf(l.topics[2]); const k = f + ':' + u; if (!approved.has(k) && !pendSet.has(k)) { pendSet.add(k); pendByFirm[f] = (pendByFirm[f] || 0) + 1; } });
    firmList.forEach(fm => fm.pending = pendByFirm[fm.id] || 0);
    const pendingTotal = Object.values(pendByFirm).reduce((s, n) => s + n, 0);
    const openSlots = firmList.reduce((s, fm) => s + Math.max(0, fm.cap - fm.members), 0);
    // contributor leaderboard: sum Contributed(firmId,user,amount,firmTotal) events per user
    const TOPIC_CONTRIB = '0xdcfa71ee125a676f843733d9d39dce2c918ecf9e92f96db4f24bdb5244ed68a0';
    const firmName = {}; firmList.forEach(fm => firmName[fm.id] = fm.name);
    const contribLogs = await ethGetLogs({ address: F, topics: [TOPIC_CONTRIB] });
    const byUser = {};
    (contribLogs || []).forEach(l => { const u = addrOf(l.topics[2]); const fid = BigInt(l.topics[1]).toString(); const amt = Number(big('0x' + l.data.slice(2, 66))) / 1e18; if (!byUser[u]) byUser[u] = { addr: u, total: 0, firm: firmName[fid] || ('Firm ' + fid) }; byUser[u].total += amt; byUser[u].firm = firmName[fid] || byUser[u].firm; });
    const contributors = Object.values(byUser).map(c => ({ addr: c.addr, total: Math.round(c.total), firm: c.firm })).sort((a, b) => b.total - a.total).slice(0, 20);
    // free agents = desk owners with firmOf==0, ranked by alpha; include contribution history
    const gl = await ethGetLogs({ address: G });
    const players = []; const seen = new Set();
    (gl || []).forEach(l => { const a = addrOf(l.topics && l.topics[1]); if (a && a !== '0x0000000000000000000000000000000000000000' && !seen.has(a)) { seen.add(a); players.push(a); } });
    const agents = [];
    const firmByAddr = {};   // addr -> firmId, for every seated member (powers the office pods)
    const readAgents = async (chunk) => {
      const calls = [];
      chunk.forEach(a => { calls.push({ to: F, data: SELc.firmOf + argA(a) }); calls.push({ to: G, data: SELc.userAlpha + argA(a) }); calls.push({ to: F, data: SELc.contributedOf + argA(a) }); });
      const body = calls.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [c, 'latest'] }));
      const byId = await rpcBatch(body, 6);
      if (!byId) return false;
      for (let k = 0; k < chunk.length; k++) {
        const fo = Number(big(byId[k * 3])), alpha = Number(big(byId[k * 3 + 1])), contrib = Math.round(Number(big(byId[k * 3 + 2])) / 1e18);
        if (fo === 0 && alpha > 0) agents.push({ addr: chunk[k], alpha, contributed: contrib });
        else if (fo > 0 && alpha > 0) firmByAddr[chunk[k]] = fo;
      }
      return true;
    };
    const failedChunks = [];
    for (let i = 0; i < players.length; i += 12) {
      const chunk = players.slice(i, i + 12);
      if (!(await readAgents(chunk))) failedChunks.push(chunk);
      await new Promise(s => setTimeout(s, 60));
    }
    if (failedChunks.length) {                          // retry throttled chunks in small slices
      await new Promise(s => setTimeout(s, 2500));
      for (const chunk of failedChunks) {
        for (let j = 0; j < chunk.length; j += 4) { await readAgents(chunk.slice(j, j + 4)); await new Promise(s => setTimeout(s, 200)); }
      }
    }
    agents.sort((a, b) => b.alpha - a.alpha);
    const fresh = {
      firms: firmList, firmCount: count, pendingTotal, openSlots,
      allFull: openSlots === 0,
      freeAgentCount: agents.length,
      freeAgents: agents.slice(0, 15).map(a => ({ addr: a.addr, alpha: a.alpha, contributed: a.contributed })),
      firmByAddr,
      contributors,
      updatedAt: Date.now(),
    };
    const priorPending = (firms && firms.pendingTotal) || 0;
    if (firmList.length > 0 && (reqLogs.length > 0)) {
      firms = fresh; firmsAt = Date.now();
      try { fs.writeFile(FIRM_FILE, JSON.stringify({ firms, at: firmsAt }), () => {}); } catch (_) {}
      console.log('FIRMS ok count=' + count + ' pending=' + pendingTotal + ' openSlots=' + openSlots + ' freeAgents=' + agents.length);
    } else {
      console.log('FIRMS skip (partial) — retry 5m'); setTimeout(refreshFirms, 300000);
    }
  } catch (e) { console.log('FIRMS failed: ' + e.message + ' — retry 5m'); setTimeout(refreshFirms, 300000); }
  finally { firmsBusy = false; }
}
setTimeout(refreshFirms, 50000);              // stagger after behavior
setInterval(refreshFirms, 3600000);           // hourly

// ---- leaderboards: rank-by-alpha (feeds report rank + office) + the Recruiter Race (cached ~30 min) ----
const LEADER_FILE = path.join(DATA_DIR, 'leaderboard.json');
const TOPIC_DESK_CREATED = '0xae270c7310a53fafb8d7ba304bfccd5f6280f2851045afc83c53d4530676be24';
let leaderboard = null, leaderAt = 0, leaderBusy = false;
try { const p = JSON.parse(fs.readFileSync(LEADER_FILE, 'utf8')); if (p && p.lb) { leaderboard = p.lb; leaderAt = p.at || 0; console.log('LOADED leaderboard from volume'); } } catch (_) {}
async function refreshLeaderboard() {
  if (leaderBusy) return; leaderBusy = true;
  const G = GAME_CONTRACT;
  const SEL = { alpha: '0xd53c636f', referral: '0x31cd6179', getDesk: '0x3656bc36' };
  const argA = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const big = h => { try { return BigInt(h || '0x0'); } catch { return 0n; } };
  const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
  try {
    // players = wallets seen on the game contract
    const gl = await ethGetLogs({ address: G });
    if (!gl) throw new Error('game logs unavailable');
    const players = []; const seen = new Set();
    gl.forEach(l => { const a = addrOf(l.topics && l.topics[1]); if (a && a !== '0x0000000000000000000000000000000000000000' && !seen.has(a)) { seen.add(a); players.push(a); } });
    // recruit counts from DeskCreated(user, referrer): topics[2] = referrer
    const deskLogs = await ethGetLogs({ address: G, topics: [TOPIC_DESK_CREATED] });
    const recruitCount = {}; let totalRecruits = 0;
    (deskLogs || []).forEach(l => { const ref = addrOf(l.topics[2]); if (ref && ref !== '0x0000000000000000000000000000000000000000') { recruitCount[ref] = (recruitCount[ref] || 0) + 1; totalRecruits++; } });
    // per-player: alpha, referralEarned, desk level
    const rows = [];
    const readChunk = async (chunk) => {
      const calls = [];
      chunk.forEach(a => { calls.push({ to: G, data: SEL.alpha + argA(a) }); calls.push({ to: G, data: SEL.referral + argA(a) }); calls.push({ to: G, data: SEL.getDesk + argA(a) }); });
      const byId = await rpcBatch(calls.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [c, 'latest'] })), 6);
      if (!byId) return false;
      for (let k = 0; k < chunk.length; k++) {
        const alpha = Number(big(byId[k * 3]));
        const referral = Number(big(byId[k * 3 + 1])) / 1e18;
        const desk = byId[k * 3 + 2];
        let dl = 0, op = null;
        try {
          if (desk && desk.length >= 2 + 64 * 7) {
            const w = i => Number(big('0x' + desk.slice(2 + i * 64, 2 + i * 64 + 64)));
            dl = w(0);
            const roster = inferRoster(w(5), w(4), alpha);   // (bwUsed, seatsUsed, alpha) -> seated operator names
            if (roster && roster.length) { let bi = -1; for (const nm of roster) { const idx = OPS_STAT.findIndex(o => o[0] === nm); if (idx > bi) bi = idx; } if (bi >= 0) op = OPS_STAT[bi][0]; }
          } else if (desk && desk.length > 66) { dl = Number(big('0x' + desk.slice(2, 66))); }
        } catch (_) {}
        rows.push({ a: chunk[k], alpha, referral: Math.round(referral), recruits: recruitCount[chunk[k]] || 0, dl, op });
      }
      return true;
    };
    const failed = [];
    for (let i = 0; i < players.length; i += 12) { const chunk = players.slice(i, i + 12); if (!(await readChunk(chunk))) failed.push(chunk); await new Promise(s => setTimeout(s, 60)); }
    if (failed.length) { await new Promise(s => setTimeout(s, 2500)); for (const chunk of failed) for (let j = 0; j < chunk.length; j += 4) { await readChunk(chunk.slice(j, j + 4)); await new Promise(s => setTimeout(s, 200)); } }

    const byAlpha = rows.filter(r => r.alpha > 0).sort((x, y) => y.alpha - x.alpha).map((r, i) => ({ a: r.a, alpha: r.alpha, dl: r.dl, op: r.op || null, rank: i + 1 }));
    const recruiters = rows.filter(r => r.referral > 0 || r.recruits > 0).sort((x, y) => y.referral - x.referral).slice(0, 20).map(r => ({ a: r.a, earned: r.referral, recruits: r.recruits }));
    const totalReferral = rows.reduce((s, r) => s + r.referral, 0);
    const fresh = { players: players.length, ranked: byAlpha.length, byAlpha, recruiters, totalRecruits, totalReferral: Math.round(totalReferral), updatedAt: Date.now() };
    const prior = (leaderboard && leaderboard.ranked) || 0;
    if (byAlpha.length >= Math.max(1, prior * 0.5, Math.ceil(players.length * 0.4))) {
      leaderboard = fresh; leaderAt = Date.now();
      try { fs.writeFile(LEADER_FILE, JSON.stringify({ lb: leaderboard, at: leaderAt }), () => {}); } catch (_) {}
      console.log('LEADER ok ranked=' + byAlpha.length + ' recruiters=' + recruiters.length + ' totalRecruits=' + totalRecruits);
    } else { console.log('LEADER skip (partial) ranked=' + byAlpha.length + ' — retry 5m'); setTimeout(refreshLeaderboard, 300000); }
  } catch (e) { console.log('LEADER failed: ' + e.message + ' — retry 5m'); setTimeout(refreshLeaderboard, 300000); }
  finally { leaderBusy = false; }
}
setTimeout(refreshLeaderboard, 65000);        // stagger after firms
setInterval(refreshLeaderboard, 1800000);     // every 30 min

// ---- our own invite link: clicks -> on-chain conversions (admin only) ----
// Every play / deals / FAQ link on the site carries ?ref=<REF_WALLET>. Clicks are just intent — the chain
// is the only proof the link WORKED: DeskCreated(user, referrer) records the recruiter immutably at desk
// creation (topics[2] = referrer), and referralEarned(addr) is the lifetime 5% recruiting bonus. Anyone
// who forks this should set REF_WALLET rather than farm the default.
const REF_WALLET = (process.env.REF_WALLET || '0x30602250c5f1fcbA5407E99B1DFaAB992EA4fFD2').toLowerCase();
const SEL_REFERRAL_EARNED = '0x31cd6179';     // referralEarned(address) — same selector the leaderboard reads
const REF_FILE = path.join(DATA_DIR, 'ref.json');
let refStats = null, refBusy = false;
try { const p = JSON.parse(fs.readFileSync(REF_FILE, 'utf8')); if (p && p.ref) { refStats = p.ref; console.log('LOADED ref stats from volume'); } } catch (_) {}
async function refreshRefStats() {
  if (refBusy) return; refBusy = true;
  try {
    const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
    const logs = await ethGetLogs({ address: GAME_CONTRACT, topics: [TOPIC_DESK_CREATED, null, pad(REF_WALLET)] });
    if (!logs) throw new Error('desk logs unavailable');
    const recruits = logs.map(l => ({ a: addrOf(l.topics[1]), block: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
    // lifetime bonus + a timestamp per recruit, in one batch
    const calls = [{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: GAME_CONTRACT, data: SEL_REFERRAL_EARNED + REF_WALLET.replace(/^0x/, '').padStart(64, '0') }, 'latest'] }];
    recruits.slice(0, 25).forEach((r, i) => calls.push({ jsonrpc: '2.0', id: i + 1, method: 'eth_getBlockByNumber', params: ['0x' + r.block.toString(16), false] }));
    const byId = await rpcBatch(calls, 6);
    if (!byId) throw new Error('referral read unavailable');
    let earned = 0; try { earned = Number(BigInt(byId[0] || '0x0')) / 1e18; } catch (_) {}
    recruits.slice(0, 25).forEach((r, i) => { const b = byId[i + 1]; if (b && b.timestamp) r.ts = parseInt(b.timestamp, 16) * 1000; });
    recruits.sort((a, b) => b.block - a.block);
    refStats = { wallet: REF_WALLET, recruits, earned: +earned.toFixed(4), updatedAt: Date.now() };
    try { fs.writeFile(REF_FILE, JSON.stringify({ ref: refStats }), () => {}); } catch (_) {}
    console.log('REF ok recruits=' + recruits.length + ' earned=' + earned.toFixed(2) + ' FLOOR');
  } catch (e) { console.log('REF failed: ' + e.message + ' — keeping last good, retry 5m'); setTimeout(refreshRefStats, 300000); }
  finally { refBusy = false; }
}
// Runs late and on its own: at 100s it was still colliding with the boot refresh stampede and the
// throttled RPC returned nothing ("desk logs unavailable"). It's cheap, so it just waits its turn.
setTimeout(refreshRefStats, 240000);
setInterval(refreshRefStats, 600000);         // every 10 min

// ---- daily metric snapshots for historical trend charts ----
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
let history = [];
try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); if (Array.isArray(h)) history = h; console.log('LOADED ' + history.length + ' history snapshots'); } catch (_) { console.log('No prior history (fresh)'); }
// Reconstructed history (backfill-history.js), covering the token's life before we started snapshotting —
// prod was down to 2 days of a 14-day-old token. Seeded days only FILL GAPS: a real snapshot for the same
// day always wins, and the live snapshotter overwrites today's row as usual. Rows carry `seeded: true`,
// and any metric that couldn't be honestly reconstructed is absent (not zero) — drawTrend skips those.
try {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'history.seed.json'), 'utf8'));
  if (Array.isArray(seed) && seed.length) {
    const have = new Set(history.map(r => r && r.d));
    const added = seed.filter(r => r && r.d && !have.has(r.d));
    if (added.length) {
      history = history.concat(added).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0).slice(-180);
      console.log('HISTORY seeded +' + added.length + ' reconstructed days -> ' + history.length + ' total');
    }
  }
} catch (_) {}
function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function snapshotHistory() {
  try {
    const s = tokenStats, lb = leaderboard;
    if (!s || !(s.burned > 0 || s.price > 0)) { setTimeout(snapshotHistory, 120000); return; }  // caches cold — retry in 2m
    const row = {
      d: dayKey(Date.now()),
      price: +(s.price || 0),
      marketCap: Math.round(s.marketCap || 0),
      burned: Math.round(s.burned || 0),
      burnedPct: +(s.burnedPct || 0).toFixed(3),
      supply: Math.round(s.supply || 0),
      circulating: Math.round(s.circulating || 0),
      alpha: Math.round(s.globalAlpha || 0),
      holders: +(s.holders || 0),
      vol24: Math.round(s.volume24h || 0),
      players: (lb && lb.players) || 0,
      referral: (lb && lb.totalReferral) || 0,
      recruits: (lb && lb.totalRecruits) || 0,
      ts: Date.now()
    };
    const i = history.findIndex(r => r.d === row.d);
    if (i >= 0) history[i] = row; else history.push(row);
    if (history.length > 180) history = history.slice(-180);
    try { fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {}); } catch (_) {}
    console.log('HISTORY snap ' + row.d + ' price=' + row.price + ' burned=' + row.burned + ' players=' + row.players);
  } catch (e) { console.log('HISTORY snap failed: ' + e.message); }
}
setTimeout(snapshotHistory, 120000);          // 2 min after boot — let token-stats + leaderboard warm
setInterval(snapshotHistory, 21600000);       // every 6h — upserts today's row (latest state wins)

// ---- X (Twitter) handle registry — proxied + cached from the game's own /api/x/profiles ----
// The official site links wallets to X profiles; that endpoint returns ONLY wallets with a linked handle.
// We proxy it server-side (avoids CORS, one fetch shared by all visitors) and cache to the volume.
// ---- Firm Wars leaderboard (basic; client-submitted, sanitized + clamped) ----
const FW_SCORES_FILE = path.join(DATA_DIR, 'fw-scores.json');
let fwScores = [];
try { const j = JSON.parse(fs.readFileSync(FW_SCORES_FILE, 'utf8')); if (Array.isArray(j)) { fwScores = j; console.log('LOADED ' + fwScores.length + ' Firm Wars scores'); } } catch (_) {}
function saveFwScores() { try { fs.writeFile(FW_SCORES_FILE, JSON.stringify(fwScores.slice(0, 300)), () => {}); } catch (_) {} }

const HANDLES_FILE = path.join(DATA_DIR, 'handles.json');
let handles = {};
try { const h = JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); if (h) { handles = h.handles || h; console.log('LOADED ' + Object.keys(handles).length + ' X handles from volume'); } } catch (_) {}
let handlesBusy = false;
async function refreshHandles() {
  if (handlesBusy) return; handlesBusy = true;
  try {
    const src = (leaderboard && leaderboard.byAlpha) ? leaderboard.byAlpha.map(r => r.a) : [];
    if (!src.length) { setTimeout(refreshHandles, 60000); return; }   // wait for the leaderboard to warm
    const fresh = {};
    for (let i = 0; i < src.length; i += 30) {
      const chunk = src.slice(i, i + 30);
      try {
        const r = await fetch('https://thefloor.sh/api/x/profiles?addresses=' + chunk.join(','), { headers: { accept: 'application/json' } });
        if (r.ok) {
          const j = await r.json();
          if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) {
            if (v && v.handle) fresh[k.toLowerCase()] = {
              handle: String(v.handle).replace(/[^A-Za-z0-9_]/g, '').slice(0, 20),
              name: String(v.name || '').slice(0, 60),
              avatar: (typeof v.avatar === 'string' && /^https:\/\//.test(v.avatar)) ? v.avatar.slice(0, 300) : null
            };
          }
        }
      } catch (_) {}
      await new Promise(s => setTimeout(s, 200));   // be polite to the source
    }
    // only commit if we got some (or we had none) — never wipe a good cache when the source is down
    if (Object.keys(fresh).length || !Object.keys(handles).length) {
      handles = fresh;
      try { fs.writeFile(HANDLES_FILE, JSON.stringify({ handles, at: Date.now() }), () => {}); } catch (_) {}
      console.log('HANDLES ok linked=' + Object.keys(handles).length + '/' + src.length);
    } else { console.log('HANDLES source empty — kept ' + Object.keys(handles).length + ' cached'); }
  } catch (e) { console.log('HANDLES failed: ' + e.message); }
  finally { handlesBusy = false; }
}
setTimeout(refreshHandles, 80000);            // after the leaderboard warms
setInterval(refreshHandles, 3600000);         // hourly

// ---- live on-chain action feed (powers the office animations) ----
// Event topics verified against the deployed contracts (cast keccak + 4byte on the emitting tx selectors).
const LIVE_TOPICS = {
  '0x70389b69edd1c02279580aa8febc4539e416926f098d49085745b7060d50f615': 'collect',   // collectPnL()
  '0x5ea52e354c5bf30e5c4375ce0134e3e7bc444da0d737e86a24bf2e8b70259da1': 'claim',     // claim()
  '0xf01bf34936bebf6df7978ec6947afa1505de3401b5472d613a51dc98a4f59495': 'seat',      // OperatorSeated(address,uint256)
  '0x505c5847cc2bc8644df94b9b7029cf870d4f43e5b8ba5b67144268facff041a8': 'recruit',   // via recruitOperator(uint8)
  '0x218a81fc89584689576a0238cab493ca814ec1b58cb4d7d980267af9c696737d': 'starter',   // via recruitStarter()
  '0x2360404a74478febece1a14f11275f22ada88d19ef96f7d785913010bfff4479': 'unseat',    // via unseatOperator(uint256)
  '0xbe86264cd011431fbac84202c8ebc0c710926ecbd2b93b129d4bfc3c4d5a6ea2': 'upgrade',   // DeskUpgraded(address,uint8,uint256)
  '0xae270c7310a53fafb8d7ba304bfccd5f6280f2851045afc83c53d4530676be24': 'newdesk',   // DeskCreated(address,address)
  '0x0a721ab4682ceb61c7e4d264ef879fc419a6d764b136e7d96ef54b2053c75673': 'referral',  // ReferralPaid(address,address,uint256)
};
const TOPIC_FIRM_CONTRIB = '0xdcfa71ee125a676f843733d9d39dce2c918ecf9e92f96db4f24bdb5244ed68a0'; // Contributed -> 100% burn
let liveActions = [];        // rolling, newest first
let lastLiveBlock = 0;       // exclusive lower bound for the next incremental poll
let liveBusy = false;
function decodeLive(l, isFirm) {
  const big = h => { try { return BigInt(h || '0x0'); } catch { return 0n; } };
  const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
  const blk = Number(big(l.blockNumber));
  if (isFirm) {
    if (l.topics[0] !== TOPIC_FIRM_CONTRIB) return null;
    const amt = Number(big('0x' + l.data.slice(2, 66))) / 1e18;
    return { t: 'firmburn', a: addrOf(l.topics[2]), amt: Math.round(amt * 100) / 100, blk };
  }
  const t = LIVE_TOPICS[l.topics[0]];
  if (!t) return null;
  let a = addrOf(l.topics[1]);
  if (t === 'referral') a = addrOf(l.topics[2]) || a;          // credit the recipient
  // primary FLOOR amount = first data word when it looks like wei
  let amt = null;
  if (l.data && l.data.length >= 66) { const v = big('0x' + l.data.slice(2, 66)); if (v > 10n ** 15n) amt = Math.round(Number(v) / 1e18 * 100) / 100; }
  return { t, a, amt, blk };
}
async function refreshLiveActions() {
  if (liveBusy) return; liveBusy = true;
  try {
    const nb = await rpcBatch([{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }], 4);
    if (!nb) throw new Error('blockNumber unavailable');
    const latest = Number(BigInt(nb[0]));
    if (!lastLiveBlock) {
      // boot prefill: one full-range read (proven cheap), keep the newest 60
      const [gl, fl] = [await ethGetLogs({ address: GAME_CONTRACT }), await ethGetLogs({ address: FIRM_CONTRACT, topics: [TOPIC_FIRM_CONTRIB] })];
      const all = [];
      (gl || []).forEach(l => { const d = decodeLive(l, false); if (d && d.a) all.push(d); });
      (fl || []).forEach(l => { const d = decodeLive(l, true); if (d && d.a) all.push(d); });
      all.sort((x, y) => y.blk - x.blk);
      liveActions = all.slice(0, 60);
      lastLiveBlock = latest;
      console.log('LIVE prefilled ' + liveActions.length + ' actions up to block ' + latest);
    } else if (latest > lastLiveBlock) {
      const from = '0x' + (lastLiveBlock + 1).toString(16);
      const [gl, fl] = [await ethGetLogs({ address: GAME_CONTRACT, fromBlock: from }), await ethGetLogs({ address: FIRM_CONTRACT, topics: [TOPIC_FIRM_CONTRIB], fromBlock: from })];
      if (gl === null && fl === null) throw new Error('logs unavailable');
      const fresh = [];
      (gl || []).forEach(l => { const d = decodeLive(l, false); if (d && d.a) fresh.push(d); });
      (fl || []).forEach(l => { const d = decodeLive(l, true); if (d && d.a) fresh.push(d); });
      if (fresh.length) {
        fresh.sort((x, y) => y.blk - x.blk).forEach(d => d.at = Date.now());   // stamp arrival (block ts ~ now for a live window)
        liveActions = fresh.concat(liveActions).slice(0, 60);
        console.log('LIVE +' + fresh.length + ' actions (blocks ' + (lastLiveBlock + 1) + '-' + latest + ')');
      }
      lastLiveBlock = latest;
    }
  } catch (e) { console.log('LIVE poll failed: ' + e.message); }
  finally { liveBusy = false; }
}
setTimeout(refreshLiveActions, 90000);        // stagger after the heavier boot jobs
setInterval(refreshLiveActions, 45000);       // steady 45s cadence (two cheap getLogs)

function track(e) {
  events.push(e);
  if (events.length > MAX) events.shift();
  counts[e.t] = (counts[e.t] || 0) + 1;
  dirty = true;                              // mark for volume flush
  console.log('EVT ' + JSON.stringify(e));   // -> Railway logs for live monitoring
}

// ---- MCP adoption telemetry ----
// Its own store, NOT the page-telemetry events buffer: a popular MCP could churn 8000 events fast and
// evict pageviews/errors. Honest about what it can and can't know — there's no auth, so `connects` counts
// SESSIONS (an agent initializes once per connect) and `clients` are SELF-REPORTED names, not verified
// unique agents. byTool shows what agents actually do (read vs prepare_* = play).
const MCP_STATS_FILE = path.join(DATA_DIR, 'mcpstats.json');
let mcpStats = { connects: 0, calls: 0, byTool: {}, byClient: {}, recent: [], firstAt: 0, lastAt: 0 };
try { const m = JSON.parse(fs.readFileSync(MCP_STATS_FILE, 'utf8')); if (m && typeof m === 'object') mcpStats = Object.assign(mcpStats, m); console.log('LOADED mcp stats (' + mcpStats.connects + ' connects, ' + mcpStats.calls + ' calls)'); } catch (_) {}
let mcpDirty = false;
setInterval(() => { if (!mcpDirty) return; mcpDirty = false; try { fs.writeFile(MCP_STATS_FILE, JSON.stringify(mcpStats), () => {}); } catch (_) {} }, 15000);
const cleanLabel = s => String(s || '').replace(/[^\w./@ +-]/g, '').slice(0, 48) || 'unknown';
function mcpTrack(kind, detail) {
  const now = Date.now();
  if (!mcpStats.firstAt) mcpStats.firstAt = now;
  mcpStats.lastAt = now;
  if (kind === 'connect') { mcpStats.connects++; const c = cleanLabel(detail && detail.client); mcpStats.byClient[c] = (mcpStats.byClient[c] || 0) + 1; mcpStats.recent.unshift({ ts: now, kind, client: c }); }
  else if (kind === 'call') { mcpStats.calls++; const t = cleanLabel(detail && detail.tool); mcpStats.byTool[t] = (mcpStats.byTool[t] || 0) + 1; mcpStats.recent.unshift({ ts: now, kind, tool: t }); }
  if (mcpStats.recent.length > 40) mcpStats.recent.length = 40;
  mcpDirty = true;
}

// One call that answers "what is the state of the floor" — assembled from the same caches the site uses,
// so an agent doesn't need 8 round-trips to get context. Anything not yet warmed is null + named in
// unknownFields; it is never zero-filled, because "0" and "we don't know" are different claims and an
// agent will repeat whichever one we hand it.
const ageOf = ts => (ts ? Date.now() - ts : null);
function buildSummary() {
  const s = tokenStats, lb = leaderboard, b = behavior;
  const unknownFields = [];
  if (!s) unknownFields.push('token', 'economy');
  if (!lb) unknownFields.push('players');
  if (!b) unknownFields.push('behavior');
  return {
    ok: true,
    partial: unknownFields.length > 0,
    unknownFields,
    token: s ? { price: s.price, priceSource: s.priceSource, supply: s.supply, circulating: s.circulating,
      marketCap: s.marketCap, burned: s.burned, burnedPct: s.burnedPct, holders: s.holders || null,
      vol24h: s.volume24h, ageMs: ageOf(tokenStatsAt) } : null,
    economy: s ? { emitted: s.emitted, emittedPct: s.emittedPct, emissionsPool: EMISSIONS_POOL, epoch: s.epoch,
      halveAt: s.halveAt, globalAlpha: s.globalAlpha, emissionRate: s.emissionRate, perAlphaDay: s.perAlphaDay } : null,
    players: lb ? { total: lb.players, ranked: lb.ranked, totalRecruits: lb.totalRecruits,
      totalReferral: lb.totalReferral, topByAlpha: (lb.byAlpha || []).slice(0, 5), ageMs: ageOf(leaderAt) } : null,
    behavior: b ? { playerSellShare: b.playerSellShare, attributableShare: b.attributableShare,
      player: b.player, trader: b.trader, routed: b.routed, liquidity: b.liquidity, ageMs: ageOf(behaviorAt),
      note: 'playerSellShare is a share of ATTRIBUTABLE sells only. routed = swaps arriving via aggregators/bots that cannot be tied to a human. liquidity is excluded from buys/sells entirely — an LP deposit is not a dump.' } : null,
    updatedAt: Date.now(),
  };
}

// ---- MCP tool surface ----
// Descriptions are load-bearing: they are the only thing standing between an agent and a confident wrong
// answer, so each one states the units and the trap. The gotchas below are the exact ones that produced
// wrong conclusions when this data was analysed by hand.
const MCP_VERSION = '2024-11-05';
const MCP_INSTRUCTIONS = [
  'Game-semantic data for $FLOOR on Robinhood Chain: desks, alpha, operators, firms, emissions.',
  'Unofficial fan-built companion to thefloor.sh — the game is the source of truth; this is a read-only mirror.',
  'Start with get_floor_state for context. Data is cached: every result carries ageMs (ms since refresh).',
  'CRITICAL: null means UNKNOWN, never zero. If partial:true, read unknownFields and do NOT report those as 0.',
  'CRITICAL: do not equate "FLOOR sent to the pool" with selling — liquidity provision goes there too, and',
  'most swap volume arrives via routers/bots that cannot be attributed to a person. get_behavior already',
  'separates player / trader / routed / liquidity; use its buckets rather than deriving your own.',
  'To decide moves, call get_strategy(address) — it computes FLOOR/day, pending PnL, seat/bandwidth room,',
  'next-upgrade cost, per-operator payback days, and the halving countdown. To buy FLOOR, get_swap_info +',
  'prepare_wrap_eth then prepare_swap_eth_for_floor (Uniswap V3, thin pool, minOut quoted live). All',
  'prepare_* tools return UNSIGNED calldata for your own signer — this server never holds or asks for keys.',
].join(' ');
const obj = (props, required) => ({ type: 'object', properties: props || {}, required: required || [], additionalProperties: false });
const MCP_TOOLS = [
  { name: 'get_floor_state', description: 'The whole state of the floor in one call: price, market cap, supply, burned, emissions/halving, global alpha, player count, and the reinvest-vs-sell split. Start here for context.', inputSchema: obj() },
  { name: 'get_player', description: 'One wallet: desk tier, alpha, share of emissions, FLOOR/day, pending PnL, balance, seated operator roster, and lifetime spend/sold. Fields may be null if an upstream scan failed — check partial and unknownFields; null means unknown, not zero.', inputSchema: obj({ address: { type: 'string', description: '0x-prefixed 40-hex wallet address' } }, ['address']) },
  { name: 'get_leaderboard', description: 'Wallets ranked by alpha (earning power), plus top recruiters by referral earned. A wallet\'s recruiter is fixed forever at desk creation.', inputSchema: obj({ limit: { type: 'integer', description: 'Max ranked wallets to return (1-100, default 20)' } }) },
  { name: 'get_behavior', description: 'Do desk owners reinvest or dump? Splits FLOOR flow into player / trader / routed / liquidity. playerSellShare is a share of ATTRIBUTABLE sells only; routed = aggregator/bot flow with no identifiable human; liquidity (LP adds/withdrawals) is excluded from buys and sells entirely. Use these buckets — deriving "sells" from raw pool transfers double-counts LP deposits as dumps.', inputSchema: obj() },
  { name: 'get_history', description: 'Daily snapshots for trends: price, market cap, burned, supply, players, alpha, holders. Rows before live tracking began are reconstructed from chain events and marked seeded:true; a metric absent on a row could not be honestly sourced for that day — treat it as unknown, not zero.', inputSchema: obj() },
  { name: 'get_live_actions', description: 'Recent on-chain game actions: collect, claim, seat, recruit, starter, unseat, upgrade, newdesk, referral, firmburn.', inputSchema: obj({ limit: { type: 'integer', description: 'Max actions to return (1-60, default 25)' } }) },
  { name: 'get_holders', description: 'Top $FLOOR holders by balance.', inputSchema: obj() },
  { name: 'get_firms', description: 'Firms, their members and contributions, plus unaffiliated free agents ranked by alpha.', inputSchema: obj() },
  { name: 'get_distribution', description: 'How desks and alpha are spread across players: tier counts and alpha concentration (top 1% / top 10%).', inputSchema: obj() },
  { name: 'prepare_create_desk', description: 'Build the UNSIGNED transaction that opens a desk (joins the game). Returns {to, value, data} for the caller to sign with their OWN wallet — this server never sees, holds, or asks for a private key, and never broadcasts. Costs 0.01 ETH. IMPORTANT: the recruiter is written on-chain at desk creation and can NEVER be changed afterwards; it defaults to this dashboard\'s address (which earns 5% of what the player later spends, paid from the game treasury, costing the player nothing). Pass `referrer` to set your own, or the zero address for none. Always tell the user who the referrer is before they sign.', inputSchema: obj({ from: { type: 'string', description: 'The wallet that will sign. Optional but recommended — lets this tool check the wallet does not already have a desk and would not revert.' }, referrer: { type: 'string', description: 'Referrer address to credit. Omit to use this dashboard\'s default; pass 0x0000000000000000000000000000000000000000 for none.' } }) },
  { name: 'list_operators', description: 'The operator catalogue: id (zero-based, as passed to prepare_recruit_operator), name, FLOOR cost, alpha and bandwidth. Read this before recruiting so you pick the right id — ids are positional and an off-by-one silently buys a different operator.', inputSchema: obj() },
  { name: 'prepare_collect', description: 'Build the UNSIGNED transaction to collect your desk\'s pending PnL. Free (no FLOOR, no ETH beyond gas). Use get_player first to see pendingPnL.', inputSchema: obj({ from: { type: 'string', description: 'The wallet that will sign (optional; used to sanity-check you have a desk).' } }) },
  { name: 'prepare_recruit_starter', description: 'Build the UNSIGNED transaction to recruit the free starter operator. No FLOOR cost.', inputSchema: obj({ from: { type: 'string', description: 'The wallet that will sign (optional).' } }) },
  { name: 'prepare_recruit_operator', description: 'Build the UNSIGNED transaction to recruit an operator by id (see list_operators — ids are ZERO-BASED). Spends FLOOR, so it requires an ERC20 approve first; if your allowance is short, the response includes an `approveFirst` transaction to sign before this one. 75% of what you spend is burned.', inputSchema: obj({ operatorId: { type: 'integer', description: 'Zero-based operator id from list_operators (0 = Retail Analyst … 14 = The Closer)' }, from: { type: 'string', description: 'The wallet that will sign. Recommended — enables the allowance check.' } }, ['operatorId']) },
  { name: 'prepare_upgrade_desk', description: 'Build the UNSIGNED transaction to upgrade your desk to the next tier (takes no arguments — it always steps up one tier). Spends FLOOR, so an approve may be needed first; pass `costFloor` from the desk table if you want the allowance checked against the exact price.', inputSchema: obj({ from: { type: 'string', description: 'The wallet that will sign (recommended).' }, costFloor: { type: 'number', description: 'Expected FLOOR cost of the upgrade, used only for the allowance check.' } }) },
  { name: 'prepare_seat_operator', description: 'Build the UNSIGNED transaction to seat an operator you own (by its FLOOROP NFT token id) at your desk, so it starts earning alpha. Seats and bandwidth are limited by your desk tier.', inputSchema: obj({ tokenId: { type: 'integer', description: 'The FLOOROP operator NFT token id to seat' }, from: { type: 'string', description: 'The wallet that will sign (optional).' } }, ['tokenId']) },
  { name: 'prepare_unseat_operator', description: 'Build the UNSIGNED transaction to unseat an operator (frees its seat and bandwidth).', inputSchema: obj({ tokenId: { type: 'integer', description: 'The FLOOROP operator NFT token id to unseat' }, from: { type: 'string', description: 'The wallet that will sign (optional).' } }, ['tokenId']) },
  { name: 'prepare_approve_floor', description: 'Build the UNSIGNED ERC20 approve letting the game contract spend your FLOOR. Needed before recruiting or upgrading. Approves an exact amount by default rather than unlimited — pass `amount` in whole FLOOR.', inputSchema: obj({ amount: { type: 'number', description: 'How much FLOOR to approve (whole tokens, not wei).' }, from: { type: 'string', description: 'The wallet that will sign (optional; used to report current allowance).' } }, ['amount']) },
  { name: 'get_strategy', description: 'The decision-relevant math for one wallet, so an agent can reason about its next move: current alpha/share, FLOOR earned per day (and USD), pending PnL waiting to be collected, seat + bandwidth headroom, the next desk upgrade (cost and what it unlocks), each operator\'s payback in days at the current emission rate, and the halving countdown (emissions ~halve after it). These are FACTS and paybacks, not instructions — the agent decides. Ignores halving decay in payback (best case). Needs the wallet to have a desk.', inputSchema: obj({ address: { type: 'string', description: '0x wallet to analyze' } }, ['address']) },
  { name: 'get_swap_info', description: 'Everything needed to swap ETH↔FLOOR on Robinhood Chain: the Uniswap V3 router, WETH address, the FLOOR/WETH pool and its 1% fee tier, and the LIVE spot price (FLOOR per ETH) read from the pool. Note the pool is thin (~tens of $k liquidity) so large buys move the price hard — size accordingly. Read this before prepare_swap_eth_for_floor, or to construct/verify a swap yourself.', inputSchema: obj() },
  { name: 'prepare_wrap_eth', description: 'Build the UNSIGNED transaction to wrap native ETH into WETH (step 1 of buying FLOOR — the router swaps WETH, not raw ETH). Returns a WETH.deposit() call carrying your ETH as value.', inputSchema: obj({ amountEth: { type: 'number', description: 'How much ETH to wrap (whole ETH, e.g. 0.05).' } }, ['amountEth']) },
  { name: 'prepare_swap_eth_for_floor', description: 'Build the UNSIGNED Uniswap V3 swap that buys FLOOR with WETH (exactInputSingle). Full buy flow is 3 signed steps: (1) prepare_wrap_eth, (2) approve WETH to the router [included as approveWeth when `from` is given and allowance is short], (3) this swap. amountOutMinimum is computed from the LIVE pool price minus your slippage, so you are protected from a bad fill — but VERIFY the numbers before signing; this spends real money and the pool is thin. Selling FLOOR for ETH is the reverse and not built here.', inputSchema: obj({ amountEth: { type: 'number', description: 'WETH to spend (whole ETH). You must already hold this much WETH — see prepare_wrap_eth.' }, recipient: { type: 'string', description: 'Address to receive the FLOOR (the signing wallet).' }, slippagePct: { type: 'number', description: 'Max slippage tolerance in percent (default 2). amountOutMinimum = live quote × (1 − this).' }, from: { type: 'string', description: 'Signing wallet, used to check WETH allowance and include an approve if needed.' } }, ['amountEth', 'recipient']) },
];
// Client hints (MCP ToolAnnotations). readOnlyHint = safe to call without a confirmation prompt. The
// get_*/list_* tools only read, and this server never writes anything regardless — so they're read-only.
// prepare_* are marked readOnlyHint:false ON PURPOSE: the server mutates nothing (it just returns
// calldata), but that calldata is a real fund-moving transaction, and we want clients to PROMPT before an
// agent fires one. openWorldHint:true everywhere — every result reflects live on-chain/market state.
MCP_TOOLS.forEach(t => {
  const write = t.name.startsWith('prepare_');
  t.annotations = { title: t.name.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), readOnlyHint: !write, openWorldHint: true };
  if (write) t.annotations.destructiveHint = false;     // buying/creating isn't destructive, but still confirm
});
// Verified against 10 real DeskCreated transactions spanning blocks 3.89M-11.46M: selector and price are
// constant across the token's whole life. Read off-chain rather than from an ABI because both explorers
// were 503 — the chain is the authority anyway, and a wrong selector here would burn someone's funds.
const SEL_CREATE_DESK = '0x07609e66';                 // createDesk(address referrer)
const SEL_HAS_DESK = '0xa223fb21';                    // hasDesk(address)
const DESK_PRICE_WEI = '0x2386f26fc10000';            // 0.01 ETH, constant since launch
const CHAIN_ID = 4663;
// Every selector below was decoded from real transactions on this chain (both explorers were 503, and the
// chain is the authority regardless). Operator ids are ZERO-BASED — verified by matching each recruit's
// arg0 against the FLOOR actually transferred in the same tx: 6/6 for zero-based, 0/6 for one-based. That
// check exists because an off-by-one here doesn't throw, it silently buys the wrong operator.
const SEL_COLLECT = '0x1f031cc0';                     // collectPnL()            — no args, no ETH
const SEL_UPGRADE_DESK = '0x790aa411';                // upgradeDesk()           — no args, spends FLOOR
const SEL_RECRUIT_OPERATOR = '0xda953bbd';            // recruitOperator(uint8)  — spends FLOOR
const SEL_RECRUIT_STARTER = '0x63970518';             // recruitStarter()        — no args
const SEL_SEAT_OPERATOR = '0xdfd6182b';               // seatOperator(uint256 tokenId)
const SEL_UNSEAT_OPERATOR = '0xf01d0e91';             // unseatOperator(uint256 tokenId)
const SEL_APPROVE = '0x095ea7b3';                     // ERC20 approve(address,uint256)
const SEL_ALLOWANCE = '0xdd62ed3e';                   // ERC20 allowance(owner,spender)
const OPS_LIST = [['Retail Analyst', 25], ['Junior Broker', 60], ['Chart Intern', 100], ['Cold Caller', 175],
  ['Options Degen', 300], ['Market Maker', 500], ['ETF Boomer', 800], ['Sell-Side Analyst', 1250],
  ['Compliance Guy', 1900], ['Quant Goblin', 2800], ['Dark Pool Dealer', 4200], ['Prop Desk Killer', 6500],
  ['Activist Whale', 10000], ['Terminal Wizard', 15000], ['The Closer', 25000]];
const w256 = v => BigInt(v).toString(16).padStart(64, '0');
const wAddr = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
// Fraction-safe: earlier this did BigInt(Math.round(n))*1e18, which was fine for whole FLOOR amounts but
// zeroed sub-1 values — 0.05 ETH rounded to 0 wei and would have built a swap-zero (reverting) tx.
const toWei = n => { const s = Number(n).toFixed(18); const [i, f] = s.split('.'); return BigInt(i) * (10n ** 18n) + BigInt((f || '').padEnd(18, '0').slice(0, 18)); };
// Desk tiers. cost[N] = the FLOOR upgradeDesk() charges to REACH level N (verified 6/6 against real
// DeskUpgraded events — the UI's "cumulative" label is loose; each step to N costs exactly this).
const DESK_TIERS = [
  { lvl: 0, name: 'Kitchen Table', seats: 2, bw: 20, prestige: 0, cost: 0 },
  { lvl: 1, name: 'One Laptop Desk', seats: 3, bw: 45, prestige: 0.025, cost: 100 },
  { lvl: 2, name: 'Retail Desk', seats: 4, bw: 80, prestige: 0.05, cost: 250 },
  { lvl: 3, name: 'Boiler Room', seats: 6, bw: 150, prestige: 0.10, cost: 600 },
  { lvl: 4, name: 'Broker Desk', seats: 8, bw: 260, prestige: 0.15, cost: 1200 },
  { lvl: 5, name: 'Options Desk', seats: 10, bw: 420, prestige: 0.20, cost: 2500 },
  { lvl: 6, name: 'Prop Desk', seats: 12, bw: 650, prestige: 0.275, cost: 5000 },
  { lvl: 7, name: 'Quant Floor', seats: 15, bw: 1000, prestige: 0.35, cost: 9000 },
  { lvl: 8, name: 'Prime Brokerage', seats: 18, bw: 1500, prestige: 0.45, cost: 16000 },
  { lvl: 9, name: 'Exchange Floor', seats: 22, bw: 2200, prestige: 0.60, cost: 30000 },
  { lvl: 10, name: 'Bell Room', seats: 26, bw: 3200, prestige: 0.80, cost: 60000 },
];
// Swap path — decoded byte-for-byte from a real ETH→FLOOR buy on this chain (not an ABI; both explorers
// were 503). Uniswap V3 SwapRouter02.exactInputSingle, WETH→FLOOR, 1% fee tier. Native ETH is wrapped to
// WETH first (deposit), then approved to the router, then swapped — the exact 3-step flow the game's own
// frontend uses. Router pulls WETH via transferFrom, so the approve is mandatory.
const SWAP_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const WETH_ADDR = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const POOL_FEE = 10000;                              // 1% — the only FLOOR/WETH tier
const SEL_EXACT_IN_SINGLE = '0x04e45aaf';            // exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtPriceLimitX96))
const SEL_WETH_DEPOSIT = '0xd0e30db0';               // WETH.deposit() — payable, no args
const SEL_SLOT0 = '0x3850c7bd';                      // pool.slot0() -> sqrtPriceX96 in first word
// Live spot price straight from the pool, so amountOutMinimum is a real quote and not a guess an agent
// could get sandwiched on. token0=WETH, token1=FLOOR → (sqrtPriceX96^2 / 2^192) = FLOOR per WETH.
async function floorPerWeth() {
  const res = await ethCall(FLOOR_POOL, SEL_SLOT0);
  if (!res) return null;
  try { const sqrt = BigInt('0x' + res.slice(2, 66)); return Number(sqrt * sqrt) / (2 ** 192); }
  catch (_) { return null; }
}
// Shared shape for every prepare_* tool: unsigned, self-describing, and loud about the fact that the
// caller signs. Nothing here ever touches a key or broadcasts.
const unsignedTx = (to, data, extra) => Object.assign({
  unsigned: true, chainId: CHAIN_ID, to, data, value: '0x0',
  execution: 'UNSIGNED. Sign and broadcast with your own wallet/signer. This server never sees, stores, or requests private keys and never broadcasts. Do not send a key to this or any API.',
}, extra || {});
// Every in-game action needs a desk first. Checking costs one eth_call and turns a mystifying revert
// into a sentence the agent can say out loud.
async function deskWarning(from) {
  const f = String(from || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(f)) return ['No `from` given, so this was not checked against the chain — every in-game action requires an existing desk.'];
  const res = await ethCall(GAME_CONTRACT, SEL_HAS_DESK + wAddr(f));
  if (res === null) return ['Could not check whether this wallet has a desk (RPC unavailable) — verify before signing.'];
  return /[1-9a-f]/.test(String(res).slice(2)) ? [] : ['This wallet has NO desk yet — this transaction would revert. Call prepare_create_desk first.'];
}
async function ethCall(to, data) {
  const b = await rpcBatch([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to, data }, 'latest'] }], 3);
  return b ? b[0] : null;
}
// Spending FLOOR needs an ERC20 approve first (the game pulls via transferFrom — 816 Approval events
// confirm this is the real flow). Returns a warning + the approve tx to run first when short.
async function floorAllowanceWarning(from, needFloor) {
  if (!from) return { warnings: ['No `from` given, so allowance was not checked. Spending FLOOR requires approving the game contract first — this will revert without it.'], approveFirst: null };
  const res = await ethCall(FLOOR_ADDR, SEL_ALLOWANCE + wAddr(from) + wAddr(GAME_CONTRACT));
  if (res === null) return { warnings: ['Could not read your FLOOR allowance (RPC unavailable) — verify before signing.'], approveFirst: null };
  let allowed = 0n; try { allowed = BigInt(res); } catch (_) {}
  const need = toWei(needFloor);
  if (allowed >= need) return { warnings: [], approveFirst: null };
  return {
    warnings: ['Insufficient FLOOR allowance: the game contract may spend ' + (Number(allowed) / 1e18).toFixed(0) + ' FLOOR but this costs ' + needFloor + '. Sign `approveFirst` before this transaction, or it will revert.'],
    approveFirst: unsignedTx(FLOOR_ADDR, SEL_APPROVE + wAddr(GAME_CONTRACT) + w256(need), {
      what: 'Approve the game contract to spend ' + needFloor + ' FLOOR',
      note: 'Approves exactly what this action costs, not an unlimited allowance — deliberately. Unlimited approvals are convenient and are also how drained wallets happen.',
    }),
  };
}
// Tools are thin wrappers over the site's own cached endpoints (loopback), not a parallel code path —
// so an agent can never be told something the dashboard itself wouldn't say.
async function selfGet(pathname) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname, { headers: { accept: 'application/json' } });
  return await r.json();
}
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
async function mcpCall(name, args) {
  args = args || {};
  switch (name) {
    case 'get_floor_state': {
      if (!tokenStats) { try { await refreshTokenStats(); } catch (_) {} }
      return buildSummary();
    }
    case 'get_player': {
      const a = String(args.address || '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { error: 'address must be a 0x-prefixed 40-hex wallet address' };
      return await selfGet('/api/player?addr=' + encodeURIComponent(a));
    }
    case 'get_leaderboard': {
      const j = await selfGet('/api/leaderboard');
      const n = clampInt(args.limit, 1, 100, 20);
      if (j && j.lb && Array.isArray(j.lb.byAlpha)) j.lb = Object.assign({}, j.lb, { byAlpha: j.lb.byAlpha.slice(0, n) });
      return j;
    }
    case 'get_behavior': return await selfGet('/api/behavior');
    case 'get_history': return await selfGet('/api/history');
    case 'get_live_actions': {
      const j = await selfGet('/api/live-actions');
      const n = clampInt(args.limit, 1, 60, 25);
      if (j && Array.isArray(j.actions)) j.actions = j.actions.slice(0, n);
      return j;
    }
    case 'get_holders': return await selfGet('/api/holders');
    case 'get_firms': return await selfGet('/api/firms');
    case 'get_distribution': return await selfGet('/api/distribution');

    // Prepare-only, never execute. This returns calldata for someone else's signer; the moment a server
    // like this touches a key it becomes a custodian and a liability, so it doesn't. The referrer is
    // returned explicitly (not just embedded in `data`) so the agent can SAY who it is before the user
    // signs — the assignment is permanent, and a permanent default that nobody can see is a trap.
    case 'prepare_create_desk': {
      const hex40 = v => /^0x[0-9a-fA-F]{40}$/.test(v);
      const raw = String(args.referrer || '').trim();
      let referrer, referrerSource;
      if (raw) {
        if (!hex40(raw)) return { error: 'referrer must be a 0x-prefixed 40-hex address (or 0x0…0 for none)' };
        referrer = raw.toLowerCase();
        referrerSource = referrer === ZERO_ADDR ? 'none (caller opted out)' : 'caller-supplied';
      } else {
        referrer = REF_WALLET;
        referrerSource = "default — this dashboard's referrer";
      }
      const from = String(args.from || '').trim();
      const warnings = [];
      if (from) {
        if (!hex40(from)) return { error: 'from must be a 0x-prefixed 40-hex address' };
        if (from.toLowerCase() === referrer) return { error: 'a wallet cannot recruit itself — pass a different referrer, or the zero address for none. This transaction would revert.' };
        const b = await rpcBatch([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: GAME_CONTRACT, data: SEL_HAS_DESK + from.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest'] }], 3);
        if (!b) warnings.push('Could not check whether this wallet already has a desk (RPC unavailable) — verify before signing.');
        else if (b[0] && /[1-9a-f]/.test(String(b[0]).slice(2))) warnings.push('This wallet ALREADY HAS a desk. Desks are one per wallet and the recruiter is fixed at creation — this transaction would revert. Nothing to do.');
      } else {
        warnings.push('No `from` given, so this was not checked against the chain — if the wallet already has a desk, this will revert.');
      }
      return {
        unsigned: true,
        chainId: CHAIN_ID,
        to: GAME_CONTRACT,
        value: DESK_PRICE_WEI,
        valueEth: '0.01',
        data: SEL_CREATE_DESK + referrer.replace(/^0x/, '').padStart(64, '0'),
        referrer,
        referrerSource,
        referrerNote: 'The recruiter is recorded on-chain when the desk is created and can NEVER be changed. This referrer earns 5% of everything this wallet later spends, for life — paid from the game treasury, so it costs the player nothing. Tell the user who the referrer is before they sign. Pass `referrer` to override, or 0x0000000000000000000000000000000000000000 for none.',
        warnings,
        execution: 'UNSIGNED. Sign and broadcast with your own wallet/signer. This server never sees, stores, or requests private keys and never broadcasts anything. Do not send a key to this or any API.',
        cost: 'Costs 0.01 ETH plus gas. Verify the amount yourself before signing — do not take this API\'s word for it.',
      };
    }
    case 'list_operators':
      return { note: 'ids are ZERO-BASED and positional — pass `id` to prepare_recruit_operator. 75% of FLOOR spent in-game is burned.',
        operators: OPS_LIST.map(([nm, cost], id) => ({ id, name: nm, costFloor: cost, alpha: OPS_STAT[id] ? OPS_STAT[id][1] : null, bandwidth: OPS_STAT[id] ? OPS_STAT[id][2] : null })) };

    case 'prepare_collect': {
      const w = await deskWarning(args.from);
      return unsignedTx(GAME_CONTRACT, SEL_COLLECT, { what: 'Collect pending PnL', costFloor: 0, warnings: w });
    }
    case 'prepare_recruit_starter': {
      const w = await deskWarning(args.from);
      return unsignedTx(GAME_CONTRACT, SEL_RECRUIT_STARTER, { what: 'Recruit the free starter operator', costFloor: 0, warnings: w });
    }
    case 'prepare_recruit_operator': {
      const id = parseInt(args.operatorId, 10);
      if (!Number.isInteger(id) || id < 0 || id >= OPS_LIST.length) return { error: 'operatorId must be a zero-based id 0-' + (OPS_LIST.length - 1) + ' — call list_operators first' };
      const [nm, cost] = OPS_LIST[id];
      const w = await deskWarning(args.from);
      const al = await floorAllowanceWarning(args.from, cost);
      return unsignedTx(GAME_CONTRACT, SEL_RECRUIT_OPERATOR + w256(id), {
        what: 'Recruit ' + nm + ' (id ' + id + ')', costFloor: cost,
        burnNote: '75% of the ' + cost + ' FLOOR is burned; 5% goes to your recruiter.',
        approveFirst: al.approveFirst, warnings: w.concat(al.warnings),
      });
    }
    case 'prepare_upgrade_desk': {
      const w = await deskWarning(args.from);
      const cost = Number(args.costFloor) > 0 ? Number(args.costFloor) : null;
      const al = cost ? await floorAllowanceWarning(args.from, cost) : { warnings: ['No costFloor given, so the FLOOR allowance was not checked — upgrading spends FLOOR and will revert without an approve.'], approveFirst: null };
      return unsignedTx(GAME_CONTRACT, SEL_UPGRADE_DESK, {
        what: 'Upgrade desk to the next tier', costFloor: cost,
        note: 'This function takes no arguments — it always upgrades one tier from where you are. Check get_player.deskLevelChain first.',
        approveFirst: al.approveFirst, warnings: w.concat(al.warnings),
      });
    }
    case 'prepare_seat_operator':
    case 'prepare_unseat_operator': {
      const id = parseInt(args.tokenId, 10);
      if (!Number.isInteger(id) || id < 0) return { error: 'tokenId must be a non-negative integer (the FLOOROP operator NFT id)' };
      const seat = name === 'prepare_seat_operator';
      const w = await deskWarning(args.from);
      return unsignedTx(GAME_CONTRACT, (seat ? SEL_SEAT_OPERATOR : SEL_UNSEAT_OPERATOR) + w256(id), {
        what: (seat ? 'Seat' : 'Unseat') + ' operator #' + id, costFloor: 0,
        note: seat ? 'You must own this operator, and your desk needs a free seat and enough bandwidth (see get_player.deskSeats / deskBandwidth).' : 'Frees the seat and its bandwidth.',
        warnings: w,
      });
    }
    case 'prepare_approve_floor': {
      const amt = Number(args.amount);
      if (!(amt > 0)) return { error: 'amount must be a positive number of whole FLOOR' };
      let current = null;
      const from = String(args.from || '').trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(from)) {
        const res = await ethCall(FLOOR_ADDR, SEL_ALLOWANCE + wAddr(from) + wAddr(GAME_CONTRACT));
        if (res !== null) { try { current = Number(BigInt(res)) / 1e18; } catch (_) {} }
      }
      return unsignedTx(FLOOR_ADDR, SEL_APPROVE + wAddr(GAME_CONTRACT) + w256(toWei(amt)), {
        what: 'Approve the game contract to spend ' + amt + ' FLOOR',
        currentAllowanceFloor: current,
        note: 'Exact-amount approval by design. An unlimited approval is more convenient and is also how wallets get drained — approve what you intend to spend.',
      });
    }
    case 'get_strategy': {
      const a = String(args.address || '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { error: 'address must be a 0x-prefixed 40-hex wallet address' };
      const [pl, ts] = await Promise.all([selfGet('/api/player?addr=' + a), (async () => { if (!tokenStats) { try { await refreshTokenStats(); } catch (_) {} } return tokenStats; })()]);
      // Degrade, don't fail: the operator paybacks + market + halving only need tokenStats, so they're
      // still returned even when the per-wallet RPC read is down. Personalized parts go null with a note —
      // an agent gets the reusable math and can retry for its own desk specifics.
      const liveOk = !!(pl && pl.stateOk);
      const price = ts ? ts.price : null;                       // USD per FLOOR
      const perAlphaDay = ts ? ts.perAlphaDay : null;           // FLOOR/day per 1 alpha
      const usd = f => (price != null && f != null) ? +(f * price).toFixed(2) : null;
      const lvl = pl.deskLevelChain != null ? pl.deskLevelChain : pl.deskLevel;
      const nextTier = (lvl != null && lvl < DESK_TIERS.length - 1) ? DESK_TIERS[lvl + 1] : null;
      const cur = (lvl != null) ? DESK_TIERS[lvl] : null;
      const seatsFree = (pl.deskSeats != null && pl.seatsUsed != null) ? pl.deskSeats - pl.seatsUsed : null;
      const bwFree = (pl.deskBandwidth != null && pl.bwUsed != null) ? pl.deskBandwidth - pl.bwUsed : null;
      // operator payback = cost / (alpha it adds × FLOOR-per-alpha-per-day)
      const operators = OPS_LIST.map(([nm, cost], id) => {
        const alpha = OPS_STAT[id] ? OPS_STAT[id][1] : null, bw = OPS_STAT[id] ? OPS_STAT[id][2] : null;
        const perDay = (alpha != null && perAlphaDay != null) ? alpha * perAlphaDay : null;
        return { id, name: nm, costFloor: cost, alpha, bandwidth: bw,
          floorPerDay: perDay != null ? +perDay.toFixed(2) : null,
          paybackDays: (perDay && perDay > 0) ? +(cost / perDay).toFixed(1) : null,
          fitsFreeBandwidth: (bwFree != null && bw != null) ? bw <= bwFree : null };
      });
      const halveMs = ts && ts.halveAt ? ts.halveAt - Date.now() : null;
      const signals = [];
      if (liveOk && pl.pendingPnL != null) signals.push(pl.pendingPnL > 0 ? `${pl.pendingPnL.toFixed(2)} FLOOR of PnL is uncollected${usd(pl.pendingPnL) != null ? ' (~$' + usd(pl.pendingPnL) + ')' : ''} — prepare_collect to realize it.` : 'No pending PnL to collect right now.');
      if (liveOk && seatsFree != null) signals.push(seatsFree > 0 ? `${seatsFree} free seat(s) and ${bwFree} spare bandwidth — room to seat more operators.` : 'All seats full — recruiting more needs a desk upgrade first.');
      if (liveOk && nextTier && cur) signals.push(`Next upgrade → ${nextTier.name}: ${nextTier.cost} FLOOR for +${nextTier.seats - cur.seats} seats, +${nextTier.bw - cur.bw} bandwidth, +${Math.round((nextTier.prestige - cur.prestige) * 100)}% prestige.`);
      if (halveMs != null) signals.push(`Halving in ${(halveMs / 86400000).toFixed(1)} days — the emission rate roughly halves after, so FLOOR/day falls. Earlier reinvestment compounds at the richer rate.`);
      if (!liveOk) signals.push('Live desk state for this wallet was unavailable (no desk yet, or the RPC is throttled). The operator paybacks and market numbers below are still valid; retry get_strategy or get_player for your desk specifics.');
      return {
        address: a,
        liveStateAvailable: liveOk,
        earning: liveOk ? { alpha: pl.userAlpha, share: pl.share, floorPerDay: pl.perDay, usdPerDay: usd(pl.perDay), pendingPnL: pl.pendingPnL, pendingPnLUsd: usd(pl.pendingPnL) } : null,
        desk: (liveOk && cur) ? { level: lvl, name: cur.name, seatsUsed: pl.seatsUsed, seats: pl.deskSeats, bandwidthUsed: pl.bwUsed, bandwidth: pl.deskBandwidth, seatsFree, bwFree, prestigeBps: pl.prestigeBps } : null,
        nextUpgrade: (liveOk && nextTier) ? { toLevel: nextTier.lvl, name: nextTier.name, costFloor: nextTier.cost, addsSeats: nextTier.seats - cur.seats, addsBandwidth: nextTier.bw - cur.bw, addsPrestigePct: Math.round((nextTier.prestige - cur.prestige) * 100) } : (liveOk ? 'Already at the top tier (Bell Room).' : null),
        deskTiers: DESK_TIERS.map(d => ({ level: d.lvl, name: d.name, seats: d.seats, bandwidth: d.bw, prestigePct: Math.round(d.prestige * 100), upgradeCostFloor: d.cost })),
        operators,
        market: { floorPriceUsd: price, floorPerAlphaPerDay: perAlphaDay, halvingInDays: halveMs != null ? +(halveMs / 86400000).toFixed(1) : null, ageMs: ts ? ageOf(tokenStatsAt) : null },
        signals,
        note: 'Paybacks assume the current emission rate and ignore halving decay (best case). These are facts, not advice — the agent chooses.',
      };
    }
    case 'get_swap_info': {
      const spot = await floorPerWeth();
      return {
        chain: 'Robinhood Chain', chainId: CHAIN_ID,
        router: SWAP_ROUTER, routerType: 'Uniswap V3 SwapRouter02',
        weth: WETH_ADDR, floor: FLOOR_ADDR, pool: FLOOR_POOL, feeTier: POOL_FEE, feePct: 1,
        liveSpot: spot != null ? { floorPerEth: +spot.toFixed(2), ethPerFloor: +(1 / spot).toExponential(4) } : null,
        method: 'exactInputSingle((tokenIn=WETH, tokenOut=FLOOR, fee=10000, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96=0))',
        howToBuy: ['1. Wrap ETH → WETH (prepare_wrap_eth).', '2. Approve WETH to the router (prepare_swap_eth_for_floor includes this as approveWeth when needed).', '3. Swap via exactInputSingle (prepare_swap_eth_for_floor).'],
        warnings: ['The pool is THIN — a large buy moves the price a lot; keep sizes small or split.', 'Always set amountOutMinimum from a fresh quote; never 0.', 'Selling FLOOR→ETH is the reverse path and is not built as a tool here.'],
      };
    }
    case 'prepare_wrap_eth': {
      const amt = Number(args.amountEth);
      if (!(amt > 0)) return { error: 'amountEth must be a positive number of ETH' };
      return unsignedTx(WETH_ADDR, SEL_WETH_DEPOSIT, {
        value: '0x' + toWei(amt).toString(16), valueEth: String(amt),
        what: 'Wrap ' + amt + ' ETH into WETH', note: 'Step 1 of buying FLOOR. WETH is 1:1 with ETH and unwrappable anytime (withdraw).',
      });
    }
    case 'prepare_swap_eth_for_floor': {
      const amt = Number(args.amountEth);
      const recip = String(args.recipient || '').trim();
      if (!(amt > 0)) return { error: 'amountEth must be a positive number' };
      if (!/^0x[0-9a-fA-F]{40}$/.test(recip)) return { error: 'recipient must be a 0x-prefixed 40-hex address' };
      const slip = Number(args.slippagePct) >= 0 && Number(args.slippagePct) < 50 ? Number(args.slippagePct) : 2;
      const spot = await floorPerWeth();
      if (spot == null) return { error: 'could not read a live pool quote right now (RPC unavailable) — do not swap without a fresh amountOutMinimum; retry shortly.' };
      const expectedFloor = amt * spot * (1 - POOL_FEE / 1e6);          // fee is taken from the input
      const minOut = expectedFloor * (1 - slip / 100);
      const amountInWei = toWei(amt), minOutWei = toWei(minOut);
      const data = SEL_EXACT_IN_SINGLE + wAddr(WETH_ADDR) + wAddr(FLOOR_ADDR) + w256(POOL_FEE) + wAddr(recip) + w256(amountInWei) + w256(minOutWei) + w256(0);
      const out = unsignedTx(SWAP_ROUTER, data, {
        what: 'Swap ' + amt + ' WETH → FLOOR', quote: { floorPerEth: +spot.toFixed(2), expectedFloor: Math.round(expectedFloor), amountOutMinimum: Math.round(minOut), slippagePct: slip },
        priceImpactNote: 'Quote is spot price; the pool is thin so a large buy will fill worse than this. If expectedFloor looks off vs get_swap_info, stop.',
        warnings: ['You must already hold ' + amt + ' WETH and have approved it to the router (see approveWeth / prepare_wrap_eth).', 'This spends real money. Verify amountOutMinimum before signing.'],
      });
      const from = String(args.from || '').trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(from)) {
        const res = await ethCall(WETH_ADDR, SEL_ALLOWANCE + wAddr(from) + wAddr(SWAP_ROUTER));
        let allowed = 0n; if (res) { try { allowed = BigInt(res); } catch (_) {} }
        if (allowed < amountInWei) out.approveWeth = unsignedTx(WETH_ADDR, SEL_APPROVE + wAddr(SWAP_ROUTER) + w256(amountInWei), { what: 'Approve ' + amt + ' WETH to the router (sign before the swap)' });
      } else out.warnings.push('No `from` given — could not check WETH allowance. The router needs WETH approved or the swap reverts.');
      return out;
    }
    default: return { error: 'unknown tool: ' + name };
  }
}

// ---- machine-readable surface (see /llms.txt) ----
// Everything under /api is public read-only data, so it's open to any origin. Without this header a
// browser-based agent can't read the API at all, which quietly firewalled off the exact audience we want.
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version, accept');
  res.setHeader('access-control-expose-headers', 'mcp-session-id');
}
const API_INDEX = {
  name: 'The Floor · companion API',
  description: 'Read-only game-semantic data for $FLOOR on Robinhood Chain (desks, alpha, operators, firms, emissions). Unofficial fan-built companion to thefloor.sh.',
  chain: { name: 'Robinhood Chain', chainId: 4663, rpc: RPC_URL },
  contracts: { floorToken: FLOOR_ADDR, game: GAME_CONTRACT, firm: FIRM_CONTRACT, pool: FLOOR_POOL },
  conventions: {
    amounts: 'All FLOOR amounts are human units (already divided by 1e18) unless a field says _raw.',
    addresses: 'Lowercase hex. Compare case-insensitively.',
    freshness: 'Every cached endpoint returns ageMs = milliseconds since that data was last refreshed.',
    unknowns: 'null means UNKNOWN, never zero. Check `partial` and `unknownFields` before trusting a number.',
  },
  mcp: { endpoint: '/mcp', transport: 'streamable-http', note: 'Add this URL as an MCP server to query the floor from an agent.' },
  endpoints: [
    { path: '/api/summary', desc: 'One call: price, supply, burned, emissions, players, behavior split, freshness. Start here.' },
    { path: '/api/token-stats', desc: 'Token + game economy: price, supply, burned, emission rate, global alpha, halving.' },
    { path: '/api/player?addr=0x…', desc: 'One wallet: desk tier, alpha, share, pending PnL, balance, seated roster.' },
    { path: '/api/leaderboard', desc: 'Wallets ranked by alpha, plus top recruiters.' },
    { path: '/api/behavior', desc: 'Desk owners vs traders: reinvested / sold / bought, with router flow and liquidity separated out.' },
    { path: '/api/distribution', desc: 'Desk-tier spread and alpha concentration.' },
    { path: '/api/holders', desc: 'Top FLOOR holders.' },
    { path: '/api/firms', desc: 'Firms, members, and free agents.' },
    { path: '/api/live-actions', desc: 'Recent on-chain game actions (collect/claim/seat/recruit/upgrade/newdesk/referral/firmburn).' },
    { path: '/api/history', desc: 'Daily snapshots for trends. Rows before tracking began are reconstructed and marked seeded:true.' },
  ],
};
const LLMS_TXT = () => `# The Floor — companion dashboard for $FLOOR (Robinhood Chain)

> Unofficial, fan-built companion to thefloor.sh. Read-only JSON, no auth, CORS open.
> This is the GAME-SEMANTIC layer: desks, alpha, operators, firms, emissions, reinvest-vs-dump.
> For raw chain data (any tx/address/block) use a block explorer instead.

## Agent endpoint
- MCP (streamable HTTP): ${'`'}/mcp${'`'} — add as an MCP server; tools are self-describing via tools/list.
- Discovery (JSON): ${'`'}/api${'`'}

## Deciding what to do (the MCP won't decide for you)
- These tools give an agent the ABILITY to read state and prepare transactions — they don't make the
  moves. To play well, read the numbers and reason. ${'`'}get_strategy(address)${'`'} does the game math for you:
  FLOOR/day, uncollected PnL, seat/bandwidth headroom, next-upgrade cost + what it unlocks, per-operator
  payback in days at the current emission rate, and the halving countdown. It returns facts + paybacks,
  not "buy now" — the choice is the agent's.
- Rough loop most players run: open desk → recruit a starter → collectPnL when PnL is worth the gas →
  reinvest into the operator with the lowest payback that fits your free bandwidth → upgrade the desk when
  you're seat/bandwidth-capped → repeat. Emissions halve every 30 days, so earlier reinvestment compounds.

## Buying FLOOR (you need it to recruit/upgrade)
- Swap on Robinhood Chain's Uniswap V3: router ${SWAP_ROUTER} (SwapRouter02), WETH ${WETH_ADDR},
  FLOOR/WETH pool ${FLOOR_POOL} at the 1% fee tier. ${'`'}get_swap_info${'`'} returns the live price.
- Flow: ${'`'}prepare_wrap_eth${'`'} (ETH→WETH) → approve WETH to the router (${'`'}prepare_swap_eth_for_floor${'`'}
  includes it) → ${'`'}prepare_swap_eth_for_floor${'`'} (exactInputSingle). amountOutMinimum is quoted live from
  the pool minus your slippage. The pool is thin — big buys fill badly; keep them small.

## Playing the game from an agent
- ${'`'}prepare_create_desk${'`'} builds the UNSIGNED transaction to open a desk. It returns {to, value, data};
  you sign with your own wallet. This server holds no keys, asks for no keys, and broadcasts nothing.
  **Never send a private key to this or any API.**
- Desk creation costs 0.01 ETH. Verify the amount yourself before signing — don't take this API's word.
- The recruiter is written on-chain at creation and can NEVER be changed. It defaults to this dashboard's
  address, which then earns 5% of what that wallet later spends (paid from the game treasury, so it costs
  the player nothing). The referrer is returned explicitly in the response — surface it to the human
  before they sign, and pass ${'`'}referrer${'`'} to override or 0x0…0 to opt out.

## Conventions (read this before trusting a number)
- FLOOR amounts are HUMAN units (already /1e18). Fields ending _raw are wei-scale.
- Addresses are lowercase hex; compare case-insensitively.
- ${'`'}ageMs${'`'} = ms since last refresh. This data is cached, not live-per-request.
- **${'`'}null${'`'} means UNKNOWN, never zero.** If ${'`'}partial:true${'`'}, some upstream failed — read ${'`'}unknownFields${'`'}
  and do NOT report those as 0. Zero and "we couldn't find out" are different claims.

## Endpoints
${API_INDEX.endpoints.map(e => `- ${'`'}${e.path}${'`'} — ${e.desc}`).join('\n')}

## Contracts
- FLOOR token: ${FLOOR_ADDR}
- Game:        ${GAME_CONTRACT}
- Firm:        ${FIRM_CONTRACT}
- FLOOR/WETH pool (Uniswap V3): ${FLOOR_POOL}

## Gotchas that will bite an agent
- "Sell volume" is NOT every transfer into the pool: liquidity adds land there too, and ~68% of real
  swap volume arrives from routers/bots, not humans. /api/behavior separates player / trader / routed
  / liquidity so you don't mistake an LP deposit for a dump.
- A wallet's recruiter is fixed forever at desk creation; it can never be changed or backfilled.
- Burned can exceed current supply (burns reduce supply), so burnedPct > 100% is normal, not a bug.
`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/api' || p.startsWith('/api/') || p === '/mcp' || p === '/llms.txt') cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p === '/llms.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    res.end(LLMS_TXT()); return;
  }
  if (p === '/api' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
    res.end(JSON.stringify(API_INDEX, null, 1)); return;
  }
  if (p === '/api/summary' && req.method === 'GET') {
    if (!tokenStats) { try { await refreshTokenStats(); } catch (_) {} }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' });
    res.end(JSON.stringify(buildSummary())); return;
  }

  // ---- MCP: point an agent at this URL and it can query the floor ----
  if (p === '/mcp') {
    if (req.method !== 'POST') {
      // A human clicking the announce link lands here with a browser; show them how to plug it in
      // instead of a bare JSON-RPC error. MCP clients never send Accept: text/html — they POST, or GET
      // asking for text/event-stream (a server-push stream this stateless server doesn't offer -> 405).
      const wantsHtml = /text\/html/i.test(req.headers.accept || '') && !/text\/event-stream/i.test(req.headers.accept || '');
      if (req.method === 'GET' && wantsHtml) {
        const base = 'https://' + (req.headers.host || 'thefloor-dashboard-production.up.railway.app');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Floor · MCP for agents</title></head>
<body style="margin:0;background:#0d0a06;color:#f2e8d5;font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.6">
<div style="max-width:720px;margin:0 auto;padding:48px 20px">
<h1 style="color:#d4af5a;font-size:22px;letter-spacing:1px">▸ THE FLOOR · MCP</h1>
<p>This URL is a <b>Model Context Protocol</b> endpoint — it's for your AI agent, not your browser.
Add it to Claude, Claude Code, or Cursor and ask the floor questions in plain language:
live desks and alpha, who's reinvesting vs dumping, operator math — and it can even <b>play</b>
(unsigned transactions only; your wallet signs, this server never touches keys).</p>
<h2 style="color:#d4af5a;font-size:15px;margin-top:28px">Add it</h2>
<pre style="background:#12100c;border:1px solid #37301f;border-radius:8px;padding:14px;overflow-x:auto;font-size:12.5px"># Claude Code
claude mcp add --transport http the-floor ${base}/mcp

# claude.ai → Settings → Connectors → Add custom connector
${base}/mcp

# Cursor (mcp.json)
{ "mcpServers": { "the-floor": { "url": "${base}/mcp" } } }</pre>
<h2 style="color:#d4af5a;font-size:15px;margin-top:28px">${MCP_TOOLS.length} tools</h2>
<p style="font-size:13px;color:#b3a88f">${MCP_TOOLS.map(t => t.name).join(' · ')}</p>
<p style="margin-top:28px;font-size:13px"><a href="/llms.txt" style="color:#d4af5a">llms.txt</a> ·
<a href="/api" style="color:#d4af5a">API index</a> · <a href="/" style="color:#d4af5a">dashboard</a></p>
<p style="font-size:11.5px;color:#6f6249">Unofficial fan-built companion to thefloor.sh. Read tools are cached public data;
write tools return unsigned calldata for your own signer. Never send a private key to this or any API.</p>
</div></body></html>`);
        return;
      }
      // No server-initiated stream: this server is stateless, every answer rides its POST response.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP streamable HTTP: POST JSON-RPC to /mcp' } }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const send = o => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
      let msg; try { msg = JSON.parse(body || '{}'); } catch (_) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return;
      }
      const one = async (m) => {
        const id = m && m.id;
        try {
          switch (m && m.method) {
            case 'initialize':
              mcpTrack('connect', { client: (m.params && m.params.clientInfo) ? (m.params.clientInfo.name + '/' + m.params.clientInfo.version) : 'unknown' });
              return { jsonrpc: '2.0', id, result: {
                // Echo the client's version when it sends one — this server is version-agnostic (plain
                // JSON-RPC + tools), so refusing a newer client would be gatekeeping for no reason.
                protocolVersion: (m.params && typeof m.params.protocolVersion === 'string') ? m.params.protocolVersion : MCP_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'the-floor', version: '1.0.0' },
                instructions: MCP_INSTRUCTIONS,
              } };
            case 'ping': return { jsonrpc: '2.0', id, result: {} };
            case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
            case 'tools/call': {
              const nm = m.params && m.params.name;
              mcpTrack('call', { tool: nm });
              const out = await mcpCall(nm, (m.params && m.params.arguments) || {});
              return { jsonrpc: '2.0', id, result: {
                content: [{ type: 'text', text: JSON.stringify(out, null, 1) }],
                isError: !!(out && out.error),
              } };
            }
            default:
              if (m && m.method && String(m.method).startsWith('notifications/')) return null;   // fire-and-forget
              return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'Method not found: ' + (m && m.method) } };
          }
        } catch (e) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Internal error: ' + e.message } };
        }
      };
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(one))).filter(Boolean);
        if (!out.length) { res.writeHead(202); res.end(); return; }
        send(out); return;
      }
      const out = await one(msg);
      if (!out) { res.writeHead(202); res.end(); return; }   // a notification gets no body
      send(out);
    });
    return;
  }

  // ---- cached FLOOR token stats (shared by all visitors) ----
  if (p === '/api/token-stats' && req.method === 'GET') {
    if (!tokenStats) { try { await refreshTokenStats(); } catch (_) {} }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    res.end(JSON.stringify(tokenStats ? Object.assign({ ok: true, ageMs: Date.now() - tokenStatsAt }, tokenStats) : { ok: false }));
    return;
  }

  // ---- telemetry ingest (same-origin beacons) ----
  if (req.method === 'POST' && p === '/event') {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 4000) req.destroy(); });
    req.on('end', () => {
      try { const e = JSON.parse(b); e.t = String(e.t || '?').slice(0, 40); delete e.ua_full; track(e); } catch (_) {}
      res.writeHead(204); res.end();
    });
    return;
  }

  // ---- admin stats (token-gated) ----
  if (p === '/admin/stats') {
    if (u.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401); res.end('unauthorized'); return; }
    const HOUR = 3600000;
    const errs = events.filter(e => e.t === 'js_error' || e.t === 'explorer_error' || e.t === 'promise_reject').slice(-60).reverse();
    const wallets = {}; events.filter(e => e.t === 'wallet_lookup').forEach(e => { if (e.addr) wallets[e.addr] = (wallets[e.addr] || 0) + 1; });
    const dev = { mobile: 0, desktop: 0 }; events.filter(e => e.t === 'pageview').forEach(e => { e.mob ? dev.mobile++ : dev.desktop++; });
    const refs = {}; events.filter(e => e.t === 'pageview' && e.ref).forEach(e => { const h = (e.ref.split('/')[2] || e.ref).slice(0, 40); refs[h] = (refs[h] || 0) + 1; });
    const sections = {}; events.filter(e => e.t === 'section_view').forEach(e => { if (e.id) sections[e.id] = (sections[e.id] || 0) + 1; });
    const lookups = events.filter(e => e.t === 'wallet_lookup');
    const okRate = lookups.length ? (lookups.filter(e => e.ok).length / lookups.length) : null;
    const nowH = Math.floor(Date.now() / HOUR);
    const hourly = []; for (let i = 23; i >= 0; i--) { const hb = nowH - i; hourly.push(events.filter(e => e.t === 'pageview' && Math.floor((e.ts || 0) / HOUR) === hb).length); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      totalEvents: events.length,
      sessions: new Set(events.map(e => e.sid)).size,
      pageviews: counts.pageview || 0,
      counts, devices: dev,
      funnel: { pageview: counts.pageview || 0, calc_use: counts.calc_use || 0, wallet_lookup: lookups.length, play_click: counts.play_click || 0, deals_click: counts.deals_click || 0 },
      walletLookups: lookups.length, lookupOkRate: okRate,
      sectionViews: sections,
      pageviewsHourly: hourly,
      topReferrers: Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 15),
      topWallets: Object.entries(wallets).sort((a, b) => b[1] - a[1]).slice(0, 20),
      recentErrors: errs,
      // invite-link performance: clicks are local telemetry, conversions/earnings come from the chain
      referral: refStats ? Object.assign({}, refStats, { clicks: { play: counts.play_click || 0, deals: counts.deals_click || 0 } }) : null,
      // MCP adoption: sessions (not verified-unique agents), tool calls, and read-vs-play split
      mcp: (() => {
        const byTool = Object.entries(mcpStats.byTool).sort((a, b) => b[1] - a[1]);
        const writes = byTool.filter(([t]) => t.startsWith('prepare_')).reduce((s, [, n]) => s + n, 0);
        return {
          connects: mcpStats.connects, calls: mcpStats.calls,
          reads: mcpStats.calls - writes, writes,
          distinctClients: Object.keys(mcpStats.byClient).length,
          byTool, byClient: Object.entries(mcpStats.byClient).sort((a, b) => b[1] - a[1]),
          firstAt: mcpStats.firstAt, lastAt: mcpStats.lastAt, recent: mcpStats.recent.slice(0, 12),
        };
      })(),
      bootAt: BOOT
    }));
    return;
  }

  // ---- cached per-address player lookup ----
  if (p === '/api/player' && req.method === 'GET') {
    const addr = (u.searchParams.get('addr') || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad address' })); return; }
    const A = addr.toLowerCase();
    const cached = playerCache.get(A);
    if (cached && Date.now() - cached.ts < (cached.ttl || PLAYER_TTL)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
      res.end(JSON.stringify(Object.assign({ ok: true, cached: true }, cached.data))); return;
    }
    let pr = playerInflight.get(A);
    if (!pr) {
      pr = (async () => {
        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
        const [scan, state] = await Promise.all([
          // The 3.5s bound dated from when this scan was a Blockscout nice-to-have. It is now the RPC
          // log scan and the ONLY source of lifetime flow — and under Railway's throttled egress its
          // retries legitimately take up to ~25s. Cutting it off early nulled the whole scan in prod
          // while the exact same code passed locally. Agents wait; wrong-vs-slow is not a close call.
          withTimeout(fetchPlayer(addr).catch(() => null), 26000),
          rpcState(addr).catch(() => null),                        // chain RPC: exact current state + earnings (fast)
        ]);
        // The Blockscout scan supplies lifetime flow (minted/sold/spend/purchases); the RPC supplies exact
        // current state. When the scan fails these were zero-filled, so a caller could not tell "sold
        // nothing" from "we never found out" — and an agent will happily report the 0 as fact. Null them
        // and name them instead.
        const scanFields = ['mint', 'inOther', 'out', 'sold', 'count', 'spend', 'deskLevel', 'purchases', 'operators'];
        const base = scan || { addr: A, mint: null, inOther: null, out: null, sold: null, bal: null, count: null,
          partial: true, earnedKnown: false, spend: null, deskLevel: null, operators: null, purchases: null, spendKnown: false };
        const data = Object.assign({}, base);
        if (!scan) data.unknownFields = scanFields.slice();
        if (state) {
          Object.assign(data, {
            stateOk: true, hasDesk: state.hasDesk, pendingPnL: state.pendingPnL,
            userAlpha: state.userAlpha, globalAlpha: state.globalAlpha, emissionRate: state.emissionRate,
            perDay: state.perDay, share: state.share, deskLevelChain: state.deskLevel, bal: state.balance,
            deskSeats: state.deskSeats, deskBandwidth: state.deskBandwidth, seatsUsed: state.seatsUsed, bwUsed: state.bwUsed,
            prestigeBps: state.prestigeBps, seatedRoster: state.seatedRoster,
          });
        } else data.stateOk = false;
        return data;
      })().finally(() => playerInflight.delete(A));
      playerInflight.set(A, pr);
    }
    try {
      const data = await pr;
      const valid = data && (data.stateOk || data.count > 0 || data.bal > 0);
      if (valid) {
        // A partial result (scan nulled by throttling) is served but only pinned briefly — caching it
        // for the full TTL froze "sold: null" for 4 minutes at a time. Complete results keep the long TTL.
        playerCache.set(A, { data, ts: Date.now(), ttl: data.partial ? 30000 : PLAYER_TTL });
        if (playerCache.size > 800) { const k = playerCache.keys().next().value; playerCache.delete(k); }
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': valid ? 'public, max-age=60' : 'no-store' });
      res.end(JSON.stringify(Object.assign({ ok: true, cached: false }, data)));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'lookup failed' }));
    }
    return;
  }

  // ---- cached player distribution (desk tiers + alpha concentration) ----
  if (p === '/api/distribution' && req.method === 'GET') {
    if (!distribution) refreshDistribution();     // kick off (async); serve empty until ready
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    res.end(JSON.stringify({ ok: !!distribution, dist: distribution || null, ageMs: distAt ? Date.now() - distAt : null }));
    return;
  }

  // ---- cached player-vs-trader behavior ----
  if (p === '/api/behavior' && req.method === 'GET') {
    if (!behavior) refreshBehavior();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    res.end(JSON.stringify({ ok: !!behavior, behavior: behavior || null, ageMs: behaviorAt ? Date.now() - behaviorAt : null }));
    return;
  }

  // ---- cached firms & free agents ----
  if (p === '/api/firms' && req.method === 'GET') {
    if (!firms) refreshFirms();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    res.end(JSON.stringify({ ok: !!firms, firms: firms || null, ageMs: firmsAt ? Date.now() - firmsAt : null }));
    return;
  }

  // ---- leaderboards + rank ----
  if (p === '/api/leaderboard' && req.method === 'GET') {
    if (!leaderboard) refreshLeaderboard();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=180' });
    res.end(JSON.stringify({ ok: !!leaderboard, lb: leaderboard || null, ageMs: leaderAt ? Date.now() - leaderAt : null }));
    return;
  }

  // ---- live on-chain action feed ----
  if (p === '/api/live-actions' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=20' });
    res.end(JSON.stringify({ ok: liveActions.length > 0, block: lastLiveBlock, actions: liveActions }));
    return;
  }

  // ---- X handle registry (linked wallets only) ----
  if (p === '/api/handles' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
    res.end(JSON.stringify({ ok: Object.keys(handles).length > 0, handles }));
    return;
  }

  // ---- Firm Wars leaderboard ----
  if (p === '/api/fw-scores' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, scores: fwScores.slice().sort((a, b) => b.score - a.score).slice(0, 50) }));
    return;
  }
  if (p === '/api/fw-scores' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(b || '{}');
        const firm = (String(j.firm || 'Anon').replace(/[<>]/g, '').trim().slice(0, 24)) || 'Anon';
        const op = String(j.op || '').replace(/[^a-zA-Z0-9 .'-]/g, '').slice(0, 24);
        let score = Math.round(Number(j.score)); if (!isFinite(score)) score = 0; score = Math.max(-1e7, Math.min(1e9, score));
        let days = Math.round(Number(j.days)) || 30; days = Math.max(1, Math.min(90, days));
        const entry = { firm, op, score, days, ts: Date.now() };
        fwScores.push(entry); fwScores.sort((a, b) => b.score - a.score); if (fwScores.length > 300) fwScores.length = 300;
        saveFwScores();
        const rank = fwScores.indexOf(entry) + 1;
        console.log('FW score ' + firm + ' ' + score + ' (rank ' + rank + '/' + fwScores.length + ')');
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rank, total: fwScores.length }));
      } catch (_) { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  // ---- daily historical snapshots ----
  if (p === '/api/history' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
    const newest = history.length ? history[history.length - 1] : null;
    res.end(JSON.stringify({ ok: history.length > 0, ageMs: newest && newest.ts ? Date.now() - newest.ts : null, history }));
    return;
  }

  // ---- cached top holders ----
  if (p === '/api/holders' && req.method === 'GET') {
    if (!holders) { try { await refreshHolders(); } catch (_) {} }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' });
    res.end(JSON.stringify({ ok: !!holders, holders: holders || [], ageMs: Date.now() - holdersAt }));
    return;
  }

  // ---- deals broadcast: GET (public) / POST (owner-gated) ----
  if (p === '/deals-status' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(dealsStatus)); return;
  }
  if (p === '/deals-status' && req.method === 'POST') {
    if (u.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401); res.end('unauthorized'); return; }
    let b = ''; req.on('data', c => { b += c; if (b.length > 2000) req.destroy(); });
    req.on('end', () => {
      try { const j = JSON.parse(b || '{}'); dealsStatus = { live: !!j.live, msg: String(j.msg || '').slice(0, 120), ts: Date.now() }; } catch (_) {}
      saveDeals();
      console.log('DEALS ' + JSON.stringify(dealsStatus));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(dealsStatus));
    });
    return;
  }

  // ---- operator-art proxy (same-origin so the office canvas stays untainted for PiP capture) ----
  if (p.startsWith('/opart/') && req.method === 'GET') {
    const slug = p.slice('/opart/'.length).replace(/\.svg$/i, '').replace(/[^a-z0-9-]/gi, '');
    if (!slug) { res.writeHead(404); res.end(''); return; }
    if (opArtCache[slug]) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      res.end(opArtCache[slug]); return;
    }
    fetch('https://thefloor.sh/assets/operator-' + slug + '.svg')
      .then(r => r.ok ? r.text() : Promise.reject(new Error('' + r.status)))
      .then(t => { opArtCache[slug] = t; res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }); res.end(t); })
      .catch(() => { res.writeHead(404); res.end(''); });
    return;
  }

  // ---- static files ----
  let fp = decodeURIComponent(p);
  if (fp === '/') fp = '/index.html';
  if (fp === '/firmwars') fp = '/firmwars.html';
  const file = path.join(ROOT, path.normalize(fp).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log('The Floor dashboard on :' + PORT));
