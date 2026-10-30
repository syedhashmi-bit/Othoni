'use strict';
// Drives first-run setup and email + password sign-in against a running
// othoni. Run via run.sh, which boots the server for each phase:
//   local      fresh data dir, https OTHONI_PUBLIC_URL, Google also configured
//   local-off  same data, restarted with OTHONI_PASSWORD_LOGIN=off
//   plain      fresh data dir, no public URL, no Google (the no-domain install)
//   direct     same, bound to a private non-loopback address
const fs = require('fs');
const BASE = process.argv[2];
const PHASE = process.argv[3] || 'local';
const CODE_FILE = process.env.CODE_FILE;
let failures = 0;
let ipSeq = 10;
const nextIp = () => `198.51.100.${ipSeq++}`;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
}

// A tiny cookie jar per "browser": session + csrf cookies, CSRF header echo.
function browser(ip = nextIp(), base = BASE, extraHeaders = {}) {
  const jar = {};
  return {
    jar,
    ip,
    async req(path, { method = 'GET', body } = {}) {
      const headers = { 'x-forwarded-for': ip, ...extraHeaders };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && jar.othoni_csrf) headers['x-othoni-csrf'] = decodeURIComponent(jar.othoni_csrf);
      const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookies = r.headers.getSetCookie();
      for (const c of setCookies) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i);
        const v = kv.slice(i + 1);
        if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k]; else jar[k] = v;
      }
      let json = null;
      try { json = await r.json(); } catch { /* */ }
      return { status: r.status, body: json, setCookies, headers: r.headers };
    },
  };
}

const login = (b, email, password) => b.req('/api/auth/login', { method: 'POST', body: { email, password } });
const sessionCookieOf = (r) => r.setCookies.find((c) => c.startsWith('othoni_session=')) || '';

