'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useQuery } from '@/lib/hooks';
import { supabase, unwrap } from '@/lib/supabase';
import { can } from '@/lib/roles';
import type { Acc, Bal, ReportRow } from '@/lib/accounting';

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
