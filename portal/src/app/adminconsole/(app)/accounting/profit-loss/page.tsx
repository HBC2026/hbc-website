'use client';
import { useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { ReportHead, ReportTable, useBalances, useChart } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Loading, PageHead, Select, StatCard } from '@/components/ui';
import { buildPnl, exportReportXlsx } from '@/lib/accounting';
import { fmtDate, monthEnd, monthStart } from '@/lib/format';

type Preset = 'month' | 'quarter' | 'year' | 'lastyear' | 'custom';

function range(p: Preset): [string, string] {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  if (p === 'month') return [monthStart(y, m), monthEnd(y, m)];
  if (p === 'quarter') { const q = Math.floor((m - 1) / 3) * 3 + 1; return [monthStart(y, q), monthEnd(y, q + 2)]; }
  if (p === 'lastyear') return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  return [`${y}-01-01`, `${y}-12-31`];
}

export default function ProfitLossPage() {
  const { company } = useApp();
  const [preset, setPreset] = useState<Preset>('year');
  const [from, setFrom] = useState(range('year')[0]);
  const [to, setTo] = useState(range('year')[1]);
  const chart = useChart();
  const bals = useBalances(from, to);

  function pick(p: Preset) {
    setPreset(p);
    if (p !== 'custom') { const [f, t] = range(p); setFrom(f); setTo(t); }
  }

  const pnl = useMemo(() => (chart.data && bals.data ? buildPnl(chart.data, bals.data) : null), [chart.data, bals.data]);
  const sub = `${fmtDate(from)} – ${fmtDate(to)}`;
  const margin = pnl && pnl.revenue ? Math.round((pnl.netProfit / pnl.revenue) * 1000) / 10 : 0;

  return (
    <>
      <PageHead eyebrow="Accounting" title="Profit & Loss" sub="Income less costs and expenses for a period">
        <button className="btn" disabled={!pnl} onClick={() => pnl && exportReportXlsx(`Profit-Loss ${from} to ${to}`, company?.name ?? '', 'Profit & Loss', sub, pnl.rows)}>⬇ Export Excel</button>
        <button className="btn" onClick={() => window.print()}>⎙ Print</button>
      </PageHead>
      {(chart.error || bals.error) && <ErrorBox error={(chart.error || bals.error)!} />}

      <div className="panel no-print" style={{ marginBottom: 16 }}>
        <div className="toolbar">
          <Select value={preset} onChange={(e) => pick(e.target.value as Preset)}>
            <option value="month">This month</option>
            <option value="quarter">This quarter</option>
            <option value="year">This year</option>
            <option value="lastyear">Last year</option>
            <option value="custom">Custom dates</option>
          </Select>
          <DatePicker value={from} onChange={(v) => { setFrom(v); setPreset('custom'); }} />
          <span className="muted">to</span>
          <DatePicker value={to} onChange={(v) => { setTo(v); setPreset('custom'); }} />
        </div>
      </div>

      {pnl && (
        <div className="stats no-print">
          <StatCard label="Revenue" icon="＋" value={<Money v={pnl.revenue} />} />
          <StatCard label="Costs & expenses" icon="−" value={<Money v={pnl.expenses} />} />
          <StatCard label="Gross profit" icon="◔" value={<Money v={pnl.grossProfit} />} />
          <StatCard label="Net profit" icon="↗" value={<span style={{ color: pnl.netProfit < 0 ? 'var(--red)' : undefined }}><Money v={pnl.netProfit} /></span>} note={`${margin}% margin`} />
        </div>
      )}

      <div className="panel flush">
        <ReportHead title="Profit & Loss Statement" sub={`For the period ${sub} · amounts in SAR`} />
        {chart.loading || bals.loading || !pnl ? <Loading /> : <ReportTable rows={pnl.rows} empty="No income or expense entries in this period yet. Post them in the Journal." />}
      </div>
    </>
  );
}
