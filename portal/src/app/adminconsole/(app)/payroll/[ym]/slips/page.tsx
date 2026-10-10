'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SalarySlipDoc, slipRange, type SlipFull } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { parseYm, periodLabel } from '@/lib/format';
import { can } from '@/lib/roles';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { AttendanceRow } from '@/lib/types';

export default function PrintAllSlips() {
  const { ym } = useParams<{ ym: string }>();
  const parsed = parseYm(ym);
  const { settings, profile, toast } = useApp();
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () => {
    if (!parsed) throw new Error('Invalid month');
    const period = unwrap(await sb.from('payroll_periods').select('id').eq('year', parsed.year).eq('month', parsed.month).maybeSingle()) as { id: string } | null;
    if (!period) return [];
    const rows = unwrap(await sb.from('salary_slips').select('*, employees(*), payroll_periods(*), payroll_entries(*)').eq('period_id', period.id)) as SlipFull[];
    rows.sort((a, b) => a.employees.emp_code.localeCompare(b.employees.emp_code));
    const att = new Map<string, AttendanceRow[]>();
    if (rows.length) {
      const [from, to] = slipRange(rows[0].payroll_periods);
      const all = await fetchAll<AttendanceRow>((f, t) => sb.from('attendance').select('*').in('employee_id', rows.map((r) => r.employee_id)).gte('work_date', from).lte('work_date', to).order('employee_id').order('work_date').range(f, t));
      for (const r of all) { if (!att.has(r.employee_id)) att.set(r.employee_id, []); att.get(r.employee_id)!.push(r); }
    }
    return rows.map((slip) => ({ slip, att: att.get(slip.employee_id) ?? [] }));
  }, [ym]);

  if (!parsed) return <ErrorBox error="Invalid month" />;
  async function print() {
    if (can(profile!.role, 'payroll:write')) {
      for (const { slip: s } of data ?? []) {
        const { error } = await sb.rpc('mark_slip_printed', { p_slip: s.id });
        if (error) { toast(error.message, true); break; }
      }
    }
    window.print();
    reload();
  }

  return (
    <>
      <PageHead eyebrow="Payroll" title={`Salary slips${data?.[0] ? ` — ${periodLabel(data[0].slip.payroll_periods)}` : ''}`} sub={`${data?.length ?? 0} slips, one A4 page each`}>
        <Link className="btn" href={`/adminconsole/payroll/${ym}`}>← Payroll</Link>
        <button className="btn primary" disabled={!data?.length} onClick={print}>Print all</button>
        <button className="btn" disabled={!data?.length} onClick={print} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : (data ?? []).length === 0 ? <div className="banner">No salary slips yet. They are generated when payroll is approved.</div>
        : data!.map(({ slip, att }) => <SalarySlipDoc key={slip.id} slip={slip} co={settings.company} att={att} />)}
    </>
  );
}
