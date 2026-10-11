'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { TimesheetDoc } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { monthEnd, monthLabel, monthStart, parseYm } from '@/lib/format';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { AttendanceRow, Employee } from '@/lib/types';

export default function PrintTimesheetsPage() {
  return <Suspense fallback={<Loading />}><PrintTimesheets /></Suspense>;
}

function PrintTimesheets() {
  const sp = useSearchParams();
  const ym = sp.get('ym') ?? '';
  const empId = sp.get('emp');
  const parsed = parseYm(ym);
  const { settings } = useApp();
  const sb = supabase();
  const { data, error, loading } = useQuery(async () => {
    if (!parsed) throw new Error('Invalid month');
    const { year: y, month: m } = parsed;
    const rows = await fetchAll<AttendanceRow>((f, t) => sb.from('attendance').select('*')
      .gte('work_date', monthStart(y, m)).lte('work_date', monthEnd(y, m)).order('employee_id').order('work_date').range(f, t));
    const att = new Map<string, AttendanceRow[]>();
    for (const r of rows) { if (!att.has(r.employee_id)) att.set(r.employee_id, []); att.get(r.employee_id)!.push(r); }
    // same list as the attendance grid: active employees plus anyone with attendance this month
    let emps = (unwrap(await sb.from('employees').select('*').order('emp_code')) as Employee[])
      .filter((e) => e.status === 'active' || att.has(e.id));
    if (empId) emps = emps.filter((e) => e.id === empId);
    return emps.map((emp) => ({ emp, att: att.get(emp.id) ?? [] }));
  }, [ym, empId]);

  if (!parsed) return <ErrorBox error="Invalid month" />;
  const back = `/adminconsole/attendance/monthly?ym=${ym}`;
  const list = data ?? [];

  return (
    <>
      <PageHead eyebrow="Attendance" title={`Timesheets — ${monthLabel(parsed.year, parsed.month)}`} sub={`${list.length} timesheet${list.length === 1 ? '' : 's'}, one A4 page each`}>
        <Link className="btn" href={back}>← Attendance</Link>
        <button className="btn primary" disabled={!list.length} onClick={() => window.print()}>{empId ? 'Print' : 'Print all'}</button>
        <button className="btn" disabled={!list.length} onClick={() => window.print()} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : list.length === 0 ? <div className="banner">No employees to print.</div>
        : <div className={empId ? 'one-page' : undefined}>
          {list.map(({ emp, att }) => <TimesheetDoc key={emp.id} emp={emp} year={parsed.year} month={parsed.month} co={settings.company} att={att} />)}
        </div>}
    </>
  );
}
