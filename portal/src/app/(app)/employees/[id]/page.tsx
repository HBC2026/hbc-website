'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_CODE, ATT_LABEL, Badge, ErrorBox, Loading, PageHead, SlipBadge, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, hrs, monthEnd, monthLabel, monthStart, ymKey } from '@/lib/format';
import { OtRule } from '@/components/OtRule';
import { supabase, unwrap } from '@/lib/supabase';
import { PAYROLL_SIDE } from '@/lib/roles';
import type { AttendanceRow, Employee, PayrollEntry, PayrollPeriod, SalarySlip } from '@/lib/types';

type Tab = 'attendance' | 'payroll' | 'slips';

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { profile, settings } = useApp();
  const sb = supabase();
  const showPayroll = PAYROLL_SIDE.includes(profile!.role);
  const [tab, setTab] = useState<Tab>('attendance');
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
  const tabs: [Tab, string][] = [['attendance', 'Attendance'], ...(showPayroll ? [['payroll', 'Payroll History'], ['slips', 'Salary Slips']] as [Tab, string][] : [])];
  const rows = att.data ?? [];
  const sum = (k: 'ot_hours' | 'regular_hours') => rows.reduce((s, r) => s + Number(r[k]), 0);

  return (
    <>
      <PageHead eyebrow={`Employee · ${e.emp_code}`} title={e.name} sub={`${e.job_title} · ${e.department}`}>
        <Link href="/employees" className="btn">← Employees</Link>
      </PageHead>

      <div className="stats">
        <div className="stat-card"><div className="stat-label">Status</div><div className="stat-number"><Badge tone={e.status === 'active' ? 'green' : ''}>{e.status === 'active' ? 'Active' : 'Inactive'}</Badge></div><div className="stat-note">Joined {fmtDate(e.joining_date)}</div></div>
        <div className="stat-card"><div className="stat-label">Basic Salary</div><div className="stat-number">{<Money v={e.basic_salary} />}</div><div className="stat-note">per month</div></div>
        <div className="stat-card"><div className="stat-label">Allowances</div><div className="stat-number">{<Money v={e.allowances} />}</div><div className="stat-note">per month</div></div>
        <div className="stat-card"><div className="stat-label">OT Rule</div><div className="stat-number" style={{ fontSize: 16 }}><OtRule e={e} defMult={settings.ot_multiplier} /></div><div className="stat-note">{e.ot_method === 'fixed' ? 'Fixed rate' : 'Applied to basic ÷ days ÷ hours'}</div></div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'attendance' && (
        <div className="panel flush">
          <div className="panel-head">
            <div className="toolbar"><input className="input" type="month" value={ym} onChange={(ev) => ev.target.value && setYm(ev.target.value)} /></div>
            <span className="muted">{monthLabel(y, m)} · Regular {hrs(sum('regular_hours'))} h · OT {hrs(sum('ot_hours'))} h</span>
          </div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Status</th><th className="r">Regular Hrs</th><th className="r">OT Hrs</th><th>Remarks</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{fmtDate(r.work_date)}</td>
                  <td><span className={`att-code ${r.status}`}>{ATT_CODE[r.status]}</span> {ATT_LABEL[r.status]}</td>
                  <td className="r">{hrs(r.regular_hours)}</td><td className="r">{hrs(r.ot_hours)}</td><td className="muted">{r.remarks}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No attendance recorded for this month.</div></td></tr>}
            </tbody>
          </table></div>
        </div>
      )}

      {tab === 'payroll' && (
        <div className="panel flush"><div className="table-wrap"><table className="table">
          <thead><tr><th>Month</th><th className="r">Basic</th><th className="r">Allowances</th><th className="r">OT Hrs</th><th className="r">OT Amount</th><th className="r">Deductions</th><th className="r">Net Salary</th><th>Period</th></tr></thead>
          <tbody>
            {(pay.data ?? []).map((p) => (
              <tr key={p.id}>
                <td><Link className="strong" href={`/payroll/${ymKey(p.payroll_periods.year, p.payroll_periods.month)}`}>{monthLabel(p.payroll_periods.year, p.payroll_periods.month)}</Link></td>
                <td className="r">{<Money v={p.basic} />}</td><td className="r">{<Money v={p.allowances} />}</td><td className="r">{hrs(p.ot_hours)}</td>
                <td className="r">{<Money v={p.ot_amount} />}</td><td className="r">{<Money v={p.deductions} />}</td><td className="r strong">{<Money v={p.net_salary} />}</td>
                <td><Badge tone={p.payroll_periods.status === 'completed' ? 'green' : ''}>{p.payroll_periods.status}</Badge></td>
              </tr>
            ))}
            {!pay.loading && (pay.data ?? []).length === 0 && <tr><td colSpan={8}><div className="empty">No payroll history yet.</div></td></tr>}
          </tbody>
        </table></div></div>
      )}

      {tab === 'slips' && (
        <div className="panel flush"><div className="table-wrap"><table className="table">
          <thead><tr><th>Slip No.</th><th>Month</th><th className="r">Net Salary</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(slips.data ?? []).map((s) => (
              <tr key={s.id}><td className="mono">{s.slip_no}</td><td>{monthLabel(s.payroll_periods.year, s.payroll_periods.month)}</td>
                <td className="r">{<Money v={s.net_snapshot} />}</td><td><SlipBadge s={s.status} /></td>
                <td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/slips/${s.id}`}>Open</Link></td></tr>
            ))}
            {!slips.loading && (slips.data ?? []).length === 0 && <tr><td colSpan={5}><div className="empty">No salary slips yet. They are generated when payroll is approved.</div></td></tr>}
          </tbody>
        </table></div></div>
      )}
    </>
  );
}
