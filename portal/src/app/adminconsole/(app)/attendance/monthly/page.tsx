'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ATT_CODE, ATT_LABEL, ErrorBox, Loading, PageHead, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { daysInMonth, hrs, monthEnd, monthLabel, monthStart, ymKey } from '@/lib/format';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { AttendanceRow, Employee } from '@/lib/types';

interface Totals { employee_id: string; present_days: number; absent_days: number; leave_days: number; weekly_off_days: number; holiday_days: number; regular_hours: number; ot_hours: number }
type View = 'timesheet' | 'calendar';

export default function MonthlyAttendancePage() {
  return <Suspense fallback={<Loading />}><MonthlyAttendance /></Suspense>;
}

function MonthlyAttendance() {
  const sb = supabase();
  const now = new Date();
  const qp = useSearchParams().get('ym');
  const [ym, setYm] = useState(qp && /^\d{4}-(0[1-9]|1[0-2])$/.test(qp) ? qp : ymKey(now.getFullYear(), now.getMonth() + 1));
  const [view, setView] = useState<View>('timesheet');
  // the wide timesheet grid can't fit a phone; start on the calendar there
  useEffect(() => { if (window.matchMedia('(max-width: 800px)').matches) setView('calendar'); }, []);
  const [empId, setEmpId] = useState('');
  const [y, m] = ym.split('-').map(Number);
  const dim = daysInMonth(y, m);

  const { data, error, loading } = useQuery(async () => {
    const [emps, totals, rows] = await Promise.all([
      sb.from('employees').select('*').order('emp_code'),
      sb.rpc('attendance_month_totals', { p_year: y, p_month: m }),
      fetchAll<AttendanceRow>((from, to) => sb.from('attendance').select('*')
        .gte('work_date', monthStart(y, m)).lte('work_date', monthEnd(y, m)).order('employee_id').order('work_date').range(from, to)),
    ]);
    const tmap = new Map((unwrap(totals) as Totals[]).map((t) => [t.employee_id, t]));
    const byEmp = new Map<string, Map<number, AttendanceRow>>();
    for (const r of rows) {
      const day = Number(r.work_date.slice(8, 10));
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
      byEmp.get(r.employee_id)!.set(day, r);
    }
    // show active employees plus anyone who has attendance in this month
    const list = (unwrap(emps) as Employee[]).filter((e) => e.status === 'active' || tmap.has(e.id));
    return { list, tmap, byEmp };
  }, [ym]);

  const list = data?.list ?? [];
  const selected = empId || list[0]?.id || '';
  const grand = useMemo(() => {
    const g = { p: 0, a: 0, l: 0, w: 0, h: 0, r: 0, o: 0 };
    data?.tmap.forEach((t) => { g.p += t.present_days; g.a += t.absent_days; g.l += t.leave_days; g.w += t.weekly_off_days; g.h += t.holiday_days; g.r += Number(t.regular_hours); g.o += Number(t.ot_hours); });
    return g;
  }, [data]);

  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const dow = (d: number) => new Date(y, m - 1, d).getDay();
  const emp = list.find((e) => e.id === selected);
  const t = data?.tmap.get(selected);

  return (
    <>
      <PageHead eyebrow="Payroll" title="Monthly Attendance" sub="Attendance is the source data for payroll — overtime is entered once, here." />
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input className="input" type="month" value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} />
        <span className="muted">{monthLabel(y, m)}</span>
        <span className="right muted" style={{ fontSize: 11 }}>P Present · A Absent · AL Annual · SL Sick · UL Unpaid · H Holiday · W Weekly Off</span>
      </div>
      <Tabs tabs={[['timesheet', 'Timesheet View'], ['calendar', 'Calendar View']]} value={view} onChange={setView} />
      {error && <ErrorBox error={error} />}
      {loading || !data ? <Loading /> : view === 'timesheet' ? (
        <div className="panel flush"><div className="table-wrap"><table className="table sheet">
          <thead><tr>
            <th>Employee</th>
            {days.map((d) => <th key={d} style={{ color: dow(d) === 5 ? 'var(--gold)' : undefined }}>{d}</th>)}
            <th>Pres</th><th>Abs</th><th>Leave</th><th>W/O</th><th>Hol</th><th>Reg Hrs</th><th>OT Hrs</th>
          </tr></thead>
          <tbody>
            {list.map((e) => {
              const tt = data.tmap.get(e.id); const cells = data.byEmp.get(e.id);
              return (
                <tr key={e.id}>
                  <td><span className="strong">{e.name}</span> <span className="muted">{e.emp_code}</span></td>
                  {days.map((d) => {
                    const r = cells?.get(d);
                    return <td key={d} title={r ? `${ATT_LABEL[r.status]} · ${hrs(r.regular_hours)}h + ${hrs(r.ot_hours)} OT` : 'Not marked'}>
                      {r ? <><span className={`att-code ${r.status}`}>{ATT_CODE[r.status]}</span>{Number(r.ot_hours) > 0 && <span className="ot">+{hrs(r.ot_hours)}</span>}</> : <span className="muted">·</span>}
                    </td>;
                  })}
                  <td className="strong">{tt?.present_days ?? 0}</td><td>{tt?.absent_days ?? 0}</td><td>{tt?.leave_days ?? 0}</td>
                  <td>{tt?.weekly_off_days ?? 0}</td><td>{tt?.holiday_days ?? 0}</td><td>{hrs(tt?.regular_hours ?? 0)}</td><td className="strong">{hrs(tt?.ot_hours ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr>
            <td>Total</td>{days.map((d) => <td key={d} />)}
            <td>{grand.p}</td><td>{grand.a}</td><td>{grand.l}</td><td>{grand.w}</td><td>{grand.h}</td><td>{hrs(grand.r)}</td><td>{hrs(grand.o)}</td>
          </tr></tfoot>
        </table></div></div>
      ) : (
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 14 }}>
            <select className="select" style={{ minWidth: 260 }} value={selected} onChange={(e) => setEmpId(e.target.value)}>
              {list.map((e) => <option key={e.id} value={e.id}>{e.emp_code} · {e.name}</option>)}
            </select>
            {emp && t && <span className="muted">Present {t.present_days} · Absent {t.absent_days} · Leave {t.leave_days} · Weekly off {t.weekly_off_days} · Holidays {t.holiday_days} · Regular {hrs(t.regular_hours)} h · OT {hrs(t.ot_hours)} h</span>}
          </div>
          <div className="cal">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div className="cal-h" key={d}>{d}</div>)}
            {Array.from({ length: new Date(y, m - 1, 1).getDay() }, (_, i) => <div key={`b${i}`} className="cal-d blank" />)}
            {days.map((d) => {
              const r = data.byEmp.get(selected)?.get(d);
              return (
                <div className="cal-d" key={d}>
                  <div className="dn">{d}</div>
                  {r ? <><span className={`att-code ${r.status}`}>{ATT_CODE[r.status]}</span>
                    <div className="h">{r.status === 'present' ? `${hrs(r.regular_hours)}h` : ATT_LABEL[r.status]}{Number(r.ot_hours) > 0 && <b style={{ color: 'var(--gold)' }}> +{hrs(r.ot_hours)} OT</b>}</div></>
                    : <div className="muted">—</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
