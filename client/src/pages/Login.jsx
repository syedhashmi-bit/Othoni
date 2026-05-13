import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Logo } from '../Logo.jsx';

export default function Login({ onLogin }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [totp, setT] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const totpRef = useRef(null);

  // /api/health is public — read whether TOTP is enabled so we can render
  // the code field. If the request fails (offline / etc.) we still render
  // the form without the field; the server will reject with 401 on submit
  // if a code was actually required.
  useEffect(() => {
    let alive = true;
    api.health()
      .then((h) => { if (alive) setTotpRequired(!!h?.auth?.totp); })
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api.login(username, password, totpRequired ? totp : undefined);
      onLogin(r.user);
    } catch (e) {
      if (e.status === 429) setErr('Too many attempts. Try again later.');
      else if (e.status === 401) {
        setErr(totpRequired ? 'Invalid username, password, or 2FA code.' : 'Invalid username or password.');
        // Clear the OTP after a failed attempt — current code is likely
        // expired by the time the user re-tries, and forcing a re-entry
        // surfaces clock-drift issues to the user rather than letting them
        // keep paste-the-same-thing.
        if (totpRequired) {
          setT('');
          setTimeout(() => totpRef.current?.focus(), 0);
        }
      } else setErr('Login failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>
          <Logo size={24} /> Othoni
        </h1>
        <p className="hint">
          Sign in to view VPS monitoring data.
          {totpRequired && <span> 2FA required.</span>}
        </p>

        {err && <div className="error">{err}</div>}

        <div className="field">
          <label htmlFor="u">Username</label>
          <input
            id="u"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setU(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input
            id="p"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setP(e.target.value)}
            required
          />
        </div>
        {totpRequired && (
          <div className="field">
            <label htmlFor="t">Authenticator code</label>
            <input
              id="t"
              ref={totpRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              className="mono"
              value={totp}
              onChange={(e) => setT(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
          </div>
        )}
        <button className="btn" type="submit" disabled={busy || (totpRequired && totp.length !== 6)}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
