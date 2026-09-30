-- Helpers, audit triggers, attendance locking and Row Level Security

-- ---------------------------------------------------------------- role helpers
create or replace function current_app_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function has_role(variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() = any (roles), false)
$$;

-- ---------------------------------------------------------------- audit helper
create or replace function log_audit(
  p_action text, p_type text, p_id text, p_label text, p_old jsonb, p_new jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  select full_name into v_name from profiles where id = auth.uid();
  insert into audit_logs (user_id, user_name, action, record_type, record_id, record_label, old_value, new_value)
  values (auth.uid(), coalesce(nullif(v_name, ''), 'System'), p_action, p_type, p_id, p_label, p_old, p_new);
end $$;

revoke all on function log_audit(text, text, text, text, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- attendance locking + audit
create or replace function period_locked(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from payroll_periods
    where year = extract(year from d)::int and month = extract(month from d)::int
      and status in ('approved', 'completed')
  )
$$;

create or replace function attendance_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_date date := coalesce(new.work_date, old.work_date);
  v_label text;
begin
  if period_locked(v_date) then
    raise exception 'Payroll for % is approved; attendance is locked. Reopen the payroll period to edit.',
      to_char(v_date, 'Mon YYYY') using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  new.updated_by := auth.uid();
  new.updated_at := now();

  select emp_code || ' ' || name into v_label from employees where id = new.employee_id;

  if tg_op = 'INSERT' then
    if new.status <> 'present' or new.ot_hours > 0 then
      perform log_audit('attendance.changed', 'attendance', new.employee_id::text || ':' || new.work_date,
        v_label || ' · ' || to_char(new.work_date, 'DD Mon YYYY'), null,
        jsonb_build_object('status', new.status, 'regular_hours', new.regular_hours, 'ot_hours', new.ot_hours));
    end if;
  elsif (new.status, new.regular_hours, new.ot_hours) is distinct from (old.status, old.regular_hours, old.ot_hours) then
    perform log_audit(
      case when new.ot_hours is distinct from old.ot_hours then 'attendance.ot_changed' else 'attendance.changed' end,
      'attendance', new.employee_id::text || ':' || new.work_date,
      v_label || ' · ' || to_char(new.work_date, 'DD Mon YYYY'),
      jsonb_build_object('status', old.status, 'regular_hours', old.regular_hours, 'ot_hours', old.ot_hours),
      jsonb_build_object('status', new.status, 'regular_hours', new.regular_hours, 'ot_hours', new.ot_hours));
  end if;
  return new;
end $$;

create trigger attendance_guard_trg before insert or update or delete on attendance
  for each row execute function attendance_guard();

create or replace function touch_employee() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger employees_touch before update on employees
  for each row execute function touch_employee();

-- ---------------------------------------------------------------- RLS
alter table profiles            enable row level security;
alter table settings            enable row level security;
alter table employees           enable row level security;
alter table attendance          enable row level security;
alter table payroll_periods     enable row level security;
alter table payroll_entries     enable row level security;
alter table salary_slips        enable row level security;
alter table quotations          enable row level security;
alter table quotation_revisions enable row level security;
alter table quotation_items     enable row level security;
alter table audit_logs          enable row level security;

-- profiles: everyone signed in can read names; only administrators change roles
create policy profiles_read on profiles for select to authenticated using (true);
create policy profiles_admin_update on profiles for update to authenticated
  using (has_role('administrator')) with check (has_role('administrator'));

-- settings
create policy settings_read on settings for select to authenticated using (true);
create policy settings_admin_write on settings for all to authenticated
  using (has_role('administrator')) with check (has_role('administrator'));

-- employees: read by payroll-side roles; write by administrator/payroll
create policy employees_read on employees for select to authenticated
  using (has_role('administrator', 'payroll', 'attendance', 'viewer'));
create policy employees_write on employees for all to authenticated
  using (has_role('administrator', 'payroll')) with check (has_role('administrator', 'payroll'));

-- attendance: written by administrator/attendance (trigger blocks locked months)
create policy attendance_read on attendance for select to authenticated
  using (has_role('administrator', 'payroll', 'attendance', 'viewer'));
create policy attendance_write on attendance for all to authenticated
  using (has_role('administrator', 'attendance')) with check (has_role('administrator', 'attendance'));

-- payroll + slips: read only from the client; every change goes through security-definer functions
create policy periods_read on payroll_periods for select to authenticated
  using (has_role('administrator', 'payroll', 'viewer'));
create policy entries_read on payroll_entries for select to authenticated
  using (has_role('administrator', 'payroll', 'viewer'));
create policy slips_read on salary_slips for select to authenticated
  using (has_role('administrator', 'payroll', 'viewer'));

-- quotations: read only from the client; writes go through functions
create policy quotations_read on quotations for select to authenticated
  using (has_role('administrator', 'quotations', 'viewer'));
create policy quotation_revisions_read on quotation_revisions for select to authenticated
  using (has_role('administrator', 'quotations', 'viewer'));
create policy quotation_items_read on quotation_items for select to authenticated
  using (has_role('administrator', 'quotations', 'viewer'));

-- audit log: append-only (no insert/update/delete policies), scoped by role
create policy audit_read on audit_logs for select to authenticated using (
  has_role('administrator', 'viewer')
  or (has_role('payroll', 'attendance') and record_type <> 'quotation')
  or (has_role('quotations') and record_type = 'quotation')
);
