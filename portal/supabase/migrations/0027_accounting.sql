-- In-house accounting: chart of accounts + double-entry journal, per company.
-- Profit & Loss and Balance Sheet are computed from journal lines (acc_balances).
--
-- Nothing writes to the journal directly: entries are posted through acc_post_entry(), which refuses
-- an entry whose debits and credits do not match. Read: administrator + viewer. Write: administrator.
-- Safe to re-run.

do $$ begin
  create type acc_type as enum ('asset', 'liability', 'equity', 'income', 'expense');
exception when duplicate_object then null; end $$;

create table if not exists acc_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  code text not null,
  name text not null,
  type acc_type not null,
  -- report grouping: current_asset, fixed_asset, current_liability, long_term_liability, equity,
  -- revenue, other_income, cost_of_sales, operating_expense, other_expense
  section text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table if not exists acc_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  entry_no int not null,
  entry_date date not null,
  memo text not null default '',
  reference text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  unique (company_id, entry_no)
);
create index if not exists acc_entries_date_idx on acc_entries (company_id, entry_date);

create table if not exists acc_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references acc_entries (id) on delete cascade,
  company_id uuid not null references companies (id),
  account_id uuid not null references acc_accounts (id),
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  memo text not null default '',
  check ((debit = 0) <> (credit = 0))          -- a line is either a debit or a credit
);
create index if not exists acc_lines_entry_idx on acc_lines (entry_id);
create index if not exists acc_lines_account_idx on acc_lines (account_id);

alter table acc_accounts enable row level security;
alter table acc_entries  enable row level security;
alter table acc_lines    enable row level security;

drop policy if exists acc_accounts_read on acc_accounts;
create policy acc_accounts_read on acc_accounts for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));
drop policy if exists acc_entries_read on acc_entries;
create policy acc_entries_read on acc_entries for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));
drop policy if exists acc_lines_read on acc_lines;
create policy acc_lines_read on acc_lines for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));

create or replace function acc_require_admin() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role('administrator') then raise exception 'Not permitted' using errcode = '42501'; end if;
  return require_company();
end $$;
revoke all on function acc_require_admin() from public, anon, authenticated;

