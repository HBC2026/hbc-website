-- Accounting: client invoices, vendor bills, and the money received or paid against them.
--
--  * An invoice or bill is a document with lines. Saving it posts one journal entry:
--      invoice: debit receivable;              credit income lines and output VAT
--      bill:    debit cost lines and input VAT; credit payable
--  * A payment against it is an ordinary two-line journal entry tagged with the document (doc_id).
--    What is still owed is the total less those payments; nothing is stored twice.
--  * These entries cannot be edited from the Journal, Register or Payments screens, so the document and
--    the books cannot drift apart. A payment may be deleted anywhere, which puts the balance back.
--  * Invoices here are internal accounting records. They are not ZATCA e-invoices.
-- Read: administrator + viewer. Write: administrator. Run after 0041. Safe to re-run.

create table if not exists acc_docs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  kind text not null check (kind in ('invoice', 'bill')),
  doc_no int not null,
  doc_date date not null,
  due_date date not null,
  client_id uuid references clients (id),
  vendor_id uuid references acc_vendors (id),
  control_account_id uuid not null references acc_accounts (id),
  vat_account_id uuid references acc_accounts (id),
  vat_rate numeric(5, 4) not null default 0,
  subtotal numeric(14, 2) not null default 0,
  vat numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  reference text not null default '',
  memo text not null default '',
  entry_id uuid not null references acc_entries (id),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  unique (company_id, kind, doc_no),
  check ((kind = 'invoice') = (client_id is not null)),
  check ((kind = 'bill') = (vendor_id is not null))
);
create index if not exists acc_docs_entry_idx on acc_docs (entry_id);

create table if not exists acc_doc_lines (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references acc_docs (id) on delete cascade,
  company_id uuid not null references companies (id),
  position int not null,
  account_id uuid not null references acc_accounts (id),
  description text not null default '',
  qty numeric(14, 3) not null check (qty > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  amount numeric(14, 2) not null
);
create index if not exists acc_doc_lines_doc_idx on acc_doc_lines (doc_id);

alter table acc_entries add column if not exists doc_id uuid references acc_docs (id);
create index if not exists acc_entries_doc_idx on acc_entries (doc_id) where doc_id is not null;

alter table acc_docs enable row level security;
alter table acc_doc_lines enable row level security;
drop policy if exists acc_docs_read on acc_docs;
create policy acc_docs_read on acc_docs for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));
drop policy if exists acc_doc_lines_read on acc_doc_lines;
create policy acc_doc_lines_read on acc_doc_lines for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'viewer'));

-- ---------------------------------------------------------------- keep document entries in step
-- acc.doc_write is switched on only inside the functions below.
create or replace function acc_guard_doc_entry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('acc.doc_write', true), '') <> 'on' then
    if exists (select 1 from acc_docs where entry_id = old.id)
       or (tg_op = 'UPDATE' and old.doc_id is not null) then
      raise exception 'This entry belongs to an invoice or bill. Change it on the Invoices or Bills screen.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function acc_guard_doc_entry() from public, anon, authenticated;
drop trigger if exists acc_guard_doc_entry on acc_entries;
create trigger acc_guard_doc_entry before update or delete on acc_entries
  for each row execute function acc_guard_doc_entry();

