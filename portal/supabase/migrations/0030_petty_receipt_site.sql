-- Petty cash: every receipt records the site it was spent at.
-- Run once in the SQL editor, after 0029.

alter table pc_receipts add column site text not null default '';

drop function pc_add_receipt(text, numeric, date, text, text, uuid, text, boolean);

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

  -- same file already submitted by anyone in this company
  if v_hash is not null and exists (select 1 from pc_receipts where company_id = a.company_id and file_hash = v_hash and status <> 'rejected') then
    raise exception 'DUPLICATE_FILE: This receipt was already uploaded. The same receipt cannot be submitted twice.';
  end if;

  -- same amount on the same date as another live receipt: employee must confirm, office is told
  select id into v_dup from pc_receipts
  where company_id = a.company_id and amount = round(p_amount, 2) and spent_on = p_date and status <> 'rejected'
    and id is distinct from p_replaces
  order by created_at limit 1;
  if v_dup is not null and not coalesce(p_confirm_dup, false) then
    raise exception 'DUPLICATE_AMOUNT: A receipt with the same amount and date was already submitted. Submit this one only if it is a different purchase.';
  end if;

  insert into pc_receipts (company_id, employee_id, amount, spent_on, description, file_path, replaces_id, file_hash, dup_of, site)
  values (a.company_id, a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path, p_replaces, v_hash, v_dup, btrim(p_site))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text, uuid, text, boolean, text) to anon, authenticated;
