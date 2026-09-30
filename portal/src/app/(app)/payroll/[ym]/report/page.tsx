'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { DocHead } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead, PeriodBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, fmtNum, hrs, monthLabel, parseYm } from '@/lib/format';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { Employee, PayrollEntry, PayrollPeriod } from '@/lib/types';

type Entry = PayrollEntry & { employees: Employee };

export default function PayrollReport() {
  const { ym } = useParams<{ ym: string }>();
  const parsed = parseYm(ym);
  const { settings } = useApp();
  const sb = supabase();

  const { data, error, loading } = useQuery(async () => {
    if (!parsed) throw new Error('Invalid month');
    const period = unwrap(await sb.from('payroll_periods').select('*').eq('year', parsed.year).eq('month', parsed.month).maybeSingle()) as PayrollPeriod | null;
    if (!period) throw new Error('Payroll has not been calculated for this month.');
    const entries = (await fetchAll<Entry>((f, t) => sb.from('payroll_entries').select('*, employees(*)').eq('period_id', period.id).order('id').range(f, t)))
      .sort((a, b) => a.employees.emp_code.localeCompare(b.employees.emp_code));
    return { period, entries };
  }, [ym]);

  if (!parsed) return <ErrorBox error="Invalid month" />;
  const label = monthLabel(parsed.year, parsed.month);
  const es = data?.entries ?? [];
  const sum = (k: keyof PayrollEntry) => es.reduce((s, e) => s + Number(e[k]), 0);

  return (
    <>
      <style>{'@media print { @page { size: A4 landscape; margin: 0; } }'}</style>
      <PageHead eyebrow="Payroll" title={`Payroll report — ${label}`}>
        <Link className="btn" href={`/payroll/${ym}`}>← Payroll</Link>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
        <button className="btn" onClick={() => window.print()} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      {loading || !data ? <Loading /> : (
        <div className="paper landscape" style={{ padding: '10mm 12mm' }}>
          <DocHead co={settings.company} right={<><div className="doc-title" style={{ fontSize: 17 }}>MONTHLY PAYROLL REPORT</div><b>{label}</b><br />Status: {data.period.status}{data.period.approved_at ? ` · Approved ${fmtDate(data.period.approved_at)}` : ' · not yet approved'}</>} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 14 }}>
            {([['Payroll Month', label], ['Employees', String(es.length)], ['Basic Salaries', <Money v={sum('basic')} />], ['Allowances', <Money v={sum('allowances')} />],
              ['OT Hours', `${hrs(sum('ot_hours'))} h`], ['OT Amount', <Money v={sum('ot_amount')} />], ['Deductions', <Money v={sum('deductions')} />]] as [string, React.ReactNode][]).map(([l, v]) => (
              <div className="doc-box" key={l}><div className="l">{l}</div><b>{v}</b></div>
            ))}
          </div>
          <div className="doc-box" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', background: 'var(--navy)', color: 'white' }}>
            <b>NET PAYROLL</b><b style={{ fontSize: 14 }}>{<Money v={sum('net_salary')} />}</b>
          </div>

          <table className="doc-table">
            <thead><tr><th>ID</th><th>Employee</th><th>Job Title</th><th className="r">Basic</th><th className="r">Allowances</th><th className="r">OT Hrs</th><th className="r">OT Amount</th><th className="r">Other Earn.</th><th className="r">Deductions</th><th className="r">Net Salary</th></tr></thead>
            <tbody>
              {es.map((e) => (
                <tr key={e.id}><td>{e.employees.emp_code}</td><td>{e.employees.name}</td><td>{e.employees.job_title}</td>
                  <td className="r">{fmtNum(e.basic)}</td><td className="r">{fmtNum(e.allowances)}</td><td className="r">{hrs(e.ot_hours)}</td><td className="r">{fmtNum(e.ot_amount)}</td>
                  <td className="r">{fmtNum(e.other_earnings)}</td><td className="r">{fmtNum(e.deductions)}</td><td className="r"><b>{fmtNum(e.net_salary)}</b></td></tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3}>Total</td><td className="r">{fmtNum(sum('basic'))}</td><td className="r">{fmtNum(sum('allowances'))}</td><td className="r">{hrs(sum('ot_hours'))}</td><td className="r">{fmtNum(sum('ot_amount'))}</td><td className="r">{fmtNum(sum('other_earnings'))}</td><td className="r">{fmtNum(sum('deductions'))}</td><td className="r">{fmtNum(sum('net_salary'))}</td></tr></tfoot>
          </table>
          <div className="doc-foot" style={{ marginTop: 'auto' }}>{settings.company.name} · Amounts in <Riyal /> · Generated {fmtDate(new Date())} <span className="no-print"><PeriodBadge s={data.period.status} /></span></div>
        </div>
      )}
    </>
  );
}