-- ---------------------------------------------------------------- save an invoice or bill
-- p_party: client (invoice) or vendor (bill). p_lines: [{account_id, description, qty, unit_price}].
create or replace function acc_save_doc(
  p_id uuid, p_kind text, p_party uuid, p_date date, p_due date, p_control uuid,
  p_vat_rate numeric, p_vat_account uuid, p_ref text, p_memo text, p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := acc_require_admin();
  v_inv boolean := p_kind = 'invoice';
  v_old acc_docs;
  v_id uuid := p_id;
  v_no int;
  v_label text;
  v_party text;
  r jsonb;
  v_n int := 0;
  v_qty numeric; v_price numeric; v_acc acc_accounts;
  v_sub numeric := 0; v_vat numeric := 0; v_total numeric;
  v_paid numeric := 0;
  v_rate numeric := coalesce(p_vat_rate, 0);
  v_journal jsonb := '[]'::jsonb;
  v_entry uuid;
begin
  if p_kind is null or p_kind not in ('invoice', 'bill') then raise exception 'Invalid document type'; end if;
  if p_id is not null then
    select * into v_old from acc_docs where id = p_id and company_id = v_co and kind = p_kind for update;
    if not found then raise exception 'Document not found'; end if;
  end if;
  if p_date is null or p_due is null then raise exception 'Enter the date and due date.'; end if;
  if p_due < p_date then raise exception 'The due date cannot be before the document date.'; end if;

  if v_inv then
    select name into v_party from clients where id = p_party and company_id = v_co;
    if not found then raise exception 'Choose a client.'; end if;
  else
    select name into v_party from acc_vendors where id = p_party and company_id = v_co;
    if not found then raise exception 'Choose a vendor.'; end if;
  end if;

  if not exists (select 1 from acc_accounts where id = p_control and company_id = v_co
                 and kind = case when v_inv then 'receivable' else 'payable' end) then
    raise exception 'Choose a % account.', case when v_inv then 'receivable' else 'payable' end;
  end if;
  if v_rate < 0 or v_rate >= 1 then raise exception 'Invalid VAT rate.'; end if;
  if v_rate > 0 and not exists (select 1 from acc_accounts where id = p_vat_account and company_id = v_co
                                and id <> p_control and type = (case when v_inv then 'liability' else 'asset' end)::acc_type) then
    raise exception 'Choose the VAT account: % for %.',
      case when v_inv then 'a liability account' else 'an asset account' end,
      case when v_inv then 'an invoice' else 'a bill' end;
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.';
  end if;
  for r in select * from jsonb_array_elements(p_lines) loop
    v_qty := round(coalesce((r ->> 'qty')::numeric, 0), 3);
    v_price := round(coalesce((r ->> 'unit_price')::numeric, 0), 2);
    if v_qty <= 0 then raise exception 'Every line needs a quantity greater than zero.'; end if;
    if v_price < 0 then raise exception 'A unit price cannot be negative.'; end if;
    select * into v_acc from acc_accounts where id = (r ->> 'account_id')::uuid and company_id = v_co;
    if not found or v_acc.id = p_control then raise exception 'Choose an account on every line.'; end if;
    if v_inv and v_acc.type <> 'income' then raise exception 'An invoice line must use an income account.'; end if;
    if not v_inv and v_acc.type not in ('expense', 'asset') then raise exception 'A bill line must use an expense or asset account.'; end if;
    if round(v_qty * v_price, 2) <= 0 then raise exception 'Every line needs a price greater than zero.'; end if;
    v_sub := v_sub + round(v_qty * v_price, 2);
    v_journal := v_journal || jsonb_build_object(
      'account_id', v_acc.id,
      case when v_inv then 'credit' else 'debit' end, round(v_qty * v_price, 2),
      'memo', btrim(coalesce(r ->> 'description', '')));
    v_n := v_n + 1;
  end loop;

  v_vat := round(v_sub * v_rate, 2);
  v_total := v_sub + v_vat;
  if v_vat > 0 then
    v_journal := v_journal || jsonb_build_object(
      'account_id', p_vat_account, case when v_inv then 'credit' else 'debit' end, v_vat, 'memo', 'VAT');
  end if;
  v_journal := jsonb_build_array(jsonb_build_object(
    'account_id', p_control, case when v_inv then 'debit' else 'credit' end, v_total)) || v_journal;

  if v_id is not null then
    select coalesce(sum(case when v_inv then l.credit else l.debit end), 0) into v_paid
    from acc_entries e join acc_lines l on l.entry_id = e.id
    where e.doc_id = v_id and l.account_id = v_old.control_account_id;
    if exists (select 1 from acc_entries where doc_id = v_id) then
      if p_party <> coalesce(v_old.client_id, v_old.vendor_id) or p_control <> v_old.control_account_id then
        raise exception 'A payment is already recorded, so the % and account cannot change.', case when v_inv then 'client' else 'vendor' end;
      end if;
      if exists (select 1 from acc_entries where doc_id = v_id and entry_date < p_date) then
        raise exception 'A payment is dated before that date.';
      end if;
      if v_total < v_paid then
        raise exception 'The total cannot be less than the % already %.', to_char(v_paid, 'FM999,999,990.00'),
          case when v_inv then 'received' else 'paid' end;
      end if;
    end if;
    v_no := v_old.doc_no;
  else
    -- per-company running number; lock keeps two simultaneous saves from taking the same one
    perform pg_advisory_xact_lock(hashtext('acc_doc_no:' || v_co::text || p_kind));
    select coalesce(max(doc_no), 0) + 1 into v_no from acc_docs where company_id = v_co and kind = p_kind;
  end if;
  v_label := case when v_inv then 'INV-' else 'BILL-' end || lpad(v_no::text, 4, '0');

  perform set_config('acc.doc_write', 'on', true);
  v_entry := acc_post_entry(v_old.entry_id, p_date,
    case when v_inv then 'Invoice ' else 'Bill ' end || v_label || ' · ' || v_party,
    case when v_inv or btrim(coalesce(p_ref, '')) = '' then v_label else btrim(p_ref) end,
    v_journal);

  if v_id is null then
    insert into acc_docs (company_id, kind, doc_no, doc_date, due_date, client_id, vendor_id, control_account_id,
      vat_account_id, vat_rate, subtotal, vat, total, reference, memo, entry_id, created_by)
    values (v_co, p_kind, v_no, p_date, p_due, case when v_inv then p_party end, case when not v_inv then p_party end, p_control,
      case when v_vat > 0 then p_vat_account end, v_rate, v_sub, v_vat, v_total,
      btrim(coalesce(p_ref, '')), btrim(coalesce(p_memo, '')), v_entry, auth.uid())
    returning id into v_id;
  else
    update acc_docs set doc_date = p_date, due_date = p_due,
      client_id = case when v_inv then p_party end, vendor_id = case when not v_inv then p_party end,
      control_account_id = p_control, vat_account_id = case when v_vat > 0 then p_vat_account end, vat_rate = v_rate,
      subtotal = v_sub, vat = v_vat, total = v_total, reference = btrim(coalesce(p_ref, '')), memo = btrim(coalesce(p_memo, ''))
    where id = v_id;
    delete from acc_doc_lines where doc_id = v_id;
  end if;
  perform set_config('acc.doc_write', '', true);

  insert into acc_doc_lines (doc_id, company_id, position, account_id, description, qty, unit_price, amount)
  select v_id, v_co, x.ord, (x.v ->> 'account_id')::uuid, btrim(coalesce(x.v ->> 'description', '')),
         round((x.v ->> 'qty')::numeric, 3), round((x.v ->> 'unit_price')::numeric, 2),
         round(round((x.v ->> 'qty')::numeric, 3) * round((x.v ->> 'unit_price')::numeric, 2), 2)
  from jsonb_array_elements(p_lines) with ordinality as x(v, ord);

  perform log_audit('accounting.' || p_kind || case when p_id is null then '_added' else '_changed' end,
    'accounting', v_id::text, v_label, null, jsonb_build_object('date', p_date, 'amount', v_total, 'party', v_party));
  return v_id;
end $$;
revoke all on function acc_save_doc(uuid, text, uuid, date, date, uuid, numeric, uuid, text, text, jsonb) from public, anon;
grant execute on function acc_save_doc(uuid, text, uuid, date, date, uuid, numeric, uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- money received / paid against a document
create or replace function acc_pay_doc(p_doc uuid, p_date date, p_account uuid, p_amount numeric, p_ref text, p_memo text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := acc_require_admin();
  d acc_docs;
  v_inv boolean;
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_due numeric;
  v_label text;
  v_entry uuid;
begin
  -- the row lock stops two payments both taking the last of the balance
  select * into d from acc_docs where id = p_doc and company_id = v_co for update;
  if not found then raise exception 'Document not found'; end if;
  v_inv := d.kind = 'invoice';
  v_label := case when v_inv then 'INV-' else 'BILL-' end || lpad(d.doc_no::text, 4, '0');
  if p_date is null then raise exception 'Enter the date.'; end if;
  if p_date < d.doc_date then raise exception 'A payment cannot be dated before the %.', d.kind; end if;
  if v_amt <= 0 then raise exception 'Enter an amount greater than zero.'; end if;
  if not exists (select 1 from acc_accounts where id = p_account and company_id = v_co and type = 'asset' and kind <> 'receivable') then
    raise exception 'Choose a cash or bank account.';
  end if;
  select d.total - coalesce(sum(case when v_inv then l.credit else l.debit end), 0) into v_due
  from acc_entries e join acc_lines l on l.entry_id = e.id
  where e.doc_id = d.id and l.account_id = d.control_account_id;
  if v_amt > v_due then
    raise exception 'That is more than the % still owed.', to_char(v_due, 'FM999,999,990.00');
  end if;

  v_entry := acc_post_entry(null, p_date,
    coalesce(nullif(btrim(coalesce(p_memo, '')), ''), case when v_inv then 'Received for ' else 'Paid for ' end || v_label),
    p_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', case when v_inv then p_account else d.control_account_id end, 'debit', v_amt),
      jsonb_build_object('account_id', case when v_inv then d.control_account_id else p_account end, 'credit', v_amt)));
  perform set_config('acc.doc_write', 'on', true);
  -- a bill payment is also a payment to that vendor, so it appears on the Payments screen
  update acc_entries set doc_id = d.id, vendor_id = d.vendor_id where id = v_entry;
  perform set_config('acc.doc_write', '', true);
  return v_entry;
end $$;
revoke all on function acc_pay_doc(uuid, date, uuid, numeric, text, text) from public, anon;
grant execute on function acc_pay_doc(uuid, date, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------- delete a document
create or replace function acc_delete_doc(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := acc_require_admin(); d acc_docs;
begin
  select * into d from acc_docs where id = p_id and company_id = v_co for update;
  if not found then raise exception 'Document not found'; end if;
  if exists (select 1 from acc_entries where doc_id = d.id) then
    raise exception 'Delete the payments on this % first.', d.kind;
  end if;
  perform set_config('acc.doc_write', 'on', true);
  delete from acc_docs where id = d.id;
  delete from acc_entries where id = d.entry_id;
  perform set_config('acc.doc_write', '', true);
  perform log_audit('accounting.' || d.kind || '_deleted', 'accounting', d.id::text,
    case when d.kind = 'invoice' then 'INV-' else 'BILL-' end || lpad(d.doc_no::text, 4, '0'),
    jsonb_build_object('date', d.doc_date, 'amount', d.total), null);
end $$;
revoke all on function acc_delete_doc(uuid) from public, anon;
grant execute on function acc_delete_doc(uuid) to authenticated;

-- ---------------------------------------------------------------- list with what has been paid
-- p_as_at null = today's position. Otherwise only documents and payments dated up to then.
create or replace function acc_doc_list(p_kind text, p_as_at date)
returns table (
  id uuid, doc_no int, doc_date date, due_date date, party_id uuid, control_account_id uuid, vat_account_id uuid,
  vat_rate numeric, subtotal numeric, vat numeric, total numeric, paid numeric, reference text, memo text
)
language sql stable security definer set search_path = public as $$
  select d.id, d.doc_no, d.doc_date, d.due_date, coalesce(d.client_id, d.vendor_id), d.control_account_id, d.vat_account_id,
         d.vat_rate, d.subtotal, d.vat, d.total,
         coalesce((select sum(case when d.kind = 'invoice' then l.credit else l.debit end)
                   from acc_entries e join acc_lines l on l.entry_id = e.id
                   where e.doc_id = d.id and l.account_id = d.control_account_id
                     and (p_as_at is null or e.entry_date <= p_as_at)), 0),
         d.reference, d.memo
  from acc_docs d
  where d.company_id = current_company()
    and has_role('administrator', 'viewer')
    and d.kind = p_kind
    and (p_as_at is null or d.doc_date <= p_as_at)
  order by d.doc_date desc, d.doc_no desc
$$;
revoke all on function acc_doc_list(text, date) from public, anon;
grant execute on function acc_doc_list(text, date) to authenticated;
