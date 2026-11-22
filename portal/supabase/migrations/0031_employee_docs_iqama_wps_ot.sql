-- Employee profile: iqama / bank details, a document box, overtime entered as HOURS and priced from salary, WPS (Mudad) fields.
-- Run once in the SQL editor, after 0030.

-- ---------------------------------------------------------------- 1. employee fields
alter table employees
  add column if not exists iqama_no text not null default '',
  add column if not exists iqama_issue_date date,
  add column if not exists iqama_expiry_date date,
  add column if not exists bank_code text not null default '',
  add column if not exists iban text not null default '';

-- Last working day: an inactive employee still appears in attendance and payroll up to (and including) this date.
alter table employees add column if not exists last_working_date date;
-- employees already inactive: use their last attendance record so their history stays visible
update employees e set last_working_date = (select max(a.work_date) from attendance a where a.employee_id = e.id)
where e.status = 'inactive' and e.last_working_date is null;

-- ---------------------------------------------------------------- 2. document box
create table if not exists employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default current_company() references companies (id),
  employee_id uuid not null references employees (id) on delete cascade,
  doc_type text not null default 'Other',
  title text not null default '',
  file_path text not null,
  file_name text not null default '',
  file_size int not null default 0,
  uploaded_by uuid references profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists employee_documents_emp_idx on employee_documents (employee_id);
create index if not exists employee_documents_company_idx on employee_documents (company_id);

alter table employee_documents enable row level security;
create policy employee_documents_read on employee_documents for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy employee_documents_write on employee_documents for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll'))
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll'));

insert into storage.buckets (id, name, public, file_size_limit)
values ('employee-documents', 'employee-documents', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = 15728640;

-- object path: <company_id>/<employee_id>/<random>-<file name>
create or replace function emp_doc_company(p_name text) returns uuid
language sql stable security definer set search_path = public as $$
  select case when (string_to_array(p_name, '/'))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then ((string_to_array(p_name, '/'))[1])::uuid end
$$;

create policy emp_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'employee-documents' and has_role_in(emp_doc_company(name), 'administrator', 'payroll', 'viewer'));
create policy emp_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-documents' and has_role_in(emp_doc_company(name), 'administrator', 'payroll'));
create policy emp_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'employee-documents' and has_role_in(emp_doc_company(name), 'administrator', 'payroll'));

