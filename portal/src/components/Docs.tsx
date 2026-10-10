'use client';
import { usePaperZoom } from '@/components/usePaperZoom';
import { asset } from '@/lib/supabase';
import { Money, Riyal } from '@/components/Money';
import { ATT_LABEL } from '@/components/ui';
import { fmtDate, fmtNum, addDays, monthEnd, monthStart, periodLabel } from '@/lib/format';
import type { AttendanceRow, Employee, PayrollEntry, PayrollPeriod, QuotationItem, QuotationRevision, SalarySlip, Settings } from '@/lib/types';

export function DocHead({ co, right }: { co: Settings['company']; right?: React.ReactNode }) {
  return (
    <div className="doc-head">
      {co.logo ? <img src={asset(co.logo)} alt={co.name} /> : <div className="doc-logo-text">{co.name}</div>}
      <div className="doc-co">
        {right ?? (
          <>
            <b>{co.name}</b><br />
            {co.address && <>{co.address}<br /></>}
            {co.phone && <>Tel: {co.phone}<br /></>}
            {co.email && <>{co.email}<br /></>}
            {co.cr_no && <>CR: {co.cr_no}<br /></>}
            {co.vat_no && <>VAT No: {co.vat_no}</>}
          </>
        )}
      </div>
    </div>
  );
}

export type SlipFull = SalarySlip & { employees: Employee; payroll_periods: PayrollPeriod; payroll_entries: PayrollEntry };

/** First and last date of the pay period (falls back to the calendar month). */
export function slipRange(p: PayrollPeriod): [string, string] {
  return [p.start_date ?? monthStart(p.year, p.month), p.end_date ?? monthEnd(p.year, p.month)];
}

