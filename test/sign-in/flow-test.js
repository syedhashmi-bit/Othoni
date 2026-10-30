'use strict';
// Drives the Google sign-in flow against a running othoni (with fake-google.js
// preloaded). Run via run.sh, which boots the server for each phase.
const BASE = process.argv[2];
const PHASE = process.argv[3] || 'main';
let failures = 0;
let ipSeq = 10;
const nextIp = () => `203.0.113.${ipSeq++}`;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
}

async function start(ip) {
  const r = await fetch(`${BASE}/api/auth/google`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
  const location = r.headers.get('location') || '';
  const cookies = r.headers.getSetCookie();
  const flowCookie = cookies.find((c) => c.startsWith('othoni_oauth=')) || '';
  let loc = null;
  try { loc = new URL(location); } catch { /* relative */ }
  return { status: r.status, location, loc, flowCookie, state: loc && loc.searchParams.get('state') };
}

function makeCode(s, claims) {
  const p = s.loc.searchParams;
  return Buffer.from(JSON.stringify({
    email_verified: true,
    nonce: p.get('nonce'),
    challenge: p.get('code_challenge'),
    redirect_uri: p.get('redirect_uri'),
    ...claims,
  })).toString('base64url');
}

async function callback(ip, params, cookie) {
  const r = await fetch(`${BASE}/api/auth/google/callback?${new URLSearchParams(params)}`, {
    redirect: 'manual',
    headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
  });
  return { status: r.status, location: r.headers.get('location'), cookies: r.headers.getSetCookie() };
}

async function login(claims, { ip = nextIp(), state, cookieState } = {}) {
  const s = await start(ip);
  const cb = await callback(
    ip,
    { code: makeCode(s, claims), state: state ?? s.state },
    `othoni_oauth=${cookieState ?? s.state}`
  );
  const session = cb.cookies.find((c) => c.startsWith('othoni_session='));
  return { s, cb, ip, sessionCookie: session ? session.split(';')[0] : null };
}

async function get(path, cookie, ip = nextIp(), method = 'GET') {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie: cookie || '', 'x-forwarded-for': ip } });
  let body = null;
  try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
}

