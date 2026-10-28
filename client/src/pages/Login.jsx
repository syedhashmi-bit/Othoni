import React, { useEffect, useState } from 'react';
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

export default function Login() {
  // null = unknown (health not back yet / failed) — show the button anyway;
  // the server redirects back with ?error=not_configured if it can't work.
  const [configured, setConfigured] = useState(null);
  const [redirecting, setRedirecting] = useState(false);
  const [err] = useState(() => new URLSearchParams(window.location.search).get('error'));

  // /api/health is public — it says whether a Google client is set up.
  useEffect(() => {
    let alive = true;
    api.health()
      .then((h) => { if (alive) setConfigured(!!h?.auth?.google); })
      .catch(() => { /* ignore */ });
    // Drop ?error= from the address bar so a refresh doesn't re-show it.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    return () => { alive = false; };
  }, []);

  const notConfigured = configured === false || err === 'not_configured';

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          <Logo size={24} /> Othoni
        </h1>
        <p className="hint">Sign in to view VPS monitoring data.</p>

        {notConfigured ? (
          <div className="error">
            Google sign-in isn't configured on this server. Set{' '}
            <code>OTHONI_GOOGLE_CLIENT_ID</code>, <code>OTHONI_GOOGLE_CLIENT_SECRET</code>,{' '}
            <code>OTHONI_PUBLIC_URL</code> and <code>OTHONI_ADMIN_EMAILS</code> in <code>.env</code>,
            then restart othoni.
          </div>
        ) : (
          <>
            {err && <div className="error">{ERRORS[err] || ERRORS.failed}</div>}
            <a
              className="btn google-btn"
              href="/api/auth/google"
              onClick={() => setRedirecting(true)}
              aria-disabled={redirecting}
            >
              <span className="google-mark"><GoogleMark /></span>
              {redirecting ? 'Redirecting to Google…' : 'Sign in with Google'}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
