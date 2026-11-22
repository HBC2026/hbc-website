'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_CODE, ATT_LABEL, Badge, ErrorBox, Loading, MonthPicker, PageHead, SlipBadge, StatCard, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, fmtNum, hrs, monthEnd, monthLabel, monthStart, ymKey, periodLabel } from '@/lib/format';
import { OtRule } from '@/components/OtRule';
import { supabase, unwrap } from '@/lib/supabase';
import { can, PAYROLL_SIDE } from '@/lib/roles';
import { otRateWorking } from '@/lib/ot';
import { EmployeeDocuments } from '@/components/EmployeeDocuments';
import { EmployeeFormModal } from '@/components/EmployeeFormModal';
import { IqamaExpiry } from '@/components/IqamaExpiry';
import type { AttendanceRow, Employee, PayrollEntry, PayrollPeriod, SalarySlip } from '@/lib/types';

type Tab = 'attendance' | 'payroll' | 'slips' | 'documents';

const isFri = (d: string) => new Date(`${d}T00:00:00`).getDay() === 5;

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { profile, settings } = useApp();
  const sb = supabase();
  const showPayroll = PAYROLL_SIDE.includes(profile!.role);
  const [tab, setTab] = useState<Tab>('attendance');
  const [editing, setEditing] = useState(false);
  const now = new Date();
  const [ym, setYm] = useState(ymKey(now.getFullYear(), now.getMonth() + 1));
  const [y, m] = ym.split('-').map(Number);

  const emp = useQuery(async () => unwrap(await sb.from('employees').select('*').eq('id', id).single()) as Employee, [id]);
  const att = useQuery(async () => unwrap(await sb.from('attendance').select('*').eq('employee_id', id)
    .gte('work_date', monthStart(y, m)).lte('work_date', monthEnd(y, m)).order('work_date')) as AttendanceRow[], [id, ym]);
  const pay = useQuery(async () => showPayroll
    ? (unwrap(await sb.from('payroll_entries').select('*, payroll_periods(*)').eq('employee_id', id)) as (PayrollEntry & { payroll_periods: PayrollPeriod })[])
        .sort((a, b) => b.payroll_periods.year * 12 + b.payroll_periods.month - (a.payroll_periods.year * 12 + a.payroll_periods.month))
    : [], [id]);
  const slips = useQuery(async () => showPayroll
    ? (unwrap(await sb.from('salary_slips').select('*, payroll_periods(*)').eq('employee_id', id)) as (SalarySlip & { payroll_periods: PayrollPeriod })[])
        .sort((a, b) => b.payroll_periods.year * 12 + b.payroll_periods.month - (a.payroll_periods.year * 12 + a.payroll_periods.month))
    : [], [id]);

  if (emp.loading) return <Loading />;
  if (emp.error || !emp.data) return <ErrorBox error={emp.error ?? 'Employee not found'} />;
  const e = emp.data;
  const tabs: [Tab, string][] = [['attendance', 'Attendance'], ...(showPayroll ? [['payroll', 'Payroll History'], ['slips', 'Salary Slips'], ['documents', 'Documents']] as [Tab, string][] : [])];
  const w = otRateWorking(e, monthStart(y, m), settings);
  const rows = att.data ?? [];
  const sum = (k: 'ot_amount') => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

  return (
    <>
      <PageHead eyebrow={`Employee · ${e.emp_code}`} title={e.name} sub={`${e.job_title} · ${e.department}`}>
        <div className="stats compact head-stats auto">
          <StatCard label="Status" icon="" value={<Badge tone={e.status === 'active' ? 'green' : ''}>{e.status === 'active' ? 'Active' : 'Inactive'}</Badge>} />
          {e.status === 'inactive' && <StatCard label="Last working day" icon="" value={e.last_working_date ? fmtDate(e.last_working_date) : '—'} />}
        </div>
        {can(profile!.role, 'employees:write') && <button className="btn primary" onClick={() => setEditing(true)}>Edit</button>}
        <Link href="/adminconsole/employees" className="btn">← Employees</Link>
      </PageHead>

      <div className="panel info-strip" style={{ marginBottom: 12 }}>
        <div className="info-grid">
          <div><div className="stat-label">Basic salary</div><div><Money v={e.basic_salary} /></div></div>
          <div><div className="stat-label">Allowances</div><div><Money v={e.allowances} /></div></div>
          <div title={e.ot_method === 'fixed' ? 'Fixed rate per OT hour' : `(${fmtNum(w.monthly)} ÷ ${w.days} days = ${fmtNum(w.daily)}) ÷ ${settings.ot_day_hours}h × ${w.mult}`}>
            <div className="stat-label">OT / hr · {monthLabel(y, m)}</div><div><Money v={w.rate} /></div></div>
          <div><div className="stat-label">OT rule</div><div><OtRule e={e} defMult={settings.ot_multiplier} /></div></div>
        </div>
      </div>

      <div className="panel info-strip" style={{ marginBottom: 16 }}>
        <div className="info-grid">
          <div><div className="stat-label">Iqama / ID number</div><div className="mono">{e.iqama_no || '—'}</div></div>
          <div><div className="stat-label">Iqama issue date</div><div>{fmtDate(e.iqama_issue_date)}</div></div>
          <div><div className="stat-label">Iqama expiry date</div><div><IqamaExpiry date={e.iqama_expiry_date} /></div></div>
          {showPayroll && <div><div className="stat-label">Bank code</div><div>{e.bank_code || '—'}</div></div>}
          {showPayroll && <div className="iban"><div className="stat-label">IBAN</div><div className="mono">{e.iban || '—'}</div></div>}
        </div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'attendance' && (
        <div className="panel flush">
          <div className="panel-head">
            <div className="toolbar"><MonthPicker value={ym} onChange={setYm} /></div>
            <span className="muted">{monthLabel(y, m)} · Overtime {fmtNum(sum('ot_amount'))}</span>
          </div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Status</th><th className="r">Overtime</th><th>Internal Notes</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={isFri(r.work_date) ? "fri" : ""}><td>{fmtDate(r.work_date)}{isFri(r.work_date) && <span className="fri-tag">Fri</span>}</td>
                  <td><span className={`att-code ${r.status}`}>{ATT_CODE[r.status]}</span> {ATT_LABEL[r.status]}</td>
                  <td className="r">{Number(r.ot_amount ?? 0) > 0 ? <>{fmtNum(r.ot_amount)} <span className={`badge ${r.ot_paid ? 'green' : 'gold'}`}>{r.ot_paid ? 'Paid' : 'Unpaid'}</span></> : '—'}</td><td className="muted">{r.remarks}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4}><div className="empty">No attendance recorded for this month.</div></td></tr>}
            </tbody>
          </table></div>
        </div>
      )}

      {tab === 'payroll' && (
        <div className="panel flush"><div className="table-wrap"><table className="table">
          <thead><tr><th>Pay Period</th><th className="r">Basic Salary</th><th className="r">Allowances</th><th className="r">Overtime Due</th><th className="r">Overtime Paid Earlier</th><th className="r">Deductions</th><th className="r">Net Pay</th><th>Status</th></tr></thead>
          <tbody>
            {(pay.data ?? []).map((p) => (
              <tr key={p.id}>
                <td><Link className="strong" href={`/adminconsole/payroll/${ymKey(p.payroll_periods.year, p.payroll_periods.month)}`}>{periodLabel(p.payroll_periods)}</Link></td>
                <td className="r">{<Money v={p.basic} />}</td><td className="r">{<Money v={p.allowances} />}</td><td className="r">{<Money v={p.ot_amount} />}</td>
                <td className="r muted">{<Money v={p.ot_paid_amount ?? 0} />}</td><td className="r">{<Money v={p.deductions} />}</td><td className="r strong">{<Money v={p.net_salary} />}</td>
                <td><Badge tone={p.payroll_periods.status === 'completed' ? 'green' : ''}>{p.payroll_periods.status}</Badge></td>
              </tr>
            ))}
            {!pay.loading && (pay.data ?? []).length === 0 && <tr><td colSpan={8}><div className="empty">No payroll history yet.</div></td></tr>}
          </tbody>
        </table></div></div>
      )}

      {tab === 'documents' && <EmployeeDocuments employeeId={e.id} canWrite={can(profile!.role, 'employees:write')} />}

      {tab === 'slips' && (
        <div className="panel flush"><div className="table-wrap"><table className="table">
          <thead><tr><th>Slip No.</th><th>Pay Period</th><th className="r">Net Pay</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(slips.data ?? []).map((s) => (
              <tr key={s.id}><td className="mono">{s.slip_no}</td><td>{periodLabel(s.payroll_periods)}</td>
                <td className="r">{<Money v={s.net_snapshot} />}</td><td><SlipBadge s={s.status} /></td>
                <td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/adminconsole/slips/${s.id}`}>Open</Link></td></tr>
            ))}
            {!slips.loading && (slips.data ?? []).length === 0 && <tr><td colSpan={5}><div className="empty">No salary slips yet. They are generated when payroll is approved.</div></td></tr>}
          </tbody>
        </table></div></div>
      )}

      {editing && <EmployeeFormModal employee={e} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); emp.reload(); }} />}
    </>
  );
}
