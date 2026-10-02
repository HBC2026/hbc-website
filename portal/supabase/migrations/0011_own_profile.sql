-- Let a signed-in user change their own display name (and nothing else on their profile).
create or replace function update_own_profile(p_full_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if length(btrim(coalesce(p_full_name, ''))) = 0 then raise exception 'Name is required'; end if;
  update profiles set full_name = btrim(p_full_name) where id = auth.uid();
end $$;
revoke all on function update_own_profile(text) from public;
grant execute on function update_own_profile(text) to authenticated;
