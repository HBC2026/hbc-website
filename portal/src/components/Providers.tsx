'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isConfigured, setCompanyId, supabase, getCompanyId } from '@/lib/supabase';
import { Modal } from '@/components/ui';
import type { Company, Profile, Role, Settings } from '@/lib/types';

export const DEFAULT_SETTINGS: Settings = {
  ot_multiplier: 1.5, standard_hours: 8, days_divisor: 30, vat_rate: 0.15, max_ot_per_day: 6,
  company: { name: 'Hassan and Bilal Company', name_ar: 'شركة حسن و بلال', address: '', phone: '', email: '', vat_no: '', cr_no: '' },
};

export interface ConfirmOptions { title?: string; message: string; confirmLabel?: string; danger?: boolean }

interface Toast { id: number; msg: string; error?: boolean }
interface AppCtx {
  loading: boolean; userId: string | null; profile: Profile | null; settings: Settings;
  /** Companies the user belongs to, and the one currently shown. `profile.role` is the role in that company. */
  companies: Company[]; company: Company | null; switchCompany: (id: string) => void;
  signOut: () => Promise<void>; reloadSettings: () => Promise<void>;
  toast: (msg: string, error?: boolean) => void;
  /** In-app replacement for window.confirm: resolves true on OK, false on Cancel / Esc / click outside. */
  confirmDialog: (o: string | ConfirmOptions) => Promise<boolean>;
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
  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirmDialog = useCallback((o: string | ConfirmOptions) => new Promise<boolean>((resolve) => {
    setDialog({ ...(typeof o === 'string' ? { message: o } : o), resolve });
  }), []);
  const answer = (ok: boolean) => { dialog?.resolve(ok); setDialog(null); };

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
      if (!uid) { setProfile(null); setCompanies([]); setCompany(null); setLoading(false); return; }

      // Which companies can this user open, and in which role? The choice must be set before any other query.
      const { data: mem } = await sb.from('company_members').select('role, companies(id, code, name, name_ar)').eq('user_id', uid);
      const rows = ((mem ?? []) as unknown as { role: Role; companies: Company }[])
        .filter((m) => m.companies)
        .sort((a, b) => a.companies.name.localeCompare(b.companies.name));
      const chosen = rows.find((m) => m.companies.id === getCompanyId()) ?? rows[0];
      setCompanyId(chosen ? chosen.companies.id : null);

      const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
      if (cancelled) return;
      setCompanies(rows.map((m) => m.companies));
      setCompany(chosen ? chosen.companies : null);
      setProfile(data ? ({ ...(data as Profile), role: chosen ? chosen.role : 'viewer' }) : null);
      if (chosen) await reloadSettings();
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

  /** Switching reloads the app on the dashboard so no data from the other company stays on screen. */
  const switchCompany = useCallback((id: string) => {
    setCompanyId(id);
    window.location.assign('/adminconsole');
  }, []);

  const signOut = useCallback(async () => { await supabase().auth.signOut(); }, []);

  return (
    <Ctx.Provider value={{ loading, userId, profile, settings, companies, company, switchCompany, signOut, reloadSettings, toast, confirmDialog }}>
      {children}
      {dialog && (
        <Modal title={dialog.title ?? 'Please confirm'} onClose={() => answer(false)}
          footer={<>
            <button className="btn" onClick={() => answer(false)}>Cancel</button>
            <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => answer(true)}>{dialog.confirmLabel ?? 'OK'}</button>
          </>}>
          <p style={{ margin: 0, whiteSpace: 'pre-line', lineHeight: 1.55 }}>{dialog.message}</p>
        </Modal>
      )}
      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  );
}
