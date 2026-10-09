'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { BatchModal } from '@/components/PayrollBatchModal';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead, PeriodBadge, StatCard } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, periodLabel, ymKey } from '@/lib/format';
import { can } from '@/lib/roles';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { PayrollPeriod } from '@/lib/types';

const fmtRange = (a: string, b: string) => `${fmtDate(a)} – ${fmtDate(b)}`;

export default function PayrollList() {
  const { profile, toast, confirmDialog } = useApp();
  const router = useRouter();
  const sb = supabase();
  const now = new Date();
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, error, loading, reload } = useQuery(async () => {
    const periods = unwrap(await sb.from('payroll_periods').select('*').order('year', { ascending: false }).order('month', { ascending: false })) as PayrollPeriod[];
    const entries = await fetchAll<{ period_id: string; net_salary: number }>((f, t) => sb.from('payroll_entries').select('period_id, net_salary').order('id').range(f, t));
    const slips = await fetchAll<{ period_id: string; signed_path: string | null }>((f, t) => sb.from('salary_slips').select('period_id, signed_path').order('id').range(f, t));
    return periods.map((p) => {
      const e = entries.filter((x) => x.period_id === p.id);
      const s = slips.filter((x) => x.period_id === p.id);
      return { p, count: e.length, net: e.reduce((a, x) => a + Number(x.net_salary), 0), slips: s.length, signed: s.filter((x) => x.signed_path).length };
    });
  }, []);

  async function remove(p: PayrollPeriod, slips: number) {
    const label = periodLabel(p);
    const msg = p.status === 'approved'
      ? `Delete the approved payroll for ${label}?

This permanently removes the payroll, its ${slips} salary slip(s) and signed-copy records, and unlocks its attendance.`
      : `Delete the payroll for ${label}?

This permanently removes the calculated payroll and its adjustments. Attendance is not affected.`;
    if (!(await confirmDialog({ title: 'Delete payroll', message: msg, confirmLabel: 'Delete' }))) return;
    const { error } = await sb.rpc('delete_payroll', { p_period: p.id });
    if (error) return toast(error.message, true);
    toast('Payroll deleted'); reload();
  }

  // A run is filed under the month its pay period ends in; the pay period itself is what is shown everywhere.
  async function calculate(start: string, end: string, ids: string[]) {
    const [y, m] = end.split('-').map(Number);
    const existing = (data ?? []).find(({ p }) => p.year === y && p.month === m)?.p;
    if (existing && !(await confirmDialog({
      title: 'Replace existing payroll run?',
      message: `A payroll run for ${periodLabel(existing)} already exists and ends in the same month as this one.

Continuing recalculates it using the new pay period and employees.`,
      confirmLabel: 'Replace',
    }))) return;
    setSetup(false);
    setBusy(true);
    const { error } = await sb.rpc('calculate_payroll', { p_year: y, p_month: m, p_start: start, p_end: end, p_employees: ids });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast(`Payroll calculated for ${fmtRange(start, end)}`);
    router.push(`/adminconsole/payroll/${ymKey(y, m)}`);
  }

  return (
    <div className="payroll-screen">
      <PageHead eyebrow="Payroll" title="Payroll" sub="Set the pay period and employees, then calculate, approve and issue salary slips.">
        {can(profile!.role, 'payroll:write') && (
          <div className="toolbar">
            <button className="btn primary" onClick={() => setSetup(true)}>+ New Payroll Run</button>
          </div>
        )}
      </PageHead>
      {error && <ErrorBox error={error} />}
      {setup && <BatchModal year={now.getFullYear()} month={now.getMonth() + 1} period={null} busy={busy} onClose={() => setSetup(false)} onRun={calculate} />}
      {data && data.length > 0 && (
        <div className="stats compact">
          <StatCard label="Payroll runs" icon="#" value={data.length} note={`${data.filter(({ p }) => p.status === 'completed').length} completed`} />
          <StatCard label="In progress" icon="…" value={data.filter(({ p }) => p.status !== 'completed').length} note="Not yet completed" />
          <StatCard label="Slips awaiting signature" icon="✎" value={data.reduce((a, d) => a + (d.slips - d.signed), 0)} note="Printed or generated, not yet signed" />
          <StatCard label="Latest net pay" icon="=" value={<Money v={data[0].net} />} note={periodLabel(data[0].p)} />
        </div>
      )}
      <div className="m-only">
        {loading ? <Loading /> : (data ?? []).map(({ p, count, net, slips, signed }) => (
          <div key={p.id} className="pcard" role="link" onClick={() => router.push(`/adminconsole/payroll/${ymKey(p.year, p.month)}`)}>
            <div className="pcard-top">
              <div><div className="pcard-name">{periodLabel(p)}</div><div className="pcard-sub">{count} employee{count === 1 ? '' : 's'} paid</div></div>
              <PeriodBadge s={p.status} />
            </div>
            <div className="pcard-big"><span>Total net pay</span><Money v={net} /></div>
            <div className="pcard-meta">
              <span>{slips ? `${signed} / ${slips} slips signed` : 'No slips yet'}</span>
              <span className="pcard-btns">
                {can(profile!.role, 'payroll:write') && p.status !== 'completed' && <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); remove(p, slips); }}>Delete</button>}
                <Link className="btn sm" href={`/adminconsole/payroll/${ymKey(p.year, p.month)}`} onClick={(e) => e.stopPropagation()}>Open</Link>
              </span>
            </div>
          </div>
        ))}
        {!loading && (data ?? []).length === 0 && <div className="empty">Tap “New Payroll Run” to choose a pay period and employees.</div>}
      </div>
      <div className="panel flush d-only">
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Pay Period</th><th>Status</th><th className="r">Employees Paid</th><th className="r">Total Net Pay</th><th className="r">Signed Slips</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map(({ p, count, net, slips, signed }) => (
                <tr key={p.id} className="click" onClick={() => router.push(`/adminconsole/payroll/${ymKey(p.year, p.month)}`)}>
                  <td className="strong">{periodLabel(p)}</td><td><PeriodBadge s={p.status} /></td>
                  <td className="r">{count}</td><td className="r strong">{<Money v={net} />}</td>
                  <td className="r">{slips ? `${signed} / ${slips}` : '—'}</td>
                  <td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/adminconsole/payroll/${ymKey(p.year, p.month)}`} onClick={(e) => e.stopPropagation()}>Open</Link>
                    {can(profile!.role, 'payroll:write') && p.status !== 'completed' && <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); remove(p, slips); }}>Delete</button>}</td>
                </tr>
              ))}
              {(data ?? []).length === 0 && <tr><td colSpan={6}><div className="empty">No payroll runs yet. Press “New Payroll Run” to choose a pay period and employees.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
