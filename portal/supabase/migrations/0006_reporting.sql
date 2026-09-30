-- Monthly attendance totals per employee (runs with the caller's RLS, so only permitted roles see rows).
-- Used by the Monthly Attendance page and the dashboard. Avoids PostgREST's 1000-row page limit.

create or replace function attendance_month_totals(p_year int, p_month int)
returns table (
  employee_id uuid, present_days int, absent_days int, leave_days int,
  weekly_off_days int, holiday_days int, regular_hours numeric, ot_hours numeric
)
language sql stable security invoker set search_path = public as $$
  select a.employee_id,
    (count(*) filter (where a.status = 'present'))::int,
    (count(*) filter (where a.status = 'absent'))::int,
    (count(*) filter (where a.status in ('annual_leave', 'sick_leave', 'unpaid_leave')))::int,
    (count(*) filter (where a.status = 'weekly_off'))::int,
    (count(*) filter (where a.status = 'holiday'))::int,
    coalesce(sum(a.regular_hours), 0), coalesce(sum(a.ot_hours), 0)
  from attendance a
  where a.work_date >= make_date(p_year, p_month, 1)
    and a.work_date < make_date(p_year, p_month, 1) + interval '1 month'
  group by a.employee_id
$$;
grant execute on function attendance_month_totals(int, int) to authenticated;
