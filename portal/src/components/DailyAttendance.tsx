'use client';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_LABEL, ATT_STATUSES, DatePicker, ErrorBox, Select, Loading } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { addDays, fmtDate, fmtNum, monthLabel, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { otHourlyRate } from '@/lib/ot';
import { supabase, unwrap } from '@/lib/supabase';
import type { AttendanceRow, AttendanceStatus, Employee } from '@/lib/types';

/** An employee row; in "all companies" mode it also carries the company, that company's settings and whether you may edit it */
type Emp = Employee & { company_code?: string; standard_hours?: number; ot_multiplier?: number; ot_day_hours?: number; locked?: boolean; can_write?: boolean };

const OT_STATUSES: AttendanceStatus[] = ['present', 'holiday', 'weekly_off'];

/** hours = OT hours (priced from salary); legacy = an old entry that only has an amount, kept editable as an amount */
interface Row { status: AttendanceStatus | ''; regular: string; ot: boolean; hours: string; amount: string; legacy: boolean; paid: boolean; remarks: string }
type Rows = Record<string, Row>;

function buildRows(emps: Emp[], existing: AttendanceRow[]): Rows {
  const by = new Map(existing.map((r) => [r.employee_id, r]));
  const out: Rows = {};
  for (const e of emps) {
    const r = by.get(e.id);
    out[e.id] = r
      ? { status: r.status, regular: String(Number(r.regular_hours)), ot: Number(r.ot_hours) > 0 || Number(r.ot_amount ?? 0) > 0,
          hours: Number(r.ot_hours) > 0 ? String(Number(r.ot_hours)) : '', amount: Number(r.ot_amount ?? 0) > 0 ? String(Number(r.ot_amount)) : '',
          legacy: !(Number(r.ot_hours) > 0) && Number(r.ot_amount ?? 0) > 0, paid: !!r.ot_paid, remarks: r.remarks }
      : { status: '', regular: '', ot: false, hours: '', amount: '', legacy: false, paid: false, remarks: '' };
  }
  return out;
}

/** all = mark attendance for the employees of every company you belong to (instead of only the selected company) */
export function DailyAttendance({ all = false }: { all?: boolean } = {}) {
  const { profile, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'attendance:write');
  const sb = supabase();
  const [date, setDate] = useState(today());
  const [dirty, setDirty] = useState(false);
  const [year, month] = date.split('-').map(Number);

  const { data, error, loading, reload } = useQuery(async () => {
    if (all) {
      const res = unwrap(await sb.rpc('attendance_day_all', { p_date: date })) as { employees: Emp[]; attendance: AttendanceRow[] };
      return { emps: res.employees, att: res.attendance, locked: false, at: Date.now() };
    }
    const [emps, att, period] = await Promise.all([
      sb.from('employees').select('*').or(`status.eq.active,last_working_date.gte.${date}`).lte('joining_date', date).order('emp_code'),
      sb.from('attendance').select('*').eq('work_date', date),
      sb.from('payroll_periods').select('status').eq('year', year).eq('month', month).maybeSingle(),
    ]);
    return {
      emps: unwrap(emps) as Emp[], att: unwrap(att) as AttendanceRow[],
      locked: ['approved', 'completed'].includes((unwrap(period) as { status: string } | null)?.status ?? ''),
      at: Date.now(),
    };
  }, [date]);

  async function changeDate(d: string) {
    if (!d) return;
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: 'You have unsaved attendance changes. Discard them?', confirmLabel: 'Discard', danger: true }))) return;
    setDirty(false); setDate(d);
  }

  return (
    <>
      <div className="toolbar no-print" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => changeDate(addDays(date, -1))}>←</button>
        <DatePicker value={date} onChange={changeDate} />
        <button className="btn" onClick={() => changeDate(addDays(date, 1))}>→</button>
        <button className="btn" onClick={() => changeDate(today())}>Today</button>
        <span className="muted">{fmtDate(date)}</span>
        {new Date(`${date}T00:00:00`).getDay() === 5 && <span className="badge gold">Friday</span>}
      </div>
      {error && <ErrorBox error={error} />}
      {loading || !data ? <Loading /> : (
        <Grid key={`${date}-${data.at}`} date={date} emps={data.emps} initial={buildRows(data.emps, data.att)}
          locked={data.locked} canWrite={canWrite} all={all} monthText={monthLabel(year, month)} onDirty={setDirty} onSaved={() => { setDirty(false); reload(); }} />
      )}
    </>
  );
}

