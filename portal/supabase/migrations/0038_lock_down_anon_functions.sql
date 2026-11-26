-- Defence in depth: the public (anonymous) API key must not be able to call any database function
-- except the four petty-cash functions that employees use through their private link.
--
-- PostgreSQL (and Supabase's default privileges) lets everyone execute a new function unless it is
-- revoked. Most functions already refuse an anonymous caller internally (has_role / require_company),
-- but this closes the door at the source instead of relying on every function body being right.
--
-- Signed-in users keep exactly the access they have today: whatever `authenticated` can execute now
-- is granted to it explicitly before the broad PUBLIC grant is removed.

do $$
declare
  f record;
  keep_anon text[] := array['pc_statement', 'pc_add_receipt', 'pc_delete_receipt', 'pc_token_valid'];
begin
  for f in
    select p.oid, p.oid::regprocedure as sig, p.proname,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_can
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')   -- skip extension functions
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth_can then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if f.proname = any (keep_anon) then execute format('grant execute on function %s to anon', f.sig); end if;
  end loop;
end $$;

-- functions created in future migrations are not callable by anonymous users unless granted on purpose
alter default privileges in schema public revoke execute on functions from public, anon;
