'use client';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ATT_LABEL, ATT_STATUSES, ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { addDays, fmtDate, hrs, monthLabel, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { AttendanceRow, AttendanceStatus, Employee } from '@/lib/types';

interface Row { status: AttendanceStatus | ''; regular: string; ot: string; remarks: string }
type Rows = Record<string, Row>;

function buildRows(emps: Employee[], existing: AttendanceRow[]): Rows {
  const by = new Map(existing.map((r) => [r.employee_id, r]));
  const out: Rows = {};
  for (const e of emps) {
    const r = by.get(e.id);
    out[e.id] = r
      ? { status: r.status, regular: String(Number(r.regular_hours)), ot: String(Number(r.ot_hours)), remarks: r.remarks }
      : { status: '', regular: '', ot: '', remarks: '' };
  }
  return out;
}

export default function DailyAttendance() {
  const { profile, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'attendance:write');
  const sb = supabase();
  const [date, setDate] = useState(today());
  const [dirty, setDirty] = useState(false);
  const [year, month] = date.split('-').map(Number);

  const { data, error, loading, reload } = useQuery(async () => {
    const [emps, att, period] = await Promise.all([
      sb.from('employees').select('*').eq('status', 'active').lte('joining_date', date).order('emp_code'),
      sb.from('attendance').select('*').eq('work_date', date),
      sb.from('payroll_periods').select('status').eq('year', year).eq('month', month).maybeSingle(),
    ]);
    return {
      emps: unwrap(emps) as Employee[], att: unwrap(att) as AttendanceRow[],
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
      <PageHead eyebrow="Payroll" title="Daily Attendance" sub="Mark everyone present, then change only the exceptions and enter overtime." />
      <div className="toolbar no-print" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => changeDate(addDays(date, -1))}>←</button>
        <input className="input" type="date" value={date} onChange={(e) => changeDate(e.target.value)} />
        <button className="btn" onClick={() => changeDate(addDays(date, 1))}>→</button>
        <button className="btn" onClick={() => changeDate(today())}>Today</button>
        <span className="muted">{fmtDate(date)}</span>
      </div>
      {error && <ErrorBox error={error} />}
      {loading || !data ? <Loading /> : (
        <Grid key={`${date}-${data.at}`} date={date} emps={data.emps} initial={buildRows(data.emps, data.att)}
          locked={data.locked} canWrite={canWrite} monthText={monthLabel(year, month)} onDirty={setDirty} onSaved={() => { setDirty(false); reload(); }} />
      )}
    </>
  );
}

function Grid({ date, emps, initial, locked, canWrite, monthText, onDirty, onSaved }: {
  date: string; emps: Employee[]; initial: Rows; locked: boolean; canWrite: boolean; monthText: string;
  onDirty: (d: boolean) => void; onSaved: () => void;
}) {
  const { settings, toast, confirmDialog } = useApp();
  const [rows, setRows] = useState<Rows>(initial);
  const [saving, setSaving] = useState(false);
  const editable = canWrite && !locked;
  const std = String(settings.standard_hours);

  useEffect(() => { onDirty(JSON.stringify(rows) !== JSON.stringify(initial)); }, [rows, initial, onDirty]);

  const patch = (id: string, p: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...p } }));

  function setStatus(id: string, status: AttendanceStatus | '') {
    if (status === 'present') patch(id, { status, regular: rows[id].regular && rows[id].regular !== '0' ? rows[id].regular : std });
    else patch(id, { status, regular: status ? '0' : '', ot: status ? '0' : '' });
  }

  async function markAll() {
    const hasExceptions = Object.values(rows).some((r) => (r.status && r.status !== 'present') || Number(r.ot) > 0);
    if (hasExceptions && !(await confirmDialog({ title: 'Mark everyone present?', message: 'This will overwrite existing exceptions and overtime for this date. Continue?', confirmLabel: 'Overwrite', danger: true }))) return;
    setRows(Object.fromEntries(emps.map((e) => [e.id, { status: 'present' as const, regular: std, ot: '0', remarks: rows[e.id].remarks }])));
  }

  const totals = useMemo(() => {
    const c: Record<string, number> = {}; let ot = 0; let unmarked = 0;
    for (const r of Object.values(rows)) {
      if (!r.status) { unmarked++; continue; }
      c[r.status] = (c[r.status] ?? 0) + 1; ot += Number(r.ot) || 0;
    }
    return { c, ot, unmarked };
  }, [rows]);

  async function save() {
    const changed: object[] = [];
    for (const e of emps) {
      const r = rows[e.id], o = initial[e.id];
      if (!r.status || JSON.stringify(r) === JSON.stringify(o)) continue;
      const regular = Number(r.regular || 0), ot = Number(r.ot || 0);
      if (regular < 0 || regular > 24 || ot < 0 || ot > 16) return toast(`${e.name}: hours out of range`, true);
      if (ot > 0 && r.status !== 'present') return toast(`${e.name}: overtime can only be entered for Present`, true);
      changed.push({ employee_id: e.id, work_date: date, status: r.status, regular_hours: regular, ot_hours: ot, remarks: r.remarks.trim() });
    }
    if (!changed.length) return toast('No changes to save');
    setSaving(true);
    const { error } = await supabase().from('attendance').upsert(changed, { onConflict: 'employee_id,work_date' });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(`Attendance saved for ${fmtDate(date)} (${changed.length} updated)` + (totals.unmarked ? ` — ${totals.unmarked} still unmarked` : ''));
    onSaved();
  }

  return (
    <>
      {locked && <div className="banner warn">Payroll for {monthText} is approved. Attendance is locked — reopen the payroll period to edit.</div>}
      <div className="stats">
        <div className="stat-card"><div className="stat-label">Present</div><div className="stat-number">{totals.c.present ?? 0} <span className="muted" style={{ fontSize: 13 }}>/ {emps.length}</span></div></div>
        <div className="stat-card"><div className="stat-label">Absent / Leave</div><div className="stat-number">{(totals.c.absent ?? 0)} <span className="muted" style={{ fontSize: 13 }}>abs · {(totals.c.annual_leave ?? 0) + (totals.c.sick_leave ?? 0) + (totals.c.unpaid_leave ?? 0)} leave</span></div></div>
        <div className="stat-card"><div className="stat-label">Holiday / Weekly Off</div><div className="stat-number">{(totals.c.holiday ?? 0) + (totals.c.weekly_off ?? 0)}</div></div>
        <div className="stat-card"><div className="stat-label">Daily OT Total</div><div className="stat-number">{hrs(totals.ot)} hrs</div><div className="stat-note">{totals.unmarked ? `${totals.unmarked} employee(s) not marked` : 'All employees marked'}</div></div>
      </div>

      <div className="panel flush">
        <div className="panel-head">
          <div className="panel-title">{emps.length} active employees</div>
          <div className="toolbar">
            <button className="btn green" disabled={!editable} onClick={markAll}>✓ Mark All Present</button>
            <button className="btn primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save Attendance'}</button>
          </div>
        </div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Employee</th><th>Status</th><th className="r">Regular Hours</th><th className="r">OT Hours</th><th>Remarks</th></tr></thead>
          <tbody>
            {emps.map((e) => {
              const r = rows[e.id]; const present = r.status === 'present';
              return (
                <tr key={e.id}>
                  <td><span className="strong">{e.name}</span><div className="muted" style={{ fontSize: 10 }}>{e.emp_code} · {e.job_title}</div></td>
                  <td>
                    <select className="select" style={{ width: 150 }} disabled={!editable} value={r.status} onChange={(ev) => setStatus(e.id, ev.target.value as AttendanceStatus | '')}>
                      <option value="">— Not marked —</option>
                      {ATT_STATUSES.map((s) => <option key={s} value={s}>{ATT_LABEL[s]}</option>)}
                    </select>
                  </td>
                  <td className="r"><input className="input num" type="number" min="0" max="24" step="0.25" disabled={!editable || !present} value={r.regular} onChange={(ev) => patch(e.id, { regular: ev.target.value })} /></td>
                  <td className="r"><input className="input num" type="number" min="0" max="16" step="0.25" disabled={!editable || !present} value={r.ot} onChange={(ev) => patch(e.id, { ot: ev.target.value })} /></td>
                  <td><input className="input" disabled={!editable} value={r.remarks} onChange={(ev) => patch(e.id, { remarks: ev.target.value })} placeholder="Optional" /></td>
                </tr>
              );
            })}
            {emps.length === 0 && <tr><td colSpan={5}><div className="empty">No active employees for this date.</div></td></tr>}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
