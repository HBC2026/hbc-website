'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SalarySlipDoc, type SlipFull } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { monthLabel, parseYm } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';

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
    return rows.sort((a, b) => a.employees.emp_code.localeCompare(b.employees.emp_code));
  }, [ym]);

  if (!parsed) return <ErrorBox error="Invalid month" />;
  async function print() {
    if (can(profile!.role, 'payroll:write')) {
      for (const s of data ?? []) {
        const { error } = await sb.rpc('mark_slip_printed', { p_slip: s.id });
        if (error) { toast(error.message, true); break; }
      }
    }
    window.print();
    reload();
  }

  return (
    <>
      <PageHead eyebrow="Payroll" title={`Salary slips — ${monthLabel(parsed.year, parsed.month)}`} sub={`${data?.length ?? 0} slips, one A4 page each`}>
        <Link className="btn" href={`/adminconsole/payroll/${ym}`}>← Payroll</Link>
        <button className="btn primary" disabled={!data?.length} onClick={print}>Print all</button>
        <button className="btn" disabled={!data?.length} onClick={print} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : (data ?? []).length === 0 ? <div className="banner">No salary slips yet. They are generated when payroll is approved.</div>
        : data!.map((s) => <SalarySlipDoc key={s.id} slip={s} co={settings.company} />)}
    </>
  );
}