-- ---------------------------------------------------------------- 3. overtime from hours
-- OT hourly rate = (basic + allowances) / calendar days in the month / OT day hours (default 9) x multiplier (default 1.5).
-- An employee set to a "fixed" OT rate uses that rate per hour; a per-employee multiplier overrides the default one.
create or replace function ot_hourly_rate(p_emp uuid, p_date date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  e employees;
  v_mult numeric; v_hours numeric; v_days int;
begin
  select * into e from employees where id = p_emp;
  if not found then return 0; end if;
  if e.ot_method = 'fixed' then return coalesce(e.ot_rate, 0); end if;
  select coalesce((select (value #>> '{}')::numeric from settings where company_id = e.company_id and key = 'ot_multiplier'), 1.5),
         coalesce((select (value #>> '{}')::numeric from settings where company_id = e.company_id and key = 'ot_day_hours'), 9)
    into v_mult, v_hours;
  v_mult := coalesce(e.ot_rate, v_mult);
  v_days := extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int;
  return round((e.basic_salary + e.allowances) / v_days / v_hours * v_mult, 2);
end $$;

-- Rows that carry OT hours get their OT amount calculated here. Older rows (amount only, 0 hours) are left alone.
create or replace function attendance_ot_amount() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.ot_hours, 0) > 0 then
    new.ot_amount := round(new.ot_hours * ot_hourly_rate(new.employee_id, new.work_date), 2);
  end if;
  return new;
end $$;

drop trigger if exists attendance_ot_amount_trg on attendance;
create trigger attendance_ot_amount_trg before insert or update on attendance
  for each row execute function attendance_ot_amount();

grant execute on function ot_hourly_rate(uuid, date) to authenticated;

-- ---------------------------------------------------------------- 4. payroll: re-price OT hours at calculation time
-- Same as 0016, plus one statement that refreshes OT amounts (so a salary change since the entry is picked up),
-- and the OT hourly rate / unpaid OT hours are recorded in the breakdown.
create or replace function calculate_payroll(
  p_year int, p_month int, p_start date default null, p_end date default null, p_employees uuid[] default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  v_period payroll_periods;
  v_first date;
  v_last date;
  v_emps uuid[];
  v_mult numeric := setting_num('ot_multiplier', 1.5);
  v_std numeric := setting_num('standard_hours', 8);
  v_div numeric := setting_num('days_divisor', 30);
  e employees;
  a record;
  v_hourly numeric; v_ot_rate numeric; v_ot_amt numeric; v_ot_paid numeric; v_abs numeric;
  v_oth_e numeric; v_oth_d numeric; v_adv numeric; v_ded numeric; v_net numeric;
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
    raise exception 'Payroll for % is approved and locked. Reopen it first.', to_char(make_date(p_year, p_month, 1), 'Mon YYYY');
  end if;

  v_first := coalesce(p_start, v_period.start_date, make_date(p_year, p_month, 1));
  v_last := coalesce(p_end, v_period.end_date, (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date);
  if v_last < v_first then raise exception 'Pay period end date is before the start date.'; end if;
  if v_last - v_first > 92 then raise exception 'Pay period cannot be longer than 92 days.'; end if;
  if p_employees is not null and cardinality(p_employees) = 0 then raise exception 'Select at least one employee.'; end if;
  v_emps := case when p_start is null and p_end is null and p_employees is null then v_period.employee_ids else p_employees end;
  update payroll_periods set start_date = v_first, end_date = v_last, employee_ids = v_emps where id = v_period.id;

  -- re-price OT entered as hours with the current salary (fires attendance_ot_amount_trg)
  update attendance set ot_hours = ot_hours
  where company_id = v_co and work_date between v_first and v_last and ot_hours > 0
    and (v_emps is null or employee_id = any(v_emps));

  for e in select * from employees where company_id = v_co
    and (status = 'active' or last_working_date >= v_first)
    and (v_emps is null or id = any(v_emps)) order by emp_code loop
    select
      count(*) filter (where status = 'present') as present_days,
      count(*) filter (where status in ('absent', 'unpaid_leave')) as unpaid_days,
      coalesce(sum(regular_hours), 0) as reg_h,
      coalesce(sum(ot_hours) filter (where not ot_paid), 0) as ot_unpaid_h,
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
    v_ot_rate := ot_hourly_rate(e.id, v_last);
    v_ot_amt := round(a.ot_unpaid, 2);
    v_ot_paid := round(a.ot_paid_amt, 2);
    v_abs := round(a.unpaid_days * e.basic_salary / v_div, 2);

    select other_earnings, other_deductions, advance_paid into v_oth_e, v_oth_d, v_adv
    from payroll_entries where period_id = v_period.id and employee_id = e.id;
    v_oth_e := coalesce(v_oth_e, 0);
    v_oth_d := coalesce(v_oth_d, 0);
    v_adv := coalesce(v_adv, 0);
    v_ded := v_abs + v_oth_d;
    v_net := e.basic_salary + e.allowances + v_ot_amt + v_oth_e - v_ded - v_adv;

    insert into payroll_entries (
      company_id, period_id, employee_id, basic, allowances, present_days, unpaid_days, regular_hours, ot_hours,
      ot_rate, ot_amount, ot_paid_amount, other_earnings, absence_deduction, other_deductions, advance_paid, deductions, net_salary, breakdown
    ) values (
      v_co, v_period.id, e.id, e.basic_salary, e.allowances, a.present_days, a.unpaid_days, a.reg_h, a.ot_unpaid_h,
      v_ot_rate, v_ot_amt, v_ot_paid, v_oth_e, v_abs, v_oth_d, v_adv, v_ded, v_net,
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
    and employee_id not in (select id from employees where company_id = v_co
                            and (status = 'active' or last_working_date >= v_first)
                            and (v_emps is null or id = any(v_emps)));

  update payroll_periods set status = 'calculated', calculated_at = now() where id = v_period.id;

  perform log_audit('payroll.calculated', 'payroll_period', v_period.id::text,
    to_char(make_date(p_year, p_month, 1), 'Mon YYYY'), jsonb_build_object('status', v_period.status),
    jsonb_build_object('status', 'calculated', 'employees', v_count, 'from', v_first, 'to', v_last));
  return v_period.id;
end $$;

grant execute on function calculate_payroll(int, int, date, date, uuid[]) to authenticated;

-- ---------------------------------------------------------------- 5. payroll checks: honour the last working day
-- Same as 0016, but inactive employees with a last working day inside the period are checked too,
-- and attendance is only required up to that day.
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
    if btrim(e.name) = '' or btrim(e.job_title) = '' or btrim(e.department) = '' then
      return query select e.id, e.emp_code, e.name, 'error', 'Missing employee information (name, job title or department).';
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
