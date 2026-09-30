'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SalarySlipDoc, type SlipFull } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { SlipUpload, ViewSigned } from '@/components/SlipActions';
import { ErrorBox, Loading, PageHead, SlipBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDateTime, monthLabel, ymKey } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';

export default function SlipPage() {
  const { id } = useParams<{ id: string }>();
  const { settings, profile, toast } = useApp();
  const sb = supabase();
  const { data: s, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('salary_slips').select('*, employees(*), payroll_periods(*), payroll_entries(*)').eq('id', id).single()) as SlipFull, [id]);

  if (loading) return <Loading />;
  if (error || !s) return <ErrorBox error={error ?? 'Salary slip not found'} />;
  const p = s.payroll_periods;

  async function print() {
    if (can(profile!.role, 'payroll:write')) {
      const { error } = await sb.rpc('mark_slip_printed', { p_slip: id });
      if (error) toast(error.message, true);
    }
    window.print();
    reload();
  }

  return (
    <>
      <PageHead eyebrow={`Salary Slip · ${s.slip_no}`} title={`${s.employees.name} — ${monthLabel(p.year, p.month)}`}>
        <Link className="btn" href={`/payroll/${ymKey(p.year, p.month)}`}>← Payroll</Link>
        <button className="btn primary" onClick={print}>Print</button>
        <button className="btn" onClick={print} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
        <SlipUpload slipId={s.id} hasSigned={!!s.signed_path} onDone={reload} />
        {s.signed_path && <ViewSigned path={s.signed_path} />}
      </PageHead>
      <div className="no-print toolbar" style={{ marginBottom: 14 }}>
        <SlipBadge s={s.status} />
        <span className="muted">Printed: {s.printed_at ? fmtDateTime(s.printed_at) : 'not yet'} · Signed copy: {s.signed_path ? fmtDateTime(s.signed_uploaded_at) : 'not uploaded'}</span>
      </div>
      <SalarySlipDoc slip={s} co={settings.company} />
    </>
  );
}
