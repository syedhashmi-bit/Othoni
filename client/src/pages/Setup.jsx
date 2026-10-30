import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Logo } from '../Logo.jsx';

// First-run setup: /setup?code=XXXX-XXXX (the link the installer prints)
// creates the first admin account and signs it in.
export default function Setup({ onLogin }) {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [needed, setNeeded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.setup.status()
      .then((r) => { if (alive) setNeeded(!!r.needed); })
      .catch(() => { if (alive) setNeeded(true); });
    // Keep the code out of the address bar (screen shares, screenshots).
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    return () => { alive = false; };
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) return setErr('Use at least 8 characters for the password.');
    if (password !== confirm) return setErr("The two passwords don't match.");
    setBusy(true);
    try {
      const r = await api.setup.complete({ code: code.trim(), email: email.trim(), password });
      onLogin(r.user);
    } catch (e) {
      if (e.status === 409) setNeeded(false);
      else setErr(e.body?.message || 'Setup failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          <Logo size={24} /> Othoni
        </h1>

        {needed === false ? (
          <>
            <p className="hint">This othoni is already set up.</p>
            <Link className="btn" to="/login" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Go to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="hint">
              Create your admin account. You'll sign in with it from now on, and can add
              more people later in Settings → Access.
            </p>
            {err && <div className="error">{err}</div>}
            <div className="field">
              <label htmlFor="code">Setup code</label>
              <input
                id="code"
                className="mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="email">Your email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus={!!code}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={mismatch}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy || needed === null}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
            <p className="fine">
              The setup code is in the installer's output, or on the server in{' '}
              <code>/var/www/othoni/data/setup-code</code>.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
