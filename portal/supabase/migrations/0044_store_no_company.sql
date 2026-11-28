-- Store Inventory no longer belongs to a company (same idea as petty cash, 0032).
--
-- One sheet and one list of signed checks, whichever company is selected. A role in ANY company counts:
-- administrator, payroll and attendance can edit; quotations and viewer can read.
-- Existing rows of every company are kept and merged. Photos stay where they are.
--
-- Run once in the SQL editor, after 0043, when deploying the matching portal. The old save function is
-- removed on purpose: a page still open with one company's rows would otherwise delete the others.

create or replace function store_is_staff(p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from company_members
    where user_id = auth.uid()
      and role::text = any (case when p_write then array['administrator', 'payroll', 'attendance']
                                 else array['administrator', 'payroll', 'attendance', 'quotations', 'viewer'] end))
$$;
grant execute on function store_is_staff(boolean) to authenticated;

-- ---------------------------------------------------------------- policies that mentioned the company (before the columns)
drop policy if exists store_items_read on store_items;
drop policy if exists store_checks_read on store_checks;
drop policy if exists store_photos_read on storage.objects;
drop policy if exists store_photos_insert on storage.objects;
drop policy if exists store_photos_delete on storage.objects;

-- ---------------------------------------------------------------- merge: one running order, each company's rows together
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'store_items' and column_name = 'company_id') then
    update store_items s set sort_order = o.n
    from (select i.id, (row_number() over (order by c.created_at, c.id, i.sort_order, i.updated_at, i.id) - 1)::int as n
          from store_items i join companies c on c.id = i.company_id) o
    where o.id = s.id;
  end if;
end $$;

alter table store_items  drop column if exists company_id;   -- also drops the indexes that included it
alter table store_checks drop column if exists company_id;
create index if not exists store_items_order_idx on store_items (sort_order);
create index if not exists store_checks_created_idx on store_checks (created_at desc);

-- no direct insert/update/delete: all writes go through store_save_all() below
create policy store_items_read on store_items for select to authenticated using (store_is_staff(false));
create policy store_checks_read on store_checks for select to authenticated using (store_is_staff(false));

-- photos: object path is still {company_id}/{file}, but the folder no longer decides who may open it
create policy store_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'store-photos' and store_is_staff(false));
create policy store_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'store-photos' and store_is_staff(true));
create policy store_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'store-photos' and store_is_staff(true));

-- ---------------------------------------------------------------- save the whole sheet and the sign-off
drop function if exists store_save(jsonb, text, date, text);

