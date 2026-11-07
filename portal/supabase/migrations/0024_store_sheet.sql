-- Store inventory, simplified: ONE editable sheet (Item, Location, Qty, Condition, Status, Attachment)
-- that is saved with the checker's name, date and signature.
--
-- Replaces the tables from 0023 (inventory_items, checkout_log, issues). Those held only the example
-- rows unless you typed data into the first version; THEY ARE DROPPED HERE. The private bucket
-- `store-photos` and its storage policies from 0023 are kept and reused for the Attachment images.
-- Nothing outside the Store is touched.

drop table if exists issues;
drop table if exists checkout_log;
drop table if exists inventory_items;

create table store_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  item text not null check (btrim(item) <> ''),
  location text not null default '',
  qty numeric(12, 2) not null default 1 check (qty >= 0),
  condition text not null default 'Good' check (condition in ('Good', 'Fair', 'Needs repair', 'Broken', 'Scrap')),
  status text not null default 'In store' check (status in ('In store', 'Checked out', 'Under repair', 'Missing', 'Disposed')),
  attachment text,                      -- object path in bucket store-photos: {company_id}/{file}
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);
create index store_items_company_idx on store_items (company_id, sort_order);

-- One row per signed save: who checked, when, their signature, and a copy of the sheet as it was saved.
create table store_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  checker_name text not null check (btrim(checker_name) <> ''),
  check_date date not null,
  signature text not null check (signature like 'data:image/png;base64,%' and length(signature) < 400000),
  row_count int not null default 0,
  snapshot jsonb not null default '[]'::jsonb,
  saved_by uuid references profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index store_checks_company_idx on store_checks (company_id, created_at desc);

alter table store_items  enable row level security;
alter table store_checks enable row level security;

create policy store_items_read on store_items for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
create policy store_checks_read on store_checks for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
-- no direct insert/update/delete: all writes go through store_save() below

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
      update store_items set item = btrim(r ->> 'item'), location = btrim(coalesce(r ->> 'location', '')),
        qty = coalesce(nullif(r ->> 'qty', '')::numeric, 0), condition = coalesce(nullif(r ->> 'condition', ''), 'Good'),
        status = coalesce(nullif(r ->> 'status', ''), 'In store'), attachment = nullif(r ->> 'attachment', ''),
        sort_order = n, updated_at = now()
      where id = v_id;
    else
      insert into store_items (company_id, item, location, qty, condition, status, attachment, sort_order)
      values (v_co, btrim(r ->> 'item'), btrim(coalesce(r ->> 'location', '')), coalesce(nullif(r ->> 'qty', '')::numeric, 0),
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
          (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'location', location, 'qty', qty, 'condition', condition,
                                                        'status', status, 'attachment', attachment) order by sort_order), '[]'::jsonb)
           from store_items where company_id = v_co));

  perform log_audit('store.saved', 'store', null, btrim(p_checker) || ' · ' || to_char(p_date, 'DD Mon YYYY'), null,
    jsonb_build_object('rows', n));

  return to_jsonb(coalesce((select array_agg(a) from unnest(v_old) a
                            where a not in (select attachment from store_items where company_id = v_co and attachment is not null)), '{}'));
end $$;
grant execute on function store_save(jsonb, text, date, text) to authenticated;
