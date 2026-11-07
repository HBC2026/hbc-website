'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useBalances, useChart } from '@/components/AccountingBits';
import { ErrorBox, Loading, PageHead, StatCard } from '@/components/ui';
import { buildPnl, natural } from '@/lib/accounting';

export default function AccountingOverview() {
  const { company } = useApp();
  const year = new Date().getFullYear();
  const chart = useChart();
  const ytd = useBalances(`${year}-01-01`, `${year}-12-31`);
  const all = useBalances(null, null);

  const k = useMemo(() => {
    if (!chart.data || !ytd.data || !all.data) return null;
    const pnl = buildPnl(chart.data, ytd.data);
    const bm = new Map(all.data.map((b) => [b.account_id, b]));
    const sum = (f: (code: string) => boolean) => chart.data!.filter((a) => f(a.code)).reduce((s, a) => s + natural(a.type, bm.get(a.id)?.debit ?? 0, bm.get(a.id)?.credit ?? 0), 0);
    return { pnl, cash: sum((c) => c.startsWith('10')), ar: sum((c) => c === '1100' || c === '1150'), ap: sum((c) => c === '2000') };
  }, [chart.data, ytd.data, all.data]);

  const err = chart.error || ytd.error || all.error;
  const posted = (all.data?.length ?? 0) > 0;

  return (
    <>
      <PageHead eyebrow="Accounting" title="Accounting" sub={`${company?.name} · year to date ${year}`} />
      {err && <ErrorBox error={err} />}
      {chart.loading || ytd.loading || all.loading || !k ? <Loading /> : (
        <>
          <div className="stats">
            <StatCard label="Revenue (YTD)" icon="＋" value={<Money v={k.pnl.revenue} />} href="/adminconsole/accounting/profit-loss" />
            <StatCard label="Costs & expenses (YTD)" icon="−" value={<Money v={k.pnl.expenses} />} href="/adminconsole/accounting/profit-loss" />
            <StatCard label="Net profit (YTD)" icon="↗" value={<span style={{ color: k.pnl.netProfit < 0 ? 'var(--red)' : undefined }}><Money v={k.pnl.netProfit} /></span>} href="/adminconsole/accounting/profit-loss" />
            <StatCard label="Cash & bank" icon="◉" value={<Money v={k.cash} />} href="/adminconsole/accounting/balance-sheet" />
          </div>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <StatCard label="Owed to us (receivables)" icon="▤" value={<Money v={k.ar} />} />
            <StatCard label="We owe (payables)" icon="▧" value={<Money v={k.ap} />} />
          </div>
          {!posted && (
            <div className="panel">
              <div className="panel-title">Getting started</div>
              <ol style={{ lineHeight: 1.9, paddingLeft: 18, fontSize: 13 }}>
                <li>Review the <Link href="/adminconsole/accounting/accounts" className="strong">Chart of Accounts</Link> (a construction-company chart is already set up).</li>
                <li>In the <Link href="/adminconsole/accounting/journal" className="strong">Journal</Link>, post one <em>Journal entry</em> for your opening balances: debit what you own (bank, receivables, equipment), credit what you owe, and credit the difference to Owners’ Capital.</li>
                <li>From then on use <em>Money received</em> and <em>Payment</em> for day-to-day transactions.</li>
                <li>Open <Link href="/adminconsole/accounting/profit-loss" className="strong">Profit &amp; Loss</Link> and <Link href="/adminconsole/accounting/balance-sheet" className="strong">Balance Sheet</Link> any time.</li>
              </ol>
            </div>
          )}
        </>
      )}
    </>
  );
}
