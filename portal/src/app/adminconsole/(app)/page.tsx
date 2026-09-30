'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, OPEN_QUOTE, PageHead, StatCard } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtNum, monthLabel, timeAgo, today, ymKey } from '@/lib/format';
import { ATTENDANCE_SIDE, PAYROLL_SIDE, QUOTE_SIDE, can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { AuditLog } from '@/lib/types';

const ACTION_ICON: Record<string, string> = { attendance: '◧', payroll: '◫', salary_slip: '✎', quotation: '▤' };
const actionText = (a: string) => a.replace('.', ' · ').replace(/_/g, ' ');

export default function Dashboard() {
  const { profile, settings } = useApp();
  const role = profile!.role;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const sb = supabase();

  const { data, error, loading } = useQuery(async () => {
    const [emp, att, period, totals, quotes, slips, audit] = await Promise.all([
      sb.from('employees').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      sb.from('attendance').select('status').eq('work_date', today()),
      sb.from('payroll_periods').select('id').eq('year', year).eq('month', month).maybeSingle(),
      sb.rpc('attendance_month_totals', { p_year: year, p_month: month }),
      sb.from('quotations').select('amount').in('status', OPEN_QUOTE),
      sb.from('salary_slips').select('id', { count: 'exact', head: true }).in('status', ['generated', 'awaiting_signature']),
      sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(6),
    ]);
    const periodRow = unwrap(period);
    let payroll: number | null = null;
    if (periodRow) {
      const entries = unwrap(await sb.from('payroll_entries').select('net_salary').eq('period_id', periodRow.id));
      payroll = entries.reduce((s: number, e: { net_salary: number }) => s + Number(e.net_salary), 0);
    }
    const attRows = unwrap(att) as { status: string }[];
    const q = unwrap(quotes) as { amount: number }[];
    return {
      employees: emp.count ?? 0,
      present: attRows.filter((r) => r.status === 'present').length,
      absent: attRows.filter((r) => r.status === 'absent').length,
      marked: attRows.length,
      payroll,
      ot: (unwrap(totals) as { ot_hours: number }[]).reduce((s, r) => s + Number(r.ot_hours), 0),
      openQuotes: q.length,
      openValue: q.reduce((s, r) => s + Number(r.amount), 0),
      slips: slips.count ?? 0,
      audit: unwrap(audit) as AuditLog[],
    };
  }, [year, month]);

  const first = profile!.full_name.split(' ')[0];
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const showPayroll = PAYROLL_SIDE.includes(role);
  const showAtt = ATTENDANCE_SIDE.includes(role);
  const showQuotes = QUOTE_SIDE.includes(role);
  const ym = ymKey(year, month);

  return (
    <>
      <PageHead eyebrow="Administration" title={`${greet}, ${first}.`} sub="Here’s an overview of your company administration." />
      {error && <ErrorBox error={error} />}
      {loading || !data ? <Loading /> : (
        <>
          <section className="stats">
            {showAtt && <StatCard label="Active Employees" icon="♙" value={data.employees} note="Currently on payroll" />}
            {showAtt && <StatCard label="Attendance Today" icon="◧"
              value={data.marked ? `${data.present} / ${data.employees}` : 'Not marked'}
              note={data.marked ? `Present · ${data.absent} absent · ${Math.max(0, data.employees - data.marked)} unmarked` : 'No attendance saved for today'} />}
            {showPayroll && <StatCard label="Monthly Payroll" icon={<Riyal />} value={data.payroll === null ? '—' : fmtNum(data.payroll)}
              note={<><Riyal /> · {monthLabel(year, month)}{data.payroll === null && " not calculated"}</>} />}
            {showAtt && <StatCard label="Overtime This Month" icon="◔" value={`${fmtNum(data.ot, 1)} hrs`} note={monthLabel(year, month)} />}
            {showQuotes && <StatCard label="Open Quotations" icon="▤" value={data.openQuotes} note="Draft, submitted or revised" />}
            {showQuotes && <StatCard label="Open Quotation Value" icon="↗" value={<Money v={data.openValue} />} note="Incl. VAT" />}
            {showPayroll && <StatCard label="Slips Awaiting Signature" icon="✎" value={data.slips} note="Signed copy not yet uploaded" />}
          </section>

          <section className="lower-grid">
            <div className="panel">
              <div className="panel-title">Recent Activity</div>
              {data.audit.length === 0 && <div className="empty">No activity yet.</div>}
              {data.audit.map((a) => (
                <div className="activity-row" key={a.id}>
                  <div className="activity-icon">{ACTION_ICON[a.record_type] ?? '•'}</div>
                  <div>
                    <div className="activity-title" style={{ textTransform: 'capitalize' }}>{actionText(a.action)}</div>
                    <div className="activity-sub">{a.record_label ?? a.record_type} · {a.user_name}</div>
                  </div>
                  <div className="activity-time">{timeAgo(a.created_at)}</div>
                </div>
              ))}
            </div>

            <div className="panel">
              <div className="panel-title">Quick Actions</div>
              {can(role, 'attendance:write') && <Link href="/adminconsole/attendance" className="quick-action"><div className="quick-title">◧ Mark Attendance</div><div className="quick-description">Record today’s attendance and overtime</div></Link>}
              {can(role, 'payroll:write') && <Link href={`/adminconsole/payroll/${ym}`} className="quick-action"><div className="quick-title">◫ Process Payroll</div><div className="quick-description">Calculate and review {monthLabel(year, month)}</div></Link>}
              {can(role, 'quotations:write') && <Link href="/adminconsole/quotations/new" className="quick-action"><div className="quick-title">＋ New Quotation</div><div className="quick-description">Create a new client quotation</div></Link>}
              {showPayroll && <Link href="/adminconsole/slips" className="quick-action"><div className="quick-title">✎ View Salary Slips</div><div className="quick-description">Print, sign and upload signed copies</div></Link>}
            </div>
          </section>
          <div className="footer-note">{settings.company.name} · Administration Portal · Internal System</div>
        </>
      )}
    </>
  );
}
