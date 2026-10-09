  -- Overtime is now a per-day checkbox with an amount and a paid / unpaid flag.
  --  * attendance.ot_amount > 0 means the employee had OT that day; ot_paid says whether it was already paid.
  --  * Payroll adds only UNPAID OT to the salary (payroll_entries.ot_amount) and reports paid OT separately (ot_paid_amount).
  alter table attendance add column if not exists ot_amount numeric(10,2) not null default 0 check (ot_amount >= 0);
  alter table attendance add column if not exists ot_paid boolean not null default false;
  alter table payroll_entries add column if not exists ot_paid_amount numeric(12,2) not null default 0;
  
  create or replace function calculate_payroll(p_year int, p_month int) returns uuid
  language plpgsql security definer set search_path = public as $$
  declare
    v_co uuid := require_company();
    v_period payroll_periods;
    v_first date := make_date(p_year, p_month, 1);
    v_last date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
    v_mult numeric := setting_num('ot_multiplier', 1.5);
    v_std numeric := setting_num('standard_hours', 8);
    v_div numeric := setting_num('days_divisor', 30);
    e employees;
    a record;
    v_hourly numeric; v_ot_rate numeric; v_ot_amt numeric; v_ot_paid numeric; v_abs numeric;
    v_oth_e numeric; v_oth_d numeric; v_ded numeric; v_net numeric;
    v_count int := 0;
  begin
    if not has_role('administrator', 'payroll') then
      raise exception 'Not permitted' using errcode = '42501';
    end if;
  
    insert into payroll_periods (company_id, year, month) values (v_co, p_year, p_month)
    on conflict (company_id, year, month) do nothing;
    select * into v_period from payroll_periods
    where company_id = v_co and year = p_year and month = p_month for update;
  
    if v_period.status in ('approved', 'completed') then
      raise exception 'Payroll for % is approved and locked. Reopen it first.', to_char(v_first, 'Mon YYYY');
    end if;
  
    for e in select * from employees where status = 'active' and company_id = v_co order by emp_code loop
      select
        count(*) filter (where status = 'present') as present_days,
        count(*) filter (where status in ('absent', 'unpaid_leave')) as unpaid_days,
        coalesce(sum(regular_hours), 0) as reg_h,
        coalesce(sum(ot_amount) filter (where not ot_paid), 0) as ot_unpaid,
        coalesce(sum(ot_amount) filter (where ot_paid), 0) as ot_paid_amt,
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
      where employee_id = e.id and company_id = v_co and work_date between v_first and v_last;
  
      v_hourly := round(e.basic_salary / v_div / v_std, 4);
      -- overtime is entered as an amount per day: unpaid OT is added to the salary, paid OT is only reported
      v_ot_rate := 0;
      v_ot_amt := round(a.ot_unpaid, 2);
      v_ot_paid := round(a.ot_paid_amt, 2);
      v_abs := round(a.unpaid_days * e.basic_salary / v_div, 2);
  
      select other_earnings, other_deductions into v_oth_e, v_oth_d
      from payroll_entries where period_id = v_period.id and employee_id = e.id;
      v_oth_e := coalesce(v_oth_e, 0);
      v_oth_d := coalesce(v_oth_d, 0);
      v_ded := v_abs + v_oth_d;
      v_net := e.basic_salary + e.allowances + v_ot_amt + v_oth_e - v_ded;
  
      insert into payroll_entries (
        company_id, period_id, employee_id, basic, allowances, present_days, unpaid_days, regular_hours, ot_hours,
        ot_rate, ot_amount, ot_paid_amount, other_earnings, absence_deduction, other_deductions, deductions, net_salary, breakdown
      ) values (
        v_co, v_period.id, e.id, e.basic_salary, e.allowances, a.present_days, a.unpaid_days, a.reg_h, 0,
        v_ot_rate, v_ot_amt, v_ot_paid, v_oth_e, v_abs, v_oth_d, v_ded, v_net,
        jsonb_build_object(
          'hourly_rate', v_hourly, 'daily_rate', round(e.basic_salary / v_div, 2),
          'ot_paid_amount', v_ot_paid, 'ot_method', e.ot_method, 'ot_multiplier', coalesce(e.ot_rate, v_mult),
          'days_divisor', v_div, 'standard_hours', v_std, 'counts', a.counts
        )
      )
      on conflict (period_id, employee_id) do update set
        basic = excluded.basic, allowances = excluded.allowances, present_days = excluded.present_days,
        unpaid_days = excluded.unpaid_days, regular_hours = excluded.regular_hours, ot_hours = excluded.ot_hours,
        ot_rate = excluded.ot_rate, ot_amount = excluded.ot_amount, ot_paid_amount = excluded.ot_paid_amount,
        absence_deduction = excluded.absence_deduction, deductions = excluded.deductions,
        net_salary = excluded.net_salary, breakdown = excluded.breakdown;
      v_count := v_count + 1;
    end loop;
  
    delete from payroll_entries
    where period_id = v_period.id
      and employee_id not in (select id from employees where status = 'active' and company_id = v_co);
  
    update payroll_periods set status = 'calculated', calculated_at = now() where id = v_period.id;
  
    perform log_audit('payroll.calculated', 'payroll_period', v_period.id::text,
      to_char(v_first, 'Mon YYYY'), jsonb_build_object('status', v_period.status),
      jsonb_build_object('status', 'calculated', 'employees', v_count));
    return v_period.id;
  end $$;
  
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
    v_first := make_date(pr.year, pr.month, 1);
    v_last := (v_first + interval '1 month - 1 day')::date;
  
    if pr.calculated_at is null then
      return query select null::uuid, null::text, null::text, 'error', 'Payroll has not been calculated yet.';
      return;
    end if;
    if exists (select 1 from attendance a where a.company_id = v_co and a.work_date between v_first and v_last and a.updated_at > pr.calculated_at) then
      return query select null::uuid, null::text, null::text, 'error',
        'Attendance changed after the last calculation. Recalculate before approving.';
    end if;
  
    for e in select * from employees where status = 'active' and company_id = v_co order by employees.emp_code loop
      if btrim(e.name) = '' or btrim(e.job_title) = '' or btrim(e.department) = '' then
        return query select e.id, e.emp_code, e.name, 'error', 'Missing employee information (name, job title or department).';
      end if;
      if e.basic_salary <= 0 then
        return query select e.id, e.emp_code, e.name, 'error', 'Missing salary information (basic salary is zero).';
      end if;
      select count(*), min(d::date) into v_missing, v_first_missing
      from generate_series(greatest(v_first, e.joining_date), v_last, interval '1 day') d
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
      elsif en.net_salary < 0 then
        return query select e.id, e.emp_code, e.name, 'error', 'Calculation error: net salary is negative.';
      end if;
    end loop;
  end $$;
  
