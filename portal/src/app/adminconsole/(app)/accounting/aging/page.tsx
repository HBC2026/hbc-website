'use client';
import { useEffect, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { loadDocs, ReportHead, useParties } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Loading, PageHead, Tabs } from '@/components/ui';
import { AGE_LABELS, aging, type DocKind } from '@/lib/accounting';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';

export default function AgingPage() {
  const { company } = useApp();
  const [side, setSide] = useState<DocKind>('invoice');
  const [asAt, setAsAt] = useState(today());
  // the Bills page links here with ?side=bill
  useEffect(() => { if (new URLSearchParams(window.location.search).get('side') === 'bill') setSide('bill'); }, []);

  const parties = useParties(side);
  const docs = useQuery(() => loadDocs(side, asAt), [company?.id, side, asAt]);
  const report = useMemo(() => aging(docs.data ?? [], asAt), [docs.data, asAt]);
  const names = useMemo(() => new Map((parties.data ?? []).map((p) => [p.id, p.name])), [parties.data]);

  const who = side === 'invoice' ? 'Client' : 'Vendor';
  const title = side === 'invoice' ? 'Receivables Ageing' : 'Payables Ageing';
  const sub = `As at ${fmtDate(asAt)}`;
  const loading = docs.loading || parties.loading;

  async function exportXlsx() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title);
    ws.columns = [{ width: 40 }, ...AGE_LABELS.map(() => ({ width: 15 })), { width: 16 }];
    ws.addRow([company?.name ?? '']).font = { bold: true, size: 14 };
    ws.addRow([title]).font = { bold: true, size: 12 };
    ws.addRow([sub]);
    ws.addRow([]);
    ws.addRow([who, ...AGE_LABELS, 'Total']).font = { bold: true };
    for (const r of report.rows) ws.addRow([names.get(r.party_id) ?? '', ...r.buckets, r.total]);
    ws.addRow(['Total', ...report.buckets, report.total]).font = { bold: true };
    for (let c = 2; c <= AGE_LABELS.length + 2; c++) ws.getColumn(c).numFmt = '#,##0.00';
    const url = URL.createObjectURL(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${title.replace(' ', '-')} ${asAt}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHead eyebrow="Accounting" title="Ageing" sub="Unpaid invoices and bills by how long they are overdue">
        <button className="btn" disabled={loading || report.rows.length === 0} onClick={exportXlsx}>⬇ Export Excel</button>
        <button className="btn" onClick={() => window.print()}>⎙ Print</button>
      </PageHead>
      {(docs.error || parties.error) && <ErrorBox error={(docs.error || parties.error)!} />}

      <Tabs<DocKind> value={side} onChange={setSide} tabs={[['invoice', 'Owed to us'], ['bill', 'We owe']]} />
      <div className="panel no-print" style={{ marginBottom: 16 }}>
        <div className="toolbar"><span className="muted">As at</span><DatePicker value={asAt} onChange={setAsAt} /></div>
      </div>

      <div className="panel flush">
        <ReportHead title={title} sub={`${sub} · amounts in SAR`} />
        {loading ? <Loading /> : report.rows.length === 0 ? <div className="empty">Nothing is owed on this date.</div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{who}</th>{AGE_LABELS.map((l) => <th key={l} className="r">{l}</th>)}<th className="r">Total</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.party_id}>
                  <td data-label={who} className="strong">{names.get(r.party_id) ?? '—'}</td>
                  {r.buckets.map((v, i) => <td key={i} data-label={AGE_LABELS[i]} className="r">{v ? <Money v={v} /> : <span className="muted">—</span>}</td>)}
                  <td data-label="Total" className="r"><strong><Money v={r.total} /></strong></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td data-label={who} className="strong">Total</td>
              {report.buckets.map((v, i) => <td key={i} data-label={AGE_LABELS[i]} className="r"><Money v={v} /></td>)}
              <td data-label="Total" className="r"><Money v={report.total} /></td>
            </tr></tfoot>
          </table></div>
        )}
      </div>
    </>
  );
}
