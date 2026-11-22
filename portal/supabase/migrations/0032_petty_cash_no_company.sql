-- Petty cash no longer belongs to a company.
--
-- Cash given, receipts and the employee's private link are now one shared ledger. Staff who can see petty cash in
-- ANY company see it all, whichever company is selected in the portal: administrators and payroll can record and
-- review, viewers can read. The employees listed are those of every company the user belongs to.
-- (Employees, payroll and attendance stay per company; nothing changes there.)
--
-- Run once in the SQL editor, after 0031.

-- ---------------------------------------------------------------- staff check that ignores the selected company
create or replace function pc_is_staff(p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from company_members
    where user_id = auth.uid()
      and role::text = any (case when p_write then array['administrator', 'payroll'] else array['administrator', 'payroll', 'viewer'] end))
$$;
grant execute on function pc_is_staff(boolean) to authenticated;

create or replace function pc_require_writer() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not pc_is_staff(true) then raise exception 'Not permitted' using errcode = '42501'; end if;
end $$;
revoke all on function pc_require_writer() from public, anon, authenticated;

-- ---------------------------------------------------------------- policies that mentioned company_id (must go before the columns)
drop policy pc_cash_read on pc_cash_given;
drop policy pc_receipts_read on pc_receipts;
drop policy pc_receipts_view on storage.objects;

alter table pc_access drop column company_id;
alter table pc_cash_given drop column company_id;
alter table pc_receipts drop column company_id;   -- also drops the indexes that included it

create policy pc_cash_read on pc_cash_given for select to authenticated using (pc_is_staff(false));
create policy pc_receipts_read on pc_receipts for select to authenticated using (pc_is_staff(false));
create policy pc_receipts_view on storage.objects for select to authenticated
  using (bucket_id = 'petty-cash-receipts' and pc_is_staff(false)
         and exists (select 1 from pc_receipts r where r.file_path = name));

-- the same file may not be a live receipt twice (now across the whole ledger)
do $$ begin
  create unique index pc_receipts_hash_uidx on pc_receipts (file_hash) where file_hash is not null and status <> 'rejected';
exception when unique_violation then
  raise notice 'Same receipt file exists in both companies; keeping a non-unique index. The app still blocks new duplicates.';
  create index pc_receipts_hash_uidx on pc_receipts (file_hash) where file_hash is not null and status <> 'rejected';
end $$;
create index pc_receipts_dup_idx on pc_receipts (amount, spent_on);

-- ---------------------------------------------------------------- helpers
drop function if exists pc_employee_label(uuid, uuid);
create or replace function pc_employee_label(p_employee uuid) returns text
language sql stable security definer set search_path = public as $$
  select emp_code || ' ' || name from employees where id = p_employee
$$;
revoke all on function pc_employee_label(uuid) from public, anon, authenticated;

-- Employees of every company the user belongs to (the employees table itself only shows the selected company).
create or replace function pc_people()
returns table (id uuid, emp_code text, name text, job_title text, status text)
language sql stable security definer set search_path = public as $$
  select e.id, e.emp_code, e.name, e.job_title, e.status::text
  from employees e
  where pc_is_staff(false)
    and e.company_id in (select m.company_id from company_members m where m.user_id = auth.uid())
$$;
grant execute on function pc_people() to authenticated;

-- ---------------------------------------------------------------- summary
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
  where pc_is_staff(false)
    and e.company_id in (select m.company_id from company_members m where m.user_id = auth.uid())
$$;
grant execute on function pc_summary() to authenticated;

