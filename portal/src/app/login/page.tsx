'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/Providers';
import { asset, isConfigured, supabase } from '@/lib/supabase';

export default function LoginPage() {
  const { userId, loading } = useApp();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loading && userId) router.replace('/'); }, [loading, userId, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <img src={asset('/hbc-logo.webp')} alt="Hassan and Bilal Company" />
        <h1>Administration Portal</h1>
        <p className="sub">Sign in with your company account</p>
        {!isConfigured && <div className="banner warn">Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local.</div>}
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw">Password</label>
            <input id="pw" className="input" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <div className="banner error" style={{ marginBottom: 0 }}>{error}</div>}
          <button className="btn primary" style={{ justifyContent: 'center', height: 40 }} disabled={busy || !isConfigured}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
