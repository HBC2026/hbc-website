import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anon);

let client: SupabaseClient | undefined;

/** Browser client using the public anon key. All access is governed by RLS. */
export function supabase(): SupabaseClient {
  client ??= createBrowserClient(url!, anon!);
  return client;
}

export const BASE_PATH = ''; // portal is served at /adminconsole by its routes, not a Next basePath
/** URL for a file in /public (plain <img> tags do not get the basePath automatically). */
export const asset = (p: string) => `${BASE_PATH}${p}`;

export const SIGNED_BUCKET = 'signed-salary-slips';

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
