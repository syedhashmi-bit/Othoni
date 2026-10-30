import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Logo } from '../Logo.jsx';

// Reasons the server's Google callback can bounce back with
// (`/login?error=<reason>`, see googleCallback in server/auth.js).
const ERRORS = {
  denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in attempt expired or was started in another tab. Try again.',
  unverified: "That Google account's email address isn't verified.",
  not_allowed:
    "That Google account isn't allowed to sign in here. Ask an admin to add it to OTHONI_ADMIN_EMAILS or OTHONI_VIEWER_EMAILS.",
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
  not_configured: "Google sign-in isn't set up on this server.",
  failed: 'Signing in with Google failed. Try again — if it keeps happening, check the server log.',
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Plain http to anything but this machine: the password crosses the
// network unencrypted. Worth a quiet warning, not a block — a LAN-only
// install is a legitimate choice.
function insecureConnection() {
  const { protocol, hostname } = window.location;
  return protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

export default function Login({ onLogin }) {
  // health.auth: { password, google, setup }. null until it answers; if it
  // fails, assume the password form so there's still a way in.
  const [auth, setAuth] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [redirecting, setRedirecting] = useState(false);
  const [err] = useState(() => new URLSearchParams(window.location.search).get('error'));

  useEffect(() => {
    let alive = true;
    api.health()
      .then((h) => { if (alive) setAuth(h?.auth || { password: true }); })
      .catch(() => { if (alive) setAuth({ password: true }); });
    // Drop ?error= from the address bar so a refresh doesn't re-show it.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    return () => { alive = false; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setFormErr(null);
    setBusy(true);
    try {
      const r = await api.login(email.trim(), password);
      onLogin(r.user);
    } catch (e) {
      if (e.status === 401) setFormErr('Wrong email or password.');
      else if (e.status === 429) setFormErr(e.body?.message || 'Too many attempts. Wait a few minutes and try again.');
      else if (e.status === 404) setFormErr('Password sign-in is turned off on this server.');
      else setFormErr('Sign-in failed. Please try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  if (!auth) {
    return <div className="login-wrap"><div className="login-card"><div className="muted">Loading…</div></div></div>;
  }

  const showPassword = auth.password && !auth.setup;
  const showGoogle = !!auth.google;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          <Logo size={24} /> Othoni
        </h1>
        <p className="hint">Sign in to view VPS monitoring data.</p>

        {auth.setup && (
          <div className="info">
            <strong>Almost there.</strong> No account exists yet — create the first
            admin with the setup link shown at the end of the install.
            <div style={{ marginTop: 8 }}>Lost it? The code is on the server:</div>
            <code className="cmd">sudo cat /var/www/othoni/data/setup-code</code>
            <div>Docker:</div>
            <code className="cmd">docker compose logs othoni</code>
            <Link to="/setup">Enter the code →</Link>
          </div>
        )}

        {err && <div className="error">{ERRORS[err] || ERRORS.failed}</div>}
        {formErr && <div className="error">{formErr}</div>}

        {showPassword && (
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {showPassword && showGoogle && <div className="login-divider">or</div>}

        {showGoogle && (
          <a
            className={`btn google-btn${showPassword ? ' ghost' : ''}`}
            href="/api/auth/google"
            onClick={() => setRedirecting(true)}
            aria-disabled={redirecting}
          >
            <span className="google-mark"><GoogleMark /></span>
            {redirecting ? 'Redirecting to Google…' : 'Sign in with Google'}
          </a>
        )}

        {!auth.password && !showGoogle && (
          <div className="error">
            No sign-in method is turned on. Remove <code>OTHONI_PASSWORD_LOGIN=off</code> from{' '}
            <code>.env</code>, or set up Google sign-in, then restart othoni.
          </div>
        )}

        {showPassword && insecureConnection() && (
          <p className="fine">
            This connection isn't encrypted, so your password crosses the network in plain
            text. Fine on a home network; if othoni is reachable from the internet, give it a
            domain with HTTPS (README → HTTPS).
          </p>
        )}
      </div>
    </div>
  );
}
