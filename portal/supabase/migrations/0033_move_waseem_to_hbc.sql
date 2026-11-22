-- One-off data move: employee "Waseem" -> Hassan and Bilal Company (HBC), together with his history.
-- Run once in the SQL editor, after 0032. It is a single DO block, so it either completes or changes nothing.
--
-- What moves:   the employee, attendance, payroll entries, salary slips, employee documents (rows + stored files).
-- What it does: * keeps his Employee ID if it is free in HBC, otherwise gives him the next HBC-### number
--               * maps each payroll entry/slip to the HBC period of the same month; creates that period (same
--                 status and dates) when HBC has none
--               * re-numbers his salary slips to the new Employee ID (SS-YYYYMM-<code>)
--               * leaves attendance OT amounts exactly as they were (they are NOT re-priced)
-- Petty cash is company-free since 0032, so it needs no change.
--
-- It stops with an error unless exactly ONE employee named like Waseem exists outside HBC.
-- Read the NOTICE lines it prints; to preview without keeping anything, run it inside begin; ... rollback;

do $$
declare
  v_hbc uuid := (select id from companies where code = 'HBC');
  v_emp employees;
  v_old uuid;
  v_code text;
  v_n int;
  r record;
  v_new_period uuid;
  v_cnt int;
begin
  if v_hbc is null then raise exception 'Company HBC not found'; end if;

  select count(*) into v_n from employees where name ilike '%waseem%' and company_id <> v_hbc;
  if v_n <> 1 then
    raise exception 'Expected exactly 1 employee matching "Waseem" outside HBC, found %. Nothing changed.', v_n;
  end if;
  select * into v_emp from employees where name ilike '%waseem%' and company_id <> v_hbc;
  v_old := v_emp.company_id;
  raise notice 'Moving % (%) from % to HBC', v_emp.name, v_emp.emp_code, (select code from companies where id = v_old);

  -- Employee ID: keep it if free in HBC, else next HBC-###
  v_code := v_emp.emp_code;
  if exists (select 1 from employees where company_id = v_hbc and emp_code = v_code) then
    select 'HBC-' || lpad((coalesce(max((substring(emp_code from '(\d+)$'))::int), 0) + 1)::text, 3, '0')
      into v_code from employees where company_id = v_hbc;
    raise notice 'Employee ID % is taken in HBC; new ID is %', v_emp.emp_code, v_code;
  end if;

  -- these triggers must not re-check locks or re-price OT while history is being moved
  alter table attendance disable trigger attendance_guard_trg;
  alter table attendance disable trigger attendance_ot_amount_trg;

  update employees set company_id = v_hbc, emp_code = v_code where id = v_emp.id;
  update attendance set company_id = v_hbc where employee_id = v_emp.id;

  -- payroll: one HBC period per month he has an entry in
  for r in
    select distinct pp.* from payroll_periods pp
    join payroll_entries pe on pe.period_id = pp.id and pe.employee_id = v_emp.id
    where pp.company_id = v_old
  loop
    select id into v_new_period from payroll_periods
      where company_id = v_hbc and year = r.year and month = r.month;
    if v_new_period is null then
      insert into payroll_periods (company_id, year, month, status, calculated_at, approved_by, approved_at,
                                   reopen_reason, completed_at, start_date, end_date, employee_ids)
      values (v_hbc, r.year, r.month, r.status, r.calculated_at, r.approved_by, r.approved_at,
              r.reopen_reason, r.completed_at, r.start_date, r.end_date, array[v_emp.id])
      returning id into v_new_period;
      raise notice '%/%: HBC had no payroll period; created one (status %)', r.month, r.year, r.status;
    else
      update payroll_periods set employee_ids = employee_ids || v_emp.id
        where id = v_new_period and employee_ids is not null and not (v_emp.id = any (employee_ids));
      raise notice '%/%: added to existing HBC payroll period', r.month, r.year;
    end if;

    update payroll_entries set company_id = v_hbc, period_id = v_new_period
      where period_id = r.id and employee_id = v_emp.id;
    update salary_slips set company_id = v_hbc, period_id = v_new_period,
        slip_no = 'SS-' || r.year || lpad(r.month::text, 2, '0') || '-' || v_code
      where employee_id = v_emp.id and period_id = r.id;
    update payroll_periods set employee_ids = array_remove(employee_ids, v_emp.id)
      where id = r.id and employee_ids is not null;
  end loop;

  -- employee documents: rows and the files (object path starts with the company id)
  update storage.objects
    set name = v_hbc::text || substring(name from length(v_old::text) + 1)
    where bucket_id = 'employee-documents'
      and name in (select file_path from employee_documents where employee_id = v_emp.id and company_id = v_old);
  update employee_documents
    set company_id = v_hbc, file_path = v_hbc::text || substring(file_path from length(v_old::text) + 1)
    where employee_id = v_emp.id and company_id = v_old;

  -- petty cash only if it still carries a company (before 0032)
  if exists (select 1 from information_schema.columns where table_name = 'pc_cash_given' and column_name = 'company_id') then
    execute format('update pc_access set company_id = %L where employee_id = %L', v_hbc, v_emp.id);
    execute format('update pc_cash_given set company_id = %L where employee_id = %L', v_hbc, v_emp.id);
    execute format('update pc_receipts set company_id = %L where employee_id = %L', v_hbc, v_emp.id);
  end if;

  alter table attendance enable trigger attendance_guard_trg;
  alter table attendance enable trigger attendance_ot_amount_trg;

  select count(*) into v_cnt from attendance where employee_id = v_emp.id and company_id = v_hbc;
  raise notice 'Done: % attendance rows now in HBC', v_cnt;
end $$;
