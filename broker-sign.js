#!/usr/bin/env node
// broker-sign — the half of the loop that actually moves money.
//
// prepare_broker_trade returns UNSIGNED calldata; this signs and broadcasts it. It is the only file
// in this repo that touches a private key, and it is deliberately local-only (.railwayignore) — the
// deployed server must never hold one.
//
//   node broker-sign.js --id 1 --in <token> --out <token> --amount 0.05            # dry run
//   node broker-sign.js --id 1 --in <token> --out <token> --amount 0.05 --send     # broadcast
//   node broker-sign.js --address                                                  # whose key is this?
//
// DRY RUN IS THE DEFAULT. Without --send it prints the transaction, the live quote and the limit
// checks, and exits without signing.
//
// THE KEY IS YOURS. This script reads it from a file you create (default .env.broker, --creds to
// change) and never prints it, logs it, or sends it anywhere except into a local signature:
//     BROKER_PK=0x<64 hex>
// .env* is gitignored and this repo is public. Use a key that holds only what you are willing to
// lose to a bug in your own strategy.
//
// LIMITS ARE NOT OPTIONAL. --max-in caps a single trade and --daily-max-in caps a rolling 24h, both
// in whole tokenIn units, and --allow restricts which tokens can be touched at all. An unattended
// loop with a key and no ceiling is the entire risk of this design.
//
// Requires ethers for secp256k1 signing (npm i ethers). Hand-rolling recoverable signatures for
// something that spends real money would be a bad trade; the server itself stays dependency-free.
const fs = require('fs');
const path = require('path');

const API = process.env.FLOOR_API || 'https://thefloor-dashboard-production.up.railway.app';
const RPC = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const STATE = path.join(__dirname, '.broker-sign-state.json');

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i > -1 && args[i + 1] ? args[i + 1] : d; };

let ethers;
try { ethers = require('ethers'); }
catch { console.error('this script needs ethers for signing:  npm i ethers'); process.exit(1); }

function loadKey() {
  const f = val('creds', '.env.broker');
  const file = path.isAbsolute(f) ? f : path.join(__dirname, f);
  let raw; try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.error('cannot read ' + file + ' (' + e.code + '). Create it with BROKER_PK=0x...'); process.exit(1); }
  const m = raw.split(/\r?\n/).find(l => l.startsWith('BROKER_PK='));
  const pk = m ? m.slice('BROKER_PK='.length).trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error(file + ': BROKER_PK must be 0x + 64 hex'); process.exit(1); }
  return pk;
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

async function mcp(name, argsObj) {
  const r = await fetch(API + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argsObj } }) });
  const j = await r.json();
  const c = j && j.result && j.result.content && j.result.content[0];
  if (!c) throw new Error('MCP returned nothing usable: ' + JSON.stringify(j).slice(0, 200));
  return JSON.parse(c.text);
}

