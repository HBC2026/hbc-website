-- Job title and department are optional: payroll checks only require the employee name.
create or replace function payroll_issues(p_period uuid)
returns table (employee_id uuid, emp_code text, name text, severity text, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  pr payroll_periods;
  v_first date; v_last date;
  e employees; en payroll_entries;
  v_missing int; v_first_missing date; v_bad_ot int;
begin
  if not has_role('administrator', 'payroll', 'viewer') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into pr from payroll_periods where id = p_period and company_id = v_co;
  if not found then raise exception 'Payroll period not found'; end if;
  v_first := coalesce(pr.start_date, make_date(pr.year, pr.month, 1));
  v_last := coalesce(pr.end_date, (make_date(pr.year, pr.month, 1) + interval '1 month - 1 day')::date);

  if pr.calculated_at is null then
    return query select null::uuid, null::text, null::text, 'error', 'Payroll has not been calculated yet.';
    return;
  end if;
  if exists (select 1 from attendance a where a.company_id = v_co and a.work_date between v_first and v_last and a.updated_at > pr.calculated_at) then
    return query select null::uuid, null::text, null::text, 'error',
      'Attendance changed after the last calculation. Recalculate before approving.';
  end if;

  for e in select * from employees where company_id = v_co
    and (status = 'active' or last_working_date >= v_first)
    and (pr.employee_ids is null or employees.id = any(pr.employee_ids)) order by employees.emp_code loop
    if btrim(e.name) = '' then
      return query select e.id, e.emp_code, e.name, 'error', 'Missing employee information (name).';
    end if;
    if e.basic_salary <= 0 then
      return query select e.id, e.emp_code, e.name, 'error', 'Missing salary information (basic salary is zero).';
    end if;
    select count(*), min(d::date) into v_missing, v_first_missing
    from generate_series(greatest(v_first, e.joining_date), least(v_last, coalesce(e.last_working_date, v_last)), interval '1 day') d
    where not exists (select 1 from attendance a where a.employee_id = e.id and a.work_date = d::date);
    if v_missing > 0 then
      return query select e.id, e.emp_code, e.name, 'error',
        format('Missing attendance for %s day(s), first on %s.', v_missing, to_char(v_first_missing, 'DD Mon YYYY'));
    end if;

    select count(*) filter (where a.ot_amount > 0 and a.status not in ('present', 'holiday', 'weekly_off'))
    into v_bad_ot
    from attendance a where a.employee_id = e.id and a.work_date between v_first and v_last;
    if v_bad_ot > 0 then
      return query select e.id, e.emp_code, e.name, 'error',
        format('Invalid OT: %s day(s) have overtime on a status other than Present, Holiday or Weekly Off.', v_bad_ot);
    end if;

    select * into en from payroll_entries pe where pe.period_id = p_period and pe.employee_id = e.id;
    if not found then
      return query select e.id, e.emp_code, e.name, 'error', 'No payroll entry. Recalculate payroll.';
    end if;
  end loop;
end $$;
grant execute on function payroll_issues(uuid) to authenticated;
