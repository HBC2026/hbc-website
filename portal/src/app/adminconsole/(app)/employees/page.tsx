'use client';
import Link from 'next/link';
import { Money } from '@/components/Money';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Badge, DatePicker, ErrorBox, Field, Loading, Modal, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { OtRule } from '@/components/OtRule';
import { EmployeeFormModal } from '@/components/EmployeeFormModal';
import { IqamaExpiry, iqamaTone } from '@/components/IqamaExpiry';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Employee } from '@/lib/types';

export default function EmployeesPage() {
  const { profile, company, settings, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'employees:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('employees').select('*').order('emp_code')) as Employee[], []);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<{ e?: Employee } | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<{ e: Employee; date: string } | null>(null);

  const rows = useMemo(() => (data ?? []).filter((e) =>
    (showInactive || e.status === 'active') &&
    `${e.emp_code} ${e.name} ${e.job_title} ${e.department}`.toLowerCase().includes(q.toLowerCase())), [data, q, showInactive]);

  const nextCode = useMemo(() => {
    const n = Math.max(0, ...(data ?? []).map((e) => Number(/(\d+)$/.exec(e.emp_code)?.[1] ?? 0)));
    return `${company?.code ?? 'EMP'}-${String(n + 1).padStart(3, '0')}`;
  }, [data, company?.code]);

  async function toggle(e: Employee) {
    if (e.status === 'active') { setLeaving({ e, date: today() }); return; }
    const { error } = await sb.from('employees').update({ status: 'active', last_working_date: null }).eq('id', e.id);
    if (error) return toast(error.message, true);
    toast('Employee reactivated'); reload();
  }

  async function deactivate() {
    if (!leaving) return;
    const { e, date } = leaving;
    if (!date) return toast('Choose the last working day', true);
    if (date < e.joining_date) return toast('The last working day cannot be before the joining date', true);
    setSaving(true);
    const { error } = await sb.from('employees').update({ status: 'inactive', last_working_date: date }).eq('id', e.id);
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(`${e.name} deactivated — still shown in attendance and payroll up to ${fmtDate(date)}`);
    setLeaving(null); reload();
  }

  return (
    <>
      <PageHead eyebrow="Payroll" title="Employees" sub="Employee payroll profiles">
        {canWrite && <button className="btn primary" onClick={() => setDraft({})}>＋ Add Employee</button>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          </div>
          <span className="muted">{rows.length} employees</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>ID</th><th>Name</th><th>Job Title</th><th>Department</th><th>Joined</th><th>Iqama Expiry</th><th className="r">Basic</th><th className="r">Allowances</th><th>OT Rule</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.status === 'active' && iqamaTone(e.iqama_expiry_date) ? `row-${iqamaTone(e.iqama_expiry_date)}` : undefined}>
                  <td className="mono">{e.emp_code}</td>
                  <td><Link href={`/adminconsole/employees/${e.id}`} className="strong">{e.name}</Link></td>
                  <td>{e.job_title}</td><td>{e.department}</td><td>{fmtDate(e.joining_date)}</td>
                  <td><IqamaExpiry date={e.iqama_expiry_date} /></td>
                  <td className="r">{<Money v={e.basic_salary} />}</td><td className="r">{<Money v={e.allowances} />}</td>
                  <td><OtRule e={e} defMult={settings.ot_multiplier} /></td>
                  <td><Badge tone={e.status === 'active' ? 'green' : ''}>{e.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <Link className="btn sm" href={`/adminconsole/employees/${e.id}`}>View</Link>{' '}
                    {canWrite && <button className="btn sm" onClick={() => setDraft({ e })}>Edit</button>}{' '}
                    {canWrite && <button className={`btn sm${e.status === 'active' ? ' danger' : ''}`} onClick={() => toggle(e)}>{e.status === 'active' ? 'Deactivate' : 'Activate'}</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={11}><div className="empty">No employees found.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {leaving && (
        <Modal title={`Deactivate ${leaving.e.name}`} onClose={() => setLeaving(null)}
          footer={<><button className="btn" onClick={() => setLeaving(null)}>Cancel</button><button className="btn danger" disabled={saving} onClick={deactivate}>{saving ? 'Saving…' : 'Deactivate'}</button></>}>
          <Field label="Last working day"><DatePicker value={leaving.date} onChange={(v) => setLeaving({ ...leaving, date: v })} /></Field>
          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>Attendance and payroll up to and including this day are kept. After it, the employee is no longer listed.</div>
        </Modal>
      )}

      {draft && (
        <EmployeeFormModal employee={draft.e} nextCode={nextCode} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); reload(); }} />
      )}
    </>
  );
}