-- Only the rows named in p_removed are deleted: an item someone else added after this sheet was loaded stays,
-- and a row someone else already deleted is not brought back. Returns the storage paths that are no longer used.
create or replace function store_save_all(p_rows jsonb, p_removed uuid[], p_checker text, p_date date, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old text[];
  v_keep uuid[] := '{}';
  v_id uuid;
  r jsonb;
  n int := 0;
begin
  if not store_is_staff(true) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  perform require_company();   -- the audit entry is written to the selected company's log
  if btrim(coalesce(p_checker, '')) = '' then raise exception 'Enter the name of the inventory checker.'; end if;
  if p_date is null then raise exception 'Enter the date.'; end if;
  if p_signature is null or p_signature not like 'data:image/png;base64,%' then raise exception 'Sign before saving.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Invalid sheet.'; end if;

  select coalesce(array_agg(attachment) filter (where attachment is not null), '{}') into v_old from store_items;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if btrim(coalesce(r ->> 'item', '')) = '' then raise exception 'Row % has no item name.', n + 1; end if;
    if v_id is not null then
      update store_items set item = btrim(r ->> 'item'), purchase_date = nullif(r ->> 'purchase_date', '')::date,
        useful_life_years = nullif(r ->> 'useful_life_years', '')::numeric, decommission_date = nullif(r ->> 'decommission_date', '')::date,
        warranty = btrim(coalesce(r ->> 'warranty', '')), location = btrim(coalesce(r ->> 'location', '')),
        qty = coalesce(nullif(r ->> 'qty', '')::numeric, 0), condition = coalesce(nullif(r ->> 'condition', ''), 'Good'),
        status = coalesce(nullif(r ->> 'status', ''), 'In store'), attachment = nullif(r ->> 'attachment', ''),
        sort_order = n, updated_at = now()
      where id = v_id;
      if not found then continue; end if;
    else
      insert into store_items (item, purchase_date, useful_life_years, decommission_date, warranty, location, qty, condition, status, attachment, sort_order)
      values (btrim(r ->> 'item'), nullif(r ->> 'purchase_date', '')::date, nullif(r ->> 'useful_life_years', '')::numeric, nullif(r ->> 'decommission_date', '')::date, btrim(coalesce(r ->> 'warranty', '')), btrim(coalesce(r ->> 'location', '')), coalesce(nullif(r ->> 'qty', '')::numeric, 0),
              coalesce(nullif(r ->> 'condition', ''), 'Good'), coalesce(nullif(r ->> 'status', ''), 'In store'),
              nullif(r ->> 'attachment', ''), n)
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
    n := n + 1;
  end loop;

  delete from store_items where id = any (coalesce(p_removed, '{}')) and id <> all (v_keep);

  -- items this sheet did not have go after it, in the order they were in
  update store_items s set sort_order = n + o.k
  from (select id, (row_number() over (order by sort_order, updated_at, id) - 1)::int as k
        from store_items where id <> all (v_keep)) o
  where o.id = s.id;

  insert into store_checks (checker_name, check_date, signature, row_count, snapshot)
  values (btrim(p_checker), p_date, p_signature, n,
          (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'purchase_date', purchase_date, 'useful_life_years', useful_life_years, 'decommission_date', decommission_date, 'warranty', warranty, 'location', location, 'qty', qty, 'condition', condition,
                                                        'status', status, 'attachment', attachment) order by sort_order), '[]'::jsonb)
           from store_items where id = any (v_keep)));

  perform log_audit('store.saved', 'store', null, btrim(p_checker) || ' · ' || to_char(p_date, 'DD Mon YYYY'), null,
    jsonb_build_object('rows', n));

  return to_jsonb(coalesce((select array_agg(a) from unnest(v_old) a
                            where a not in (select attachment from store_items where attachment is not null)), '{}'));
end $$;
-- ---------------------------------------------------------------- add one item straight away (phone form)
create or replace function store_add_item(p_item jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not store_is_staff(true) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  perform require_company();   -- the audit entry is written to the selected company's log
  if btrim(coalesce(p_item ->> 'item', '')) = '' then raise exception 'Enter the item name.'; end if;

  insert into store_items (item, purchase_date, useful_life_years, warranty, location, qty, condition, status, attachment, sort_order)
  values (btrim(p_item ->> 'item'), nullif(p_item ->> 'purchase_date', '')::date, nullif(p_item ->> 'useful_life_years', '')::numeric,
          btrim(coalesce(p_item ->> 'warranty', '')), btrim(coalesce(p_item ->> 'location', '')),
          coalesce(nullif(p_item ->> 'qty', '')::numeric, 1), coalesce(nullif(p_item ->> 'condition', ''), 'Good'),
          coalesce(nullif(p_item ->> 'status', ''), 'In store'), nullif(p_item ->> 'attachment', ''),
          (select coalesce(max(sort_order) + 1, 0) from store_items))
  returning id into v_id;

  perform log_audit('store.item_added', 'store', v_id::text, btrim(p_item ->> 'item'), null, p_item - 'attachment');
  return v_id;
end $$;

revoke all on function store_add_item(jsonb) from public, anon;
grant execute on function store_add_item(jsonb) to authenticated;
revoke all on function store_save_all(jsonb, uuid[], text, date, text) from public, anon;
revoke all on function store_is_staff(boolean) from public, anon;
grant execute on function store_save_all(jsonb, uuid[], text, date, text) to authenticated;
