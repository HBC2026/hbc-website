'use client';
import { asset } from '@/lib/supabase';
import { Money, Riyal } from '@/components/Money';
import { fmtDate, fmtNum, hrs, monthLabel, addDays } from '@/lib/format';
import type { Employee, PayrollEntry, PayrollPeriod, QuotationItem, QuotationRevision, SalarySlip, Settings } from '@/lib/types';

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

export function SalarySlipDoc({ slip, co }: { slip: SlipFull; co: Settings['company'] }) {
  const e = slip.payroll_entries; const emp = slip.employees; const p = slip.payroll_periods;
  const gross = Number(e.basic) + Number(e.allowances) + Number(e.ot_amount) + Number(e.other_earnings);
  return (
    <div className="paper">
      <DocHead co={co} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 }}>
        <div><div className="doc-title">SALARY SLIP</div><div style={{ fontSize: 13, fontWeight: 600 }}>{monthLabel(p.year, p.month)}</div></div>
        <div style={{ textAlign: 'right', fontSize: 10, color: '#555' }}>Slip No. {slip.slip_no}</div>
      </div>

      <div className="doc-meta">
        <div className="doc-box"><div className="l">Employee</div><b style={{ fontSize: 13 }}>{emp.name}</b><br />Employee ID: {emp.emp_code}<br />Job Title: {emp.job_title}</div>
        <div className="doc-box"><div className="l">Details</div>Department: {emp.department}<br />Joining Date: {fmtDate(emp.joining_date)}<br />Pay Period: {monthLabel(p.year, p.month)}</div>
      </div>

      <table className="doc-table">
        <thead><tr><th>Earnings</th><th className="r">Amount (<Riyal />)</th></tr></thead>
        <tbody>
          <tr><td>Basic Salary</td><td className="r">{fmtNum(e.basic)}</td></tr>
          <tr><td>Allowances</td><td className="r">{fmtNum(e.allowances)}</td></tr>
          <tr><td>Overtime — {hrs(e.ot_hours)} hours × {<Money v={e.ot_rate} />}</td><td className="r">{fmtNum(e.ot_amount)}</td></tr>
          {Number(e.other_earnings) > 0 && <tr><td>Other Earnings</td><td className="r">{fmtNum(e.other_earnings)}</td></tr>}
        </tbody>
        <tfoot><tr><td>Total Earnings</td><td className="r">{fmtNum(gross)}</td></tr></tfoot>
      </table>

      <table className="doc-table">
        <thead><tr><th>Deductions</th><th className="r">Amount (<Riyal />)</th></tr></thead>
        <tbody>
          <tr><td>Absence / Unpaid Leave — {e.unpaid_days} day(s)</td><td className="r">{fmtNum(e.absence_deduction)}</td></tr>
          {Number(e.other_deductions) > 0 && <tr><td>Other Deductions{e.adjustment_note ? ` — ${e.adjustment_note}` : ''}</td><td className="r">{fmtNum(e.other_deductions)}</td></tr>}
        </tbody>
        <tfoot><tr><td>Total Deductions</td><td className="r">{fmtNum(e.deductions)}</td></tr></tfoot>
      </table>

      <div className="doc-totals"><div className="grand"><span>NET SALARY</span><span>{<Money v={e.net_salary} />}</span></div></div>

      <div style={{ marginTop: 14, fontSize: 10, color: '#555' }}>
        Attendance: {e.present_days} day(s) present · {e.unpaid_days} unpaid day(s) · Regular hours {hrs(e.regular_hours)} · Overtime hours {hrs(e.ot_hours)}
      </div>

      <div style={{ marginTop: 26, fontSize: 10, color: '#444' }}>I acknowledge receipt of the above salary for the stated period.</div>
      <div className="sign-row">
        <div><div className="line" /><div className="cap">Employee Signature: __________________</div></div>
        <div><div className="line" /><div className="cap">Date: __________________</div></div>
        <div><div className="line" /><div className="cap">Authorized Signature: __________________</div></div>
      </div>
      <div className="doc-foot">{co.name} · This is a computer-generated salary slip and is valid only when signed.</div>
    </div>
  );
}

export type QuoteHeader = { number: string; status?: string };

export function QuotationDoc({ number, rev, items, co }: { number: string; rev: QuotationRevision; items: QuotationItem[]; co: Settings['company'] }) {
  const validUntil = addDays(rev.quote_date, rev.validity_days);
  const label = rev.revision > 0 ? `${number}-R${rev.revision}` : number;
  return (
    <div className="paper">
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
