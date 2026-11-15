-- Petty cash: a submitted receipt can never be deleted by the employee.
--
-- Before, an employee could remove a pending or rejected receipt (pc_delete_receipt). Now every
-- submission stays on record. When the office rejects a receipt it is asking for a revised one:
-- the employee submits a new receipt that points at the rejected one (replaces_id). The rejected
-- receipt stays in the history, still marked rejected, and can be revised only once.
--
-- Run once in the SQL editor, after 0008 and 0010.

alter table pc_receipts add column replaces_id uuid references pc_receipts (id) on delete set null;
create unique index pc_receipts_replaces_uidx on pc_receipts (replaces_id) where replaces_id is not null;

-- no more employee-side deletes
drop function pc_delete_receipt(text, uuid);

-- ---------------------------------------------------------------- add (optionally as a revision)
drop function pc_add_receipt(text, numeric, date, text, text);

create or replace function pc_add_receipt(p_token text, p_amount numeric, p_date date, p_description text, p_file_path text,
                                          p_replaces uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a pc_access; v_id uuid; old pc_receipts;
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
  if p_replaces is not null then
    select * into old from pc_receipts where id = p_replaces and employee_id = a.employee_id for update;
    if not found or old.status <> 'rejected' then
      raise exception 'Only a rejected receipt can be revised.';
    end if;
    if exists (select 1 from pc_receipts where replaces_id = p_replaces) then
      raise exception 'A revised receipt was already submitted for this one.';
    end if;
  end if;
  insert into pc_receipts (company_id, employee_id, amount, spent_on, description, file_path, replaces_id)
  values (a.company_id, a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path, p_replaces)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------- review: do not approve a receipt that was already revised
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
  if p_status = 'approved' and exists (select 1 from pc_receipts where replaces_id = p_id) then
    raise exception 'The employee already submitted a revised receipt. Review that one instead.';
  end if;
  update pc_receipts set status = p_status,
    reject_reason = case when p_status = 'rejected' then btrim(p_reason) else '' end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;
  perform log_audit('petty_cash.receipt_' || p_status, 'petty_cash', p_id::text, pc_employee_label(r.employee_id, v_co),
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status, 'amount', r.amount, 'reason', btrim(coalesce(p_reason, ''))));
end $$;
grant execute on function pc_review_receipt(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- statement: expose the revision links
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
    'cash', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', given_on, 'note', note, 'given_by', given_by)
                                       order by given_on desc, created_at desc)
                      from pc_cash_given where employee_id = e.id), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'date', r.spent_on, 'description', r.description,
                                       'status', r.status, 'reject_reason', r.reject_reason,
                                       'replaces_id', r.replaces_id,
                                       'revised', exists (select 1 from pc_receipts n where n.replaces_id = r.id))
                                       order by r.spent_on desc, r.created_at desc)
                          from pc_receipts r where r.employee_id = e.id), '[]'::jsonb)
  );
end $$;
grant execute on function pc_statement(text) to anon, authenticated;
