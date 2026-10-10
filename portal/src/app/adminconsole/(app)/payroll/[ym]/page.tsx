'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_LABEL, Badge, StatCard, ErrorBox, Field, Loading, Modal, PageHead, PeriodBadge, SlipBadge, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { BatchModal } from '@/components/PayrollBatchModal';
import { fmtDate, fmtDateTime, fmtNum, monthLabel, parseYm, periodLabel, timeAgo, ymd } from '@/lib/format';
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
  const [setup, setSetup] = useState(false);

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

  if (!parsed) return <ErrorBox error="Invalid pay period." />;
  const { year, month } = parsed;
  const period = data?.period ?? null;
  const label = period ? periodLabel(period) : monthLabel(year, month);
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
  const calculate = async (start: string, end: string, ids: string[]) => {
    setSetup(false);
    setBusy(true);
    const { error } = await sb.rpc('calculate_payroll', { p_year: year, p_month: month, p_start: start, p_end: end, p_employees: ids });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast('Payroll recalculated with the new pay period and employees'); reload();
  };
  const approve = async () => {
    if (!(await confirmDialog({ title: 'Approve payroll', message: `Approve payroll for ${label}?\n\nThis locks the payroll period and its attendance, and generates salary slips.`, confirmLabel: 'Approve' }))) return;
    run(() => sb.rpc('approve_payroll', { p_period: period!.id }), 'Payroll approved — salary slips generated');
  };

  const tot = entries.reduce((a, e) => ({
    basic: a.basic + Number(e.basic), allow: a.allow + Number(e.allowances), ot: a.ot + Number(e.ot_paid_amount ?? 0), otAmt: a.otAmt + Number(e.ot_amount),
    other: a.other + Number(e.other_earnings), days: a.days + Number(e.present_days), unpaid: a.unpaid + Number(e.unpaid_days),
    ded: a.ded + Number(e.deductions), adv: a.adv + Number(e.advance_paid ?? 0), net: a.net + Number(e.net_salary),
  }), { basic: 0, allow: 0, ot: 0, otAmt: 0, other: 0, days: 0, unpaid: 0, ded: 0, adv: 0, net: 0 });
  const gross = tot.basic + tot.allow + tot.otAmt + tot.other;

  const tabs: [Tab, string][] = [['payroll', 'Summary'], ['validation', `Checks${period?.status === 'calculated' && errors.length ? ` (${errors.length} to fix)` : ''}`], ['slips', `Slips (${signed}/${slips.length})`], ['audit', 'Activity Log']];

  return (
    <div className="payroll-screen">
      <PageHead eyebrow="Payroll" title={label} sub={period ? 'Payroll run' : 'Nothing has been calculated for this pay period yet.'}>
        <Link href="/adminconsole/payroll" className="btn">← All payroll runs</Link>
        <Link href={`/adminconsole/attendance/monthly?ym=${params.ym}`} className="btn">View Attendance</Link>
        {period && entries.length > 0 && <Link href={`/adminconsole/payroll/${params.ym}/report`} className="btn">Payroll Report</Link>}
        {canWrite && !locked && <button className="btn" disabled={busy} onClick={() => setSetup(true)}>{period ? '↻ Recalculate' : 'Set Up & Calculate'}</button>}
        {canWrite && period?.status === 'calculated' && <button className="btn green" disabled={busy || errors.length > 0} title={errors.length ? 'Resolve the validation errors first' : ''} onClick={approve}>Approve Payroll</button>}
        {can(role, 'payroll:reopen') && locked && <button className="btn danger" onClick={() => setReopen(true)}>Reopen Payroll</button>}
      </PageHead>

      <div className="m-only m-steps">
        <div className="m-steps-top"><strong>{STEPS[Math.min(step, STEPS.length - 1)]}</strong><span>Step {Math.min(step + 1, STEPS.length)} of {STEPS.length}</span></div>
        <div className="m-bar"><i style={{ width: `${(Math.min(step, STEPS.length - 1) + 1) / STEPS.length * 100}%` }} /></div>
      </div>
      <div className="stepper d-only">
        {STEPS.map((s, i) => <div key={s} className={`step${i < step ? ' done' : ''}${i === step ? ' current' : ''}`}><span className="n">{i < step ? '✓' : i + 1}</span>{s}</div>)}
      </div>

      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : (
        <>
          {period && (
            <div className={`banner ${locked ? 'ok' : period.reopen_reason ? 'warn' : ''}`}>
              <PeriodBadge s={period.status} />{' '}
              {period.start_date && period.end_date && <><strong>{fmtDate(period.start_date)} – {fmtDate(period.end_date)}</strong> · {period.employee_ids ? `${entries.length} selected employees` : 'all employees'}. </>}
              {locked ? <>Locked — approved {fmtDateTime(period.approved_at)}. Attendance for this payroll run can’t be edited.{period.status === 'approved' && ` ${signed} of ${slips.length} signed slips uploaded.`}</>
                : <>Not locked. Last calculated {period.calculated_at ? timeAgo(period.calculated_at) : '—'}.{period.reopen_reason && <> Reopened: “{period.reopen_reason}”.</>}</>}
            </div>
          )}

          {entries.length > 0 && (
            <div className="stats compact">
              <StatCard label="Employees paid" icon="#" value={entries.length} note={period?.start_date && period?.end_date ? `${fmtDate(period.start_date)} – ${fmtDate(period.end_date)}` : undefined} />
              <StatCard label="Gross pay" icon="+" value={<Money v={gross} />} note="Basic + allowances + overtime + other earnings" />
              <StatCard label="Total deductions" icon="−" value={<Money v={tot.ded} />} note={`${tot.unpaid} unpaid day(s) across the team`} />
              <StatCard label="Net pay" icon="=" value={<Money v={tot.net} />} note={tot.adv > 0 ? `After ${fmtNum(tot.adv)} already paid` : tot.ot > 0 ? `Overtime already paid separately: ${fmtNum(tot.ot)}` : 'Amount payable to employees'} />
            </div>
          )}

          <Tabs tabs={tabs} value={tab} onChange={setTab} />

          {tab === 'payroll' && (
            <div className="m-only">
              {entries.map((e) => (
                <button type="button" key={e.id} className="pcard" onClick={() => setOpen(e)}>
                  <div className="pcard-top">
                    <div><div className="pcard-name">{e.employees.name}</div><div className="pcard-sub">{e.employees.emp_code} · {e.employees.job_title}</div></div>
                    <div className="pcard-net"><span>Net pay</span><Money v={e.net_salary} /></div>
                  </div>
                  <div className="pcard-grid">
                    <div><span>Days worked</span>{e.present_days}</div>
                    <div><span>Unpaid days</span>{e.unpaid_days > 0 ? <b className="neg">{e.unpaid_days}</b> : 0}</div>
                    <div><span>Basic salary</span>{fmtNum(e.basic)}</div>
                    <div><span>Allowances</span>{fmtNum(e.allowances)}</div>
                    <div><span>Overtime due</span>{fmtNum(e.ot_amount)}</div>
                    <div><span>Deductions</span>{fmtNum(e.deductions)}</div>
                    <div><span>Already paid</span>{fmtNum(e.advance_paid ?? 0)}</div>
                  </div>
                </button>
              ))}
              {entries.length === 0 && <div className="empty">{canWrite ? 'Tap “Set Up & Calculate” to choose the pay period and employees.' : 'Not calculated yet.'}</div>}
            </div>
          )}
          {tab === 'payroll' && (
            <div className="panel flush d-only"><div className="table-wrap"><table className="table">
              <thead><tr><th>Employee</th><th className="r">Days Worked</th><th className="r">Unpaid Days</th><th className="r">Basic Salary</th><th className="r">Allowances</th><th className="r">Overtime Due</th><th className="r">Overtime Paid Earlier</th><th className="r">Deductions</th><th className="r">Already Paid</th><th className="r">Net Pay</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="click" onClick={() => setOpen(e)}>
                    <td><span className="strong">{e.employees.name}</span><div className="muted" style={{ fontSize: 10 }}>{e.employees.emp_code} · {e.employees.job_title}</div></td>
                    <td className="r">{e.present_days}</td><td className="r">{e.unpaid_days > 0 ? <span className="badge red">{e.unpaid_days}</span> : 0}</td>
                    <td className="r">{fmtNum(e.basic)}</td><td className="r">{fmtNum(e.allowances)}</td>
                    <td className="r">{Number(e.ot_amount) > 0 ? <span className="badge gold">{fmtNum(e.ot_amount)}</span> : fmtNum(0)}</td>
                    <td className="r muted">{fmtNum(e.ot_paid_amount ?? 0)}</td>
                    <td className="r">{fmtNum(e.deductions)}</td><td className="r" onClick={(ev) => ev.stopPropagation()}>{canWrite && !locked ? <AdvanceCell entry={e} onSaved={reload} /> : fmtNum(e.advance_paid ?? 0)}</td><td className="r strong">{fmtNum(e.net_salary)}</td>
                  </tr>
                ))}
                {entries.length === 0 && <tr><td colSpan={10}><div className="empty">{canWrite ? 'Press “Set Up & Calculate” to choose the pay period and employees, then build this run from attendance.' : 'Not calculated yet.'}</div></td></tr>}
              </tbody>
              {entries.length > 0 && <tfoot><tr><td>Total · {entries.length} employees</td><td className="r">{tot.days}</td><td className="r">{tot.unpaid}</td><td className="r">{fmtNum(tot.basic)}</td><td className="r">{fmtNum(tot.allow)}</td><td className="r">{fmtNum(tot.otAmt)}</td><td className="r">{fmtNum(tot.ot)}</td><td className="r">{fmtNum(tot.ded)}</td><td className="r">{fmtNum(tot.adv)}</td><td className="r">{<Money v={tot.net} />}</td></tr></tfoot>}
            </table></div></div>
          )}

          {tab === 'validation' && (
            <div className="panel">
              <div className="panel-title">Checks before approval</div>
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
                <thead><tr><th>Employee</th><th className="r">Net Pay</th><th>Printed</th><th>Signed Copy</th><th>Status</th><th /></tr></thead>
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
              <thead><tr><th>Date & Time</th><th>Done By</th><th>Activity</th><th>Reference</th><th>Details</th></tr></thead>
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
      {setup && <BatchModal year={year} month={month} period={period} busy={busy} onClose={() => setSetup(false)} onRun={calculate} />}
      {reopen && period && <ReopenModal periodId={period.id} label={label} onClose={() => setReopen(false)} onDone={() => { setReopen(false); reload(); }} />}
    </div>
  );
}

