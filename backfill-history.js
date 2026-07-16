// One-time historical reconstruction of the Trends series -> history.seed.json
//
// WHY THIS EXISTS: snapshotHistory() in server.js only records the CURRENT day, so the chart could only
// ever grow forward from whenever the volume was last reset (prod was down to 2 days). The token is only
// ~14 days old, so its ENTIRE life is reconstructable from chain + GeckoTerminal — this backfills it once,
// ships the result as a seed, and the live snapshotter takes over from there. Real snapshots always win.
//
// Row shape must match snapshotHistory() exactly (see server.js). Fields we cannot honestly reconstruct
// are OMITTED, never zero-filled — drawTrend() skips absent values rather than plotting a fake 0.
//
//   run:  node backfill-history.js          (writes history.seed.json)
//
// The public RPC rate-limits hard (429 "Too Many Requests"), so every call is paced and retried.

const fs = require('fs');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FLOOR = '0xA80Ba06F0a0327E68dA6BedE67eB35ac023D6e62';
const GAME = '0x89d40f5e4d260577691d05e681d47519eb44f113';
const POOL = '0x73ed66f4e5e7e59e279cab050074bfeaec5c55a2';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ALPHA_SEL = '0xec98557e';                 // globalAlphaPower()
const GECKO_NET = 'robinhood';

const sleep = ms => new Promise(s => setTimeout(s, ms));
const addrOf = t => (t && t.length === 66) ? ('0x' + t.slice(26)).toLowerCase() : null;
const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

let calls = 0;
async function rpc(method, params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      calls++;
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j && 'result' in j) return j.result;
    } catch (_) {}
    await sleep(1000 * (i + 1));                // 429s need real backoff, not 200ms
  }
  return null;
}
async function rpcBatch(body, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      calls++;
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (Array.isArray(j) && j.length === body.length && j.every(x => x && ('result' in x))) {
        const m = {}; j.forEach(x => { m[x.id] = x.result; }); return m;
      }
    } catch (_) {}
    await sleep(1000 * (i + 1));
  }
  return null;
}
// Paced, chunked log scan. One 1M-block window at a time with a gap, or the RPC 429s.
async function scanLogs(filter, latest, step = 1000000, gap = 1300) {
  const out = [];
  for (let f = 0; f <= latest; f += step) {
    const to = Math.min(f + step - 1, latest);
    const r = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }]);
    if (!Array.isArray(r)) throw new Error('log scan failed at block ' + f);
    out.push(...r);
    await sleep(gap);
  }
  return out;
}

