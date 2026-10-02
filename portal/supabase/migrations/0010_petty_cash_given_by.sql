-- Petty cash: record the name of the person who handed over the cash.
-- pc_give_cash gets a required p_given_by; pc_delete_cash (audit) and pc_statement (employee page) include it.

alter table pc_cash_given add column given_by text not null default '';

drop function pc_give_cash(uuid, numeric, date, text);

create or replace function pc_give_cash(p_employee uuid, p_amount numeric, p_date date, p_note text, p_given_by text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  v_id uuid;
  v_label text := pc_employee_label(p_employee, v_co);
begin
  if v_label is null then raise exception 'Employee not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  if btrim(coalesce(p_given_by, '')) = '' then raise exception 'Enter the name of the person who gave the cash.'; end if;
  insert into pc_cash_given (company_id, employee_id, amount, given_on, note, given_by, created_by)
  values (v_co, p_employee, round(p_amount, 2), coalesce(p_date, current_date), btrim(coalesce(p_note, '')), btrim(p_given_by), auth.uid())
  returning id into v_id;
  perform log_audit('petty_cash.given', 'petty_cash', v_id::text, v_label, null,
    jsonb_build_object('amount', round(p_amount, 2), 'date', coalesce(p_date, current_date), 'note', btrim(coalesce(p_note, '')), 'given_by', btrim(p_given_by)));
  return v_id;
end $$;
grant execute on function pc_give_cash(uuid, numeric, date, text, text) to authenticated;

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
    jsonb_build_object('amount', c.amount, 'date', c.given_on, 'note', c.note, 'given_by', c.given_by), null);
end $$;
grant execute on function pc_delete_cash(uuid) to authenticated;

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
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', spent_on, 'description', description,
                                       'status', status, 'reject_reason', reject_reason)
                                       order by spent_on desc, created_at desc)
                          from pc_receipts where employee_id = e.id), '[]'::jsonb)
  );
end $$;
grant execute on function pc_statement(text) to anon, authenticated;