(async () => {
  const wallet = new ethers.Wallet(loadKey());
  if (flag('address')) { console.log(wallet.address); return; }

  const id = parseInt(val('id', ''), 10);
  const tokenIn = String(val('in', '')).toLowerCase();
  const tokenOut = String(val('out', '')).toLowerCase();
  const amount = Number(val('amount', ''));
  const fee = parseInt(val('fee', '10000'), 10);
  const slippage = Number(val('slippage', '2'));
  const maxIn = Number(val('max-in', '0'));
  const dailyMaxIn = Number(val('daily-max-in', '0'));
  const allow = String(val('allow', '')).toLowerCase().split(',').filter(Boolean);
  const SEND = flag('send');

  if (!(id >= 1 && id <= 4444) || !/^0x[0-9a-f]{40}$/.test(tokenIn) || !/^0x[0-9a-f]{40}$/.test(tokenOut) || !(amount > 0)) {
    console.error('usage: node broker-sign.js --id <1-4444> --in <token> --out <token> --amount <n> [--fee 10000]');
    console.error('       [--slippage 2] [--max-in n] [--daily-max-in n] [--allow t1,t2] [--send]');
    process.exit(1);
  }

  // ---- limits, before anything is built or signed ----
  if (allow.length && (!allow.includes(tokenIn) || !allow.includes(tokenOut))) {
    console.error('BLOCKED by --allow: ' + (allow.includes(tokenIn) ? tokenOut : tokenIn) + ' is not on the allowlist'); process.exit(1);
  }
  if (maxIn > 0 && amount > maxIn) { console.error(`BLOCKED by --max-in: ${amount} > ${maxIn}`); process.exit(1); }
  const st = readState();
  const key = wallet.address.toLowerCase() + ':' + tokenIn;
  const cutoff = Date.now() - 86400000;
  const recent = (st[key] || []).filter(e => e.at > cutoff);
  const spent = recent.reduce((s, e) => s + e.amt, 0);
  if (dailyMaxIn > 0 && spent + amount > dailyMaxIn) {
    console.error(`BLOCKED by --daily-max-in: ${spent} already sent in 24h, +${amount} would exceed ${dailyMaxIn}`); process.exit(1);
  }
  if (!maxIn && !dailyMaxIn) console.log('WARNING: no --max-in or --daily-max-in set. Running unattended without a ceiling is how a bad strategy becomes an expensive one.');

  // ---- build (the server does the verification; it refuses if anything is off) ----
  const tx = await mcp('prepare_broker_trade', { id, from: wallet.address, tokenIn, tokenOut, amountIn: amount, fee, slippagePct: slippage });
  if (tx.error) { console.error('server refused to build it: ' + tx.error); process.exit(1); }

  console.log('broker #' + id + ' wallet ' + tx.brokerWallet);
  console.log('signer      ' + wallet.address + (tx.brokerOwner === wallet.address.toLowerCase() ? '  (matches ownerOf)' : '  MISMATCH'));
  console.log('quote       ' + (tx.verified && tx.verified.quote));
  console.log('limits      max-in=' + (maxIn || 'none') + '  daily=' + (dailyMaxIn || 'none') + '  used24h=' + spent);
  if (tx.approveFirst) console.log('steps       2 (approve, then swap)');

  const steps = [];
  if (tx.approveFirst) steps.push({ label: 'approve', t: tx.approveFirst });
  steps.push({ label: 'swap', t: tx });

  if (!SEND) {
    for (const s of steps) console.log('\n--- would send (' + s.label + ') ---\n  to   ' + s.t.to + '\n  data ' + String(s.t.data).slice(0, 74) + '…\n  value ' + (s.t.value || '0x0'));
    console.log('\nDRY RUN — nothing signed. Add --send to broadcast.');
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = wallet.connect(provider);
  for (const s of steps) {
    const req = { to: s.t.to, data: s.t.data, value: s.t.value && s.t.value !== '0x0' ? BigInt(s.t.value) : 0n };
    // Estimate first: a revert here costs nothing, a revert on-chain costs gas and tells you less.
    try { req.gasLimit = (await provider.estimateGas({ ...req, from: wallet.address })) * 12n / 10n; }
    catch (e) { console.error(s.label + ' would revert (estimateGas failed): ' + (e.shortMessage || e.message)); process.exit(1); }
    const sent = await signer.sendTransaction(req);
    console.log(s.label + ' sent ' + sent.hash);
    const rec = await sent.wait();
    if (!rec || rec.status !== 1) { console.error(s.label + ' FAILED on-chain — stopping before the next step'); process.exit(1); }
    console.log('  confirmed in block ' + rec.blockNumber);
  }

  recent.push({ at: Date.now(), amt: amount });
  st[key] = recent; writeState(st);
  console.log('done. broker-agent.js will pick the trade up and post it.');
})().catch(e => { console.error('FAILED: ' + (e.shortMessage || e.message)); process.exit(1); });