/** Already-paid amount edited straight in the payroll table; saved when the field loses focus. */
function AdvanceCell({ entry: e, onSaved }: { entry: Entry; onSaved: () => void }) {
  const { toast } = useApp();
  const start = String(Number(e.advance_paid ?? 0));
  const [v, setV] = useState(start);
  async function save() {
    if (Number(v || 0) === Number(start)) return;
    const { error } = await supabase().rpc('update_entry_adjustment', {
      p_entry: e.id, p_other_earnings: Number(e.other_earnings), p_other_deductions: Number(e.other_deductions), p_note: e.adjustment_note, p_advance: Number(v || 0),
    });
    if (error) { setV(start); return toast(error.message, true); }
    toast('Already paid saved'); onSaved();
  }
  return <input className="input num" style={{ width: 100, textAlign: 'right' }} type="text" inputMode="decimal" value={v}
    onChange={(x) => /^[0-9]*[.]?[0-9]{0,2}$/.test(x.target.value) && setV(x.target.value)}
    onBlur={save} onKeyDown={(x) => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />;
}

function Breakdown({ entry: e, editable, onClose, onSaved }: { entry: Entry; editable: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [earn, setEarn] = useState(String(Number(e.other_earnings)));
  const [ded, setDed] = useState(String(Number(e.other_deductions)));
  const [adv, setAdv] = useState(String(Number(e.advance_paid ?? 0)));
  const [note, setNote] = useState(e.adjustment_note);
  const [saving, setSaving] = useState(false);
  const b = e.breakdown;
  const counts = b.counts ?? ({} as Record<AttendanceStatus, number>);
  const gross = Number(e.basic) + Number(e.allowances) + Number(e.ot_amount) + Number(e.other_earnings);

  async function save() {
    setSaving(true);
    const { error } = await supabase().rpc('update_entry_adjustment', { p_entry: e.id, p_other_earnings: Number(earn || 0), p_other_deductions: Number(ded || 0), p_note: note, p_advance: Number(adv || 0) });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Adjustments saved'); onSaved();
  }

  return (
    <Modal title={`${e.employees.name} · ${e.employees.emp_code}`} wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button>{editable && <button className="btn primary" disabled={saving} onClick={save}>Save adjustments</button>}</>}>
      <div className="muted" style={{ marginBottom: 14 }}>
        {e.employees.job_title} · Attendance: {(Object.keys(counts) as AttendanceStatus[]).filter((k) => counts[k] > 0).map((k) => `${ATT_LABEL[k]} ${counts[k]}`).join(' · ') || 'none'}
      </div>
      <div className="kv">
        <span className="k">Basic salary</span><span className="v">{<Money v={e.basic} />}</span>
        <span className="k">Allowances</span><span className="v">{<Money v={e.allowances} />}</span>
        <span className="k">Overtime (unpaid)<span className="formula">Unpaid OT entered in attendance — added to the salary</span></span>
        <span className="v">{<Money v={e.ot_amount} />}</span>
        {Number(e.ot_paid_amount ?? 0) > 0 && <><span className="k">Overtime (already paid)<span className="formula">Paid separately — not added to the salary</span></span><span className="v muted">{<Money v={e.ot_paid_amount ?? 0} />}</span></>}
        <span className="k">Other earnings</span><span className="v">{editable ? <input className="input num" style={{ width: 120, display: 'inline-block' }} type="number" min="0" step="0.01" value={earn} onChange={(x) => setEarn(x.target.value)} /> : <Money v={e.other_earnings} />}</span>
        <div className="sep" />
        <span className="k strong">Gross earnings</span><span className="v">{<Money v={gross} />}</span>
        <span className="k">Absence deduction<span className="formula">{e.unpaid_days} unpaid day(s) × (basic ÷ {b.days_divisor} = {<Money v={b.daily_rate} />})</span></span><span className="v">− {<Money v={e.absence_deduction} />}</span>
        <span className="k">Other deductions</span><span className="v">{editable ? <input className="input num" style={{ width: 120, display: 'inline-block' }} type="number" min="0" step="0.01" value={ded} onChange={(x) => setDed(x.target.value)} /> : <>− <Money v={e.other_deductions} /></>}</span>
        <span className="k">Already paid<span className="formula">Paid to the employee before this slip — taken off the net pay</span></span>
        <span className="v">{editable ? <input className="input num" style={{ width: 120, display: 'inline-block' }} type="number" min="0" step="0.01" value={adv} onChange={(x) => setAdv(x.target.value)} /> : <>− <Money v={e.advance_paid ?? 0} /></>}</span>
        <div className="sep" />
        <span className="k tot">Net pay{editable && <span className="formula">Updates after saving</span>}</span><span className="v tot">{<Money v={e.net_salary} />}</span>
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
      <div className="banner warn">Reopening unlocks this run’s attendance and payroll. If amounts change after re-approval, affected salary slips are reset and must be printed and signed again. This action is recorded in the audit log.</div>
      <Field label="Reason (required)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Correct overtime for two employees" /></Field>
    </Modal>
  );
}
