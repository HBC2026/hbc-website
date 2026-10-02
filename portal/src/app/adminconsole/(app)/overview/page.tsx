'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, OPEN_QUOTE, PageHead, StatCard } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { monthLabel } from '@/lib/format';
import { PAYROLL_SIDE, PETTY_SIDE, QUOTE_SIDE } from '@/lib/roles';
import { fetchAll, supabase, supabaseFor, unwrap } from '@/lib/supabase';
import type { Company, PayrollPeriod, PcSummaryRow, QuotationStatus, Role } from '@/lib/types';

interface Row {
  company: Company; role: Role;
  quotes: { open: number; openValue: number; approved: number; approvedValue: number } | null;
  petty: { given: number; spent: number; balance: number; review: number } | null;
  payroll: { processed: number; processedTotal: number; pending: { label: string; status: string; net: number }[]; pendingTotal: number } | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function AllCompanies() {
  const { companies, switchCompany } = useApp();
  const go = (id: string, to: string) => ({ className: 'click', title: 'Open in this company', onClick: () => switchCompany(id, to) });
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { data, error, loading } = useQuery(async () => {
    const me = unwrap(await supabase().auth.getUser() as never) as { user: { id: string } };
    const mem = unwrap(await supabase().from('company_members').select('company_id, role').eq('user_id', me.user.id)) as { company_id: string; role: Role }[];
    const roles = new Map(mem.map((m) => [m.company_id, m.role]));

    return Promise.all(companies.map(async (company): Promise<Row> => {
      const role = roles.get(company.id) ?? 'viewer';
      const sb = supabaseFor(company.id);
      const row: Row = { company, role, quotes: null, petty: null, payroll: null };

      if (QUOTE_SIDE.includes(role)) {
        const q = unwrap(await sb.from('quotations').select('status, amount')) as { status: QuotationStatus; amount: number }[];
        const open = q.filter((x) => OPEN_QUOTE.includes(x.status));
        const appr = q.filter((x) => x.status === 'approved');
        row.quotes = {
          open: open.length, openValue: sum(open.map((x) => Number(x.amount))),
          approved: appr.length, approvedValue: sum(appr.map((x) => Number(x.amount))),
        };
      }

      if (PETTY_SIDE.includes(role)) {
        const s = unwrap(await sb.rpc('pc_summary')) as PcSummaryRow[];
        row.petty = {
          given: sum(s.map((x) => Number(x.given))), spent: sum(s.map((x) => Number(x.spent))),
          balance: sum(s.map((x) => Number(x.balance))), review: sum(s.map((x) => x.pending_count)),
        };
      }

      if (PAYROLL_SIDE.includes(role)) {
        const periods = unwrap(await sb.from('payroll_periods').select('*').eq('year', year)) as PayrollPeriod[];
        const net = new Map<string, number>();
        if (periods.length) {
          const ids = periods.map((p) => p.id);
          const entries = await fetchAll<{ period_id: string; net_salary: number }>((f, t) =>
            sb.from('payroll_entries').select('period_id, net_salary').in('period_id', ids).order('id').range(f, t));
          for (const e of entries) net.set(e.period_id, (net.get(e.period_id) ?? 0) + Number(e.net_salary));
        }
        const done = periods.filter((p) => p.status === 'approved' || p.status === 'completed');
        const pend: { label: string; status: string; net: number }[] = periods.filter((p) => p.status === 'open' || p.status === 'calculated').sort((a, b) => a.month - b.month)
          .map((p) => ({ label: monthLabel(p.year, p.month), status: p.status, net: net.get(p.id) ?? 0 }));
        if (!periods.some((p) => p.month === month)) pend.push({ label: monthLabel(year, month), status: 'not started', net: 0 });
        row.payroll = {
          processed: done.length, processedTotal: sum(done.map((p) => net.get(p.id) ?? 0)),
          pending: pend, pendingTotal: sum(pend.map((p) => p.net)),
        };
      }
      return row;
    }));
  }, [companies.map((c) => c.id).join(',')]);

  const rows = data ?? [];
  const tot = {
    openQ: sum(rows.map((r) => r.quotes?.open ?? 0)), openQV: sum(rows.map((r) => r.quotes?.openValue ?? 0)),
    held: sum(rows.map((r) => r.petty?.balance ?? 0)),
    paid: sum(rows.map((r) => r.payroll?.processedTotal ?? 0)),
    pend: sum(rows.map((r) => r.payroll?.pending.length ?? 0)),
  };
  const dash = <span className="muted">—</span>;

  return (
    <>
      <PageHead eyebrow="Group" title="All Companies" sub={`Quotations, petty cash and payroll across every company you can access · ${year}`} />
      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : (
        <>
          <section className="stats">
            <StatCard label="Open Quotations" icon="▤" value={tot.openQ} note={<>Worth <Money v={tot.openQV} dp={0} /></>} />
            <StatCard label="Petty Cash Held" icon="◉" value={<Money v={tot.held} />} note="All companies" />
            <StatCard label={`Payroll Processed ${year}`} icon={<Riyal />} value={<Money v={tot.paid} dp={0} />} note="Approved or completed" />
            <StatCard label="Pending Payroll" icon="◔" value={tot.pend} note="Months not yet approved" />
          </section>

          <div className="panel flush" style={{ marginBottom: 18 }}>
            <div className="panel-head"><div className="panel-title">Quotations</div></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Company</th><th className="r">Open</th><th className="r">Open value</th><th className="r">Approved</th><th className="r">Approved value</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.company.id} {...go(r.company.id, '/adminconsole/quotations')}>
                    <td className="strong">{r.company.name}</td>
                    <td className="r">{r.quotes?.open ?? dash}</td>
                    <td className="r">{r.quotes ? <Money v={r.quotes.openValue} dp={0} /> : dash}</td>
                    <td className="r">{r.quotes?.approved ?? dash}</td>
                    <td className="r">{r.quotes ? <Money v={r.quotes.approvedValue} dp={0} /> : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          <div className="panel flush" style={{ marginBottom: 18 }}>
            <div className="panel-head"><div className="panel-title">Petty Cash Balances</div></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Company</th><th className="r">Given</th><th className="r">Receipts</th><th className="r">Balance held</th><th className="r">To review</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.company.id} {...go(r.company.id, '/adminconsole/pettycash')}>
                    <td className="strong">{r.company.name}</td>
                    <td className="r">{r.petty ? <Money v={r.petty.given} /> : dash}</td>
                    <td className="r">{r.petty ? <Money v={r.petty.spent} /> : dash}</td>
                    <td className="r">{r.petty ? <strong style={{ color: r.petty.balance < 0 ? 'var(--red)' : undefined }}><Money v={r.petty.balance} /></strong> : dash}</td>
                    <td className="r">{r.petty?.review ?? dash}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          <div className="panel flush">
            <div className="panel-head"><div className="panel-title">Payroll {year}</div></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Company</th><th className="r">Months processed</th><th className="r">Net processed</th><th>Pending</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.company.id} {...go(r.company.id, '/adminconsole/payroll')}>
                    <td className="strong">{r.company.name}</td>
                    <td className="r">{r.payroll?.processed ?? dash}</td>
                    <td className="r">{r.payroll ? <Money v={r.payroll.processedTotal} dp={0} /> : dash}</td>
                    <td>{r.payroll ? (r.payroll.pending.length
                      ? r.payroll.pending.map((p) => <div key={p.label}>{p.label} <span className="muted">· {p.status}{p.net ? <> · <Money v={p.net} dp={0} /></> : null}</span></div>)
                      : <span className="muted">Nothing pending</span>) : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
          <div className="footer-note">Figures only include the sections your role in each company allows. <Link href="/adminconsole">Back to dashboard</Link></div>
        </>
      )}
    </>
  );
}
