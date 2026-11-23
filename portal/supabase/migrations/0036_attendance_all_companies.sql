-- Mark attendance for the employees of EVERY company you belong to on one screen.
-- (employees/attendance policies only show the selected company, so these two functions do the cross-company work.)
-- Rules still apply: you can only mark attendance for companies where you are administrator or attendance staff,
-- and an approved/completed payroll month stays locked. Run once in the SQL editor.

-- one day: employees (with their company, OT settings and whether you may edit them) + the attendance already marked
create or replace function attendance_day_all(p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  select array_agg(company_id) into v_ids from company_members
  where user_id = auth.uid() and role::text in ('administrator', 'payroll', 'attendance', 'viewer');
  if v_ids is null then raise exception 'Not permitted' using errcode = '42501'; end if;

  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(to_jsonb(e) || jsonb_build_object(
        'company_code', c.code,
        'company_name', c.name,
        'standard_hours', coalesce((select (s.value #>> '{}')::numeric from settings s where s.company_id = e.company_id and s.key = 'standard_hours'), 8),
        'ot_multiplier', coalesce((select (s.value #>> '{}')::numeric from settings s where s.company_id = e.company_id and s.key = 'ot_multiplier'), 1.5),
        'ot_day_hours', coalesce((select (s.value #>> '{}')::numeric from settings s where s.company_id = e.company_id and s.key = 'ot_day_hours'), 9),
        'locked', period_locked(p_date, e.company_id),
        'can_write', exists (select 1 from company_members m where m.user_id = auth.uid() and m.company_id = e.company_id
                             and m.role::text in ('administrator', 'attendance'))
      ) order by c.code, e.emp_code)
      from employees e join companies c on c.id = e.company_id
      where e.company_id = any (v_ids)
        and (e.status = 'active' or e.last_working_date >= p_date)
        and e.joining_date <= p_date
    ), '[]'::jsonb),
    'attendance', coalesce((
      select jsonb_agg(to_jsonb(a))
      from attendance a
      where a.company_id = any (v_ids) and a.work_date = p_date
    ), '[]'::jsonb));
end $$;
grant execute on function attendance_day_all(date) to authenticated;

-- save: p_rows = [{employee_id, work_date, status, regular_hours, ot_hours, ot_amount, ot_paid, remarks}, ...]
create or replace function save_attendance_all(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_co uuid;
  v_date date;
  n int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select e.company_id into v_co from employees e where e.id = (r ->> 'employee_id')::uuid;
    if v_co is null then raise exception 'Employee not found'; end if;
    if not exists (select 1 from company_members m where m.user_id = auth.uid() and m.company_id = v_co
                   and m.role::text in ('administrator', 'attendance')) then
      raise exception 'Not permitted' using errcode = '42501';
    end if;
    v_date := (r ->> 'work_date')::date;
    -- approved payroll months are also refused by attendance_guard_trg; checked here for a clear message
    if period_locked(v_date, v_co) then
      raise exception 'Payroll for % is approved; attendance is locked. Reopen the payroll period to edit.', to_char(v_date, 'Mon YYYY');
    end if;
    insert into attendance (company_id, employee_id, work_date, status, regular_hours, ot_hours, ot_amount, ot_paid, remarks)
    values (v_co, (r ->> 'employee_id')::uuid, v_date, (r ->> 'status')::attendance_status,
            coalesce((r ->> 'regular_hours')::numeric, 0), coalesce((r ->> 'ot_hours')::numeric, 0),
            coalesce((r ->> 'ot_amount')::numeric, 0), coalesce((r ->> 'ot_paid')::boolean, false), coalesce(r ->> 'remarks', ''))
    on conflict (employee_id, work_date) do update set
      status = excluded.status, regular_hours = excluded.regular_hours, ot_hours = excluded.ot_hours,
      ot_amount = excluded.ot_amount, ot_paid = excluded.ot_paid, remarks = excluded.remarks;
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function save_attendance_all(jsonb) to authenticated;
