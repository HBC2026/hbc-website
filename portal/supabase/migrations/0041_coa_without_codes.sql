-- Chart of accounts without account codes.
--
--  * What the codes used to decide (which accounts are cash, receivable or payable) is now a field, `kind`.
--  * Accounts sort by section, then by `sort_order` (set by the user on the Chart of Accounts screen),
--    then by name.
--  * The old `code` column is kept, optional and unused, so no data is lost.
-- Run after 0027. Safe to re-run.

alter table acc_accounts alter column code drop not null;
alter table acc_accounts add column if not exists sort_order int;

-- one time only: mark the accounts the Overview used to find by code, so re-running keeps the user's choices
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'acc_accounts' and column_name = 'kind') then
    alter table acc_accounts add column kind text not null default '' check (kind in ('', 'cash', 'receivable', 'payable'));
    update acc_accounts set kind = case
      when type = 'asset' and code like '10%' then 'cash'
      when type = 'asset' and code in ('1100', '1150') then 'receivable'
      when type = 'liability' and code = '2000' then 'payable'
      else '' end;
  end if;
end $$;

-- ---------------------------------------------------------------- default chart of accounts
create or replace function acc_seed_company(p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into acc_accounts (company_id, name, type, section, kind)
  select p_company, v.name, v.type::acc_type, v.section, v.kind
  from (values
    ('Cash on Hand',                   'asset', 'current_asset', 'cash'),
    ('Bank Account',                   'asset', 'current_asset', 'cash'),
    ('Petty Cash',                     'asset', 'current_asset', 'cash'),
    ('Accounts Receivable',            'asset', 'current_asset', 'receivable'),
    ('Retention Receivable',           'asset', 'current_asset', 'receivable'),
    ('Advances to Employees',          'asset', 'current_asset', ''),
    ('Prepaid Expenses',               'asset', 'current_asset', ''),
    ('Inventory / Materials',          'asset', 'current_asset', ''),
    ('VAT Receivable (Input VAT)',     'asset', 'current_asset', ''),
    ('Equipment & Machinery',          'asset', 'fixed_asset', ''),
    ('Vehicles',                       'asset', 'fixed_asset', ''),
    ('Furniture & Office Equipment',   'asset', 'fixed_asset', ''),
    ('Accumulated Depreciation',       'asset', 'fixed_asset', ''),
    ('Accounts Payable',               'liability', 'current_liability', 'payable'),
    ('Accrued Salaries',               'liability', 'current_liability', ''),
    ('End of Service Provision',       'liability', 'current_liability', ''),
    ('VAT Payable (Output VAT)',       'liability', 'current_liability', ''),
    ('GOSI Payable',                   'liability', 'current_liability', ''),
    ('Advances from Clients',          'liability', 'current_liability', ''),
    ('Bank Loan',                      'liability', 'long_term_liability', ''),
    ('Loans from Owners',              'liability', 'long_term_liability', ''),
    ('Owners'' Capital',               'equity', 'equity', ''),
    ('Owners'' Drawings',              'equity', 'equity', ''),
    ('Retained Earnings',              'equity', 'equity', ''),
    ('Contract Revenue',               'income', 'revenue', ''),
    ('Variation Orders',               'income', 'revenue', ''),
    ('Other Revenue',                  'income', 'revenue', ''),
    ('Other Income',                   'income', 'other_income', ''),
    ('Materials',                      'expense', 'cost_of_sales', ''),
    ('Subcontractors',                 'expense', 'cost_of_sales', ''),
    ('Site Labour',                    'expense', 'cost_of_sales', ''),
    ('Equipment Hire & Fuel',          'expense', 'cost_of_sales', ''),
    ('Site Costs',                     'expense', 'cost_of_sales', ''),
    ('Salaries & Wages',               'expense', 'operating_expense', ''),
    ('GOSI & Employee Benefits',       'expense', 'operating_expense', ''),
    ('Iqama, Visa & Government Fees',  'expense', 'operating_expense', ''),
    ('Rent',                           'expense', 'operating_expense', ''),
    ('Utilities',                      'expense', 'operating_expense', ''),
    ('Telephone & Internet',           'expense', 'operating_expense', ''),
    ('Vehicle Running Costs',          'expense', 'operating_expense', ''),
    ('Insurance',                      'expense', 'operating_expense', ''),
    ('Office Supplies',                'expense', 'operating_expense', ''),
    ('Professional Fees',              'expense', 'operating_expense', ''),
    ('Repairs & Maintenance',          'expense', 'operating_expense', ''),
    ('Travel & Accommodation',         'expense', 'operating_expense', ''),
    ('Depreciation',                   'expense', 'operating_expense', ''),
    ('Other Operating Expenses',       'expense', 'operating_expense', ''),
    ('Bank Charges',                   'expense', 'other_expense', ''),
    ('Finance Cost / Interest',        'expense', 'other_expense', ''),
    ('Zakat & Income Tax',             'expense', 'other_expense', '')
  ) as v(name, type, section, kind)
  where not exists (select 1 from acc_accounts a where a.company_id = p_company and lower(a.name) = lower(v.name));
end $$;
revoke all on function acc_seed_company(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- accounts
drop function if exists acc_save_account(uuid, text, text, acc_type, text, boolean);

create or replace function acc_save_account(p_id uuid, p_name text, p_type acc_type, p_section text, p_kind text, p_active boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin(); v_id uuid; v_old acc_accounts;
begin
  p_name := btrim(coalesce(p_name, ''));
  p_kind := coalesce(p_kind, '');
  if p_name = '' then raise exception 'Enter the account name.'; end if;
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
  if p_kind in ('cash', 'receivable') and p_type <> 'asset' then raise exception 'Only an asset account can be cash/bank or receivable.'; end if;
  if p_kind = 'payable' and p_type <> 'liability' then raise exception 'Only a liability account can be payable.'; end if;

  if p_id is not null then
    select * into v_old from acc_accounts where id = p_id and company_id = v_co;
    if not found then raise exception 'Account not found'; end if;
  end if;
  -- names tell accounts apart; an old duplicate can still be edited as long as it is not renamed
  if (p_id is null or lower(v_old.name) <> lower(p_name))
     and exists (select 1 from acc_accounts where company_id = v_co and lower(name) = lower(p_name)) then
    raise exception 'An account named % already exists.', p_name;
  end if;

  if p_id is null then
    insert into acc_accounts (company_id, name, type, section, kind, is_active)
    values (v_co, p_name, p_type, p_section, p_kind, coalesce(p_active, true)) returning id into v_id;
    perform log_audit('accounting.account_added', 'accounting', v_id::text, p_name, null,
      jsonb_build_object('type', p_type, 'section', p_section));
  else
    -- type cannot change once the account has postings (it would rewrite past reports)
    if v_old.type <> p_type and exists (select 1 from acc_lines where account_id = p_id) then
      raise exception 'This account already has entries, so its type cannot change.';
    end if;
    update acc_accounts set name = p_name, type = p_type, section = p_section, kind = p_kind, is_active = coalesce(p_active, true),
      sort_order = case when section = p_section then sort_order end
    where id = p_id returning id into v_id;
    perform log_audit('accounting.account_changed', 'accounting', v_id::text, p_name, null, null);
  end if;
  return v_id;
end $$;
revoke all on function acc_save_account(uuid, text, acc_type, text, text, boolean) from public, anon;
grant execute on function acc_save_account(uuid, text, acc_type, text, text, boolean) to authenticated;

-- p_ids: the section's accounts in the order wanted. An empty list returns the section to name order.
create or replace function acc_order_accounts(p_section text, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin();
begin
  if exists (select 1 from unnest(p_ids) x
             where not exists (select 1 from acc_accounts a where a.id = x and a.company_id = v_co and a.section = p_section)) then
    raise exception 'Every account must belong to that section.';
  end if;
  update acc_accounts set sort_order = array_position(p_ids, id) where company_id = v_co and section = p_section;
  perform log_audit('accounting.accounts_reordered', 'accounting', v_co::text, p_section, null, null);
end $$;
revoke all on function acc_order_accounts(text, uuid[]) from public, anon;
grant execute on function acc_order_accounts(text, uuid[]) to authenticated;
