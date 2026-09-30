'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { ErrorBox, Loading, PageHead, PeriodBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, monthLabel, ymKey } from '@/lib/format';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { PayrollPeriod } from '@/lib/types';

export default function Archive() {
  const sb = supabase();
  const { data, error, loading } = useQuery(async () => {
    const periods = unwrap(await sb.from('payroll_periods').select('*').in('status', ['approved', 'completed'])
      .order('year', { ascending: false }).order('month', { ascending: false })) as PayrollPeriod[];
    const entries = await fetchAll<{ period_id: string; net_salary: number }>((f, t) => sb.from('payroll_entries').select('period_id, net_salary').order('id').range(f, t));
    const slips = await fetchAll<{ period_id: string; signed_path: string | null }>((f, t) => sb.from('salary_slips').select('period_id, signed_path').order('id').range(f, t));
    return periods.map((p) => {
      const e = entries.filter((x) => x.period_id === p.id); const s = slips.filter((x) => x.period_id === p.id);
      return { p, count: e.length, net: e.reduce((a, x) => a + Number(x.net_salary), 0), slips: s.length, signed: s.filter((x) => x.signed_path).length };
    });
  }, []);

  return (
    <>
      <PageHead eyebrow="Payroll" title="Payroll Archive" sub="Approved payroll months, kept permanently with attendance, calculations, slips, signed copies and audit history." />
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Month</th><th>Status</th><th className="r">Employees</th><th className="r">Net Payroll</th><th>Approved</th><th className="r">Signed Slips</th><th>Open</th></tr></thead>
            <tbody>
              {(data ?? []).map(({ p, count, net, slips, signed }) => {
                const k = ymKey(p.year, p.month);
                return (
                  <tr key={p.id}>
                    <td className="strong">{monthLabel(p.year, p.month)}</td><td><PeriodBadge s={p.status} /></td>
                    <td className="r">{count}</td><td className="r strong">{<Money v={net} />}</td><td>{fmtDate(p.approved_at)}</td><td className="r">{signed} / {slips}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn sm" href={`/payroll/${k}`}>Payroll & Audit</Link>{' '}
                      <Link className="btn sm" href={`/payroll/${k}/report`}>Report</Link>{' '}
                      <Link className="btn sm" href={`/attendance/monthly?ym=${k}`}>Attendance</Link>{' '}
                      <Link className="btn sm" href={`/payroll/${k}/slips`}>Slips</Link>
                    </td>
                  </tr>
                );
              })}
              {(data ?? []).length === 0 && <tr><td colSpan={7}><div className="empty">Nothing archived yet. Payroll months appear here once approved.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