-- ---------------------------------------------------------------- staff actions
create or replace function pc_give_cash(p_employee uuid, p_amount numeric, p_date date, p_note text, p_given_by text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_label text;
begin
  perform pc_require_writer();
  v_label := pc_employee_label(p_employee);
  if v_label is null then raise exception 'Employee not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  if btrim(coalesce(p_given_by, '')) = '' then raise exception 'Enter the name of the person who gave the cash.'; end if;
  insert into pc_cash_given (employee_id, amount, given_on, note, given_by, created_by)
  values (p_employee, round(p_amount, 2), coalesce(p_date, current_date), btrim(coalesce(p_note, '')), btrim(p_given_by), auth.uid())
  returning id into v_id;
  perform log_audit('petty_cash.given', 'petty_cash', v_id::text, v_label, null,
    jsonb_build_object('amount', round(p_amount, 2), 'date', coalesce(p_date, current_date), 'note', btrim(coalesce(p_note, '')), 'given_by', btrim(p_given_by)));
  return v_id;
end $$;
grant execute on function pc_give_cash(uuid, numeric, date, text, text) to authenticated;

create or replace function pc_delete_cash(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c pc_cash_given;
begin
  perform pc_require_writer();
  select * into c from pc_cash_given where id = p_id;
  if not found then raise exception 'Entry not found'; end if;
  delete from pc_cash_given where id = p_id;
  perform log_audit('petty_cash.cash_deleted', 'petty_cash', p_id::text, pc_employee_label(c.employee_id),
    jsonb_build_object('amount', c.amount, 'date', c.given_on, 'note', c.note, 'given_by', c.given_by), null);
end $$;
grant execute on function pc_delete_cash(uuid) to authenticated;

create or replace function pc_review_receipt(p_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r pc_receipts;
begin
  perform pc_require_writer();
  if p_status not in ('approved', 'rejected') then raise exception 'Invalid status'; end if;
  if p_status = 'rejected' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Enter a reason so the employee knows what to upload again.';
  end if;
  select * into r from pc_receipts where id = p_id;
  if not found then raise exception 'Receipt not found'; end if;
  if p_status = 'approved' and exists (select 1 from pc_receipts where replaces_id = p_id) then
    raise exception 'The employee already submitted a revised receipt. Review that one instead.';
  end if;
  update pc_receipts set status = p_status,
    reject_reason = case when p_status = 'rejected' then btrim(p_reason) else '' end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;
  perform log_audit('petty_cash.receipt_' || p_status, 'petty_cash', p_id::text, pc_employee_label(r.employee_id),
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status, 'amount', r.amount, 'reason', btrim(coalesce(p_reason, ''))));
end $$;
grant execute on function pc_review_receipt(uuid, text, text) to authenticated;

create or replace function pc_get_link(p_employee uuid, p_regenerate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare v_token text;
begin
  perform pc_require_writer();
  if pc_employee_label(p_employee) is null then raise exception 'Employee not found'; end if;
  if p_regenerate then
    delete from pc_access where employee_id = p_employee;
    perform log_audit('petty_cash.link_regenerated', 'petty_cash', p_employee::text, pc_employee_label(p_employee), null, null);
  end if;
  insert into pc_access (employee_id) values (p_employee) on conflict (employee_id) do nothing;
  select token into v_token from pc_access where employee_id = p_employee;
  return v_token;
end $$;
grant execute on function pc_get_link(uuid, boolean) to authenticated;

create or replace function pc_duplicate_info(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pc_is_staff(false) then raise exception 'Not permitted' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_object_agg(r.id, jsonb_build_object('id', o.id, 'employee', e.emp_code || ' ' || e.name, 'amount', o.amount,
                                                      'date', o.spent_on, 'status', o.status, 'description', o.description))
    from pc_receipts r
    join pc_receipts o on o.id = r.dup_of
    join employees e on e.id = o.employee_id
    where r.id = any(p_ids)
  ), '{}'::jsonb);
end $$;
grant execute on function pc_duplicate_info(uuid[]) to authenticated;

-- ---------------------------------------------------------------- employee page (token = credential)
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

create or replace function pc_add_receipt(p_token text, p_amount numeric, p_date date, p_description text, p_file_path text,
                                          p_replaces uuid default null, p_file_hash text default null, p_confirm_dup boolean default false, p_site text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a pc_access; v_id uuid; old pc_receipts; v_dup uuid; v_hash text := nullif(lower(btrim(coalesce(p_file_hash, ''))), '');
begin
  select a2.* into a from pc_access a2 join employees e on e.id = a2.employee_id
  where a2.token = p_token and e.status = 'active';
  if not found then raise exception 'This link is no longer valid. Ask the office for a new one.' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Enter the receipt amount.'; end if;
  if p_date is null or p_date > current_date + 1 then raise exception 'Enter the date on the receipt.'; end if;
  if btrim(coalesce(p_description, '')) = '' then raise exception 'Say what the money was spent on.'; end if;
  if btrim(coalesce(p_site, '')) = '' then raise exception 'Enter the site name.'; end if;
  if p_file_path is null or p_file_path not like p_token || '/%' or length(p_file_path) > 300 then
    raise exception 'Attach a photo of the receipt.';
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then raise exception 'Attach a photo of the receipt.'; end if;
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

  -- same file already submitted by anyone
  if v_hash is not null and exists (select 1 from pc_receipts where file_hash = v_hash and status <> 'rejected') then
    raise exception 'DUPLICATE_FILE: This receipt was already uploaded. The same receipt cannot be submitted twice.';
  end if;

  -- same amount on the same date as another live receipt: employee must confirm, office is told
  select id into v_dup from pc_receipts
  where amount = round(p_amount, 2) and spent_on = p_date and status <> 'rejected'
    and id is distinct from p_replaces
  order by created_at limit 1;
  if v_dup is not null and not coalesce(p_confirm_dup, false) then
    raise exception 'DUPLICATE_AMOUNT: A receipt with the same amount and date was already submitted. Submit this one only if it is a different purchase.';
  end if;

  insert into pc_receipts (employee_id, amount, spent_on, description, file_path, replaces_id, file_hash, dup_of, site)
  values (a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path, p_replaces, v_hash, v_dup, btrim(p_site))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text, uuid, text, boolean, text) to anon, authenticated;

drop function if exists pc_require_staff();
