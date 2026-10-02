-- Petty cash: cash given to employees, receipts they upload against it, and the net balance.
--
-- Employees do not sign in. Each gets a private link (a long random token) to a phone page.
-- The page talks to the database only through the token-checked functions below, which are the
-- only things granted to the `anon` role. Staff (administrator / payroll write, viewer read)
-- use the normal per-company RLS and security-definer functions.
--
-- balance = cash given - receipts that are not rejected (pending and approved both count).

create table pc_access (
  employee_id uuid primary key references employees (id) on delete cascade,
  company_id uuid not null references companies (id) default current_company(),
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table pc_cash_given (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  employee_id uuid not null references employees (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  given_on date not null default current_date,
  note text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index pc_cash_given_emp_idx on pc_cash_given (employee_id, given_on);
create index pc_cash_given_company_idx on pc_cash_given (company_id);

create table pc_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  employee_id uuid not null references employees (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  spent_on date not null,
  description text not null,
  file_path text not null,                 -- storage object in bucket petty-cash-receipts: {token}/{file}
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text not null default '',
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index pc_receipts_emp_idx on pc_receipts (employee_id, spent_on);
create index pc_receipts_company_idx on pc_receipts (company_id);

alter table pc_access     enable row level security;
alter table pc_cash_given enable row level security;
alter table pc_receipts   enable row level security;

-- tokens are never readable by the client; staff fetch a link through pc_get_link()
create policy pc_cash_read on pc_cash_given for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy pc_receipts_read on pc_receipts for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('petty-cash-receipts', 'petty-cash-receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

create or replace function pc_token_valid(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pc_access a join employees e on e.id = a.employee_id
    where a.token = p_token and e.status = 'active')
$$;

-- employees upload into the folder named by their own token (insert only: no read, update or delete)
create policy pc_receipts_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'petty-cash-receipts'
              and coalesce(array_length(storage.foldername(name), 1), 0) = 1
              and pc_token_valid((storage.foldername(name))[1]));

-- staff view a file only if a receipt in their current company points at it
create policy pc_receipts_view on storage.objects for select to authenticated
  using (bucket_id = 'petty-cash-receipts'
         and has_role('administrator', 'payroll', 'viewer')
         and exists (select 1 from pc_receipts r
                     where r.file_path = name and r.company_id = (select current_company())));

-- ---------------------------------------------------------------- staff functions
create or replace function pc_require_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  return require_company();
end $$;
revoke all on function pc_require_staff() from public, anon, authenticated;

create or replace function pc_employee_label(p_employee uuid, p_company uuid) returns text
language sql stable security definer set search_path = public as $$
  select emp_code || ' ' || name from employees where id = p_employee and company_id = p_company
$$;
revoke all on function pc_employee_label(uuid, uuid) from public, anon, authenticated;

-- Given / spent / balance for every employee that has any petty cash activity or a link.
create or replace function pc_summary()
returns table (employee_id uuid, given numeric, spent numeric, pending_count int, rejected_count int, balance numeric, has_link boolean)
language sql stable security definer set search_path = public as $$
  select e.id,
    coalesce(g.total, 0),
    coalesce(r.total, 0),
    coalesce(r.pending, 0),
    coalesce(r.rejected, 0),
    coalesce(g.total, 0) - coalesce(r.total, 0),
    exists (select 1 from pc_access a where a.employee_id = e.id)
  from employees e
  left join (select employee_id, sum(amount) total from pc_cash_given group by employee_id) g on g.employee_id = e.id
  left join (select employee_id,
               coalesce(sum(amount) filter (where status <> 'rejected'), 0) total,
               (count(*) filter (where status = 'pending'))::int pending,
               (count(*) filter (where status = 'rejected'))::int rejected
             from pc_receipts group by employee_id) r on r.employee_id = e.id
  where e.company_id = current_company()
    and has_role('administrator', 'payroll', 'viewer')
$$;
grant execute on function pc_summary() to authenticated;

create or replace function pc_give_cash(p_employee uuid, p_amount numeric, p_date date, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  v_id uuid;
  v_label text := pc_employee_label(p_employee, v_co);
begin
  if v_label is null then raise exception 'Employee not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  insert into pc_cash_given (company_id, employee_id, amount, given_on, note, created_by)
  values (v_co, p_employee, round(p_amount, 2), coalesce(p_date, current_date), btrim(coalesce(p_note, '')), auth.uid())
  returning id into v_id;
  perform log_audit('petty_cash.given', 'petty_cash', v_id::text, v_label, null,
    jsonb_build_object('amount', round(p_amount, 2), 'date', coalesce(p_date, current_date), 'note', btrim(coalesce(p_note, ''))));
  return v_id;
end $$;
grant execute on function pc_give_cash(uuid, numeric, date, text) to authenticated;

create or replace function pc_delete_cash(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  c pc_cash_given;
begin
  select * into c from pc_cash_given where id = p_id and company_id = v_co;
  if not found then raise exception 'Entry not found'; end if;
  delete from pc_cash_given where id = p_id;
  perform log_audit('petty_cash.cash_deleted', 'petty_cash', p_id::text, pc_employee_label(c.employee_id, v_co),
    jsonb_build_object('amount', c.amount, 'date', c.given_on, 'note', c.note), null);
end $$;
grant execute on function pc_delete_cash(uuid) to authenticated;

-- status = 'approved' | 'rejected' (a reason is required to reject, so the employee knows what to fix)
create or replace function pc_review_receipt(p_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  r pc_receipts;
begin
  if p_status not in ('approved', 'rejected') then raise exception 'Invalid status'; end if;
  if p_status = 'rejected' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Enter a reason so the employee knows what to upload again.';
  end if;
  select * into r from pc_receipts where id = p_id and company_id = v_co;
  if not found then raise exception 'Receipt not found'; end if;
  update pc_receipts set status = p_status,
    reject_reason = case when p_status = 'rejected' then btrim(p_reason) else '' end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;
  perform log_audit('petty_cash.receipt_' || p_status, 'petty_cash', p_id::text, pc_employee_label(r.employee_id, v_co),
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status, 'amount', r.amount, 'reason', btrim(coalesce(p_reason, ''))));
end $$;
grant execute on function pc_review_receipt(uuid, text, text) to authenticated;

-- The employee's private link token (created on first use). Regenerating revokes the old link.
create or replace function pc_get_link(p_employee uuid, p_regenerate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  v_token text;
begin
  if pc_employee_label(p_employee, v_co) is null then raise exception 'Employee not found'; end if;
  if p_regenerate then
    delete from pc_access where employee_id = p_employee;
    perform log_audit('petty_cash.link_regenerated', 'petty_cash', p_employee::text, pc_employee_label(p_employee, v_co), null, null);
  end if;
  insert into pc_access (employee_id, company_id) values (p_employee, v_co)
  on conflict (employee_id) do nothing;
  select token into v_token from pc_access where employee_id = p_employee;
  return v_token;
end $$;
grant execute on function pc_get_link(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- employee functions (token = credential)
create or replace function pc_statement(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a pc_access; e employees;
  v_given numeric; v_spent numeric;
begin
  select * into a from pc_access where token = p_token;
  if not found then return null; end if;
  select * into e from employees where id = a.employee_id;
  select coalesce(sum(amount), 0) into v_given from pc_cash_given where employee_id = e.id;
  select coalesce(sum(amount), 0) into v_spent from pc_receipts where employee_id = e.id and status <> 'rejected';
  return jsonb_build_object(
    'name', e.name, 'emp_code', e.emp_code, 'active', e.status = 'active',
    'company', (select name from companies where id = a.company_id),
    'given', v_given, 'spent', v_spent, 'balance', v_given - v_spent,
    'cash', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', given_on, 'note', note)
                                       order by given_on desc, created_at desc)
                      from pc_cash_given where employee_id = e.id), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', spent_on, 'description', description,
                                       'status', status, 'reject_reason', reject_reason)
                                       order by spent_on desc, created_at desc)
                          from pc_receipts where employee_id = e.id), '[]'::jsonb)
  );
end $$;
grant execute on function pc_statement(text) to anon, authenticated;

create or replace function pc_add_receipt(p_token text, p_amount numeric, p_date date, p_description text, p_file_path text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a pc_access; v_id uuid;
begin
  select a2.* into a from pc_access a2 join employees e on e.id = a2.employee_id
  where a2.token = p_token and e.status = 'active';
  if not found then raise exception 'This link is no longer valid. Ask the office for a new one.' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Enter the receipt amount.'; end if;
  if p_date is null or p_date > current_date + 1 then raise exception 'Enter the date on the receipt.'; end if;
  if btrim(coalesce(p_description, '')) = '' then raise exception 'Say what the money was spent on.'; end if;
  if p_file_path is null or p_file_path not like p_token || '/%' or length(p_file_path) > 300 then
    raise exception 'Attach a photo of the receipt.';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'petty-cash-receipts' and o.name = p_file_path) is false then
    raise exception 'The receipt photo did not upload. Please try again.';
  end if;
  insert into pc_receipts (company_id, employee_id, amount, spent_on, description, file_path)
  values (a.company_id, a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text) to anon, authenticated;

-- employees may remove a receipt that is still pending or was rejected (to upload it again)
create or replace function pc_delete_receipt(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a pc_access;
begin
  select * into a from pc_access where token = p_token;
  if not found then raise exception 'This link is no longer valid.' using errcode = '42501'; end if;
  delete from pc_receipts where id = p_id and employee_id = a.employee_id and status in ('pending', 'rejected');
  if not found then raise exception 'This receipt is approved and cannot be removed.'; end if;
end $$;
grant execute on function pc_delete_receipt(text, uuid) to anon, authenticated;

-- anon may call only the three employee functions above (nothing else in the schema)
revoke execute on function pc_token_valid(text) from public;
grant execute on function pc_token_valid(text) to anon, authenticated;
