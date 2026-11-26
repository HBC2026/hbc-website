'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useQuery } from '@/lib/hooks';
import { supabase, unwrap } from '@/lib/supabase';
import { can } from '@/lib/roles';
import type { Acc, Bal, ReportRow, Vendor, VendorPayment } from '@/lib/accounting';

/** Loads the company's chart of accounts. An administrator opening a company with none gets the standard chart created. */
export function useChart() {
  const { company, profile } = useApp();
  const sb = supabase();
  const q = useQuery(async () => {
    let accs = unwrap(await sb.from('acc_accounts').select('id, code, name, type, section, is_active').order('code')) as Acc[];
    if (accs.length === 0 && can(profile?.role, 'accounting:write')) {
      unwrap(await sb.rpc('acc_seed_accounts'));
      accs = unwrap(await sb.from('acc_accounts').select('id, code, name, type, section, is_active').order('code')) as Acc[];
    }
    return accs;
  }, [company?.id]);
  return q;
}

export async function loadBalances(from: string | null, to: string | null): Promise<Bal[]> {
  const rows = unwrap(await supabase().rpc('acc_balances', { p_from: from, p_to: to })) as { account_id: string; debit: number | string; credit: number | string }[];
  return rows.map((r) => ({ account_id: r.account_id, debit: Number(r.debit), credit: Number(r.credit) }));
}

/** Re-runs `fn` whenever the company changes; small convenience over useQuery for balances. */
export function useBalances(from: string | null, to: string | null) {
  const { company } = useApp();
  return useQuery(() => loadBalances(from, to), [company?.id, from, to]);
}

export function ReportTable({ rows, empty }: { rows: ReportRow[]; empty?: ReactNode }) {
  if (!rows.some((r) => r.kind === 'line')) return <div className="empty">{empty ?? 'No postings in this period.'}</div>;
  return (
    <table className="rep">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={`rep-${r.kind}`}>
            <td className="rep-code">{r.code ?? ''}</td>
            <td className="rep-label">{r.label}</td>
            <td className="rep-amt">{r.kind === 'section' ? '' : <Money v={r.amount ?? 0} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Print-friendly report heading (shown on screen and on paper). */
export function ReportHead({ title, sub }: { title: string; sub: string }) {
  const { company } = useApp();
  return (
    <div className="rep-head">
      <div className="rep-co">{company?.name}</div>
      <h2>{title}</h2>
      <div className="muted">{sub}</div>
    </div>
  );
}

/** Keeps a value in sync when it is only known after the first render (avoids server/client date mismatch). */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

export function useVendors() {
  const { company } = useApp();
  return useQuery(async () =>
    unwrap(await supabase().from('acc_vendors').select('id, name, phone, vat_no, notes, is_active').order('name')) as Vendor[],
  [company?.id]);
}

/** Every vendor payment, newest first. Read in pages so totals stay right past the API's 1000-row limit. */
export function useVendorPayments() {
  const { company } = useApp();
  return useQuery(async () => {
    const all: VendorPayment[] = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await supabase().from('acc_entries')
        .select('id, entry_no, entry_date, memo, reference, vendor_id, acc_lines(account_id, debit, credit)')
        .not('vendor_id', 'is', null)
        .order('entry_date', { ascending: false }).order('entry_no', { ascending: false })
        .range(from, from + 999)) as VendorPayment[];
      all.push(...page);
      if (page.length < 1000) return all;
    }
  }, [company?.id]);
}
