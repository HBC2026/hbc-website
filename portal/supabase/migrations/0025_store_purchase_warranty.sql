-- Store sheet: add "Date of purchase" and "Warranty" columns (both optional).
-- Only adds columns and re-creates store_save() so it saves them; existing rows and checks are untouched.

alter table store_items add column if not exists purchase_date date;
alter table store_items add column if not exists warranty text not null default '';

-- Saves the whole sheet and the sign-off in one transaction.
-- p_rows: [{id?, item, location, qty, condition, status, attachment}] in display order. Rows missing from it are deleted.
-- Returns the storage paths that are no longer used, so the page can remove those images.
create or replace function store_save(p_rows jsonb, p_checker text, p_date date, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  v_old text[];
  v_keep uuid[] := '{}';
  v_id uuid;
  r jsonb;
  n int := 0;
begin
  if not has_role('administrator', 'payroll', 'attendance') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if btrim(coalesce(p_checker, '')) = '' then raise exception 'Enter the name of the inventory checker.'; end if;
  if p_date is null then raise exception 'Enter the date.'; end if;
  if p_signature is null or p_signature not like 'data:image/png;base64,%' then raise exception 'Sign before saving.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Invalid sheet.'; end if;

  select coalesce(array_agg(attachment) filter (where attachment is not null), '{}') into v_old
    from store_items where company_id = v_co;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if btrim(coalesce(r ->> 'item', '')) = '' then raise exception 'Row % has no item name.', n + 1; end if;
    if v_id is not null and exists (select 1 from store_items where id = v_id and company_id = v_co) then
      update store_items set item = btrim(r ->> 'item'), purchase_date = nullif(r ->> 'purchase_date', '')::date,
        warranty = btrim(coalesce(r ->> 'warranty', '')), location = btrim(coalesce(r ->> 'location', '')),
        qty = coalesce(nullif(r ->> 'qty', '')::numeric, 0), condition = coalesce(nullif(r ->> 'condition', ''), 'Good'),
        status = coalesce(nullif(r ->> 'status', ''), 'In store'), attachment = nullif(r ->> 'attachment', ''),
        sort_order = n, updated_at = now()
      where id = v_id;
    else
      insert into store_items (company_id, item, purchase_date, warranty, location, qty, condition, status, attachment, sort_order)
      values (v_co, btrim(r ->> 'item'), nullif(r ->> 'purchase_date', '')::date, btrim(coalesce(r ->> 'warranty', '')), btrim(coalesce(r ->> 'location', '')), coalesce(nullif(r ->> 'qty', '')::numeric, 0),
              coalesce(nullif(r ->> 'condition', ''), 'Good'), coalesce(nullif(r ->> 'status', ''), 'In store'),
              nullif(r ->> 'attachment', ''), n)
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
    n := n + 1;
  end loop;

  delete from store_items where company_id = v_co and id <> all (v_keep);

  insert into store_checks (company_id, checker_name, check_date, signature, row_count, snapshot)
  values (v_co, btrim(p_checker), p_date, p_signature, n,
          (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'purchase_date', purchase_date, 'warranty', warranty, 'location', location, 'qty', qty, 'condition', condition,
                                                        'status', status, 'attachment', attachment) order by sort_order), '[]'::jsonb)
           from store_items where company_id = v_co));

  perform log_audit('store.saved', 'store', null, btrim(p_checker) || ' · ' || to_char(p_date, 'DD Mon YYYY'), null,
    jsonb_build_object('rows', n));

  return to_jsonb(coalesce((select array_agg(a) from unnest(v_old) a
                            where a not in (select attachment from store_items where company_id = v_co and attachment is not null)), '{}'));
end $$;
grant execute on function store_save(jsonb, text, date, text) to authenticated;
