'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@/components/Money';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Badge, ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { OtRule } from '@/components/OtRule';
import { EmployeeFormModal } from '@/components/EmployeeFormModal';
import { IqamaExpiry, iqamaTone } from '@/components/IqamaExpiry';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Employee } from '@/lib/types';

export default function EmployeesPage() {
  const { profile, company, settings } = useApp();
  const router = useRouter();
  const canWrite = can(profile!.role, 'employees:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('employees').select('*').order('emp_code')) as Employee[], []);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<{ e?: Employee } | null>(null);

  const rows = useMemo(() => (data ?? []).filter((e) =>
    (showInactive || e.status === 'active') &&
    `${e.emp_code} ${e.name} ${e.job_title} ${e.department}`.toLowerCase().includes(q.toLowerCase())), [data, q, showInactive]);

  const nextCode = useMemo(() => {
    const n = Math.max(0, ...(data ?? []).map((e) => Number(/(\d+)$/.exec(e.emp_code)?.[1] ?? 0)));
    return `${company?.code ?? 'EMP'}-${String(n + 1).padStart(3, '0')}`;
  }, [data, company?.code]);

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
            <thead><tr><th>ID</th><th>Name</th><th>Job Title</th><th>Department</th><th>Joined</th><th>Iqama Expiry</th><th className="r">Basic</th><th className="r">Allowances</th><th>OT Rule</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={`click${e.status === 'active' && iqamaTone(e.iqama_expiry_date) ? ` row-${iqamaTone(e.iqama_expiry_date)}` : ''}`} onClick={() => router.push(`/adminconsole/employees/${e.id}`)}>
                  <td className="mono">{e.emp_code}</td>
                  <td><Link href={`/adminconsole/employees/${e.id}`} className="strong">{e.name}</Link></td>
                  <td>{e.job_title}</td><td>{e.department}</td><td>{fmtDate(e.joining_date)}</td>
                  <td><IqamaExpiry date={e.iqama_expiry_date} /></td>
                  <td className="r">{<Money v={e.basic_salary} />}</td><td className="r">{<Money v={e.allowances} />}</td>
                  <td><OtRule e={e} defMult={settings.ot_multiplier} /></td>
                  <td><Badge tone={e.status === 'active' ? 'green' : ''}>{e.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={10}><div className="empty">No employees found.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <EmployeeFormModal employee={draft.e} nextCode={nextCode} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); reload(); }} />
      )}
    </>
  );
}
