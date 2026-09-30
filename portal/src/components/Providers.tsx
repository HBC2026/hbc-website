'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isConfigured, supabase } from '@/lib/supabase';
import type { Profile, Settings } from '@/lib/types';

export const DEFAULT_SETTINGS: Settings = {
  ot_multiplier: 1.5, standard_hours: 8, days_divisor: 30, vat_rate: 0.15, max_ot_per_day: 6,
  company: { name: 'Hassan and Bilal Company', name_ar: 'شركة حسن و بلال', address: '', phone: '', email: '', vat_no: '', cr_no: '' },
};

interface Toast { id: number; msg: string; error?: boolean }
interface AppCtx {
  loading: boolean; userId: string | null; profile: Profile | null; settings: Settings;
  signOut: () => Promise<void>; reloadSettings: () => Promise<void>;
  toast: (msg: string, error?: boolean) => void;
}
const Ctx = createContext<AppCtx | null>(null);

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside Providers');
  return c;
}

export function Providers({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3000);
  }, []);

  const reloadSettings = useCallback(async () => {
    const { data } = await supabase().from('settings').select('key, value');
    if (!data) return;
    const s: Record<string, unknown> = {};
    data.forEach((r: { key: string; value: unknown }) => { s[r.key] = r.value; });
    setSettings({ ...DEFAULT_SETTINGS, ...s, company: { ...DEFAULT_SETTINGS.company, ...(s.company as object) } } as Settings);
  }, []);

  useEffect(() => {
    if (!isConfigured) { setLoading(false); return; }
    const sb = supabase();
    let cancelled = false;

    async function load(uid: string | null) {
      setUserId(uid);
      if (!uid) { setProfile(null); setLoading(false); return; }
      const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
      if (cancelled) return;
      setProfile((data as Profile) ?? null);
      await reloadSettings();
      if (!cancelled) setLoading(false);
    }

    sb.auth.getSession().then(({ data }) => load(data.session?.user.id ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      // Defer to avoid deadlocking inside the auth callback.
      if (event === 'INITIAL_SESSION') return;
      setTimeout(() => load(session?.user.id ?? null), 0);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [reloadSettings]);

  const signOut = useCallback(async () => { await supabase().auth.signOut(); }, []);

  return (
    <Ctx.Provider value={{ loading, userId, profile, settings, signOut, reloadSettings, toast }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  );
}
