'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead, PeriodBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { monthLabel, ymKey } from '@/lib/format';
import { can } from '@/lib/roles';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { PayrollPeriod } from '@/lib/types';

export default function PayrollList() {
  const { profile } = useApp();
  const router = useRouter();
  const sb = supabase();
  const now = new Date();
  const [ym, setYm] = useState(ymKey(now.getFullYear(), now.getMonth() + 1));

  const { data, error, loading } = useQuery(async () => {
    const periods = unwrap(await sb.from('payroll_periods').select('*').order('year', { ascending: false }).order('month', { ascending: false })) as PayrollPeriod[];
    const entries = await fetchAll<{ period_id: string; net_salary: number }>((f, t) => sb.from('payroll_entries').select('period_id, net_salary').order('id').range(f, t));
    const slips = await fetchAll<{ period_id: string; signed_path: string | null }>((f, t) => sb.from('salary_slips').select('period_id, signed_path').order('id').range(f, t));
    return periods.map((p) => {
      const e = entries.filter((x) => x.period_id === p.id);
      const s = slips.filter((x) => x.period_id === p.id);
      return { p, count: e.length, net: e.reduce((a, x) => a + Number(x.net_salary), 0), slips: s.length, signed: s.filter((x) => x.signed_path).length };
    });
  }, []);

  return (
    <>
      <PageHead eyebrow="Payroll" title="Payroll" sub="Attendance → Calculate → Review → Approve → Salary Slips → Signed Copies → Complete">
        {can(profile!.role, 'payroll:write') && (
          <div className="toolbar">
            <input className="input" type="month" value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} />
            <button className="btn primary" onClick={() => router.push(`/adminconsole/payroll/${ym}`)}>Process Payroll →</button>
          </div>
        )}
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Payroll Month</th><th>Status</th><th className="r">Employees</th><th className="r">Net Payroll</th><th className="r">Signed Slips</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map(({ p, count, net, slips, signed }) => (
                <tr key={p.id} className="click" onClick={() => router.push(`/adminconsole/payroll/${ymKey(p.year, p.month)}`)}>
                  <td className="strong">{monthLabel(p.year, p.month)}</td><td><PeriodBadge s={p.status} /></td>
                  <td className="r">{count}</td><td className="r strong">{<Money v={net} />}</td>
                  <td className="r">{slips ? `${signed} / ${slips}` : '—'}</td>
                  <td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/adminconsole/payroll/${ymKey(p.year, p.month)}`}>Open</Link></td>
                </tr>
              ))}
              {(data ?? []).length === 0 && <tr><td colSpan={6}><div className="empty">No payroll processed yet. Choose a month above and start with “Process Payroll”.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
