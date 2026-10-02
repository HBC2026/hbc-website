import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anon);

let client: SupabaseClient | undefined;

const COMPANY_KEY = 'hbc-company';
let companyId: string | null = null;

/** The company the portal is currently showing. Sent to Supabase as the x-company-id header. */
export function getCompanyId(): string | null {
  if (companyId === null) {
    try { companyId = localStorage.getItem(COMPANY_KEY); } catch { /* storage unavailable */ }
  }
  return companyId;
}

export function setCompanyId(id: string | null) {
  companyId = id;
  try { if (id) localStorage.setItem(COMPANY_KEY, id); else localStorage.removeItem(COMPANY_KEY); } catch { /* ignore */ }
}

/** fetch wrapper that adds the company header; the database only honours it for companies the user belongs to. */
const companyFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const id = getCompanyId();
  if (id) headers.set('x-company-id', id);
  return fetch(input, { ...init, headers });
};

/** Browser client using the public anon key. All access is governed by RLS. */
export function supabase(): SupabaseClient {
  client ??= createBrowserClient(url!, anon!, { global: { fetch: companyFetch } });
  return client;
}

/** A separate client pinned to one company (same login), for screens that read several companies at once. */
export function supabaseFor(id: string): SupabaseClient {
  const pinned: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-company-id', id);
    return fetch(input, { ...init, headers });
  };
  return createBrowserClient(url!, anon!, { isSingleton: false, global: { fetch: pinned } });
}

export const BASE_PATH = ''; // portal is served at /adminconsole by its routes, not a Next basePath
/** URL for a file in /public (plain <img> tags do not get the basePath automatically). */
export const asset = (p: string) => `${BASE_PATH}${p}`;

export const SIGNED_BUCKET = 'signed-salary-slips';
export const PETTY_BUCKET = 'petty-cash-receipts';

/** Throws a readable Error when a Supabase response contains an error. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** Fetches every row of a query, paging past PostgREST's 1000-row default limit. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = unwrap(await build(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