function Grid({ date, emps, initial, locked, canWrite, all, monthText, onDirty, onSaved }: {
  date: string; emps: Emp[]; initial: Rows; locked: boolean; canWrite: boolean; all: boolean; monthText: string;
  onDirty: (d: boolean) => void; onSaved: () => void;
}) {
  const { settings, toast, confirmDialog } = useApp();
  const editable = canWrite && !locked;
  const std = String(settings.standard_hours);
  // per employee: in all-companies mode each employee follows their own company's settings, lock and permissions
  const canEdit = (e: Emp) => (all ? !!e.can_write && !e.locked : editable);
  const stdOf = (e: Emp) => (all && e.standard_hours != null ? String(e.standard_hours) : std);
  const otSettings = (e: Emp) => (all && e.ot_multiplier != null ? { ot_multiplier: e.ot_multiplier, ot_day_hours: e.ot_day_hours ?? settings.ot_day_hours } : settings);
  const anyEditable = all ? emps.some(canEdit) : editable;
  const lockedCompanies = [...new Set(emps.filter((e) => e.locked).map((e) => e.company_code))];
  // Fridays default to Weekend for anyone not yet marked (still needs Save; `initial` stays the stored state)
  const start = useMemo(() => {
    if (!anyEditable || new Date(`${date}T00:00:00`).getDay() !== 5) return initial;
    const editableIds = new Set(emps.filter(canEdit).map((e) => e.id));
    return Object.fromEntries(Object.entries(initial).map(([id, r]) => [id, r.status || !editableIds.has(id) ? r : { ...r, status: 'weekly_off' as const, regular: '0' }])) as Rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, anyEditable, date]);
  const [rows, setRows] = useState<Rows>(start);
  const [saving, setSaving] = useState(false);

  useEffect(() => { onDirty(JSON.stringify(rows) !== JSON.stringify(start)); }, [rows, start, onDirty]);

  const patch = (id: string, p: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...p } }));

  function setStatus(id: string, status: AttendanceStatus | '') {
    const std = stdOf(emps.find((x) => x.id === id)!);
    const keepOt = OT_STATUSES.includes(status as AttendanceStatus);
    const ot = keepOt ? { ot: rows[id].ot, hours: rows[id].hours, amount: rows[id].amount, legacy: rows[id].legacy, paid: rows[id].paid } : { ot: false, hours: '', amount: '', legacy: false, paid: false };
    if (status === 'present') patch(id, { status, regular: rows[id].regular && rows[id].regular !== '0' ? rows[id].regular : std, ...ot });
    else patch(id, { status, regular: status ? '0' : '', ...ot });
  }

  async function markAll() {
    const hasExceptions = Object.values(rows).some((r) => (r.status && r.status !== 'present') || r.ot);
    if (hasExceptions && !(await confirmDialog({ title: 'Mark everyone present?', message: 'This will overwrite existing exceptions and overtime for this date. Continue?', confirmLabel: 'Overwrite', danger: true }))) return;
    setRows((cur) => ({ ...cur, ...Object.fromEntries(emps.filter(canEdit).map((e) => [e.id, { status: 'present' as const, regular: stdOf(e), ot: false, hours: '', amount: '', legacy: false, paid: false, remarks: rows[e.id].remarks }])) }));
  }

  async function markAllOff() {
    const hasMarks = Object.values(rows).some((r) => r.status && r.status !== 'weekly_off');
    if (hasMarks && !(await confirmDialog({ title: 'Mark everyone weekend?', message: 'This will overwrite existing attendance, overtime and leave for this date. Continue?', confirmLabel: 'Overwrite', danger: true }))) return;
    setRows((cur) => ({ ...cur, ...Object.fromEntries(emps.filter(canEdit).map((e) => [e.id, { status: 'weekly_off' as const, regular: '0', ot: false, hours: '', amount: '', legacy: false, paid: false, remarks: rows[e.id].remarks }])) }));
  }

  const totals = useMemo(() => {
    const c: Record<string, number> = {}; let otPaid = 0; let otUnpaid = 0; let unmarked = 0;
    for (const [id, r] of Object.entries(rows)) {
      if (!r.status) { unmarked++; continue; }
      c[r.status] = (c[r.status] ?? 0) + 1;
      if (r.ot) {
        const emp = emps.find((x) => x.id === id);
        const amt = r.legacy ? Number(r.amount) || 0 : (Number(r.hours) || 0) * (emp ? otHourlyRate(emp, date, otSettings(emp)) : 0);
        if (r.paid) otPaid += amt; else otUnpaid += amt;
      }
    }
    return { c, otPaid, otUnpaid, unmarked };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, emps, date, settings]);

  async function save() {
    const changed: object[] = [];
    for (const e of emps) {
      const r = rows[e.id], o = initial[e.id];
      if (!r.status || JSON.stringify(r) === JSON.stringify(o) || !canEdit(e)) continue;
      const regular = r.status === 'present' ? Number(r.regular || stdOf(e)) : 0;
      const hours = r.ot && !r.legacy ? Number(r.hours || 0) : 0, amount = r.ot && r.legacy ? Number(r.amount || 0) : 0;
      if (r.ot && !OT_STATUSES.includes(r.status)) return toast(`${e.name}: overtime can only be entered for Present, Holiday or Weekend`, true);
      if (r.ot && !r.legacy && !(hours > 0)) return toast(`${e.name}: enter the OT hours`, true);
      if (hours > 16) return toast(`${e.name}: OT hours cannot be more than 16`, true);
      if (r.ot && r.legacy && !(amount > 0)) return toast(`${e.name}: enter the OT amount`, true);
      if (amount > 99999) return toast(`${e.name}: OT amount out of range`, true);
      // Always send the OT fields: a bulk upsert fills keys missing from some rows with NULL, which violates NOT NULL
      changed.push({ employee_id: e.id, work_date: date, status: r.status, regular_hours: regular, ot_hours: hours, ot_amount: amount, ot_paid: r.ot && r.paid, remarks: r.remarks.trim() });
    }
    if (!changed.length) return toast('No changes to save');
    setSaving(true);
    const { error } = all
      ? await supabase().rpc('save_attendance_all', { p_rows: changed })
      : await supabase().from('attendance').upsert(changed, { onConflict: 'employee_id,work_date' });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(`Attendance saved for ${fmtDate(date)} (${changed.length} updated)` + (totals.unmarked ? ` — ${totals.unmarked} still unmarked` : ''));
    onSaved();
  }

  return (
    <>
      {all && lockedCompanies.length > 0 && <div className="banner warn">Payroll for {monthText} is approved for {lockedCompanies.join(', ')}. Those employees are locked — reopen the payroll period to edit.</div>}
      {locked && <div className="banner warn">Payroll for {monthText} is approved. Attendance is locked — reopen the payroll period to edit.</div>}
      <div className="stats compact">
        <div className="stat-card"><div className="stat-label">Present</div><div className="stat-number">{totals.c.present ?? 0} <span className="muted" style={{ fontSize: 13 }}>/ {emps.length}</span></div></div>
        <div className="stat-card"><div className="stat-label">Absent / Leave</div><div className="stat-number">{(totals.c.absent ?? 0)} <span className="muted" style={{ fontSize: 13 }}>abs · {(totals.c.annual_leave ?? 0) + (totals.c.sick_leave ?? 0) + (totals.c.unpaid_leave ?? 0)} leave</span></div></div>
        <div className="stat-card"><div className="stat-label">Holiday / Weekend</div><div className="stat-number">{(totals.c.holiday ?? 0) + (totals.c.weekly_off ?? 0)}</div></div>
        <div className="stat-card"><div className="stat-label">Overtime</div><div className="stat-number">{fmtNum(totals.otUnpaid)} <span className="muted" style={{ fontSize: 13 }}>unpaid</span></div><div className="stat-note">{fmtNum(totals.otPaid)} paid{totals.unmarked ? ` · ${totals.unmarked} not marked` : ''}</div></div>
      </div>

      <div className="panel flush" style={{ overflow: 'clip' }}>
        <div className="panel-head">
          <div className="panel-title">{emps.length} active employees</div>
        </div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Employee</th><th>Status</th><th>Overtime</th><th className="r">OT Hours</th><th className="r">OT Amount</th><th>Paid</th><th>Internal Notes</th></tr></thead>
          <tbody>
            {emps.map((e) => {
              const r = rows[e.id]; const present = r.status === 'present'; const otOk = OT_STATUSES.includes(r.status as AttendanceStatus); 
              return (
                <tr key={e.id}>
                  <td><span className="strong">{e.name}</span><div className="muted" style={{ fontSize: 10 }}>{all && e.company_code ? `${e.company_code} · ` : ''}{e.emp_code} · {e.job_title}</div></td>
                  <td>
                    <Select className="select" style={{ width: 150 }} disabled={!canEdit(e)} value={r.status} onChange={(ev) => setStatus(e.id, ev.target.value as AttendanceStatus | '')}>
                      <option value="">— Not marked —</option>
                      {ATT_STATUSES.map((s) => <option key={s} value={s}>{ATT_LABEL[s]}</option>)}
                    </Select>
                  </td>
                  <td>
                    {otOk && <Select className="select" style={{ width: 150 }} disabled={!canEdit(e)} value={r.ot ? 'ot' : ''} onChange={(ev) => patch(e.id, ev.target.value === 'ot' ? { ot: true } : { ot: false, hours: '', amount: '', legacy: false, paid: false })}>
                      <option value="">No Overtime</option>
                      <option value="ot">Overtime Work</option>
                    </Select>}
                  </td>
                  <td className="r">{r.ot && !r.legacy && <input className="input num" type="text" inputMode="decimal" placeholder="Hours" style={{ width: 80 }} disabled={!canEdit(e)} value={r.hours} onChange={(ev) => { const v = ev.target.value; if (/^[0-9]{0,2}[.]?[0-9]{0,2}$/.test(v)) patch(e.id, { hours: v }); }} />}</td>
                  <td className="r">{r.ot && (r.legacy
                    ? <input className="input num" type="text" inputMode="decimal" placeholder="Amount" disabled={!canEdit(e)} value={r.amount} onChange={(ev) => { const v = ev.target.value; if (/^[0-9]*[.]?[0-9]{0,2}$/.test(v)) patch(e.id, { amount: v }); }} />
                    : <span title={`Rate ${fmtNum(otHourlyRate(e, date, otSettings(e)))} per hour`}>{fmtNum((Number(r.hours) || 0) * otHourlyRate(e, date, otSettings(e)))}</span>)}</td>
                  <td>
                    {r.ot && <Select className="select" style={{ width: 130 }} disabled={!canEdit(e)} value={r.paid ? 'paid' : 'unpaid'} onChange={(ev) => patch(e.id, { paid: ev.target.value === 'paid' })}>
                      <option value="unpaid">Not Paid</option>
                      <option value="paid">Paid</option>
                    </Select>}
                  </td>
                  <td><input className="input" disabled={!canEdit(e)} value={r.remarks} onChange={(ev) => patch(e.id, { remarks: ev.target.value })} placeholder="Internal note (optional)" /></td>
                </tr>
              );
            })}
            {emps.length === 0 && <tr><td colSpan={7}><div className="empty">No active employees for this date.</div></td></tr>}
          </tbody>
        </table></div>
        <div className="toolbar action-bar no-print" style={{ position: 'sticky', bottom: 0, zIndex: 5, padding: '14px 22px', background: 'var(--surface-soft)', borderTop: '2px solid var(--border)', boxShadow: '0 -6px 14px rgba(15,23,42,.08)', justifyContent: 'flex-end', borderRadius: '0 0 16px 16px' }}>
          <button className="btn green" disabled={!anyEditable} onClick={markAll}>✓ Mark All Present</button>
          {new Date(`${date}T00:00:00`).getDay() === 5 && <button className="btn" disabled={!anyEditable} onClick={markAllOff}>Mark All Weekend</button>}
          <button className="btn primary" disabled={!anyEditable || saving} onClick={save}>{saving ? 'Saving…' : 'Save Attendance'}</button>
        </div>
      </div>
    </>
  );
}