async function local() {
  const anon = browser();
  const h = await anon.req('/api/health');
  check('health: password on, setup pending, google on', h.body?.auth?.password === true && h.body.auth.setup === true && h.body.auth.google === true, h.body?.auth);
  const st = await anon.req('/api/setup');
  check('GET /api/setup → needed', st.status === 200 && st.body?.needed === true, st);

  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  const mode = (fs.statSync(CODE_FILE).mode & 0o777).toString(8);
  check('setup code file exists, 0600, XXXX-XXXX', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) && mode === '600', { code, mode });

  const early = await login(browser(), 'admin@local.test', 'whatever-123');
  check('login before any account → 401', early.status === 401, early);

  const bad = await anon.req('/api/setup', { method: 'POST', body: { code: 'AAAA-AAAA', email: 'admin@local.test', password: 'correct-horse' } });
  check('setup with wrong code → 403 bad_code', bad.status === 403 && bad.body?.error === 'bad_code', bad);
  const badEmail = await anon.req('/api/setup', { method: 'POST', body: { code, email: 'not-an-email', password: 'correct-horse' } });
  check('setup with bad email → 400 invalid_email', badEmail.status === 400 && badEmail.body?.error === 'invalid_email', badEmail);
  const shortPw = await anon.req('/api/setup', { method: 'POST', body: { code, email: 'admin@local.test', password: 'short' } });
  check('setup with short password → 400 invalid_password', shortPw.status === 400 && shortPw.body?.error === 'invalid_password', shortPw);

  // Lowercase, no dash: people retype codes.
  const admin = browser();
  const done = await admin.req('/api/setup', { method: 'POST', body: { code: code.toLowerCase().replace('-', ''), email: 'Admin@Local.Test', password: 'correct-horse' } });
  check('setup with the code creates the admin and signs in', done.status === 200 && done.body?.user?.username === 'admin@local.test' && done.body.user.role === 'admin', done);
  check('setup session cookie is Secure (https public URL)', /Secure/.test(sessionCookieOf(done)) && /HttpOnly/.test(sessionCookieOf(done)), sessionCookieOf(done));
  check('setup code file removed after use', !fs.existsSync(CODE_FILE));
  const again = await browser().req('/api/setup', { method: 'POST', body: { code, email: 'evil@local.test', password: 'correct-horse' } });
  check('second setup → 409 already_set_up', again.status === 409 && again.body?.error === 'already_set_up', again);
  const h2 = await anon.req('/api/health');
  check('health: setup no longer pending', h2.body?.auth?.setup === false, h2.body?.auth);

  const me = await admin.req('/api/auth/me');
  check('me → admin via password', me.body?.user?.role === 'admin' && me.body.user.method === 'password', me.body);

  const wrong = await login(browser(), 'admin@local.test', 'wrong-password');
  check('wrong password → 401', wrong.status === 401, wrong.status);
  const unknown = await login(browser(), 'nobody@local.test', 'correct-horse');
  check('unknown email → 401', unknown.status === 401, unknown.status);
  const admin2 = browser();
  const ok = await login(admin2, 'ADMIN@local.test', 'correct-horse');
  check('right password (email case-insensitive) → 200 + session', ok.status === 200 && !!sessionCookieOf(ok) && ok.body?.user?.role === 'admin', ok);

  // Accounts API
  const created = await admin.req('/api/accounts', { method: 'POST', body: { email: 'viewer@local.test', password: 'viewer-pass-1', role: 'viewer' } });
  check('admin creates a viewer', created.status === 200 && created.body?.account?.role === 'viewer' && !('passwordHash' in created.body.account), created);
  const dup = await admin.req('/api/accounts', { method: 'POST', body: { email: 'viewer@local.test', password: 'viewer-pass-1' } });
  check('duplicate email → 400 email_taken', dup.status === 400 && dup.body?.error === 'email_taken', dup);
  const noCsrf = await fetch(`${BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `othoni_session=${admin.jar.othoni_session}`, 'x-forwarded-for': admin.ip },
    body: JSON.stringify({ email: 'x@local.test', password: 'xxxxxxxx' }),
  });
  check('account create without CSRF header → 403', noCsrf.status === 403, noCsrf.status);
  const list = await admin.req('/api/accounts');
  check('GET /api/accounts lists both, no hashes', list.body?.accounts?.length === 2 && list.body.accounts.every((a) => !('passwordHash' in a)) && list.body.passwordLogin === true, list.body);
  const viewerId = created.body?.account?.id;

  const viewer = browser();
  const vl = await login(viewer, 'viewer@local.test', 'viewer-pass-1');
  const vme = await viewer.req('/api/auth/me');
  check('viewer signs in as viewer', vl.status === 200 && vme.body?.user?.role === 'viewer', vme.body);
  const vlist = await viewer.req('/api/accounts');
  check('viewer gets 403 on /api/accounts', vlist.status === 403, vlist.status);
  const vwrong = await viewer.req('/api/account/password', { method: 'POST', body: { current: 'nope-nope', password: 'viewer-pass-2' } });
  check('own password change with wrong current → 403', vwrong.status === 403 && vwrong.body?.error === 'wrong_password', vwrong);
  const viewerOther = browser();
  await login(viewerOther, 'viewer@local.test', 'viewer-pass-1');
  const vchange = await viewer.req('/api/account/password', { method: 'POST', body: { current: 'viewer-pass-1', password: 'viewer-pass-2' } });
  check('viewer changes own password', vchange.status === 200 && vchange.body?.revokedSessions >= 1, vchange);
  check('…keeps this session', (await viewer.req('/api/auth/me')).status === 200);
  check('…signs out the other one', (await viewerOther.req('/api/auth/me')).status === 401);
  check('old password no longer works', (await login(browser(), 'viewer@local.test', 'viewer-pass-1')).status === 401);
  check('new password works', (await login(browser(), 'viewer@local.test', 'viewer-pass-2')).status === 200);

  const dis = await admin.req(`/api/accounts/${viewerId}`, { method: 'PATCH', body: { disabled: true } });
  check('admin disables viewer', dis.status === 200 && dis.body?.account?.disabled === true, dis);
  check('disabled viewer loses session', (await viewer.req('/api/auth/me')).status === 401);
  check('disabled viewer cannot sign in', (await login(browser(), 'viewer@local.test', 'viewer-pass-2')).status === 401);
  await admin.req(`/api/accounts/${viewerId}`, { method: 'PATCH', body: { disabled: false } });
  const viewer3 = browser();
  check('re-enabled viewer signs in', (await login(viewer3, 'viewer@local.test', 'viewer-pass-2')).status === 200);
  const reset = await admin.req(`/api/accounts/${viewerId}`, { method: 'PATCH', body: { password: 'reset-by-admin' } });
  check('admin resets viewer password', reset.status === 200, reset);
  check('…which signs the viewer out', (await viewer3.req('/api/auth/me')).status === 401);

  // Google admins exist in this phase, so deleting the last local admin is allowed — just don't.
  const google = await admin.req('/api/sign-in');
  check('/api/sign-in reports password + google', google.body?.password === true && google.body.configured === true, google.body);

  // Lockout: 5 wrong from one IP → locked, even with the right password.
  const attacker = browser();
  let last;
  for (let i = 0; i < 5; i++) last = await login(attacker, 'admin@local.test', `guess-${i}-xx`);
  check('5th wrong password from one IP → 429 locked', last.status === 429 && last.body?.error === 'locked' && last.headers.get('retry-after'), last);
  check('locked IP refused even with the right password', (await login(attacker, 'admin@local.test', 'correct-horse')).status === 429);
  check('other IPs unaffected', (await login(browser(), 'admin@local.test', 'correct-horse')).status === 200);

  // Locked-out recovery: the reset script edits accounts.json while the
  // server is running, and the new password has to work straight away.
  const out = require('child_process').execFileSync(process.execPath, [process.env.RESET_SCRIPT, 'viewer@local.test'], { encoding: 'utf8' });
  const newPw = /New password for [^:]+: (\S+)/.exec(out)?.[1];
  check('reset-password.js prints a new password', !!newPw, out);
  check('…which works on the running server straight away', (await login(browser(), 'viewer@local.test', newPw)).status === 200);
  check('…and the old one no longer does', (await login(browser(), 'viewer@local.test', 'reset-by-admin')).status === 401);

  // Bad setup codes after setup is done → 409, not a code oracle.
  check('setup after setup → 409 even with junk', (await browser().req('/api/setup', { method: 'POST', body: { code: 'x' } })).status === 409);

  const acct = JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE, 'utf8'));
  const amode = (fs.statSync(process.env.ACCOUNTS_FILE).mode & 0o777).toString(8);
  check('accounts.json is 0600 with scrypt hashes', amode === '600' && acct.accounts.every((a) => /^scrypt\$/.test(a.passwordHash)), { amode });

  fs.writeFileSync(process.env.SESSIONS_OUT, JSON.stringify({ admin: admin.jar }));
}

async function localOff() {
  const anon = browser();
  const h = await anon.req('/api/health');
  check('password off: health says password false, setup false', h.body?.auth?.password === false && h.body.auth.setup === false, h.body?.auth);
  const { admin } = JSON.parse(fs.readFileSync(process.env.SESSIONS_OUT, 'utf8'));
  const r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `othoni_session=${admin.othoni_session}` } });
  check('password off: existing password session → 401', r.status === 401, r.status);
  const l = await login(browser(), 'admin@local.test', 'correct-horse');
  check('password off: POST /api/auth/login → 404', l.status === 404 && l.body?.error === 'password_login_off', l);
  const st = await anon.req('/api/setup');
  check('password off: no setup', st.body?.needed === false, st.body);
}

async function plain() {
  const anon = browser();
  const h = await anon.req('/api/health');
  check('no-domain install: password on, google off, setup pending', h.body?.auth?.password === true && h.body.auth.google === false && h.body.auth.setup === true, h.body?.auth);
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  const admin = browser();
  const done = await admin.req('/api/setup', { method: 'POST', body: { code, email: 'me@home.test', password: 'home-lab-pass' } });
  const cookie = sessionCookieOf(done);
  check('plain http: session cookie set without Secure', done.status === 200 && cookie && !/Secure/.test(cookie), cookie);
  check('plain http: session works', (await admin.req('/api/auth/me')).body?.user?.role === 'admin');
  const viaTls = browser(nextIp(), BASE, { 'x-forwarded-proto': 'https' });
  const l = await login(viaTls, 'me@home.test', 'home-lab-pass');
  check('behind a local https proxy (X-Forwarded-Proto) → Secure cookie', /Secure/.test(sessionCookieOf(l)), sessionCookieOf(l));

  const list = await admin.req('/api/accounts');
  const selfId = list.body?.accounts?.[0]?.id;
  const del = await admin.req(`/api/accounts/${selfId}`, { method: 'DELETE' });
  check('cannot delete the last admin (no Google)', del.status === 400 && del.body?.error === 'last_admin', del);
  const dis = await admin.req(`/api/accounts/${selfId}`, { method: 'PATCH', body: { disabled: true } });
  check('cannot disable the last admin', dis.status === 400 && dis.body?.error === 'last_admin', dis);
}

// Server bound to a private, non-loopback address: this client reaches it
// directly, not through a local proxy, so it can't pick its IP with
// X-Forwarded-For — rotating fake IPs still trips the per-IP lock.
async function direct() {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await login(browser(`192.0.2.${100 + i}`), 'me@home.test', `wrong-${i}-xxxx`);
  }
  check('direct client: forged X-Forwarded-For ignored → locked after 5', last.status === 429, last.status);
}

({ local, 'local-off': localOff, plain, direct }[PHASE])()
  .then(() => { console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(2); });