-- ---------------------------------------------------------------- default chart of accounts
create or replace function acc_seed_company(p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into acc_accounts (company_id, code, name, type, section) values
    (p_company, '1000', 'Cash on Hand',                   'asset', 'current_asset'),
    (p_company, '1010', 'Bank Account',                   'asset', 'current_asset'),
    (p_company, '1020', 'Petty Cash',                     'asset', 'current_asset'),
    (p_company, '1100', 'Accounts Receivable',            'asset', 'current_asset'),
    (p_company, '1150', 'Retention Receivable',           'asset', 'current_asset'),
    (p_company, '1200', 'Advances to Employees',          'asset', 'current_asset'),
    (p_company, '1250', 'Prepaid Expenses',               'asset', 'current_asset'),
    (p_company, '1300', 'Inventory / Materials',          'asset', 'current_asset'),
    (p_company, '1350', 'VAT Receivable (Input VAT)',     'asset', 'current_asset'),
    (p_company, '1500', 'Equipment & Machinery',          'asset', 'fixed_asset'),
    (p_company, '1510', 'Vehicles',                       'asset', 'fixed_asset'),
    (p_company, '1520', 'Furniture & Office Equipment',   'asset', 'fixed_asset'),
    (p_company, '1590', 'Accumulated Depreciation',       'asset', 'fixed_asset'),
    (p_company, '2000', 'Accounts Payable',               'liability', 'current_liability'),
    (p_company, '2100', 'Accrued Salaries',               'liability', 'current_liability'),
    (p_company, '2150', 'End of Service Provision',       'liability', 'current_liability'),
    (p_company, '2200', 'VAT Payable (Output VAT)',       'liability', 'current_liability'),
    (p_company, '2250', 'GOSI Payable',                   'liability', 'current_liability'),
    (p_company, '2300', 'Advances from Clients',          'liability', 'current_liability'),
    (p_company, '2500', 'Bank Loan',                      'liability', 'long_term_liability'),
    (p_company, '2600', 'Loans from Owners',              'liability', 'long_term_liability'),
    (p_company, '3000', 'Owners'' Capital',               'equity', 'equity'),
    (p_company, '3100', 'Owners'' Drawings',              'equity', 'equity'),
    (p_company, '3900', 'Retained Earnings',              'equity', 'equity'),
    (p_company, '4000', 'Contract Revenue',               'income', 'revenue'),
    (p_company, '4100', 'Variation Orders',               'income', 'revenue'),
    (p_company, '4200', 'Other Revenue',                  'income', 'revenue'),
    (p_company, '4900', 'Other Income',                   'income', 'other_income'),
    (p_company, '5000', 'Materials',                      'expense', 'cost_of_sales'),
    (p_company, '5100', 'Subcontractors',                 'expense', 'cost_of_sales'),
    (p_company, '5200', 'Site Labour',                    'expense', 'cost_of_sales'),
    (p_company, '5300', 'Equipment Hire & Fuel',          'expense', 'cost_of_sales'),
    (p_company, '5400', 'Site Costs',                     'expense', 'cost_of_sales'),
    (p_company, '6000', 'Salaries & Wages',               'expense', 'operating_expense'),
    (p_company, '6010', 'GOSI & Employee Benefits',       'expense', 'operating_expense'),
    (p_company, '6020', 'Iqama, Visa & Government Fees', 'expense', 'operating_expense'),
    (p_company, '6100', 'Rent',                           'expense', 'operating_expense'),
    (p_company, '6110', 'Utilities',                      'expense', 'operating_expense'),
    (p_company, '6120', 'Telephone & Internet',           'expense', 'operating_expense'),
    (p_company, '6200', 'Vehicle Running Costs',          'expense', 'operating_expense'),
    (p_company, '6300', 'Insurance',                      'expense', 'operating_expense'),
    (p_company, '6400', 'Office Supplies',                'expense', 'operating_expense'),
    (p_company, '6500', 'Professional Fees',              'expense', 'operating_expense'),
    (p_company, '6600', 'Repairs & Maintenance',          'expense', 'operating_expense'),
    (p_company, '6700', 'Travel & Accommodation',         'expense', 'operating_expense'),
    (p_company, '6800', 'Depreciation',                   'expense', 'operating_expense'),
    (p_company, '6900', 'Other Operating Expenses',       'expense', 'operating_expense'),
    (p_company, '7000', 'Bank Charges',                   'expense', 'other_expense'),
    (p_company, '7100', 'Finance Cost / Interest',        'expense', 'other_expense'),
    (p_company, '7900', 'Zakat & Income Tax',             'expense', 'other_expense')
  on conflict (company_id, code) do nothing;
end $$;
revoke all on function acc_seed_company(uuid) from public, anon, authenticated;

-- existing companies get the standard chart now
do $$ declare c record; begin
  for c in select id from companies loop perform acc_seed_company(c.id); end loop;
end $$;

-- called by the page the first time an administrator opens Accounting in a company with no accounts
create or replace function acc_seed_accounts() returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin();
begin
  if not exists (select 1 from acc_accounts where company_id = v_co) then
    perform acc_seed_company(v_co);
    perform log_audit('accounting.chart_seeded', 'accounting', v_co::text, 'Chart of accounts', null, null);
  end if;
end $$;
grant execute on function acc_seed_accounts() to authenticated;

-- ---------------------------------------------------------------- accounts
create or replace function acc_save_account(p_id uuid, p_code text, p_name text, p_type acc_type, p_section text, p_active boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin(); v_id uuid;
begin
  p_code := btrim(coalesce(p_code, '')); p_name := btrim(coalesce(p_name, ''));
  if p_code = '' or p_name = '' then raise exception 'Enter the account code and name.'; end if;
  if p_section not in ('current_asset','fixed_asset','current_liability','long_term_liability','equity',
                       'revenue','other_income','cost_of_sales','operating_expense','other_expense') then
    raise exception 'Invalid section';
  end if;
  if (p_type = 'asset' and p_section not in ('current_asset','fixed_asset'))
     or (p_type = 'liability' and p_section not in ('current_liability','long_term_liability'))
     or (p_type = 'equity' and p_section <> 'equity')
     or (p_type = 'income' and p_section not in ('revenue','other_income'))
     or (p_type = 'expense' and p_section not in ('cost_of_sales','operating_expense','other_expense')) then
    raise exception 'The section does not belong to that account type.';
  end if;
  if p_id is null then
    insert into acc_accounts (company_id, code, name, type, section, is_active)
    values (v_co, p_code, p_name, p_type, p_section, coalesce(p_active, true)) returning id into v_id;
    perform log_audit('accounting.account_added', 'accounting', v_id::text, p_code || ' ' || p_name, null,
      jsonb_build_object('type', p_type, 'section', p_section));
  else
    -- type cannot change once the account has postings (it would rewrite past reports)
    if exists (select 1 from acc_lines l join acc_accounts a on a.id = l.account_id
               where a.id = p_id and a.company_id = v_co and a.type <> p_type) then
      raise exception 'This account already has entries, so its type cannot change.';
    end if;
    update acc_accounts set code = p_code, name = p_name, type = p_type, section = p_section, is_active = coalesce(p_active, true)
    where id = p_id and company_id = v_co returning id into v_id;
    if v_id is null then raise exception 'Account not found'; end if;
    perform log_audit('accounting.account_changed', 'accounting', v_id::text, p_code || ' ' || p_name, null, null);
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'Account code % is already used.', p_code;
end $$;
grant execute on function acc_save_account(uuid, text, text, acc_type, text, boolean) to authenticated;

-- ---------------------------------------------------------------- journal
-- p_lines: [{account_id, debit, credit, memo}]. p_id null = new entry, otherwise replaces that entry's date, text and lines.
create or replace function acc_post_entry(p_id uuid, p_date date, p_memo text, p_ref text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := acc_require_admin();
  v_id uuid := p_id;
  v_no int;
  r jsonb;
  v_dr numeric := 0; v_cr numeric := 0; v_n int := 0;
  v_deb numeric; v_cre numeric;
begin
  if p_date is null then raise exception 'Enter the date.'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Invalid lines.'; end if;

  for r in select * from jsonb_array_elements(p_lines) loop
    v_deb := round(coalesce((r ->> 'debit')::numeric, 0), 2);
    v_cre := round(coalesce((r ->> 'credit')::numeric, 0), 2);
    if v_deb = 0 and v_cre = 0 then continue; end if;
    if v_deb < 0 or v_cre < 0 or (v_deb > 0 and v_cre > 0) then
      raise exception 'Each line must be either a debit or a credit.';
    end if;
    if not exists (select 1 from acc_accounts where id = (r ->> 'account_id')::uuid and company_id = v_co and is_active) then
      raise exception 'Choose an active account on every line.';
    end if;
    v_dr := v_dr + v_deb; v_cr := v_cr + v_cre; v_n := v_n + 1;
  end loop;
  if v_n < 2 then raise exception 'An entry needs at least two lines.'; end if;
  if v_dr <> v_cr then
    raise exception 'Debits (%) and credits (%) must be equal.', to_char(v_dr, 'FM999,999,999.00'), to_char(v_cr, 'FM999,999,999.00');
  end if;

  if v_id is null then
    -- per-company running number; lock keeps two simultaneous saves from taking the same one
    perform pg_advisory_xact_lock(hashtext('acc_entry_no:' || v_co::text));
    select coalesce(max(entry_no), 0) + 1 into v_no from acc_entries where company_id = v_co;
    insert into acc_entries (company_id, entry_no, entry_date, memo, reference, created_by)
    values (v_co, v_no, p_date, btrim(coalesce(p_memo, '')), btrim(coalesce(p_ref, '')), auth.uid())
    returning id into v_id;
  else
    update acc_entries set entry_date = p_date, memo = btrim(coalesce(p_memo, '')), reference = btrim(coalesce(p_ref, ''))
    where id = v_id and company_id = v_co returning entry_no into v_no;
    if v_no is null then raise exception 'Entry not found'; end if;
    delete from acc_lines where entry_id = v_id;
  end if;

  insert into acc_lines (entry_id, company_id, account_id, debit, credit, memo)
  select v_id, v_co, (x ->> 'account_id')::uuid,
         round(coalesce((x ->> 'debit')::numeric, 0), 2), round(coalesce((x ->> 'credit')::numeric, 0), 2),
         btrim(coalesce(x ->> 'memo', ''))
  from jsonb_array_elements(p_lines) x
  where round(coalesce((x ->> 'debit')::numeric, 0), 2) <> 0 or round(coalesce((x ->> 'credit')::numeric, 0), 2) <> 0;

  perform log_audit(case when p_id is null then 'accounting.entry_posted' else 'accounting.entry_changed' end,
    'accounting', v_id::text, 'JE-' || lpad(v_no::text, 4, '0'), null,
    jsonb_build_object('date', p_date, 'amount', v_dr, 'memo', btrim(coalesce(p_memo, ''))));
  return v_id;
end $$;
grant execute on function acc_post_entry(uuid, date, text, text, jsonb) to authenticated;

create or replace function acc_delete_entry(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin(); e acc_entries; v_amt numeric;
begin
  select * into e from acc_entries where id = p_id and company_id = v_co;
  if not found then raise exception 'Entry not found'; end if;
  select coalesce(sum(debit), 0) into v_amt from acc_lines where entry_id = p_id;
  delete from acc_entries where id = p_id;
  perform log_audit('accounting.entry_deleted', 'accounting', p_id::text, 'JE-' || lpad(e.entry_no::text, 4, '0'),
    jsonb_build_object('date', e.entry_date, 'amount', v_amt, 'memo', e.memo), null);
end $$;
grant execute on function acc_delete_entry(uuid) to authenticated;

-- ---------------------------------------------------------------- reports
-- Total debits and credits per account for entries dated p_from..p_to (either may be null = unbounded).
-- P&L uses a range; the Balance Sheet uses p_from = null and p_to = the "as at" date.
create or replace function acc_balances(p_from date, p_to date)
returns table (account_id uuid, debit numeric, credit numeric)
language sql stable security definer set search_path = public as $$
  select l.account_id, coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
  from acc_lines l join acc_entries e on e.id = l.entry_id
  where e.company_id = current_company()
    and has_role('administrator', 'viewer')
    and (p_from is null or e.entry_date >= p_from)
    and (p_to is null or e.entry_date <= p_to)
  group by l.account_id
$$;
grant execute on function acc_balances(date, date) to authenticated;
