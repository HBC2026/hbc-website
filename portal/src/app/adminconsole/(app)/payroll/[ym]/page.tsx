'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_LABEL, Badge, ErrorBox, Field, Loading, Modal, PageHead, PeriodBadge, SlipBadge, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDateTime, fmtNum, hrs, monthLabel, parseYm, timeAgo } from '@/lib/format';
import { can } from '@/lib/roles';
import { fetchAll, supabase, unwrap } from '@/lib/supabase';
import type { AttendanceStatus, AuditLog, Employee, PayrollEntry, PayrollPeriod, SalarySlip } from '@/lib/types';

type Entry = PayrollEntry & { employees: Employee };
type Slip = SalarySlip & { employees: Employee };
interface Issue { employee_id: string | null; emp_code: string | null; name: string | null; severity: 'error' | 'warning'; message: string }
type Tab = 'payroll' | 'validation' | 'slips' | 'audit';

const STEPS = ['Attendance', 'Calculate', 'Review', 'Approve', 'Salary Slips', 'Signed Copies', 'Complete'];

export default function PayrollPeriodPage() {
  const params = useParams<{ ym: string }>();
  const parsed = parseYm(params.ym);
  const { profile, toast, confirmDialog } = useApp();
  const role = profile!.role;
  const sb = supabase();
  const [tab, setTab] = useState<Tab>('payroll');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  const [reopen, setReopen] = useState(false);

  const { data, error, loading, reload } = useQuery(async () => {
    if (!parsed) throw new Error('Invalid month');
    const { year, month } = parsed;
    const period = unwrap(await sb.from('payroll_periods').select('*').eq('year', year).eq('month', month).maybeSingle()) as PayrollPeriod | null;
    if (!period) return { period: null, entries: [], issues: [], slips: [], audit: [] };
    const entries = (await fetchAll<Entry>((f, t) => sb.from('payroll_entries').select('*, employees(*)').eq('period_id', period.id).order('id').range(f, t)))
      .sort((a, b) => a.employees.emp_code.localeCompare(b.employees.emp_code));
    const slips = (unwrap(await sb.from('salary_slips').select('*, employees(*)').eq('period_id', period.id)) as Slip[])
      .sort((a, b) => a.employees.emp_code.localeCompare(b.employees.emp_code));
    const issues = period.status === 'calculated' ? (unwrap(await sb.rpc('payroll_issues', { p_period: period.id })) as Issue[]) : [];
    const mm = String(month).padStart(2, '0');
    const audit = unwrap(await sb.from('audit_logs').select('*').or(`record_id.eq.${period.id},record_label.like.SS-${year}${mm}-%`)
      .order('created_at', { ascending: false }).limit(100)) as AuditLog[];
    return { period, entries, issues, slips, audit };
  }, [params.ym]);

  if (!parsed) return <ErrorBox error="Invalid payroll month." />;
  const { year, month } = parsed;
  const label = monthLabel(year, month);
  const period = data?.period ?? null;
  const entries = data?.entries ?? [];
  const slips = data?.slips ?? [];
  const issues = data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const locked = period?.status === 'approved' || period?.status === 'completed';
  const canWrite = can(role, 'payroll:write');
  const signed = slips.filter((s) => s.signed_path).length;

  let step = 1;
  if (period?.status === 'calculated') step = 2;
  else if (period?.status === 'approved') step = signed > 0 ? 5 : 4;
  else if (period?.status === 'completed') step = 7;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) return toast(error.message, true);
    toast(ok); reload();
  }
  const calculate = () => run(() => sb.rpc('calculate_payroll', { p_year: year, p_month: month }), `Payroll calculated for ${label}`);
  const approve = async () => {
    if (!(await confirmDialog({ title: 'Approve payroll', message: `Approve payroll for ${label}?\n\nThis locks the payroll period and its attendance, and generates salary slips.`, confirmLabel: 'Approve' }))) return;
    run(() => sb.rpc('approve_payroll', { p_period: period!.id }), 'Payroll approved — salary slips generated');
  };

  const tot = entries.reduce((a, e) => ({
    basic: a.basic + Number(e.basic), allow: a.allow + Number(e.allowances), ot: a.ot + Number(e.ot_hours), otAmt: a.otAmt + Number(e.ot_amount),
    ded: a.ded + Number(e.deductions), net: a.net + Number(e.net_salary),
  }), { basic: 0, allow: 0, ot: 0, otAmt: 0, ded: 0, net: 0 });

  const tabs: [Tab, string][] = [['payroll', 'Payroll'], ['validation', `Validation${period?.status === 'calculated' ? ` (${errors.length} errors)` : ''}`], ['slips', `Salary Slips (${signed}/${slips.length} signed)`], ['audit', 'Audit History']];

  return (
    <>
      <PageHead eyebrow="Payroll" title={label} sub={period ? undefined : 'Payroll has not been calculated for this month yet.'}>
        <Link href="/adminconsole/payroll" className="btn">← All periods</Link>
        <Link href={`/adminconsole/attendance/monthly?ym=${params.ym}`} className="btn">Attendance</Link>
        {period && entries.length > 0 && <Link href={`/adminconsole/payroll/${params.ym}/report`} className="btn">Report</Link>}
        {canWrite && !locked && <button className="btn" disabled={busy} onClick={calculate}>{period ? '↻ Recalculate' : 'Calculate Payroll'}</button>}
        {canWrite && period?.status === 'calculated' && <button className="btn green" disabled={busy || errors.length > 0} title={errors.length ? 'Resolve the validation errors first' : ''} onClick={approve}>Approve Payroll</button>}
        {can(role, 'payroll:reopen') && locked && <button className="btn danger" onClick={() => setReopen(true)}>Reopen Payroll</button>}
      </PageHead>

      <div className="stepper">
        {STEPS.map((s, i) => <div key={s} className={`step${i < step ? ' done' : ''}${i === step ? ' current' : ''}`}><span className="n">{i < step ? '✓' : i + 1}</span>{s}</div>)}
      </div>

      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : (
        <>
          {period && (
            <div className={`banner ${locked ? 'ok' : period.reopen_reason ? 'warn' : ''}`}>
              <PeriodBadge s={period.status} />{' '}
              {locked ? <>Locked — approved {fmtDateTime(period.approved_at)}. Attendance for this month can’t be edited.{period.status === 'approved' && ` ${signed} of ${slips.length} signed slips uploaded.`}</>
                : <>Not locked. Last calculated {period.calculated_at ? timeAgo(period.calculated_at) : '—'}.{period.reopen_reason && <> Reopened: “{period.reopen_reason}”.</>}</>}
            </div>
          )}

          <Tabs tabs={tabs} value={tab} onChange={setTab} />

          {tab === 'payroll' && (
            <div className="panel flush"><div className="table-wrap"><table className="table">
              <thead><tr><th>Employee</th><th className="r">Basic</th><th className="r">Allowances</th><th className="r">OT Hrs</th><th className="r">OT Amount</th><th className="r">Deductions</th><th className="r">Net Salary</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="click" onClick={() => setOpen(e)}>
                    <td><span className="strong">{e.employees.name}</span><div className="muted" style={{ fontSize: 10 }}>{e.employees.emp_code}</div></td>
                    <td className="r">{fmtNum(e.basic)}</td><td className="r">{fmtNum(e.allowances)}</td><td className="r">{hrs(e.ot_hours)}</td>
                    <td className="r">{fmtNum(e.ot_amount)}</td><td className="r">{fmtNum(e.deductions)}</td><td className="r strong">{fmtNum(e.net_salary)}</td>
                  </tr>
                ))}
                {entries.length === 0 && <tr><td colSpan={7}><div className="empty">{canWrite ? 'Press “Calculate Payroll” to build this month from attendance.' : 'Not calculated yet.'}</div></td></tr>}
              </tbody>
              {entries.length > 0 && <tfoot><tr><td>Total · {entries.length} employees</td><td className="r">{fmtNum(tot.basic)}</td><td className="r">{fmtNum(tot.allow)}</td><td className="r">{hrs(tot.ot)}</td><td className="r">{fmtNum(tot.otAmt)}</td><td className="r">{fmtNum(tot.ded)}</td><td className="r">{<Money v={tot.net} />}</td></tr></tfoot>}
            </table></div></div>
          )}

          {tab === 'validation' && (
            <div className="panel">
              <div className="panel-title">Pre-approval checks</div>
              {period?.status !== 'calculated' && <div className="muted">{locked ? 'Payroll is approved; all checks passed at approval.' : 'Calculate payroll to run the checks.'}</div>}
              {period?.status === 'calculated' && issues.length === 0 && <div className="banner ok" style={{ marginBottom: 0 }}>All checks passed. Payroll is ready to approve.</div>}
              {issues.map((i, k) => (
                <div className="issue" key={k}>
                  <Badge tone={i.severity === 'error' ? 'red' : 'gold'}>{i.severity}</Badge>
                  <span className="strong">{i.name ? `${i.emp_code} · ${i.name}` : 'Payroll'}</span><span>{i.message}</span>
                </div>
              ))}
              {period?.status === 'calculated' && <div className="muted" style={{ marginTop: 14 }}>Checks: missing attendance · missing salary information · invalid OT · missing employee information · calculation errors · attendance changed since calculation.</div>}
            </div>
          )}

          {tab === 'slips' && (
            <div className="panel flush">
              <div className="panel-head">
                <div className="panel-title">Salary slips</div>
                {locked && slips.length > 0 && <Link className="btn primary sm" href={`/adminconsole/payroll/${params.ym}/slips`}>Print all slips (A4)</Link>}
              </div>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Employee</th><th className="r">Net Salary</th><th>Printed</th><th>Signed</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {slips.map((s) => (
                    <tr key={s.id}><td><span className="strong">{s.employees.name}</span><div className="muted" style={{ fontSize: 10 }}>{s.slip_no}</div></td>
                      <td className="r">{<Money v={s.net_snapshot} />}</td><td>{s.printed_at ? '✓' : '—'}</td><td>{s.signed_path ? '✓' : '—'}</td>
                      <td><SlipBadge s={s.status} /></td><td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/adminconsole/slips/${s.id}`}>Open</Link></td></tr>
                  ))}
                  {slips.length === 0 && <tr><td colSpan={6}><div className="empty">Salary slips are generated when payroll is approved.</div></td></tr>}
                </tbody>
              </table></div>
            </div>
          )}

          {tab === 'audit' && (
            <div className="panel flush"><div className="table-wrap"><table className="table">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
              <tbody>
                {(data?.audit ?? []).map((a) => (
                  <tr key={a.id}><td>{fmtDateTime(a.created_at)}</td><td>{a.user_name}</td><td style={{ textTransform: 'capitalize' }}>{a.action.replace(/[._]/g, ' ')}</td><td>{a.record_label}</td>
                    <td className="muted">{a.new_value ? Object.entries(a.new_value).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') : ''}</td></tr>
                ))}
                {(data?.audit ?? []).length === 0 && <tr><td colSpan={5}><div className="empty">No audit entries yet.</div></td></tr>}
              </tbody>
            </table></div></div>
          )}
        </>
      )}

      {open && <Breakdown entry={open} editable={canWrite && !locked} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
      {reopen && period && <ReopenModal periodId={period.id} label={label} onClose={() => setReopen(false)} onDone={() => { setReopen(false); reload(); }} />}
    </>
  );
}

function Breakdown({ entry: e, editable, onClose, onSaved }: { entry: Entry; editable: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [earn, setEarn] = useState(String(Number(e.other_earnings)));
  const [ded, setDed] = useState(String(Number(e.other_deductions)));
  const [note, setNote] = useState(e.adjustment_note);
  const [saving, setSaving] = useState(false);
  const b = e.breakdown;
  const counts = b.counts ?? ({} as Record<AttendanceStatus, number>);
  const gross = Number(e.basic) + Number(e.allowances) + Number(e.ot_amount) + Number(e.other_earnings);

  async function save() {
    setSaving(true);
    const { error } = await supabase().rpc('update_entry_adjustment', { p_entry: e.id, p_other_earnings: Number(earn || 0), p_other_deductions: Number(ded || 0), p_note: note });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Adjustments saved'); onSaved();
  }

  return (
    <Modal title={`${e.employees.name} · ${e.employees.emp_code}`} wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button>{editable && <button className="btn primary" disabled={saving} onClick={save}>Save adjustments</button>}</>}>
      <div className="muted" style={{ marginBottom: 14 }}>
        {e.employees.job_title} · Attendance: {(Object.keys(counts) as AttendanceStatus[]).filter((k) => counts[k] > 0).map((k) => `${ATT_LABEL[k]} ${counts[k]}`).join(' · ') || 'none'} · Regular {hrs(e.regular_hours)} h
      </div>
      <div className="kv">
        <span className="k">Basic salary</span><span className="v">{<Money v={e.basic} />}</span>
        <span className="k">Allowances</span><span className="v">{<Money v={e.allowances} />}</span>
        <span className="k">Overtime<span className="formula">{hrs(e.ot_hours)} h × {<Money v={e.ot_rate} />}
          {b.ot_method === 'fixed' ? ' (fixed rate)' : ` (basic ÷ ${b.days_divisor} ÷ ${b.standard_hours} = ${fmtNum(b.hourly_rate, 4)} × ${b.ot_multiplier})`}</span></span>
        <span className="v">{<Money v={e.ot_amount} />}</span>
        <span className="k">Other earnings</span><span className="v">{editable ? <input className="input num" style={{ width: 120, display: 'inline-block' }} type="number" min="0" step="0.01" value={earn} onChange={(x) => setEarn(x.target.value)} /> : <Money v={e.other_earnings} />}</span>
        <div className="sep" />
        <span className="k strong">Gross earnings</span><span className="v">{<Money v={gross} />}</span>
        <span className="k">Absence deduction<span className="formula">{e.unpaid_days} unpaid day(s) × (basic ÷ {b.days_divisor} = {<Money v={b.daily_rate} />})</span></span><span className="v">− {<Money v={e.absence_deduction} />}</span>
        <span className="k">Other deductions</span><span className="v">{editable ? <input className="input num" style={{ width: 120, display: 'inline-block' }} type="number" min="0" step="0.01" value={ded} onChange={(x) => setDed(x.target.value)} /> : <>− <Money v={e.other_deductions} /></>}</span>
        <div className="sep" />
        <span className="k tot">Net salary</span><span className="v tot">{<Money v={e.net_salary} />}</span>
      </div>
      {(editable || e.adjustment_note) && <div style={{ marginTop: 16 }}><Field label="Adjustment note">{editable ? <input className="input" value={note} onChange={(x) => setNote(x.target.value)} /> : <div>{e.adjustment_note}</div>}</Field></div>}
      {editable && <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>Saving updates the net salary immediately. Recalculating from attendance keeps these adjustments.</div>}
    </Modal>
  );
}

function ReopenModal({ periodId, label, onClose, onDone }: { periodId: string; label: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const { error } = await supabase().rpc('reopen_payroll', { p_period: periodId, p_reason: reason });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast('Payroll reopened'); onDone();
  }
  return (
    <Modal title={`Reopen payroll — ${label}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || reason.trim().length < 5} onClick={go}>Reopen payroll</button></>}>
      <div className="banner warn">Reopening unlocks this month’s attendance and payroll. If amounts change after re-approval, affected salary slips are reset and must be printed and signed again. This action is recorded in the audit log.</div>
      <Field label="Reason (required)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Correct overtime for two employees" /></Field>
    </Modal>
  );
}