(async () => {
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const head = await rpc('eth_getBlockByNumber', ['0x' + latest.toString(16), false]);
  const headTs = parseInt(head.timestamp, 16) * 1000;
  console.log('latest block', latest, '=', new Date(headTs).toISOString());

  console.log('\nscanning FLOOR transfers (paced)…');
  const xfers = await scanLogs({ address: FLOOR, topics: [TRANSFER] }, latest);
  xfers.sort((a, b) => (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) || (parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)));
  console.log('  transfers:', xfers.length);

  console.log('scanning game contract logs (paced)…');
  const glogs = await scanLogs({ address: GAME }, latest);
  glogs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
  console.log('  game logs:', glogs.length);

  // ---- day boundaries: first block at/after each UTC midnight, all days binary-searched in parallel ----
  const firstTs = parseInt((await rpc('eth_getBlockByNumber', ['0x' + parseInt(xfers[0].blockNumber, 16).toString(16), false])).timestamp, 16) * 1000;
  const days = [];
  for (let t = Date.UTC(...dayKey(firstTs).split('-').map((v, i) => i === 1 ? +v - 1 : +v)); t <= headTs; t += 86400000) days.push({ d: dayKey(t), end: t + 86400000 });
  console.log('\ndays to reconstruct:', days.length, '(' + days[0].d + ' -> ' + days[days.length - 1].d + ')');

  let lo = days.map(() => 0), hi = days.map(() => latest);
  for (let it = 0; it < 26; it++) {
    const mids = days.map((_, i) => Math.floor((lo[i] + hi[i]) / 2));
    const res = await rpcBatch(mids.map((m, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['0x' + m.toString(16), false] })));
    if (!res) throw new Error('block batch failed');
    days.forEach((day, i) => {
      const b = res[i]; if (!b) return;
      const ts = parseInt(b.timestamp, 16) * 1000;
      if (ts < day.end) lo[i] = mids[i] + 1; else hi[i] = mids[i];
    });
    await sleep(400);
  }
  // snapshot block for day D = last block of that day
  days.forEach((day, i) => { day.block = Math.min(Math.max(0, hi[i] - 1), latest); });

  // ---- replay every transfer, snapshotting cumulative state at each day boundary ----
  const bal = new Map(), seenPlayer = new Set();
  const add = (a, v) => { if (!a) return; bal.set(a, (bal.get(a) || 0) + v); };
  let minted = 0, burned = 0, xi = 0, gi = 0;
  const rows = [];
  for (const day of days) {
    for (; xi < xfers.length && parseInt(xfers[xi].blockNumber, 16) <= day.block; xi++) {
      const l = xfers[xi];
      const from = addrOf(l.topics[1]), to = addrOf(l.topics[2]);
      let v = 0; try { v = Number(BigInt(l.data)) / 1e18; } catch (_) { continue; }
      if (from === ZERO) minted += v; else add(from, -v);
      if (to === ZERO) burned += v; else add(to, v);
    }
    for (; gi < glogs.length && parseInt(glogs[gi].blockNumber, 16) <= day.block; gi++) {
      const a = addrOf(glogs[gi].topics && glogs[gi].topics[1]);
      if (a && a !== ZERO) seenPlayer.add(a);
    }
    const supply = minted - burned;                       // verified identity: mints - burns === totalSupply
    const deadBal = bal.get(DEAD) || 0;
    const circulating = Math.max(0, supply - deadBal);
    let holders = 0; for (const v of bal.values()) if (v > 1e-9) holders++;
    rows.push({ d: day.d, block: day.block, burned: Math.round(burned), supply: Math.round(supply),
      circulating: Math.round(circulating), burnedPct: supply > 0 ? +(burned / supply * 100).toFixed(3) : 0,
      players: seenPlayer.size, holdersReplay: holders, ts: day.end - 1 });
  }

  // ---- price + 24h volume: GeckoTerminal daily candles ----
  const o = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/${GECKO_NET}/pools/${POOL}/ohlcv/day?aggregate=1&limit=1000`, { headers: { accept: 'application/json' } })).json();
  const candles = new Map();
  ((o.data && o.data.attributes && o.data.attributes.ohlcv_list) || []).forEach(c => candles.set(dayKey(c[0] * 1000), { close: c[4], vol: c[5] }));
  console.log('gecko candles:', candles.size);

  // ---- alpha: globalAlphaPower() at each day's block. Partial-archive node — older days will fail,
  // and those days simply omit `alpha` rather than claim zero. ----
  let alphaOk = 0;
  for (const r of rows) {
    const res = await rpc('eth_call', [{ to: GAME, data: ALPHA_SEL }, '0x' + r.block.toString(16)], 3);
    if (res && res !== '0x') { try { r.alpha = Number(BigInt(res)); alphaOk++; } catch (_) {} }
    await sleep(220);
  }
  console.log('alpha recovered for', alphaOk, 'of', rows.length, 'days (partial archive)');

  // ---- assemble rows in snapshotHistory() shape; omit what we can't honestly source ----
  const out = rows.map(r => {
    const c = candles.get(r.d);
    const row = { d: r.d, burned: r.burned, burnedPct: r.burnedPct, supply: r.supply,
      circulating: r.circulating, players: r.players, ts: r.ts, seeded: true };
    if (c) { row.price = c.close; row.marketCap = Math.round(c.close * r.circulating); row.vol24 = Math.round(c.vol); }
    if (r.alpha !== undefined) row.alpha = r.alpha;
    return row;
  });

  fs.writeFileSync('history.seed.json', JSON.stringify(out, null, 1));
  console.log('\nwrote history.seed.json:', out.length, 'days | rpc calls:', calls);
  console.table(out.map(r => ({ d: r.d, burned: r.burned, price: r.price ? +r.price.toFixed(5) : '-', mcap: r.marketCap || '-', players: r.players, alpha: r.alpha || '-' })));
  console.log('\nreplay-derived holders (for comparison vs blockscout holders_count):');
  console.log(rows.slice(-3).map(r => '  ' + r.d + ': ' + r.holdersReplay).join('\n'));
})().catch(e => { console.error('BACKFILL FAILED:', e.message); process.exit(1); });
