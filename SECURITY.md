# Security posture — The Floor companion (dashboard + MCP)

Unofficial, community-built companion to games on Robinhood Chain (The Floor, StonkBrokers).
This document is the threat model and the standing security posture. It is meant to be read
**before** you connect the MCP or trust a number it returns.

## What this server is (and is not)

- A **hosted, stateless HTTP server**. You use it at a URL; you do not install or run it locally.
- **Reads:** cached public on-chain data (desks, alpha, emissions, broker wallets, dividends,
  prices). Nothing here is authoritative — the games' own contracts are. Every cached endpoint
  returns `ageMs` (staleness) and uses `null` to mean *unknown*, never zero.
- **Writes:** every `prepare_*` tool returns **UNSIGNED calldata** (`{to, value, data}`) for **your**
  wallet to sign. This server does not now, and will never:
  - hold, request, store, or log a private key or seed phrase;
  - sign anything;
  - broadcast a transaction.
  If any tool ever asks you for a private key, that is not this server — stop.

## Custody & funds

There is **no custody**. The server never has access to funds. The most a malicious or buggy
response could do is hand you calldata you then choose to sign — so:

- Every `prepare_*` response states plainly what it does, the value it moves, and (for desk
  creation) the referrer, before you sign.
- The referrer on desk creation defaults to this dashboard's wallet, is **disclosed** in the
  response, and is **overridable** (pass your own, or the zero address for none).
- You should verify amounts yourself before signing. The docs say so everywhere.

## Write-path safety: verification-gated, fail-closed

The broker cross-game write tools (`prepare_broker_floor_desk`, `prepare_broker_floor_collect`,
`prepare_activate_broker`) are **MCP-only** (there is deliberately no website that builds or submits
these) and **fail closed**: they return an error and **no calldata** unless every check passes live
on-chain —

- `from` is required and must equal `ownerOf(tokenId)` (the broker's ERC-6551 account is owner-gated);
- the broker is activated where the policy requires it, desk state is readable and correct;
- fee quote and token allowance reads succeed.

An error means *not verified*. The calldata builders only ever assemble bytes from
internally-validated, range-checked inputs (addresses are 40-hex-validated; amounts are
fraction-safe wei; ids are integer-clamped) — no user string is interpolated into calldata.

## Data & privacy

- Telemetry is anonymous and same-origin (page views, section views, wallet-lookup counts). It
  carries no private data and is used to fix issues.
- The public `/admin/stats` surface (analytics) is **auth-gated and fails closed** — with no admin
  key configured it is unreachable; the key is compared in constant time. Environment variable
  **values are never exposed** by any endpoint (an ops-status surface returns presence booleans only).
- No personal data is compiled, and no wallet-to-identity mapping is published beyond what wallets
  have themselves linked publicly on-chain / via the game's own X-handle registry.

## Availability

Reads are heavily **cached** (per-endpoint TTLs; broker lookups are event-aware — served until a
dividend round or transfer actually changes the data) specifically so that traffic does not hammer
the upstream RPC. There is no hard per-IP rate limit today; the caching is the primary protection,
and abuse would degrade only this server's own freshness, never funds. Documented here for honesty;
rate limiting may be added.

## Review log

- **2026-07-19 — internal adversarial review.** Read the write paths, calldata builders, internal
  fetch (`selfGet` is localhost-only with validated/encoded args — no SSRF), input validation, and
  admin auth. Two issues found and fixed the same day:
  1. The `/mcp` human landing page interpolated the client-controlled `Host` header into cached HTML
     (reflected-XSS / host-header injection). **Fixed:** host is sanitized to a safe hostname charset.
  2. The admin analytics key fell back to a guessable default when unset. **Fixed:** admin auth now
     fails closed (no key ⇒ unreachable) and compares in constant time.
- This is an internal review, not a third-party audit. The code is open for community audit.

## Reporting

Found something? Open an issue on the repository, or reach the maintainer via the dashboard's
listed contact. Please do not post exploit details for anything fund-affecting publicly before it
is fixed — though note that by design there are no funds for this server to lose.
