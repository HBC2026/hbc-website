-- Store Inventory: up to two photos per item.
-- Run once in the SQL editor, after 0045 and BEFORE deploying the matching portal. Safe to run more than once.
-- The portal that is live before the deploy keeps working.

alter table store_items add column if not exists attachment2 text;   -- second object path in bucket store-photos

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

  select coalesce(array_agg(a), '{}') into v_old
    from store_items s, unnest(array[s.attachment, s.attachment2]) a where a is not null;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if btrim(coalesce(r ->> 'item', '')) = '' then raise exception 'Row % has no item name.', n + 1; end if;
    if v_id is not null then
      update store_items set item = btrim(r ->> 'item'), description = btrim(coalesce(r ->> 'description', description)), purchase_date = nullif(r ->> 'purchase_date', '')::date,
        useful_life_years = nullif(r ->> 'useful_life_years', '')::numeric, decommission_date = nullif(r ->> 'decommission_date', '')::date,
        warranty = btrim(coalesce(r ->> 'warranty', '')), location = btrim(coalesce(r ->> 'location', '')),
        qty = coalesce(nullif(r ->> 'qty', '')::numeric, 0), condition = coalesce(nullif(r ->> 'condition', ''), 'Good'),
        status = coalesce(nullif(r ->> 'status', ''), 'In store'), attachment = nullif(r ->> 'attachment', ''),
        attachment2 = case when r ? 'attachment2' then nullif(r ->> 'attachment2', '') else attachment2 end,
        sort_order = n, updated_at = now()
      where id = v_id;
      if not found then continue; end if;
    else
      insert into store_items (item, description, purchase_date, useful_life_years, decommission_date, warranty, location, qty, condition, status, attachment, attachment2, sort_order)
      values (btrim(r ->> 'item'), btrim(coalesce(r ->> 'description', '')), nullif(r ->> 'purchase_date', '')::date, nullif(r ->> 'useful_life_years', '')::numeric, nullif(r ->> 'decommission_date', '')::date, btrim(coalesce(r ->> 'warranty', '')), btrim(coalesce(r ->> 'location', '')), coalesce(nullif(r ->> 'qty', '')::numeric, 0),
              coalesce(nullif(r ->> 'condition', ''), 'Good'), coalesce(nullif(r ->> 'status', ''), 'In store'),
              nullif(r ->> 'attachment', ''), nullif(r ->> 'attachment2', ''), n)
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
          (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'description', description, 'purchase_date', purchase_date, 'useful_life_years', useful_life_years, 'decommission_date', decommission_date, 'warranty', warranty, 'location', location, 'qty', qty, 'condition', condition,
                                                        'status', status, 'attachment', attachment, 'attachment2', attachment2) order by sort_order), '[]'::jsonb)
           from store_items where id = any (v_keep)));

  perform log_audit('store.saved', 'store', null, btrim(p_checker) || ' · ' || to_char(p_date, 'DD Mon YYYY'), null,
    jsonb_build_object('rows', n));

  return to_jsonb(coalesce((select array_agg(a) from unnest(v_old) a
                            where not exists (select 1 from store_items s where a in (s.attachment, s.attachment2))), '{}'));
end $$;

create or replace function store_add_item(p_item jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not store_is_staff(true) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  perform require_company();   -- the audit entry is written to the selected company's log
  if btrim(coalesce(p_item ->> 'item', '')) = '' then raise exception 'Enter the item name.'; end if;

  insert into store_items (item, description, purchase_date, useful_life_years, warranty, location, qty, condition, status, attachment, attachment2, sort_order)
  values (btrim(p_item ->> 'item'), btrim(coalesce(p_item ->> 'description', '')), nullif(p_item ->> 'purchase_date', '')::date, nullif(p_item ->> 'useful_life_years', '')::numeric,
          btrim(coalesce(p_item ->> 'warranty', '')), btrim(coalesce(p_item ->> 'location', '')),
          coalesce(nullif(p_item ->> 'qty', '')::numeric, 1), coalesce(nullif(p_item ->> 'condition', ''), 'Good'),
          coalesce(nullif(p_item ->> 'status', ''), 'In store'), nullif(p_item ->> 'attachment', ''), nullif(p_item ->> 'attachment2', ''),
          (select coalesce(max(sort_order) + 1, 0) from store_items))
  returning id into v_id;

  perform log_audit('store.item_added', 'store', v_id::text, btrim(p_item ->> 'item'), null, p_item - 'attachment' - 'attachment2');
  return v_id;
end $$;
