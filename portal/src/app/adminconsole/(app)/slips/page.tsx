'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useState } from 'react';
import { SlipUpload, ViewSigned } from '@/components/SlipActions';
import { ErrorBox, Select, Loading, PageHead, PeriodBadge, SlipBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, monthLabel, ymKey } from '@/lib/format';
import { fetchAll, supabase } from '@/lib/supabase';
import type { Employee, PayrollPeriod, SalarySlip } from '@/lib/types';

type Row = SalarySlip & { employees: Employee; payroll_periods: PayrollPeriod };

export default function SlipTracking() {
  const sb = supabase();
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('pending');

  const { data, error, loading, reload } = useQuery(async () => {
    const rows = await fetchAll<Row>((f, t) => sb.from('salary_slips').select('*, employees(*), payroll_periods(*)').order('id').range(f, t));
    return rows.sort((a, b) => (b.payroll_periods.year * 12 + b.payroll_periods.month) - (a.payroll_periods.year * 12 + a.payroll_periods.month)
      || a.employees.emp_code.localeCompare(b.employees.emp_code));
  }, []);

  const months = Array.from(new Map((data ?? []).map((r) => [r.period_id, r.payroll_periods])).values());
  const rows = (data ?? []).filter((r) => (!period || r.period_id === period) && (status === 'all' || (status === 'pending' ? !r.signed_path : !!r.signed_path)));
  const signed = (data ?? []).filter((r) => (!period || r.period_id === period) && r.signed_path).length;
  const total = (data ?? []).filter((r) => !period || r.period_id === period).length;

  return (
    <>
      <PageHead eyebrow="Payroll" title="Salary Slips" sub="Print → employee signs → scan and upload the signed copy. A payroll month completes once every signed slip is uploaded." />
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <Select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">All months</option>
              {months.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.year, p.month)}</option>)}
            </Select>
            <Select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Awaiting signed copy</option><option value="signed">Signed copy uploaded</option><option value="all">All</option>
            </Select>
          </div>
          <span className="muted">{signed} of {total} signed copies uploaded</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Employee</th><th>Month</th><th className="r">Net Salary</th><th>Printed</th><th>Signed</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><span className="strong">{s.employees.name}</span><div className="muted" style={{ fontSize: 10 }}>{s.employees.emp_code}</div></td>
                  <td>{monthLabel(s.payroll_periods.year, s.payroll_periods.month)} <PeriodBadge s={s.payroll_periods.status} /></td>
                  <td className="r">{<Money v={s.net_snapshot} />}</td>
                  <td>{s.printed_at ? `✓ ${fmtDate(s.printed_at)}` : '—'}</td>
                  <td>{s.signed_path ? `✓ ${fmtDate(s.signed_uploaded_at)}` : '—'}</td>
                  <td><SlipBadge s={s.status} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link className="btn sm" href={`/adminconsole/slips/${s.id}`}>Preview</Link>{' '}
                    <SlipUpload small slipId={s.id} hasSigned={!!s.signed_path} onDone={reload} />{' '}
                    {s.signed_path && <ViewSigned small path={s.signed_path} />}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">{(data ?? []).length ? 'Nothing matches this filter.' : 'No salary slips yet. Approve a payroll month to generate them.'}</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      {months.length > 0 && <div className="muted" style={{ marginTop: 12, fontSize: 11 }}>Tip: open a payroll month and use “Print all slips” to print every slip in one go. Latest month: <Link href={`/adminconsole/payroll/${ymKey(months[0].year, months[0].month)}`} className="strong">{monthLabel(months[0].year, months[0].month)}</Link>.</div>}
    </>
  );
}
