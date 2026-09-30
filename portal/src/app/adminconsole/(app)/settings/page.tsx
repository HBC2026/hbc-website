'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Field, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { can, ROLES, ROLE_LABEL } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Profile, Role, Settings } from '@/lib/types';

export default function SettingsPage() {
  const { profile, settings, reloadSettings, toast } = useApp();
  const canWrite = can(profile!.role, 'settings:write');
  const sb = supabase();
  const [s, setS] = useState<Settings>(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(settings), [settings]);

  const team = useQuery(async () => unwrap(await sb.from('profiles').select('*').order('created_at')) as Profile[], []);

  const num = (k: 'ot_multiplier' | 'standard_hours' | 'days_divisor' | 'vat_rate' | 'max_ot_per_day', v: string) => setS((x) => ({ ...x, [k]: Number(v) }));
  const co = (k: keyof Settings['company'], v: string) => setS((x) => ({ ...x, company: { ...x.company, [k]: v } }));

  async function save() {
    if (!(s.ot_multiplier > 0) || !(s.standard_hours > 0) || !(s.days_divisor > 0) || s.vat_rate < 0) return toast('Please enter valid numbers', true);
    setBusy(true);
    const rows = (['ot_multiplier', 'standard_hours', 'days_divisor', 'vat_rate', 'max_ot_per_day'] as const).map((key) => ({ key, value: s[key], updated_at: new Date().toISOString() }))
      .concat([{ key: 'company' as never, value: s.company as never, updated_at: new Date().toISOString() }]);
    const { error } = await sb.from('settings').upsert(rows, { onConflict: 'key' });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast('Settings saved'); reloadSettings();
  }

  async function setRole(id: string, role: Role) {
    if (id === profile!.id && role !== 'administrator' && !confirm('You are changing your own role. You will lose administrator access. Continue?')) return;
    const { error } = await sb.from('profiles').update({ role }).eq('id', id);
    if (error) return toast(error.message, true);
    toast('Role updated'); team.reload();
  }

  return (
    <>
      <PageHead eyebrow="System" title="Settings" sub="Payroll rules, quotation defaults, company details and user roles">
        {canWrite && <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>}
      </PageHead>
      {!canWrite && <div className="banner warn">Only administrators can change settings.</div>}
      <div className="stack">
        <div className="panel">
          <div className="panel-title">Payroll &amp; overtime rules</div>
          <div className="form-grid">
            <Field label="Default OT multiplier"><input className="input num" type="number" step="0.05" min="0" disabled={!canWrite} value={s.ot_multiplier} onChange={(e) => num('ot_multiplier', e.target.value)} /></Field>
            <Field label="Standard hours per day"><input className="input num" type="number" step="0.5" min="1" disabled={!canWrite} value={s.standard_hours} onChange={(e) => num('standard_hours', e.target.value)} /></Field>
            <Field label="Days per month (for daily / hourly rate)"><input className="input num" type="number" min="1" disabled={!canWrite} value={s.days_divisor} onChange={(e) => num('days_divisor', e.target.value)} /></Field>
            <Field label="Warn when OT per day exceeds (hours)"><input className="input num" type="number" step="0.5" min="0" disabled={!canWrite} value={s.max_ot_per_day} onChange={(e) => num('max_ot_per_day', e.target.value)} /></Field>
          </div>
          <div className="muted" style={{ marginTop: 12, fontSize: 11 }}>Hourly rate = basic ÷ days per month ÷ standard hours. OT amount = OT hours × hourly rate × multiplier (or a fixed hourly rate set on the employee). Unpaid days (Absent, Unpaid Leave) deduct basic ÷ days per month each. Changes apply the next time payroll is calculated; approved months are never altered.</div>
        </div>

        <div className="panel">
          <div className="panel-title">Quotations</div>
          <div className="form-grid"><Field label="Default VAT rate (e.g. 0.15 = 15%)"><input className="input num" type="number" step="0.01" min="0" disabled={!canWrite} value={s.vat_rate} onChange={(e) => num('vat_rate', e.target.value)} /></Field></div>
        </div>

        <div className="panel">
          <div className="panel-title">Company details (shown on printed documents)</div>
          <div className="form-grid">
            <Field label="Company name"><input className="input" disabled={!canWrite} value={s.company.name} onChange={(e) => co('name', e.target.value)} /></Field>
            <Field label="Address" className="span-2"><input className="input" disabled={!canWrite} value={s.company.address} onChange={(e) => co('address', e.target.value)} /></Field>
            <Field label="Phone"><input className="input" disabled={!canWrite} value={s.company.phone} onChange={(e) => co('phone', e.target.value)} /></Field>
            <Field label="Email"><input className="input" disabled={!canWrite} value={s.company.email} onChange={(e) => co('email', e.target.value)} /></Field>
            <Field label="Commercial registration (CR) no."><input className="input" disabled={!canWrite} value={s.company.cr_no} onChange={(e) => co('cr_no', e.target.value)} /></Field>
            <Field label="VAT registration no."><input className="input" disabled={!canWrite} value={s.company.vat_no} onChange={(e) => co('vat_no', e.target.value)} /></Field>
          </div>
        </div>

        <div className="panel flush">
          <div className="panel-head"><div className="panel-title">Users &amp; roles</div><span className="muted">Create users in Supabase → Authentication; they appear here after first sign-in.</span></div>
          {team.error && <ErrorBox error={team.error} />}
          {team.loading ? <Loading /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
              <tbody>
                {(team.data ?? []).map((p) => (
                  <tr key={p.id}><td className="strong">{p.full_name}</td><td>{p.email}</td>
                    <td><select className="select" style={{ width: 170 }} disabled={!canWrite} value={p.role} onChange={(e) => setRole(p.id, e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}
