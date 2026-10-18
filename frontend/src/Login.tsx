import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setToken } from './api';

const DEMO = [
  ['alice.admin@demo.test', 'Admin, all teams'],
  ['liam.lead@demo.test', 'Lead in Payments Ops'],
  ['lena.lead@demo.test', 'Lead in Support and Compliance'],
  ['mia.member@demo.test', 'Member in Payments, Support'],
  ['vera.viewer@demo.test', 'Viewer (read only)'],
  ['noah.member@demo.test', 'Member in Compliance, Platform'],
];

export default function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('mia.member@demo.test');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
      setToken(r.token);
      qc.clear();
      location.hash = '#/';
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card">
        <h1>Operations Desk</h1>
        <p className="muted">Sign in to see the work your teams need to move.</p>
        <label className="field"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="banner error" role="alert">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="card demo">
        <h2>Demo accounts</h2>
        <p className="muted">Password for all: password123</p>
        {DEMO.map(([e, d]) => (
          <button key={e} type="button" className="ghost left" onClick={() => setEmail(e)}>
            {e}<small>{d}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
