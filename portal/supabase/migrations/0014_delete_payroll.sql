-- Delete a payroll run (period + its entries and salary slips, via cascade) unless it is completed.
create or replace function delete_payroll(p_period uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); pr payroll_periods; v_entries int; v_slips int;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into pr from payroll_periods where id = p_period and company_id = v_co for update;
  if not found then raise exception 'Payroll period not found'; end if;
  if pr.status = 'completed' then
    raise exception 'A completed payroll cannot be deleted.';
  end if;
  select count(*) into v_entries from payroll_entries where period_id = p_period;
  select count(*) into v_slips from salary_slips where period_id = p_period;

  perform log_audit('payroll.deleted', 'payroll_period', p_period::text,
    to_char(make_date(pr.year, pr.month, 1), 'Mon YYYY'),
    jsonb_build_object('status', pr.status, 'entries', v_entries, 'slips', v_slips), null);
  delete from payroll_periods where id = p_period;
end $$;

grant execute on function delete_payroll(uuid) to authenticated;
