// X (Twitter) API v2 client, OAuth 1.0a user context, zero dependencies.
//
// Split out of x-post.js so it can be REQUIRED rather than only run. x-post.js reads .env at module
// load and process.exit()s when it is missing, which is fine for a CLI and fatal for anything that
// wants to import it.
//
// It is also credential-agnostic on purpose. x-post.js posts as the dashboard; the broker agent must
// post as the BROKER'S OWNER, from their own developer app. Same code, different keys — so keys are
// passed in, never read from a fixed path, and never logged.
//
//   const { xClient, loadCreds } = require('./x-client');
//   const x = xClient(loadCreds('.env.broker'));   // or pass {apiKey, apiSecret, accessToken, accessSecret}
//   await x.verify();                              // who am I posting as?
//   await x.tweet('gm');
const fs = require('fs');
const crypto = require('crypto');

const pct = s => encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Minimal .env reader. Values may contain '=' (X secrets do), so only split on the first one.
function loadCreds(file) {
  const env = {};
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('cannot read credentials file ' + file + ' (' + e.code + ')'); }
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const creds = { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET };
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(file + ' is missing: ' + missing.join(', '));
  return creds;
}

function xClient(creds) {
  const { apiKey, apiSecret, accessToken, accessSecret } = creds || {};
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('xClient needs {apiKey, apiSecret, accessToken, accessSecret}');
  }

  // OAuth 1.0a signature. Query params must be folded into the signature base, so callers can pass
  // a bare URL with a query string and still get a valid signature.
  function authHeader(method, url) {
    const u = new URL(url);
    const p = {
      oauth_consumer_key: apiKey,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: accessToken,
      oauth_version: '1.0',
    };
    const all = { ...p };
    u.searchParams.forEach((v, k) => { all[k] = v; });
    const base = [method.toUpperCase(), pct(u.origin + u.pathname),
      pct(Object.keys(all).sort().map(k => pct(k) + '=' + pct(all[k])).join('&'))].join('&');
    const key = pct(apiSecret) + '&' + pct(accessSecret);
    p.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
    return 'OAuth ' + Object.keys(p).sort().map(k => pct(k) + '="' + pct(p[k]) + '"').join(', ');
  }

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: authHeader(method, url), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    return { status: r.status, body: j, ok: r.status < 300 };
  }

  return {
    // Who the keys actually belong to. Worth calling before a first post: a wrong-account tweet is
    // not something you can quietly undo.
    verify: () => api('GET', 'https://api.x.com/2/users/me'),
    tweet: (text, replyToId) => {
      const payload = { text };
      if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };
      return api('POST', 'https://api.x.com/2/tweets', payload);
    },
    api,
  };
}

module.exports = { xClient, loadCreds };
