'use strict';
// Preloaded into the othoni server (node -r). Stands in for Google's token
// endpoint and JWKS so the real verification path runs end to end.
//
// The test client encodes what the "user" did at Google into the `code`:
//   base64url(JSON{ email, email_verified, nonce, challenge, redirect_uri, aud?, iss?, kid?, sub? })
// The token endpoint checks client creds, redirect_uri and PKCE like Google
// does, then mints an RS256 ID token from those claims.
const crypto = require('crypto');
const jwt = require(require.resolve('jsonwebtoken', { paths: [process.cwd()] }));

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
// A second key Google never published — tokens signed with it must fail.
const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const realFetch = global.fetch;
global.__fakeGoogleCalls = { jwks: 0, token: 0 };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://www.googleapis.com/oauth2/v3/certs') {
    global.__fakeGoogleCalls.jwks++;
    return json(200, { keys: [jwk] }, { 'cache-control': 'public, max-age=3600' });
  }
  if (u === 'https://oauth2.googleapis.com/token') {
    global.__fakeGoogleCalls.token++;
    const body = new URLSearchParams(String(opts.body));
    if (body.get('client_id') !== process.env.OTHONI_GOOGLE_CLIENT_ID ||
        body.get('client_secret') !== process.env.OTHONI_GOOGLE_CLIENT_SECRET) {
      return json(401, { error: 'invalid_client' });
    }
    if (body.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    let c;
    try { c = JSON.parse(Buffer.from(body.get('code'), 'base64url').toString()); }
    catch { return json(400, { error: 'invalid_grant' }); }
    if (body.get('redirect_uri') !== c.redirect_uri) return json(400, { error: 'redirect_uri_mismatch' });
    const challenge = crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
    if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: c.iss || 'https://accounts.google.com',
      aud: c.aud || process.env.OTHONI_GOOGLE_CLIENT_ID,
      sub: c.sub || '1098765432101234567890',
      email: c.email,
      email_verified: c.email_verified,
      nonce: c.nonce,
      iat: now,
      exp: now + 3600,
    };
    const key = c.kid === 'rogue' ? rogue : privateKey;
    const id_token = jwt.sign(claims, key, { algorithm: 'RS256', keyid: c.kid === 'unknown' ? 'nope' : 'test-kid' });
    return json(200, { access_token: 'x', id_token, token_type: 'Bearer', expires_in: 3599 });
  }
  return realFetch(url, opts);
};
