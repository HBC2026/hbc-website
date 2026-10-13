/** Server-side helpers for the /api/jsa routes: caller authorisation through Supabase, using only the public anon key. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Builds a Supabase client that acts AS THE CALLER (their JWT + company header), so row-level security applies exactly as in the browser.
 * No service-role key is involved. Returns a Response when the caller is not an administrator of the selected company.
 */
export async function authorize(req: Request): Promise<{ sb: SupabaseClient } | Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return json({ error: 'Supabase is not configured on the server.' }, 500);
  const auth = req.headers.get('authorization') ?? '';
  const company = req.headers.get('x-company-id') ?? '';
  if (!/^Bearer\s+\S+$/.test(auth) || !company) return json({ error: 'Please sign in again.' }, 401);
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: auth, 'x-company-id': company } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc('jsa_can_use');
  if (error) return json({ error: /jsa_can_use/.test(error.message) ? 'JSA migration 0017 has not been applied to the database yet.' : 'Your session could not be verified. Please sign in again.' }, error.code === 'PGRST202' ? 500 : 401);
  if (data !== true) return json({ error: 'JSA Management is available to administrators only.' }, 403);
  return { sb };
}
