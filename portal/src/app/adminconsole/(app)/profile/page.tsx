'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Field, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Company, Role } from '@/lib/types';

const MIN_PASSWORD = 8;

export default function ProfilePage() {
  const { profile, company, userId, reloadProfile, toast } = useApp();
  const sb = supabase();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  useEffect(() => setName(profile?.full_name ?? ''), [profile?.full_name]);

  const memberships = useQuery(async () => {
    const rows = unwrap(await sb.from('company_members').select('role, companies(id, code, name, name_ar)').eq('user_id', userId!)) as unknown as { role: Role; companies: Company }[];
    return rows.filter((m) => m.companies).sort((a, b) => a.companies.name.localeCompare(b.companies.name));
  }, [userId]);

  if (!profile) return <Loading />;
  const initials = profile.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'U';

  async function saveName() {
    const v = name.trim();
    if (!v) return toast('Name is required', true);
    setSavingName(true);
    const { error } = await sb.rpc('update_own_profile', { p_full_name: v });
    setSavingName(false);
    if (error) return toast(error.message, true);
    toast('Profile updated'); reloadProfile();
  }

  async function savePassword() {
    if (pw.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters`, true);
    if (pw !== pw2) return toast('Passwords do not match', true);
    setSavingPw(true);
    const { error } = await sb.auth.updateUser({ password: pw });
    setSavingPw(false);
    if (error) return toast(error.message, true);
    setPw(''); setPw2(''); toast('Password changed');
  }

  return (
    <>
      <PageHead eyebrow="Account" title="My profile" sub="Your name, access and sign-in password" />
      <div className="stack">
        <div className="panel">
          <div className="panel-title">Account</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
            <div className="avatar profile-avatar">{initials}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{profile.full_name || 'Unnamed user'}</div>
              <div className="muted" style={{ fontSize: 12 }}>{profile.email ?? '—'}</div>
            </div>
          </div>
          <div className="form-grid">
            <Field label="Full name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName()} /></Field>
            <Field label="Email"><input className="input" value={profile.email ?? ''} disabled /></Field>
            <Field label={`Role${company ? ` at ${company.name}` : ''}`}><input className="input" value={ROLE_LABEL[profile.role]} disabled /></Field>
            <Field label="Member since"><input className="input" value={fmtDate(profile.created_at)} disabled /></Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={savingName || name.trim() === profile.full_name} onClick={saveName}>{savingName ? 'Saving…' : 'Save name'}</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Companies and access</div>
          {memberships.loading ? <Loading /> : (memberships.data ?? []).length === 0 ? <div className="muted">No company access yet.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Company</th><th>Role</th></tr></thead>
                <tbody>
                  {(memberships.data ?? []).map((m) => (
                    <tr key={m.companies.id}>
                      <td>{m.companies.name}{m.companies.id === company?.id && <span className="muted"> (current)</span>}</td>
                      <td>{ROLE_LABEL[m.role]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Change password</div>
          <div className="form-grid">
            <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && savePassword()} /></Field>
          </div>
          <div className="muted" style={{ margin: '10px 0 14px', fontSize: 11 }}>At least {MIN_PASSWORD} characters.</div>
          <button className="btn primary" disabled={savingPw || !pw} onClick={savePassword}>{savingPw ? 'Saving…' : 'Change password'}</button>
        </div>
      </div>
    </>
  );
}
