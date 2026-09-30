-- Payroll workflow: Attendance → Calculate → Review → Approve → Slips → Signed copies → Complete
-- All writes to payroll tables go through these security-definer functions so that
-- calculation, locking and audit rows are atomic and cannot be bypassed by the client.

create or replace function setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::numeric from settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------- calculate
create or replace function calculate_payroll(p_year int, p_month int) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_period payroll_periods;
  v_first date := make_date(p_year, p_month, 1);
  v_last date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_mult numeric := setting_num('ot_multiplier', 1.5);
  v_std numeric := setting_num('standard_hours', 8);
  v_div numeric := setting_num('days_divisor', 30);
  e employees;
  a record;
  v_hourly numeric; v_ot_rate numeric; v_ot_amt numeric; v_abs numeric;
  v_entry payroll_entries;
  v_oth_e numeric; v_oth_d numeric; v_ded numeric; v_net numeric;
  v_count int := 0;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  insert into payroll_periods (year, month) values (p_year, p_month)
  on conflict (year, month) do nothing;
  select * into v_period from payroll_periods where year = p_year and month = p_month for update;

  if v_period.status in ('approved', 'completed') then
    raise exception 'Payroll for % is approved and locked. Reopen it first.', to_char(v_first, 'Mon YYYY');
  end if;

  for e in select * from employees where status = 'active' order by emp_code loop
    select
      count(*) filter (where status = 'present') as present_days,
      count(*) filter (where status in ('absent', 'unpaid_leave')) as unpaid_days,
      coalesce(sum(regular_hours), 0) as reg_h,
      coalesce(sum(ot_hours), 0) as ot_h,
      jsonb_build_object(
        'present', count(*) filter (where status = 'present'),
        'absent', count(*) filter (where status = 'absent'),
        'annual_leave', count(*) filter (where status = 'annual_leave'),
        'sick_leave', count(*) filter (where status = 'sick_leave'),
        'unpaid_leave', count(*) filter (where status = 'unpaid_leave'),
        'holiday', count(*) filter (where status = 'holiday'),
        'weekly_off', count(*) filter (where status = 'weekly_off')
      ) as counts
    into a
    from attendance
    where employee_id = e.id and work_date between v_first and v_last;

    v_hourly := round(e.basic_salary / v_div / v_std, 4);
    if e.ot_method = 'fixed' then
      v_ot_rate := coalesce(e.ot_rate, 0);
    else
      v_ot_rate := round(v_hourly * coalesce(e.ot_rate, v_mult), 2);
    end if;
    v_ot_amt := round(a.ot_h * v_ot_rate, 2);
    v_abs := round(a.unpaid_days * e.basic_salary / v_div, 2);

    select other_earnings, other_deductions into v_oth_e, v_oth_d
    from payroll_entries where period_id = v_period.id and employee_id = e.id;
    v_oth_e := coalesce(v_oth_e, 0);
    v_oth_d := coalesce(v_oth_d, 0);
    v_ded := v_abs + v_oth_d;
    v_net := e.basic_salary + e.allowances + v_ot_amt + v_oth_e - v_ded;

    insert into payroll_entries (
      period_id, employee_id, basic, allowances, present_days, unpaid_days, regular_hours, ot_hours,
      ot_rate, ot_amount, other_earnings, absence_deduction, other_deductions, deductions, net_salary, breakdown
    ) values (
      v_period.id, e.id, e.basic_salary, e.allowances, a.present_days, a.unpaid_days, a.reg_h, a.ot_h,
      v_ot_rate, v_ot_amt, v_oth_e, v_abs, v_oth_d, v_ded, v_net,
      jsonb_build_object(
        'hourly_rate', v_hourly, 'daily_rate', round(e.basic_salary / v_div, 2),
        'ot_method', e.ot_method, 'ot_multiplier', coalesce(e.ot_rate, v_mult),
        'days_divisor', v_div, 'standard_hours', v_std, 'counts', a.counts
      )
    )
    on conflict (period_id, employee_id) do update set
      basic = excluded.basic, allowances = excluded.allowances, present_days = excluded.present_days,
      unpaid_days = excluded.unpaid_days, regular_hours = excluded.regular_hours, ot_hours = excluded.ot_hours,
      ot_rate = excluded.ot_rate, ot_amount = excluded.ot_amount,
      absence_deduction = excluded.absence_deduction, deductions = excluded.deductions,
      net_salary = excluded.net_salary, breakdown = excluded.breakdown;
    v_count := v_count + 1;
  end loop;

  delete from payroll_entries
  where period_id = v_period.id and employee_id not in (select id from employees where status = 'active');

  update payroll_periods set status = 'calculated', calculated_at = now() where id = v_period.id;

  perform log_audit('payroll.calculated', 'payroll_period', v_period.id::text,
    to_char(v_first, 'Mon YYYY'), jsonb_build_object('status', v_period.status),
    jsonb_build_object('status', 'calculated', 'employees', v_count));
  return v_period.id;
