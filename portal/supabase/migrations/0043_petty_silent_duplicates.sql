-- Petty cash: the employee is never told that a receipt looks like a duplicate. Only the office is warned.
--
-- Before this, the same file was refused and a matching amount + date asked the employee to confirm. Now both are
-- accepted like any other receipt and linked to the earlier one (dup_of) for the office to review.
-- Safe to run more than once.

-- the same file may now be saved twice, so the lookup index must not be unique
drop index if exists pc_receipts_hash_uidx;
create index pc_receipts_hash_uidx on pc_receipts (file_hash) where file_hash is not null and status <> 'rejected';

-- p_confirm_dup is no longer used; it stays so that pages loaded before this change keep working
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

  -- possible duplicate of another live receipt: the same file first, otherwise the same amount on the same date
  if v_hash is not null then
    select id into v_dup from pc_receipts
    where file_hash = v_hash and status <> 'rejected' and id is distinct from p_replaces
    order by created_at limit 1;
  end if;
  if v_dup is null then
    select id into v_dup from pc_receipts
    where amount = round(p_amount, 2) and spent_on = p_date and status <> 'rejected' and id is distinct from p_replaces
    order by created_at limit 1;
  end if;

  insert into pc_receipts (employee_id, amount, spent_on, description, file_path, replaces_id, file_hash, dup_of, site)
  values (a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path, p_replaces, v_hash, v_dup, btrim(p_site))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text, uuid, text, boolean, text) to anon, authenticated;

-- staff: the receipt a flagged one may duplicate, and whether it is the very same file
create or replace function pc_duplicate_info(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pc_is_staff(false) then raise exception 'Not permitted' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_object_agg(r.id, jsonb_build_object('id', o.id, 'employee', e.emp_code || ' ' || e.name, 'amount', o.amount,
                                                      'date', o.spent_on, 'status', o.status, 'description', o.description,
                                                      'same_file', coalesce(o.file_hash = r.file_hash, false)))
    from pc_receipts r
    join pc_receipts o on o.id = r.dup_of
    join employees e on e.id = o.employee_id
    where r.id = any(p_ids)
  ), '{}'::jsonb);
end $$;
grant execute on function pc_duplicate_info(uuid[]) to authenticated;