async function main() {
  const h = await get('/api/health');
  check('health reports google configured', h.body?.auth?.google === true, h.body?.auth);
  check('health no longer exposes totp/lockout', h.body?.auth && !('totp' in h.body.auth) && !('lockout' in h.body.auth), h.body?.auth);

  const s = await start(nextIp());
  const p = s.loc && s.loc.searchParams;
  check('start redirects to Google', s.status === 302 && s.loc?.origin === 'https://accounts.google.com' && s.loc.pathname === '/o/oauth2/v2/auth', s.location);
  check('start sends PKCE S256 + nonce + state', p?.get('code_challenge_method') === 'S256' && p.get('code_challenge')?.length === 43 && p.get('nonce')?.length >= 43 && p.get('state')?.length >= 43, Object.fromEntries(p || []));
  check('start uses OTHONI_PUBLIC_URL redirect', p?.get('redirect_uri') === 'https://othoni.test/api/auth/google/callback', p?.get('redirect_uri'));
  check('start scope + prompt', p?.get('scope') === 'openid email' && p.get('prompt') === 'select_account' && p.get('response_type') === 'code');
  check('flow cookie is HttpOnly/Secure/Lax, path-scoped', /HttpOnly/i.test(s.flowCookie) && /Secure/i.test(s.flowCookie) && /SameSite=Lax/i.test(s.flowCookie) && /Path=\/api\/auth\/google/.test(s.flowCookie), s.flowCookie);

  // Happy path: admin (allowlist is case-insensitive: env has Admin@Example.com)
  const a = await login({ email: 'admin@example.com' });
  check('admin callback redirects to /', a.cb.status === 302 && a.cb.location === '/', a.cb);
  check('admin callback sets session + csrf cookies', !!a.sessionCookie && a.cb.cookies.some((c) => c.startsWith('othoni_csrf=')), a.cb.cookies);
  check('admin callback clears flow cookie', a.cb.cookies.some((c) => /^othoni_oauth=;/.test(c)), a.cb.cookies);
  const me = await get('/api/auth/me', a.sessionCookie);
  check('me → admin', me.status === 200 && me.body?.user?.username === 'admin@example.com' && me.body.user.role === 'admin', me);
  const si = await get('/api/sign-in', a.sessionCookie);
  check('/api/sign-in lists allowlist (viewer dedup)', si.status === 200 && si.body.configured === true &&
    JSON.stringify(si.body.admins) === '["admin@example.com"]' && JSON.stringify(si.body.viewers) === '["viewer@example.com"]' &&
    si.body.redirectUri === 'https://othoni.test/api/auth/google/callback', si.body);
  const sess = await get('/api/sessions', a.sessionCookie);
  check('session row attributed to email', sess.body?.sessions?.some((x) => x.self && x.actor === 'admin@example.com' && x.role === 'admin'), sess.body);

  // Replay of the same code/state → state already consumed
  const replay = await callback(a.ip, { code: makeCode(a.s, { email: 'admin@example.com' }), state: a.s.state }, `othoni_oauth=${a.s.state}`);
  check('state is single-use', replay.location === '/login?error=expired', replay);

  // Viewer
  const v = await login({ email: 'viewer@example.com' });
  const vme = await get('/api/auth/me', v.sessionCookie);
  check('viewer → viewer role', vme.body?.user?.role === 'viewer', vme);
  const vsi = await get('/api/sign-in', v.sessionCookie);
  check('viewer gets 403 on /api/sign-in', vsi.status === 403, vsi);
  const vpost = await get('/api/sessions/whatever', v.sessionCookie, nextIp(), 'DELETE');
  check('viewer cannot mutate', vpost.status === 403, vpost);

  // Rejections
  const na = await login({ email: 'stranger@example.com' });
  check('non-allowlisted → not_allowed, no session', na.cb.location === '/login?error=not_allowed' && !na.sessionCookie, na.cb);
  const uv = await login({ email: 'admin@example.com', email_verified: false });
  check('unverified email → unverified', uv.cb.location === '/login?error=unverified' && !uv.sessionCookie, uv.cb);
  const csrfAttack = await login({ email: 'admin@example.com' }, { cookieState: 'attacker-state' });
  check('state/cookie mismatch → expired', csrfAttack.cb.location === '/login?error=expired' && !csrfAttack.sessionCookie, csrfAttack.cb);
  const noCookie = await (async () => { const ip = nextIp(); const s2 = await start(ip); return callback(ip, { code: makeCode(s2, { email: 'admin@example.com' }), state: s2.state }, null); })();
  check('missing flow cookie → expired', noCookie.location === '/login?error=expired', noCookie);
  const badNonce = await login({ email: 'admin@example.com', nonce: 'wrong' });
  check('wrong nonce → failed', badNonce.cb.location === '/login?error=failed' && !badNonce.sessionCookie, badNonce.cb);
  const badPkce = await login({ email: 'admin@example.com', challenge: 'x'.repeat(43) });
  check('PKCE mismatch at token endpoint → failed', badPkce.cb.location === '/login?error=failed' && !badPkce.sessionCookie, badPkce.cb);
  const badAud = await login({ email: 'admin@example.com', aud: 'someone-elses-client' });
  check('wrong audience → failed', badAud.cb.location === '/login?error=failed' && !badAud.sessionCookie, badAud.cb);
  const badIss = await login({ email: 'admin@example.com', iss: 'https://evil.example' });
  check('wrong issuer → failed', badIss.cb.location === '/login?error=failed' && !badIss.sessionCookie, badIss.cb);
  const rogue = await login({ email: 'admin@example.com', kid: 'rogue' });
  check('token signed by unpublished key → failed', rogue.cb.location === '/login?error=failed' && !rogue.sessionCookie, rogue.cb);
  const unk = await login({ email: 'admin@example.com', kid: 'unknown' });
  check('unknown kid → failed', unk.cb.location === '/login?error=failed' && !unk.sessionCookie, unk.cb);
  const denied = await callback(nextIp(), { error: 'access_denied', state: 'x' }, 'othoni_oauth=x');
  check('user cancels at Google → denied', denied.location === '/login?error=denied', denied);

  // Old endpoints are gone
  const oldLogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"admin","password":"admin123"}' });
  check('POST /api/auth/login no longer logs anyone in', oldLogin.status === 401 || oldLogin.status === 404, oldLogin.status);
  const oldUsers = await get('/api/users', a.sessionCookie);
  check('/api/users is gone', oldUsers.status === 404 || (oldUsers.status === 200 && !oldUsers.body?.users), oldUsers);

  // Rate limit: one IP, 21 hits on start
  const ip = nextIp();
  let last = null;
  for (let i = 0; i < 21; i++) last = await start(ip);
  check('21st sign-in hit from one IP → rate_limited', last.status === 302 && last.location === '/login?error=rate_limited', last.location);

  require('fs').writeFileSync(process.env.SESSIONS_OUT, JSON.stringify({ admin: a.sessionCookie, viewer: v.sessionCookie }));
}

async function afterRestart() {
  // Server restarted with viewer@example.com removed from the allowlist and
  // admin demoted to viewer.
  const { admin, viewer } = JSON.parse(require('fs').readFileSync(process.env.SESSIONS_OUT, 'utf8'));
  const v = await get('/api/auth/me', viewer);
  check('removed email loses access mid-session', v.status === 401, v);
  const a = await get('/api/auth/me', admin);
  check('demoted email is viewer mid-session', a.status === 200 && a.body?.user?.role === 'viewer', a);
}

(PHASE === 'main' ? main() : afterRestart())
  .then(() => { console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(2); });
