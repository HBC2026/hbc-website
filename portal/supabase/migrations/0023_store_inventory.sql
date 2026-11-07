-- Store inventory: tools and leftover site materials, who has what, and what is broken.
-- Adds new objects only; no existing table, function or policy is changed.
--
-- Per company (company_id + RLS, same as clients / petty cash).
-- Read: every signed-in role. Write: administrator, payroll, attendance.
-- Computed (not stored): checked out? (open checkout row), next check due, open issue count, days open.

create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  item_id text not null check (btrim(item_id) <> ''),           -- e.g. T-001, M-001
  name text not null check (btrim(name) <> ''),
  type text not null default 'Tool' check (type in ('Tool', 'Material')),
  category text not null default '',
  brand_model text not null default '',
  location text not null default '',
  qty numeric(12, 2) not null default 1 check (qty >= 0),
  min_qty numeric(12, 2) not null default 0 check (min_qty >= 0),
  condition text not null default 'Good' check (condition in ('Good', 'Fair', 'Needs repair', 'Broken', 'Scrap')),
  last_checked date,
  check_every_days int not null default 90 check (check_every_days >= 0),
  notes text not null default '',
  photo_url text,                                                -- object path in bucket store-photos (optional)
  created_at timestamptz not null default now(),
  unique (company_id, item_id)
);
create index inventory_items_company_idx on inventory_items (company_id);

create table checkout_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  item_id uuid not null references inventory_items (id) on delete cascade,
  taken_by text not null check (btrim(taken_by) <> ''),
  site_job text not null default '',
  date_out date not null default current_date,
  condition_out text not null default 'Good' check (condition_out in ('Good', 'Fair', 'Needs repair', 'Broken', 'Scrap')),
  date_returned date,                                            -- null = still out
  condition_back text check (condition_back in ('Good', 'Fair', 'Needs repair', 'Broken', 'Scrap')),
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index checkout_log_item_idx on checkout_log (item_id);
create index checkout_log_company_idx on checkout_log (company_id);
-- an item can only be out once at a time
create unique index checkout_log_one_open_idx on checkout_log (item_id) where date_returned is null;

create table issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  item_id uuid not null references inventory_items (id) on delete cascade,
  reported_by text not null default '',
  date_found date not null default current_date,
  description text not null check (btrim(description) <> ''),
  action_needed text not null default '',
  est_cost numeric(12, 2) not null default 0 check (est_cost >= 0),
  status text not null default 'Open' check (status in ('Open', 'Fixed', 'Scrapped')),
  date_fixed date,
  created_at timestamptz not null default now()
);
create index issues_item_idx on issues (item_id);
create index issues_company_idx on issues (company_id);

alter table inventory_items enable row level security;
alter table checkout_log    enable row level security;
alter table issues          enable row level security;

create policy inv_items_read on inventory_items for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
create policy inv_items_write on inventory_items for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'))
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'));

create policy inv_checkout_read on checkout_log for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
create policy inv_checkout_write on checkout_log for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'))
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'));

create policy inv_issues_read on issues for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
create policy inv_issues_write on issues for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'))
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance'));

-- ---------------------------------------------------------------- photos (private bucket, 5 MB, images only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-photos', 'store-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

-- object path: {company_id}/{random}.jpg ; access is decided by the user's role in the folder's company
-- (does not depend on the x-company-id header, which storage requests may not carry)
create policy store_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'store-photos'
         and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and has_role_in(((storage.foldername(name))[1])::uuid, 'administrator', 'payroll', 'attendance', 'quotations', 'viewer'));
create policy store_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'store-photos'
              and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and has_role_in(((storage.foldername(name))[1])::uuid, 'administrator', 'payroll', 'attendance'));
create policy store_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'store-photos'
         and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and has_role_in(((storage.foldername(name))[1])::uuid, 'administrator', 'payroll', 'attendance'));

-- ---------------------------------------------------------------- example data (clearly labelled; delete in the app)
-- Goes to the first company (Hassan and Bilal Company). Skipped if that company already has an example item.
do $$
declare
  v_co uuid := (select id from companies order by created_at limit 1);
  v_item uuid;
begin
  if v_co is null or exists (select 1 from inventory_items where company_id = v_co and item_id = 'EX-001') then
    return;
  end if;
  insert into inventory_items (company_id, item_id, name, type, category, brand_model, location, qty, min_qty,
                               condition, last_checked, check_every_days, notes)
  values (v_co, 'EX-001', 'EXAMPLE - Angle grinder (delete me)', 'Tool', 'Power tools', 'Example 125mm', 'Store Room', 1, 0,
          'Needs repair', current_date - 120, 90, 'EXAMPLE ROW so you can see how the Store works. Delete it once you have added real items.')
  returning id into v_item;
  insert into checkout_log (company_id, item_id, taken_by, site_job, date_out, condition_out, notes)
  values (v_co, v_item, 'Example Worker', 'Example Site', current_date - 5, 'Good', 'EXAMPLE checkout - still out');
  insert into issues (company_id, item_id, reported_by, date_found, description, action_needed, est_cost, status)
  values (v_co, v_item, 'Example Worker', current_date - 20, 'EXAMPLE issue: power cord is frayed near the plug',
          'Replace cord', 35, 'Open');
end $$;
