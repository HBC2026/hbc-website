-- Quotations: numbering, revisions (never overwritten), totals calculated server-side

create or replace function write_quotation_revision(p_quotation uuid, p_rev int, p jsonb, p_note text)
returns quotation_revisions
language plpgsql security definer set search_path = public as $$
declare
  v_rev quotation_revisions;
  v_sub numeric; v_disc numeric; v_rate numeric; v_vat numeric;
  it jsonb; v_pos int := 0;
begin
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'A quotation needs at least one line item.';
  end if;
  if btrim(coalesce(p ->> 'client', '')) = '' then
    raise exception 'Client is required.';
  end if;

  select coalesce(sum(round((i ->> 'qty')::numeric * (i ->> 'unit_price')::numeric, 2)), 0)
  into v_sub from jsonb_array_elements(p -> 'items') i;
  v_disc := coalesce((p ->> 'discount')::numeric, 0);
  v_rate := coalesce((p ->> 'vat_rate')::numeric, setting_num('vat_rate', 0.15));
  if v_disc < 0 or v_disc > v_sub then
    raise exception 'Discount must be between 0 and the subtotal.';
  end if;
  v_vat := round((v_sub - v_disc) * v_rate, 2);

  insert into quotation_revisions (
    quotation_id, revision, client, attention, project, quote_date, validity_days, reference,
    subtotal, discount, vat_rate, vat_amount, grand_total, payment_terms, delivery, notes, revision_note, created_by
  ) values (
    p_quotation, p_rev, btrim(p ->> 'client'), coalesce(p ->> 'attention', ''), coalesce(p ->> 'project', ''),
    coalesce((p ->> 'quote_date')::date, current_date), coalesce((p ->> 'validity_days')::int, 30),
    coalesce(p ->> 'reference', ''), v_sub, v_disc, v_rate, v_vat, v_sub - v_disc + v_vat,
    coalesce(p ->> 'payment_terms', ''), coalesce(p ->> 'delivery', ''), coalesce(p ->> 'notes', ''),
    coalesce(p_note, ''), auth.uid()
  ) returning * into v_rev;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_pos := v_pos + 1;
    insert into quotation_items (revision_id, position, description, qty, unit, unit_price)
    values (v_rev.id, v_pos, btrim(it ->> 'description'), (it ->> 'qty')::numeric,
            coalesce(nullif(it ->> 'unit', ''), 'Nos'), (it ->> 'unit_price')::numeric);
  end loop;
  return v_rev;
end $$;
revoke all on function write_quotation_revision(uuid, int, jsonb, text) from public, anon, authenticated;

create or replace function create_quotation(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_year int; v_seq int; v_number text; v_id uuid; v_rev quotation_revisions;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  v_year := extract(year from coalesce((p ->> 'quote_date')::date, current_date))::int;
  perform pg_advisory_xact_lock(hashtext('quotation_number'));
  select coalesce(max(right(number, 4)::int), 0) + 1 into v_seq
  from quotations where number like 'HBC-QT-' || v_year || '-%';
  v_number := 'HBC-QT-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into quotations (number, created_by) values (v_number, auth.uid()) returning id into v_id;
  v_rev := write_quotation_revision(v_id, 0, p, 'Original');
  update quotations set client = v_rev.client, project = v_rev.project, quote_date = v_rev.quote_date,
    amount = v_rev.grand_total where id = v_id;

  perform log_audit('quotation.created', 'quotation', v_id::text, v_number, null,
    jsonb_build_object('client', v_rev.client, 'project', v_rev.project, 'grand_total', v_rev.grand_total));
  return v_id;
end $$;

create or replace function revise_quotation(p_id uuid, p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  q quotations; v_rev quotation_revisions; v_next int;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id for update;
  if not found then raise exception 'Quotation not found'; end if;
  v_next := q.current_revision + 1;
  v_rev := write_quotation_revision(p_id, v_next, p, p ->> 'revision_note');
  update quotations set current_revision = v_next, status = 'revised', client = v_rev.client,
    project = v_rev.project, quote_date = v_rev.quote_date, amount = v_rev.grand_total, updated_at = now()
  where id = p_id;

  perform log_audit('quotation.revised', 'quotation', p_id::text, q.number || ' R' || v_next,
    jsonb_build_object('revision', q.current_revision, 'grand_total', q.amount),
    jsonb_build_object('revision', v_next, 'grand_total', v_rev.grand_total));
  return v_next;
end $$;

create or replace function set_quotation_status(p_id uuid, p_status quotation_status) returns void
language plpgsql security definer set search_path = public as $$
declare q quotations;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id for update;
  if not found then raise exception 'Quotation not found'; end if;
  if q.status = p_status then return; end if;
  update quotations set status = p_status, updated_at = now() where id = p_id;
  perform log_audit('quotation.status_changed', 'quotation', p_id::text, q.number,
    jsonb_build_object('status', q.status), jsonb_build_object('status', p_status));
end $$;

grant execute on function create_quotation(jsonb), revise_quotation(uuid, jsonb),
  set_quotation_status(uuid, quotation_status) to authenticated;