/** One-page salary slip: pay breakdown, attendance summary, timecard with internal notes, signatures. */
export function SalarySlipDoc({ slip, co, att = [] }: { slip: SlipFull; co: Settings['company']; att?: AttendanceRow[] }) {
  const e = slip.payroll_entries; const emp = slip.employees; const p = slip.payroll_periods;
  const otPaid = Number(e.ot_paid_amount ?? 0);
  const advance = Number(e.advance_paid ?? 0);
  const gross = Number(e.basic) + Number(e.allowances) + Number(e.ot_amount) + otPaid + Number(e.other_earnings);
  const fit = usePaperZoom();

  const [from, to] = slipRange(p);
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 93; d = addDays(d, 1)) days.push(d);
  const byDate = new Map(att.map((r) => [r.work_date, r]));
  const c = (e.breakdown?.counts ?? {}) as Record<string, number>;
  const n = (k: string) => Number(c[k] ?? 0);
  const leave = n('annual_leave') + n('sick_leave') + n('unpaid_leave');
  const cols = Math.min(4, Math.max(2, Math.ceil(days.length / 17)));
  const per = Math.ceil(days.length / cols);
  const chunks = Array.from({ length: cols }, (_, i) => days.slice(i * per, (i + 1) * per));
  const notes = days.filter((d) => byDate.get(d)?.remarks?.trim());
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="paper slip" ref={fit.ref} style={fit.style}>
      <DocHead co={co} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
        <div><div className="doc-title">SALARY SLIP</div><div style={{ fontSize: 12, fontWeight: 600 }}>{periodLabel(p)}</div></div>
        <div style={{ textAlign: 'right', fontSize: 10, color: '#555' }}>Slip No. {slip.slip_no}</div>
      </div>

      <div className="doc-meta" style={{ gridTemplateColumns: '1fr' }}>
        <div className="doc-box"><div className="l">Employee</div><b style={{ fontSize: 12 }}>{emp.name}</b><br />Employee ID: {emp.emp_code}<br />Job Title: {emp.job_title}</div>
      </div>

      <div className="tc-title">Timecard</div>
      <div className="tc-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {chunks.map((chunk, i) => (
          <table key={i} className="tc">
            <thead><tr><th>Date</th><th>Status</th><th className="r">Overtime</th></tr></thead>
            <tbody>
              {chunk.map((d) => {
                const r = byDate.get(d); const dow = new Date(`${d}T00:00:00`).getDay();
                return (
                  <tr key={d} className={dow === 5 ? 'fri' : ''}>
                    <td>{d.slice(8)} {DOW[dow]}{r?.remarks?.trim() ? <sup> *</sup> : null}</td>
                    <td>{r ? <span className={`att-code ${r.status}`}>{ATT_LABEL[r.status]}</span> : '—'}</td>
                    <td className="r">{Number(r?.ot_amount ?? 0) > 0 ? fmtNum(r!.ot_amount) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      </div>
      <div className="slip-small">* see remarks</div>
      <table className="doc-table slip-summary">
        <thead><tr><th>Days in the pay period</th><th>Days Present</th><th>Holidays / Weekends</th><th>Leave</th><th>Absent</th></tr></thead>
        <tbody><tr><td>{days.length}</td><td>{n('present')}</td><td>{n('holiday') + n('weekly_off')}</td><td>{leave}</td><td>{n('absent')}</td></tr></tbody>
      </table>
      {notes.length > 0 && (
        <div className="tc-notes">
          <b>Remarks</b>
          {notes.map((d) => <div key={d}><span>{fmtDate(d)}</span> {byDate.get(d)!.remarks.trim()}</div>)}
        </div>
      )}

      <div style={{ marginTop: 22 }} />
      <div className="slip-cols">
        <div>
          <table className="doc-table">
            <thead><tr><th>Earnings</th><th className="r">Amount (<Riyal />)</th></tr></thead>
            <tbody>
              <tr><td>Basic Salary</td><td className="r">{fmtNum(e.basic)}</td></tr>
              <tr><td>Allowances</td><td className="r">{fmtNum(e.allowances)}</td></tr>
              {(Number(e.ot_amount) > 0 || otPaid > 0) && <tr>
                <td>Overtime</td>
                <td className="r">{fmtNum(Number(e.ot_amount) + otPaid)}</td></tr>}
              {Number(e.other_earnings) > 0 && <tr><td>Other Earnings</td><td className="r">{fmtNum(e.other_earnings)}</td></tr>}
            </tbody>
            <tfoot><tr><td>Total Earnings</td><td className="r">{fmtNum(gross)}</td></tr></tfoot>
          </table>
        </div>
        <div>
          <table className="doc-table">
            <thead><tr><th>Deductions</th><th className="r">Amount (<Riyal />)</th></tr></thead>
            <tbody>
              <tr><td>Absence / Unpaid Leave — {e.unpaid_days} day(s)</td><td className="r">{fmtNum(e.absence_deduction)}</td></tr>
              {Number(e.other_deductions) > 0 && <tr><td>Other Deductions{e.adjustment_note ? ` — ${e.adjustment_note}` : ''}</td><td className="r">{fmtNum(e.other_deductions)}</td></tr>}
              {otPaid > 0 && <tr><td>Overtime Paid Earlier</td><td className="r">{fmtNum(otPaid)}</td></tr>}
              {advance > 0 && <tr><td>Already Paid (before this slip)</td><td className="r">{fmtNum(advance)}</td></tr>}
            </tbody>
            <tfoot><tr><td>Total Deductions{advance > 0 || otPaid > 0 ? ' & Amount Paid' : ''}</td><td className="r">{fmtNum(Number(e.deductions) + advance + otPaid)}</td></tr></tfoot>
          </table>
        </div>
      </div>
      <div className="doc-totals" style={{ width: '100%' }}><div className="grand"><span>NET PAY</span><span><Money v={e.net_salary} /></span></div></div>

      <div style={{ marginTop: 'auto', paddingTop: 10, fontSize: 10, color: '#444' }}>I acknowledge receipt of the above salary for the stated period.</div>
      <div className="sign-row">
        <div><div className="line" /><div className="cap">Employee Signature</div></div>
        <div><div className="line" /><div className="cap">Date</div></div>
      </div>
      <div className="doc-foot">{co.name} · This is a computer-generated salary slip and is valid only when signed.</div>
    </div>
  );
}

export type QuoteHeader = { number: string; status?: string };

export function QuotationDoc({ number, rev, items, co }: { number: string; rev: QuotationRevision; items: QuotationItem[]; co: Settings['company'] }) {
  const validUntil = addDays(rev.quote_date, rev.validity_days);
  const label = rev.revision > 0 ? `${number}-R${rev.revision}` : number;
  const fit = usePaperZoom();
  return (
    <div className="paper" ref={fit.ref} style={fit.style}>
      <DocHead co={co} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="doc-title">QUOTATION</div>
        <div style={{ textAlign: 'right', fontSize: 10.5 }}><b>{label}</b><br />Date: {fmtDate(rev.quote_date)}</div>
      </div>

      <div className="doc-meta">
        <div className="doc-box"><div className="l">To</div><b style={{ fontSize: 12 }}>{rev.client}</b>{rev.attention && <><br />Attention: {rev.attention}</>}</div>
        <div className="doc-box"><div className="l">Project</div><b>{rev.project || '—'}</b><br />
          {rev.reference && <>Reference: {rev.reference}<br /></>}Valid until: {fmtDate(validUntil)} ({rev.validity_days} days)</div>
      </div>

      <table className="doc-table">
        <thead><tr><th style={{ width: 28 }}>#</th><th>Description</th><th className="r">Qty</th><th>Unit</th><th className="r">Unit Price</th><th className="r">Total</th></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}><td>{i + 1}</td><td className="pre">{it.description}</td><td className="r">{fmtNum(it.qty, Number.isInteger(Number(it.qty)) ? 0 : 2)}</td><td>{it.unit}</td>
              <td className="r">{fmtNum(it.unit_price)}</td><td className="r">{fmtNum(Number(it.qty) * Number(it.unit_price))}</td></tr>
          ))}
        </tbody>
      </table>

      <div className="doc-totals">
        <div><span>Subtotal</span><span>{<Money v={rev.subtotal} />}</span></div>
        {Number(rev.discount) > 0 && <div><span>Discount</span><span>− {<Money v={rev.discount} />}</span></div>}
        <div><span>VAT ({fmtNum(Number(rev.vat_rate) * 100, 0)}%)</span><span>{<Money v={rev.vat_amount} />}</span></div>
        <div className="grand"><span>GRAND TOTAL</span><span>{<Money v={rev.grand_total} />}</span></div>
      </div>

      <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
        {rev.payment_terms && <div><b>Payment Terms:</b> <span className="pre">{rev.payment_terms}</span></div>}
        {rev.delivery && <div><b>Delivery:</b> <span className="pre">{rev.delivery}</span></div>}
        {rev.notes && <div><b>Notes:</b> <span className="pre">{rev.notes}</span></div>}
      </div>

      <div className="sign-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div><div className="line" /><div className="cap">For {co.name}</div></div>
        <div><div className="line" /><div className="cap">Client Acceptance (Signature / Stamp / Date)</div></div>
      </div>
      <div className="doc-foot">{co.name}{co.address ? ` · ${co.address}` : ''}{co.phone ? ` · ${co.phone}` : ''}{co.email ? ` · ${co.email}` : ''}</div>
    </div>
  );
}