end $$;

-- ---------------------------------------------------------------- manual adjustments
create or replace function update_entry_adjustment(
  p_entry uuid, p_other_earnings numeric, p_other_deductions numeric, p_note text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  en payroll_entries; pr payroll_periods; v_label text;
  v_ded numeric; v_net numeric;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into en from payroll_entries where id = p_entry for update;
  if not found then raise exception 'Payroll entry not found'; end if;
  select * into pr from payroll_periods where id = en.period_id;
  if pr.status in ('approved', 'completed') then
    raise exception 'Payroll period is locked';
  end if;
  if p_other_earnings < 0 or p_other_deductions < 0 then
    raise exception 'Amounts cannot be negative';
  end if;

  v_ded := en.absence_deduction + p_other_deductions;
  v_net := en.basic + en.allowances + en.ot_amount + p_other_earnings - v_ded;
  update payroll_entries set other_earnings = p_other_earnings, other_deductions = p_other_deductions,
    deductions = v_ded, net_salary = v_net, adjustment_note = coalesce(p_note, '')
  where id = p_entry;

  select emp_code || ' ' || name into v_label from employees where id = en.employee_id;
  perform log_audit('payroll.adjusted', 'payroll_period', pr.id::text, v_label || ' · ' || to_char(make_date(pr.year, pr.month, 1), 'Mon YYYY'),
    jsonb_build_object('other_earnings', en.other_earnings, 'other_deductions', en.other_deductions, 'net', en.net_salary),
    jsonb_build_object('other_earnings', p_other_earnings, 'other_deductions', p_other_deductions, 'net', v_net));
end $$;

-- ---------------------------------------------------------------- validation
create or replace function payroll_issues(p_period uuid)
returns table (employee_id uuid, emp_code text, name text, severity text, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  pr payroll_periods;
  v_first date; v_last date;
  v_max_ot numeric := setting_num('max_ot_per_day', 6);
  e employees; en payroll_entries;
  v_missing int; v_first_missing date; v_bad_ot int; v_high_ot int;
begin
  if not has_role('administrator', 'payroll', 'viewer') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into pr from payroll_periods where id = p_period;
  if not found then raise exception 'Payroll period not found'; end if;
  v_first := make_date(pr.year, pr.month, 1);
  v_last := (v_first + interval '1 month - 1 day')::date;

  if pr.calculated_at is null then
    return query select null::uuid, null::text, null::text, 'error', 'Payroll has not been calculated yet.';
    return;
  end if;
  if exists (select 1 from attendance a where a.work_date between v_first and v_last and a.updated_at > pr.calculated_at) then
    return query select null::uuid, null::text, null::text, 'error',
      'Attendance changed after the last calculation. Recalculate before approving.';
  end if;

  for e in select * from employees where status = 'active' order by employees.emp_code loop
    if btrim(e.name) = '' or btrim(e.job_title) = '' or btrim(e.department) = '' then
      return query select e.id, e.emp_code, e.name, 'error', 'Missing employee information (name, job title or department).';
    end if;
    if e.basic_salary <= 0 then
      return query select e.id, e.emp_code, e.name, 'error', 'Missing salary information (basic salary is zero).';
    end if;
    if e.ot_method = 'fixed' and e.ot_rate is null then
      return query select e.id, e.emp_code, e.name, 'error', 'Fixed OT method selected but no OT rate is set.';
    end if;

    select count(*), min(d::date) into v_missing, v_first_missing
    from generate_series(greatest(v_first, e.joining_date), v_last, interval '1 day') d
    where not exists (select 1 from attendance a where a.employee_id = e.id and a.work_date = d::date);
    if v_missing > 0 then
      return query select e.id, e.emp_code, e.name, 'error',
        format('Missing attendance for %s day(s), first on %s.', v_missing, to_char(v_first_missing, 'DD Mon YYYY'));
    end if;

    select count(*) filter (where a.ot_hours > 0 and a.status <> 'present'),
           count(*) filter (where a.ot_hours > v_max_ot)
    into v_bad_ot, v_high_ot
    from attendance a where a.employee_id = e.id and a.work_date between v_first and v_last;
    if v_bad_ot > 0 then
      return query select e.id, e.emp_code, e.name, 'error',
        format('Invalid OT: %s day(s) have overtime on a non-working status.', v_bad_ot);
    end if;
    if v_high_ot > 0 then
      return query select e.id, e.emp_code, e.name, 'warning',
        format('%s day(s) with OT above %s hours.', v_high_ot, v_max_ot);
    end if;

    select * into en from payroll_entries pe where pe.period_id = p_period and pe.employee_id = e.id;
    if not found then
      return query select e.id, e.emp_code, e.name, 'error', 'No payroll entry. Recalculate payroll.';
    elsif en.net_salary < 0 then
      return query select e.id, e.emp_code, e.name, 'error', 'Calculation error: net salary is negative.';
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- completion check
create or replace function refresh_period_completion(p_period uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pr payroll_periods;
begin
  select * into pr from payroll_periods where id = p_period for update;
  if pr.status <> 'approved' then return; end if;
  if exists (select 1 from salary_slips where period_id = p_period)
     and not exists (select 1 from salary_slips where period_id = p_period and signed_path is null) then
    update payroll_periods set status = 'completed', completed_at = now() where id = p_period;
    update salary_slips set status = 'completed' where period_id = p_period;
    perform log_audit('payroll.completed', 'payroll_period', p_period::text,
      to_char(make_date(pr.year, pr.month, 1), 'Mon YYYY'), null, jsonb_build_object('status', 'completed'));
  end if;
end $$;
revoke all on function refresh_period_completion(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- approve
create or replace function approve_payroll(p_period uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pr payroll_periods; v_errors int; v_label text; en record; sl salary_slips; v_n int := 0;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into pr from payroll_periods where id = p_period for update;
  if not found then raise exception 'Payroll period not found'; end if;
  if pr.status <> 'calculated' then
    raise exception 'Only a calculated payroll can be approved (current status: %).', pr.status;
  end if;
  select count(*) into v_errors from payroll_issues(p_period) where severity = 'error';
  if v_errors > 0 then
    raise exception 'Payroll has % blocking issue(s). Resolve them before approving.', v_errors;
  end if;

  v_label := to_char(make_date(pr.year, pr.month, 1), 'Mon YYYY');
  update payroll_periods set status = 'approved', approved_by = auth.uid(), approved_at = now(), reopen_reason = null
  where id = p_period;

  for en in
    select pe.*, emp.emp_code from payroll_entries pe join employees emp on emp.id = pe.employee_id
    where pe.period_id = p_period
  loop
    select * into sl from salary_slips where entry_id = en.id;
    if not found then
      insert into salary_slips (entry_id, period_id, employee_id, slip_no, net_snapshot)
      values (en.id, p_period, en.employee_id,
              'SS-' || pr.year || lpad(pr.month::text, 2, '0') || '-' || en.emp_code, en.net_salary);
      v_n := v_n + 1;
    elsif sl.net_snapshot <> en.net_salary then
      -- amounts changed after a reopen: the old signed copy no longer matches
      if sl.signed_path is not null then
        perform log_audit('salary_slip.invalidated', 'salary_slip', sl.id::text, sl.slip_no,
          jsonb_build_object('signed_path', sl.signed_path, 'net', sl.net_snapshot),
          jsonb_build_object('net', en.net_salary));
      end if;
      update salary_slips set net_snapshot = en.net_salary, status = 'generated', printed_at = null,
        signed_path = null, signed_uploaded_at = null, signed_uploaded_by = null where id = sl.id;
      v_n := v_n + 1;
    end if;
  end loop;

  perform log_audit('payroll.approved', 'payroll_period', p_period::text, v_label,
    jsonb_build_object('status', 'calculated'), jsonb_build_object('status', 'approved'));
  perform log_audit('salary_slip.generated', 'payroll_period', p_period::text, v_label, null,
    jsonb_build_object('slips_generated_or_reset', v_n));
  perform refresh_period_completion(p_period);
end $$;

-- ---------------------------------------------------------------- reopen
create or replace function reopen_payroll(p_period uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare pr payroll_periods;
begin
  if not has_role('administrator') then
    raise exception 'Only an administrator can reopen payroll' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'A reason (at least 5 characters) is required to reopen payroll.';
  end if;
  select * into pr from payroll_periods where id = p_period for update;
  if not found then raise exception 'Payroll period not found'; end if;
  if pr.status not in ('approved', 'completed') then
    raise exception 'Payroll is not approved.';
  end if;

  update payroll_periods set status = 'calculated', reopen_reason = btrim(p_reason),
    approved_by = null, approved_at = null, completed_at = null where id = p_period;
  update salary_slips set status = case
      when signed_path is not null then 'signed_uploaded'::slip_status
      when printed_at is not null then 'awaiting_signature'::slip_status
      else 'generated'::slip_status end
  where period_id = p_period;

  perform log_audit('payroll.reopened', 'payroll_period', p_period::text,
    to_char(make_date(pr.year, pr.month, 1), 'Mon YYYY'),
    jsonb_build_object('status', pr.status),
    jsonb_build_object('status', 'calculated', 'reason', btrim(p_reason)));
end $$;

-- ---------------------------------------------------------------- salary slips
create or replace function mark_slip_printed(p_slip uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  update salary_slips set printed_at = coalesce(printed_at, now()),
    status = case when status = 'generated' then 'awaiting_signature'::slip_status else status end
  where id = p_slip;
end $$;

create or replace function signed_slip_path(p_slip uuid) returns text
language sql stable security definer set search_path = public as $$
  select 'salary-slips/' || pr.year || '/' || lpad(pr.month::text, 2, '0') || '/' || e.emp_code || '/signed-slip.pdf'
  from salary_slips s
  join payroll_periods pr on pr.id = s.period_id
  join employees e on e.id = s.employee_id
  where s.id = p_slip
$$;

-- Called by the browser AFTER it uploaded the file to Storage at signed_slip_path(slip).
create or replace function register_signed_slip(p_slip uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare sl salary_slips;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into sl from salary_slips where id = p_slip for update;
  if not found then raise exception 'Salary slip not found'; end if;
  if p_path is distinct from signed_slip_path(p_slip) then
    raise exception 'Unexpected storage path';
  end if;

  update salary_slips set signed_path = p_path, signed_uploaded_at = now(), signed_uploaded_by = auth.uid(),
    printed_at = coalesce(printed_at, now()),
    status = case when status = 'completed' then status else 'signed_uploaded'::slip_status end
  where id = p_slip;

  perform log_audit(case when sl.signed_path is null then 'salary_slip.signed_uploaded' else 'salary_slip.signed_replaced' end,
    'salary_slip', p_slip::text, sl.slip_no, jsonb_build_object('signed_path', sl.signed_path),
    jsonb_build_object('signed_path', p_path));
  perform refresh_period_completion(sl.period_id);
end $$;

grant execute on function calculate_payroll(int, int), update_entry_adjustment(uuid, numeric, numeric, text),
  payroll_issues(uuid), approve_payroll(uuid), reopen_payroll(uuid, text), mark_slip_printed(uuid),
  signed_slip_path(uuid), register_signed_slip(uuid, text) to authenticated;
