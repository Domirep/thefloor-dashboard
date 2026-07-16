# The Floor dashboard — live monitoring runbook

Auto-monitor cadence: **every ~15 min** while post-tweet traffic is live. Mode: **auto-fix & deploy**, report each cycle.

## Each cycle
1. Pull stats:
   `curl -s "https://thefloor-dashboard-production.up.railway.app/admin/stats?key=flr_4acb07318b7e"`
   (key is the Railway `ADMIN_KEY` var — view-only, keep private)
2. Optionally scan deploy logs for `EVT` / errors: `railway logs --service thefloor-dashboard`
3. Triage against the signals below.
4. If a **concrete** issue is found → make the **smallest** fix in `C:\Users\Christi\thefloor-dashboard`, validate, deploy, verify, report.
5. Report a one-line health summary even when nothing needs doing.

## Signals → action
- `js_error` (any recurring) → **fix now.** Reproduce from `msg`/`src`/`line`, patch, redeploy.
- `explorer_error` spike (>~30% of wallet lookups failing, or `lookupOkRate` < 0.6) → improve resilience (backoff, caching, clearer "busy" UX). The Robinhood Chain Blockscout is known-flaky; don't over-react to a few.
- `wallet_lookup` `ok:false` rate high → same as above.
- Device split heavily mobile → keep prioritizing mobile polish.
- `section_view` shows a section nobody scrolls to → consider reordering (like Player Report → top).
- `calc_use` low vs pageviews → the calculator isn't being discovered; consider surfacing it.

## Deploy (local, authed CLI)
```
cd C:/Users/Christi/thefloor-dashboard
node --check server.js                     # if server changed
railway up --detach --service thefloor-dashboard
```
Verify after: `curl -s -o /dev/null -w "%{http_code}" <prod-url>` and confirm the change is present.

## Guardrails (important)
- Only change code on a **concrete signal**. No speculative redesigns unattended.
- Smallest viable fix. Validate the inline `<script>` parses (`new Function(code)`) before deploy.
- Never expose the admin key in the client. Never log wallet PII beyond the pasted public 0x address.
- If unsure or the fix is large/risky → **don't auto-deploy; flag it for review** instead.
