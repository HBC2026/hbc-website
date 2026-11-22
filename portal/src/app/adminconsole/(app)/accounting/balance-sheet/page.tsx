'use client';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ReportHead, ReportTable, useBalances, useChart } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Loading, PageHead } from '@/components/ui';
import { buildBalanceSheet, exportReportXlsx } from '@/lib/accounting';
import { fmtDate, today } from '@/lib/format';

export default function BalanceSheetPage() {
  const { company } = useApp();
  const [asAt, setAsAt] = useState(today());
  const chart = useChart();
  const bals = useBalances(null, asAt);

  const bs = useMemo(() => (chart.data && bals.data ? buildBalanceSheet(chart.data, bals.data) : null), [chart.data, bals.data]);
  const sub = `As at ${fmtDate(asAt)}`;

  return (
    <>
      <PageHead eyebrow="Accounting" title="Balance Sheet" sub="What the company owns, owes and is worth on a date">
        <button className="btn" disabled={!bs} onClick={() => bs && exportReportXlsx(`Balance-Sheet ${asAt}`, company?.name ?? '', 'Balance Sheet', sub, bs.rows)}>⬇ Export Excel</button>
        <button className="btn" onClick={() => window.print()}>⎙ Print</button>
      </PageHead>
      {(chart.error || bals.error) && <ErrorBox error={(chart.error || bals.error)!} />}

      <div className="panel no-print" style={{ marginBottom: 16 }}>
        <div className="toolbar"><span className="muted">As at</span><DatePicker value={asAt} onChange={setAsAt} /></div>
      </div>

      <div className="panel flush">
        <ReportHead title="Balance Sheet" sub={`${sub} · amounts in SAR`} />
        {chart.loading || bals.loading || !bs ? <Loading /> : <ReportTable rows={bs.rows} empty="No balances yet. Enter opening balances and transactions in the Journal." />}
      </div>
    </>
  );
}
