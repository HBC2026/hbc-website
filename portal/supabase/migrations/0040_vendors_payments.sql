-- Accounting: vendors, and payments made to them.
--
-- A vendor payment is an ordinary two-line journal entry (debit what was paid for, credit the cash or
-- bank account) tagged with the vendor, so it shows in the Journal, Register and reports straight away
-- and deleting the entry removes the payment. Read: administrator + viewer. Write: administrator.
-- Safe to re-run.

create table if not exists acc_vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  name text not null,
  phone text not null default '',
  vat_no text not null default '',
  notes text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists acc_vendors_name_idx on acc_vendors (company_id, lower(name));

alter table acc_entries add column if not exists vendor_id uuid references acc_vendors (id);
create index if not exists acc_entries_vendor_idx on acc_entries (vendor_id) where vendor_id is not null;

alter table acc_vendors enable row level security;
drop policy if exists acc_vendors_read on acc_vendors;
create policy acc_vendors_read on acc_vendors for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));

create or replace function acc_save_vendor(p_id uuid, p_name text, p_phone text, p_vat_no text, p_notes text, p_active boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin(); v_id uuid;
begin
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' then raise exception 'Enter the vendor name.'; end if;
  if p_id is null then
    insert into acc_vendors (company_id, name, phone, vat_no, notes, is_active)
    values (v_co, p_name, btrim(coalesce(p_phone, '')), btrim(coalesce(p_vat_no, '')), btrim(coalesce(p_notes, '')), coalesce(p_active, true))
    returning id into v_id;
    perform log_audit('accounting.vendor_added', 'accounting', v_id::text, p_name, null, null);
  else
    update acc_vendors set name = p_name, phone = btrim(coalesce(p_phone, '')), vat_no = btrim(coalesce(p_vat_no, '')),
      notes = btrim(coalesce(p_notes, '')), is_active = coalesce(p_active, true)
    where id = p_id and company_id = v_co returning id into v_id;
    if v_id is null then raise exception 'Vendor not found'; end if;
    perform log_audit('accounting.vendor_changed', 'accounting', v_id::text, p_name, null, null);
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'A vendor named % already exists.', p_name;
end $$;
revoke all on function acc_save_vendor(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function acc_save_vendor(uuid, text, text, text, text, boolean) to authenticated;

-- p_id null = new payment, otherwise the journal entry of an existing payment. Returns that entry's id.
create or replace function acc_save_payment(p_id uuid, p_vendor uuid, p_date date, p_from uuid, p_for uuid, p_amount numeric, p_ref text, p_memo text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := acc_require_admin();
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_active boolean;
  v_old uuid;
  v_id uuid;
begin
  select is_active into v_active from acc_vendors where id = p_vendor and company_id = v_co;
  if not found then raise exception 'Choose a vendor.'; end if;
  if p_id is not null then
    select vendor_id into v_old from acc_entries where id = p_id and company_id = v_co;
    if v_old is null then raise exception 'Payment not found'; end if;
  end if;
  if not v_active and v_old is distinct from p_vendor then raise exception 'This vendor is inactive.'; end if;
  if v_amt <= 0 then raise exception 'Enter an amount greater than zero.'; end if;
  if p_from = p_for then raise exception 'The two accounts must be different.'; end if;
  if not exists (select 1 from acc_accounts where id = p_from and company_id = v_co and type = 'asset') then
    raise exception 'Pay from a cash or bank account.';
  end if;

  v_id := acc_post_entry(p_id, p_date, p_memo, p_ref, jsonb_build_array(
    jsonb_build_object('account_id', p_for, 'debit', v_amt),
    jsonb_build_object('account_id', p_from, 'credit', v_amt)));
  update acc_entries set vendor_id = p_vendor where id = v_id;
  return v_id;
end $$;
revoke all on function acc_save_payment(uuid, uuid, date, uuid, uuid, numeric, text, text) from public, anon;
grant execute on function acc_save_payment(uuid, uuid, date, uuid, uuid, numeric, text, text) to authenticated;
