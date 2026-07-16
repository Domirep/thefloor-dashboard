// X (Twitter) posting via API v2 with OAuth 1.0a user context — zero dependencies.
// Usage:
//   node x-post.js verify              -> GET /2/users/me (auth check, posts nothing)
//   node x-post.js tweet "text"        -> post a single tweet
//   node x-post.js thread thread.json  -> post an array of tweets as a reply chain
// Credentials come from .env in this directory (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// minimal .env loader (no dotenv dep; values may contain '=')
const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const CK = env.X_API_KEY, CS = env.X_API_SECRET, AT = env.X_ACCESS_TOKEN, AS = env.X_ACCESS_SECRET;
if (!CK || !CS || !AT || !AS) { console.error('missing X_* credentials in .env'); process.exit(1); }

const pct = s => encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(method, url) {
  const p = {
    oauth_consumer_key: CK,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: AT,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(p).sort().map(k => `${pct(k)}=${pct(p[k])}`).join('&');
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');
  const key = `${pct(CS)}&${pct(AS)}`;
  p.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map(k => `${pct(k)}="${pct(p[k])}"`).join(', ');
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: oauthHeader(method, url), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: r.status, body: j };
}

async function postTweet(text, replyToId) {
  const payload = { text };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };
  return api('POST', 'https://api.x.com/2/tweets', payload);
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'verify') {
    const r = await api('GET', 'https://api.x.com/2/users/me');
    console.log(r.status, JSON.stringify(r.body));
  } else if (cmd === 'tweet') {
    const r = await postTweet(arg);
    console.log(r.status, JSON.stringify(r.body));
  } else if (cmd === 'thread') {
    const tweets = JSON.parse(fs.readFileSync(arg, 'utf8'));
    let prev = null;
    for (let i = 0; i < tweets.length; i++) {
      const r = await postTweet(tweets[i], prev);
      if (r.status >= 300 || !r.body.data) { console.error(`tweet ${i + 1} FAILED:`, r.status, JSON.stringify(r.body)); process.exit(1); }
      prev = r.body.data.id;
      console.log(`tweet ${i + 1}/${tweets.length} posted: https://x.com/i/status/${prev}`);
      if (i < tweets.length - 1) await new Promise(s => setTimeout(s, 2000));
    }
  } else {
    console.log('usage: node x-post.js verify | tweet "text" | thread file.json');
  }
})();
