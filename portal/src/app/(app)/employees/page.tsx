'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { OtRule } from '@/components/OtRule';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Employee } from '@/lib/types';

type Draft = Omit<Employee, 'id' | 'basic_salary' | 'allowances' | 'ot_rate'> & { id?: string; basic_salary: string; allowances: string; ot_rate: string };

function toDraft(e?: Employee, nextCode = ''): Draft {
  return {
    id: e?.id, emp_code: e?.emp_code ?? nextCode, name: e?.name ?? '', job_title: e?.job_title ?? '', department: e?.department ?? '',
    joining_date: e?.joining_date ?? today(), basic_salary: String(e?.basic_salary ?? ''), allowances: String(e?.allowances ?? 0),
    ot_method: e?.ot_method ?? 'multiplier', ot_rate: e?.ot_rate == null ? '' : String(e.ot_rate), status: e?.status ?? 'active',
  };
}

export default function EmployeesPage() {
  const { profile, settings, toast } = useApp();
  const canWrite = can(profile!.role, 'employees:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('employees').select('*').order('emp_code')) as Employee[], []);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => (data ?? []).filter((e) =>
    (showInactive || e.status === 'active') &&
    `${e.emp_code} ${e.name} ${e.job_title} ${e.department}`.toLowerCase().includes(q.toLowerCase())), [data, q, showInactive]);

  const nextCode = useMemo(() => {
    const n = Math.max(0, ...(data ?? []).map((e) => Number(/(\d+)$/.exec(e.emp_code)?.[1] ?? 0)));
    return `HBC-${String(n + 1).padStart(3, '0')}`;
  }, [data]);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.emp_code.trim()) return toast('Employee ID and name are required', true);
    if (Number(draft.basic_salary) <= 0) return toast('Basic salary must be greater than zero', true);
    if (draft.ot_method === 'fixed' && draft.ot_rate === '') return toast('Enter the fixed OT rate per hour', true);
    setSaving(true);
    const payload = {
      emp_code: draft.emp_code.trim(), name: draft.name.trim(), job_title: draft.job_title.trim(), department: draft.department.trim(),
      joining_date: draft.joining_date, basic_salary: Number(draft.basic_salary), allowances: Number(draft.allowances || 0),
      ot_method: draft.ot_method, ot_rate: draft.ot_rate === '' ? null : Number(draft.ot_rate), status: draft.status,
    };
    const res = draft.id ? await sb.from('employees').update(payload).eq('id', draft.id) : await sb.from('employees').insert(payload);
    setSaving(false);
    if (res.error) return toast(res.error.message, true);
    toast(draft.id ? 'Employee updated' : 'Employee added');
    setDraft(null); reload();
  }

  async function toggle(e: Employee) {
    const status = e.status === 'active' ? 'inactive' : 'active';
    if (status === 'inactive' && !confirm(`Deactivate ${e.name}? They will be excluded from future attendance and payroll.`)) return;
    const { error } = await sb.from('employees').update({ status }).eq('id', e.id);
    if (error) return toast(error.message, true);
    toast(status === 'active' ? 'Employee reactivated' : 'Employee deactivated'); reload();
  }

  const set = (k: keyof Draft, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <>
      <PageHead eyebrow="Payroll" title="Employees" sub="Employee payroll profiles">
        {canWrite && <button className="btn primary" onClick={() => setDraft(toDraft(undefined, nextCode))}>＋ Add Employee</button>}
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
            <thead><tr><th>ID</th><th>Name</th><th>Job Title</th><th>Department</th><th>Joined</th><th className="r">Basic</th><th className="r">Allowances</th><th>OT Rule</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.emp_code}</td>
                  <td><Link href={`/employees/${e.id}`} className="strong">{e.name}</Link></td>
                  <td>{e.job_title}</td><td>{e.department}</td><td>{fmtDate(e.joining_date)}</td>
                  <td className="r">{<Money v={e.basic_salary} />}</td><td className="r">{<Money v={e.allowances} />}</td>
                  <td><OtRule e={e} defMult={settings.ot_multiplier} /></td>
                  <td><Badge tone={e.status === 'active' ? 'green' : ''}>{e.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <Link className="btn sm" href={`/employees/${e.id}`}>View</Link>{' '}
                    {canWrite && <button className="btn sm" onClick={() => setDraft(toDraft(e))}>Edit</button>}{' '}
                    {canWrite && <button className={`btn sm${e.status === 'active' ? ' danger' : ''}`} onClick={() => toggle(e)}>{e.status === 'active' ? 'Deactivate' : 'Activate'}</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={10}><div className="empty">No employees found.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title={draft.id ? 'Edit Employee' : 'Add Employee'} wide onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Employee'}</button></>}>
          <div className="form-grid">
            <Field label="Employee ID"><input className="input" value={draft.emp_code} onChange={(e) => set('emp_code', e.target.value)} /></Field>
            <Field label="Full name" className="span-2"><input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Job title"><input className="input" value={draft.job_title} onChange={(e) => set('job_title', e.target.value)} /></Field>
            <Field label="Department"><input className="input" value={draft.department} onChange={(e) => set('department', e.target.value)} /></Field>
            <Field label="Joining date"><input className="input" type="date" value={draft.joining_date} onChange={(e) => set('joining_date', e.target.value)} /></Field>
            <Field label={<>Basic salary (<Riyal /> / month)</>}><input className="input num" type="number" min="0" step="0.01" value={draft.basic_salary} onChange={(e) => set('basic_salary', e.target.value)} /></Field>
            <Field label={<>Allowances (<Riyal /> / month)</>}><input className="input num" type="number" min="0" step="0.01" value={draft.allowances} onChange={(e) => set('allowances', e.target.value)} /></Field>
            <Field label="OT calculation">
              <select className="select" value={draft.ot_method} onChange={(e) => set('ot_method', e.target.value)}>
                <option value="multiplier">Multiplier on hourly rate</option>
                <option value="fixed">Fixed rate per hour</option>
              </select>
            </Field>
            <Field label={draft.ot_method === 'fixed' ? <>OT rate (<Riyal /> / hour)</> : `OT multiplier (blank = default ${settings.ot_multiplier}×)`}>
              <input className="input num" type="number" min="0" step="0.01" value={draft.ot_rate} onChange={(e) => set('ot_rate', e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
