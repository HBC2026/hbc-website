-- ======== migrations/0001_schema.sql ========
-- HBC Admin Portal — schema
-- Run migrations in order (0001 → 0005) in the Supabase SQL editor or via `supabase db push`.


-- ---------------------------------------------------------------- enums
create type app_role as enum ('administrator', 'payroll', 'attendance', 'quotations', 'viewer');
create type attendance_status as enum
  ('present', 'absent', 'annual_leave', 'sick_leave', 'unpaid_leave', 'holiday', 'weekly_off');
create type employee_status as enum ('active', 'inactive');
create type period_status as enum ('open', 'calculated', 'approved', 'completed');
create type slip_status as enum ('generated', 'awaiting_signature', 'signed_uploaded', 'completed');
create type quotation_status as enum ('draft', 'submitted', 'revised', 'approved', 'rejected', 'expired');

-- ---------------------------------------------------------------- profiles
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text,
  role app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- First user to sign up becomes administrator; everyone else starts as viewer.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    case when exists (select 1 from profiles) then 'viewer'::app_role else 'administrator'::app_role end
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- settings
create table settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

insert into settings (key, value, description) values
  ('ot_multiplier',  '1.5'::jsonb,  'Overtime multiplier applied to the hourly rate'),
  ('standard_hours', '8'::jsonb,    'Standard working hours per day'),
  ('days_divisor',   '30'::jsonb,   'Days in a month used for daily/hourly rate'),
  ('vat_rate',       '0.15'::jsonb, 'Default VAT rate for quotations'),
  ('max_ot_per_day', '6'::jsonb,    'Overtime hours per day above which payroll validation warns'),
  ('company',        '{"name":"Hassan and Bilal Company","name_ar":"شركة حسن و بلال","address":"Kingdom of Saudi Arabia","phone":"","email":"","vat_no":"","cr_no":""}'::jsonb, 'Company details shown on documents');

-- ---------------------------------------------------------------- employees
create table employees (
  id uuid primary key default gen_random_uuid(),
  emp_code text not null unique,
  name text not null,
  job_title text not null default '',
  department text not null default '',
  joining_date date not null,
  basic_salary numeric(12,2) not null default 0 check (basic_salary >= 0),
  allowances numeric(12,2) not null default 0 check (allowances >= 0),
  ot_method text not null default 'multiplier' check (ot_method in ('multiplier', 'fixed')),
  -- multiplier: factor on hourly rate (falls back to settings.ot_multiplier when null)
  -- fixed: SAR per OT hour
  ot_rate numeric(10,2) check (ot_rate is null or ot_rate >= 0),
  status employee_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- attendance
create table attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete restrict,
  work_date date not null,
  status attendance_status not null default 'present',
  regular_hours numeric(4,2) not null default 0 check (regular_hours between 0 and 24),
  ot_hours numeric(4,2) not null default 0 check (ot_hours between 0 and 16),
  remarks text not null default '',
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index attendance_date_idx on attendance (work_date);

-- ---------------------------------------------------------------- payroll
create table payroll_periods (
  id uuid primary key default gen_random_uuid(),
  year int not null check (year between 2000 and 2100),
  month int not null check (month between 1 and 12),
  status period_status not null default 'open',
  calculated_at timestamptz,
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  reopen_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (year, month)
);

create table payroll_entries (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references payroll_periods (id) on delete cascade,
  employee_id uuid not null references employees (id) on delete restrict,
  basic numeric(12,2) not null default 0,
  allowances numeric(12,2) not null default 0,
  present_days int not null default 0,
  unpaid_days int not null default 0,
  regular_hours numeric(8,2) not null default 0,
  ot_hours numeric(8,2) not null default 0,
  ot_rate numeric(10,2) not null default 0,
  ot_amount numeric(12,2) not null default 0,
  other_earnings numeric(12,2) not null default 0 check (other_earnings >= 0),
  absence_deduction numeric(12,2) not null default 0,
  other_deductions numeric(12,2) not null default 0 check (other_deductions >= 0),
  deductions numeric(12,2) not null default 0,
  net_salary numeric(12,2) not null default 0,
  adjustment_note text not null default '',
  breakdown jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (period_id, employee_id)
);
create index payroll_entries_employee_idx on payroll_entries (employee_id);

create table salary_slips (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null unique references payroll_entries (id) on delete cascade,
  period_id uuid not null references payroll_periods (id) on delete cascade,
  employee_id uuid not null references employees (id) on delete restrict,
  slip_no text not null unique,
  net_snapshot numeric(12,2) not null,
  status slip_status not null default 'generated',
  printed_at timestamptz,
  signed_path text,             -- Storage path in bucket signed-salary-slips
  signed_uploaded_at timestamptz,
  signed_uploaded_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index salary_slips_period_idx on salary_slips (period_id);

-- ---------------------------------------------------------------- quotations
create table quotations (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,               -- e.g. HBC-QT-2026-0148
  current_revision int not null default 0,   -- 0 = original, 1 = R1 ...
  status quotation_status not null default 'draft',
  -- denormalised from the current revision for fast listing
  client text not null default '',
  project text not null default '',
  quote_date date not null default current_date,
  amount numeric(14,2) not null default 0,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quotations_status_idx on quotations (status);

-- One row per revision; earlier revisions are never overwritten.
create table quotation_revisions (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations (id) on delete cascade,
  revision int not null,
  client text not null,
  attention text not null default '',
  project text not null default '',
  quote_date date not null,
  validity_days int not null default 30,
  reference text not null default '',
  subtotal numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0 check (discount >= 0),
  vat_rate numeric(5,4) not null default 0.15,
  vat_amount numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  payment_terms text not null default '',
  delivery text not null default '',
  notes text not null default '',
  revision_note text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  unique (quotation_id, revision)
);

create table quotation_items (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references quotation_revisions (id) on delete cascade,
  position int not null,
  description text not null,
  qty numeric(12,3) not null check (qty >= 0),
  unit text not null default 'Nos',
  unit_price numeric(14,2) not null check (unit_price >= 0)
);
create index quotation_items_rev_idx on quotation_items (revision_id, position);

-- ---------------------------------------------------------------- audit
create table audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  user_name text not null default 'System',
  action text not null,
  record_type text not null,
  record_id text,
  record_label text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_record_idx on audit_logs (record_type, record_id);

-- ======== migrations/0002_helpers_audit_rls.sql ========
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

-- ======== migrations/0003_payroll_functions.sql ========
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

-- ======== migrations/0004_quotation_functions.sql ========
-- Quotations: numbering, revisions (never overwritten), totals calculated server-side

create or replace function write_quotation_revision(p_quotation uuid, p_rev int, p jsonb, p_note text)
returns quotation_revisions
language plpgsql security definer set search_path = public as $$
declare
  v_rev quotation_revisions;
  v_sub numeric; v_disc numeric; v_rate numeric; v_vat numeric;
  it jsonb; v_pos int := 0;
begin
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'A quotation needs at least one line item.';
  end if;
  if btrim(coalesce(p ->> 'client', '')) = '' then
    raise exception 'Client is required.';
  end if;

  select coalesce(sum(round((i ->> 'qty')::numeric * (i ->> 'unit_price')::numeric, 2)), 0)
  into v_sub from jsonb_array_elements(p -> 'items') i;
  v_disc := coalesce((p ->> 'discount')::numeric, 0);
  v_rate := coalesce((p ->> 'vat_rate')::numeric, setting_num('vat_rate', 0.15));
  if v_disc < 0 or v_disc > v_sub then
    raise exception 'Discount must be between 0 and the subtotal.';
  end if;
  v_vat := round((v_sub - v_disc) * v_rate, 2);

  insert into quotation_revisions (
    quotation_id, revision, client, attention, project, quote_date, validity_days, reference,
    subtotal, discount, vat_rate, vat_amount, grand_total, payment_terms, delivery, notes, revision_note, created_by
  ) values (
    p_quotation, p_rev, btrim(p ->> 'client'), coalesce(p ->> 'attention', ''), coalesce(p ->> 'project', ''),
    coalesce((p ->> 'quote_date')::date, current_date), coalesce((p ->> 'validity_days')::int, 30),
    coalesce(p ->> 'reference', ''), v_sub, v_disc, v_rate, v_vat, v_sub - v_disc + v_vat,
    coalesce(p ->> 'payment_terms', ''), coalesce(p ->> 'delivery', ''), coalesce(p ->> 'notes', ''),
    coalesce(p_note, ''), auth.uid()
  ) returning * into v_rev;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_pos := v_pos + 1;
    insert into quotation_items (revision_id, position, description, qty, unit, unit_price)
    values (v_rev.id, v_pos, btrim(it ->> 'description'), (it ->> 'qty')::numeric,
            coalesce(nullif(it ->> 'unit', ''), 'Nos'), (it ->> 'unit_price')::numeric);
  end loop;
  return v_rev;
end $$;
revoke all on function write_quotation_revision(uuid, int, jsonb, text) from public, anon, authenticated;

create or replace function create_quotation(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_year int; v_seq int; v_number text; v_id uuid; v_rev quotation_revisions;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  v_year := extract(year from coalesce((p ->> 'quote_date')::date, current_date))::int;
  perform pg_advisory_xact_lock(hashtext('quotation_number'));
  select coalesce(max(right(number, 4)::int), 0) + 1 into v_seq
  from quotations where number like 'HBC-QT-' || v_year || '-%';
  v_number := 'HBC-QT-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into quotations (number, created_by) values (v_number, auth.uid()) returning id into v_id;
  v_rev := write_quotation_revision(v_id, 0, p, 'Original');
  update quotations set client = v_rev.client, project = v_rev.project, quote_date = v_rev.quote_date,
    amount = v_rev.grand_total where id = v_id;

  perform log_audit('quotation.created', 'quotation', v_id::text, v_number, null,
    jsonb_build_object('client', v_rev.client, 'project', v_rev.project, 'grand_total', v_rev.grand_total));
  return v_id;
end $$;

create or replace function revise_quotation(p_id uuid, p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  q quotations; v_rev quotation_revisions; v_next int;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id for update;
  if not found then raise exception 'Quotation not found'; end if;
  v_next := q.current_revision + 1;
  v_rev := write_quotation_revision(p_id, v_next, p, p ->> 'revision_note');
  update quotations set current_revision = v_next, status = 'revised', client = v_rev.client,
    project = v_rev.project, quote_date = v_rev.quote_date, amount = v_rev.grand_total, updated_at = now()
  where id = p_id;

  perform log_audit('quotation.revised', 'quotation', p_id::text, q.number || ' R' || v_next,
    jsonb_build_object('revision', q.current_revision, 'grand_total', q.amount),
    jsonb_build_object('revision', v_next, 'grand_total', v_rev.grand_total));
  return v_next;
end $$;

create or replace function set_quotation_status(p_id uuid, p_status quotation_status) returns void
language plpgsql security definer set search_path = public as $$
declare q quotations;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id for update;
  if not found then raise exception 'Quotation not found'; end if;
  if q.status = p_status then return; end if;
  update quotations set status = p_status, updated_at = now() where id = p_id;
  perform log_audit('quotation.status_changed', 'quotation', p_id::text, q.number,
    jsonb_build_object('status', q.status), jsonb_build_object('status', p_status));
end $$;

grant execute on function create_quotation(jsonb), revise_quotation(uuid, jsonb),
  set_quotation_status(uuid, quotation_status) to authenticated;

-- ======== migrations/0005_storage.sql ========
-- Private bucket for scanned, signed salary slips.
-- Object path convention: salary-slips/{year}/{month}/{employee_code}/signed-slip.pdf
-- The path is stored in salary_slips.signed_path. The bucket is NOT public: the portal
-- views files through short-lived signed URLs (createSignedUrl), which requires the
-- select policy below.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signed-salary-slips', 'signed-salary-slips', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf'];

create policy signed_slips_read on storage.objects for select to authenticated
  using (bucket_id = 'signed-salary-slips' and has_role('administrator', 'payroll', 'viewer'));

create policy signed_slips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%'
              and has_role('administrator', 'payroll'));

-- update is needed for replacing a signed copy (upload with upsert)
create policy signed_slips_update on storage.objects for update to authenticated
  using (bucket_id = 'signed-salary-slips' and has_role('administrator', 'payroll'))
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%');

-- No delete policy: signed documents are retained permanently.

-- ======== migrations/0006_reporting.sql ========
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


-- ======== migrations/0007_multi_company.sql ========
-- Multi-company support: two fully separate companies, per-user / per-company roles.
--
-- The browser sends the chosen company in the `x-company-id` request header. current_company()
-- returns it only if the caller is a member, so RLS and the security-definer functions are
-- scoped to one company per request (no header / not a member => no rows, writes refused).
-- Existing data and users become Company 1 (HBC); administrators also administer Company 2 (MDGC).

-- ---------------------------------------------------------------- companies + membership
create table companies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,            -- quotation number prefix, e.g. HBC-QT-2026-0001
  name text not null,
  name_ar text not null default '',
  created_at timestamptz not null default now()
);

insert into companies (code, name, name_ar) values
  ('HBC',  'Hassan and Bilal Company', 'شركة حسن و بلال'),
  ('MDGC', 'Micro Data General Contracting Corporation', '');

create table company_members (
  user_id uuid not null references profiles (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  role app_role not null default 'viewer',
  primary key (user_id, company_id)
);
create index company_members_company_idx on company_members (company_id);

-- every existing user keeps their role in Company 1; administrators also administer Company 2
insert into company_members (user_id, company_id, role)
  select p.id, c.id, p.role from profiles p join companies c on c.code = 'HBC';
insert into company_members (user_id, company_id, role)
  select p.id, c.id, 'administrator' from profiles p join companies c on c.code = 'MDGC'
  where p.role = 'administrator';

comment on column profiles.role is 'Legacy: superseded by company_members.role. Kept only so old data is not lost.';

-- ---------------------------------------------------------------- helpers
create or replace function current_company() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_hdr text := nullif(current_setting('request.headers', true), '');
  v_raw text;
  v_id uuid;
begin
  if v_hdr is null then return null; end if;
  v_raw := v_hdr::json ->> 'x-company-id';
  if v_raw is null or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select company_id into v_id from company_members
  where user_id = auth.uid() and company_id = v_raw::uuid;
  return v_id;
end $$;

create or replace function require_company() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid := current_company();
begin
  if v is null then raise exception 'No company selected' using errcode = '42501'; end if;
  return v;
end $$;

create or replace function role_in(p_company uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select role from company_members where user_id = auth.uid() and company_id = p_company
$$;

create or replace function has_role_in(p_company uuid, variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(role_in(p_company) = any (roles), false)
$$;

-- has_role() (used by all policies and functions) now means "my role in the current company"
create or replace function current_app_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from company_members where user_id = auth.uid() and company_id = current_company()
$$;

create or replace function shares_company(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_members where user_id = p_user and company_id = current_company())
$$;

-- ---------------------------------------------------------------- company_id on business tables
alter table attendance disable trigger attendance_guard_trg;   -- backfill must not hit the month lock

do $$
declare
  t text;
  v_hbc uuid := (select id from companies where code = 'HBC');
begin
  foreach t in array array['settings', 'employees', 'attendance', 'payroll_periods', 'payroll_entries',
                           'salary_slips', 'quotations', 'quotation_revisions', 'quotation_items', 'audit_logs']
  loop
    execute format('alter table %I add column company_id uuid references companies (id)', t);
    execute format('update %I set company_id = $1', t) using v_hbc;
    execute format('alter table %I alter column company_id set not null', t);
    execute format('alter table %I alter column company_id set default current_company()', t);
    execute format('create index %I on %I (company_id)', t || '_company_idx', t);
  end loop;
end $$;

alter table attendance enable trigger attendance_guard_trg;

-- uniqueness is now per company
alter table settings drop constraint settings_pkey, add primary key (company_id, key);
alter table employees drop constraint employees_emp_code_key,
  add constraint employees_company_code_key unique (company_id, emp_code);
alter table payroll_periods drop constraint payroll_periods_year_month_key,
  add constraint payroll_periods_company_ym_key unique (company_id, year, month);
alter table salary_slips drop constraint salary_slips_slip_no_key,
  add constraint salary_slips_company_slip_key unique (company_id, slip_no);
alter table quotations drop constraint quotations_number_key,
  add constraint quotations_company_number_key unique (company_id, number);

-- ---------------------------------------------------------------- settings for Company 2
insert into settings (company_id, key, value, description)
  select c.id, s.key, s.value, s.description
  from companies c
  join settings s on s.company_id = (select id from companies where code = 'HBC')
  where c.code = 'MDGC' and s.key <> 'company';

insert into settings (company_id, key, value, description)
  select id, 'company',
    jsonb_build_object('name', name, 'name_ar', name_ar, 'address', 'Kingdom of Saudi Arabia',
      'phone', '', 'email', '', 'vat_no', '', 'cr_no', '', 'logo', ''),
    'Company details shown on documents'
  from companies where code = 'MDGC';

update settings set value = value || '{"logo": "/hbc-logo.webp"}'::jsonb
where key = 'company' and company_id = (select id from companies where code = 'HBC');

-- ---------------------------------------------------------------- new users
-- The first user becomes administrator of every company; later users have no access until an
-- administrator assigns them to a company.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_first boolean := not exists (select 1 from profiles);
begin
  insert into profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    case when v_first then 'administrator'::app_role else 'viewer'::app_role end
  );
  if v_first then
    insert into company_members (user_id, company_id, role)
      select new.id, id, 'administrator' from companies;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- audit + settings helpers
create or replace function setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::numeric from settings
                   where key = p_key and company_id = current_company()), p_default)
$$;

-- ---------------------------------------------------------------- attendance locking
drop function period_locked(date);
create or replace function period_locked(d date, p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from payroll_periods
    where company_id = p_company
      and year = extract(year from d)::int and month = extract(month from d)::int
      and status in ('approved', 'completed')
  )
$$;

create or replace function attendance_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_date date := coalesce(new.work_date, old.work_date);
  v_company uuid := coalesce(new.company_id, old.company_id);
  v_label text;
begin
  if period_locked(v_date, v_company) then
    raise exception 'Payroll for % is approved; attendance is locked. Reopen the payroll period to edit.',
      to_char(v_date, 'Mon YYYY') using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if not exists (select 1 from employees where id = new.employee_id and company_id = new.company_id) then
    raise exception 'Employee does not belong to this company';
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

-- ---------------------------------------------------------------- RLS
alter table companies        enable row level security;
alter table company_members  enable row level security;

create policy companies_read on companies for select to authenticated
  using (id in (select company_id from company_members where user_id = auth.uid()));
-- a user sees only their own memberships; administrators manage members through functions
create policy members_read_own on company_members for select to authenticated
  using (user_id = auth.uid());

drop policy profiles_read on profiles;
drop policy profiles_admin_update on profiles;
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or shares_company(id));

drop policy settings_read on settings;
drop policy settings_admin_write on settings;
create policy settings_read on settings for select to authenticated
  using (company_id = (select current_company()));
create policy settings_admin_write on settings for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));

drop policy employees_read on employees;
drop policy employees_write on employees;
create policy employees_read on employees for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'viewer'));
create policy employees_write on employees for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll'))
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll'));

drop policy attendance_read on attendance;
drop policy attendance_write on attendance;
create policy attendance_read on attendance for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'attendance', 'viewer'));
create policy attendance_write on attendance for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'attendance'))
  with check (company_id = (select current_company()) and has_role('administrator', 'attendance'));

drop policy periods_read on payroll_periods;
drop policy entries_read on payroll_entries;
drop policy slips_read on salary_slips;
create policy periods_read on payroll_periods for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy entries_read on payroll_entries for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy slips_read on salary_slips for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));

drop policy quotations_read on quotations;
drop policy quotation_revisions_read on quotation_revisions;
drop policy quotation_items_read on quotation_items;
create policy quotations_read on quotations for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations', 'viewer'));
create policy quotation_revisions_read on quotation_revisions for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations', 'viewer'));
create policy quotation_items_read on quotation_items for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations', 'viewer'));

drop policy audit_read on audit_logs;
create policy audit_read on audit_logs for select to authenticated using (
  company_id = (select current_company()) and (
    has_role('administrator', 'viewer')
    or (has_role('payroll', 'attendance') and record_type <> 'quotation')
    or (has_role('quotations') and record_type = 'quotation')
  )
);

-- ---------------------------------------------------------------- payroll functions
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
  v_hourly numeric; v_ot_rate numeric; v_ot_amt numeric; v_abs numeric;
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
    where employee_id = e.id and company_id = v_co and work_date between v_first and v_last;

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
      company_id, period_id, employee_id, basic, allowances, present_days, unpaid_days, regular_hours, ot_hours,
      ot_rate, ot_amount, other_earnings, absence_deduction, other_deductions, deductions, net_salary, breakdown
    ) values (
      v_co, v_period.id, e.id, e.basic_salary, e.allowances, a.present_days, a.unpaid_days, a.reg_h, a.ot_h,
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
  where period_id = v_period.id
    and employee_id not in (select id from employees where status = 'active' and company_id = v_co);

  update payroll_periods set status = 'calculated', calculated_at = now() where id = v_period.id;

  perform log_audit('payroll.calculated', 'payroll_period', v_period.id::text,
    to_char(v_first, 'Mon YYYY'), jsonb_build_object('status', v_period.status),
    jsonb_build_object('status', 'calculated', 'employees', v_count));
  return v_period.id;
end $$;

create or replace function update_entry_adjustment(
  p_entry uuid, p_other_earnings numeric, p_other_deductions numeric, p_note text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  en payroll_entries; pr payroll_periods; v_label text;
  v_ded numeric; v_net numeric;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into en from payroll_entries where id = p_entry and company_id = v_co for update;
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

create or replace function payroll_issues(p_period uuid)
returns table (employee_id uuid, emp_code text, name text, severity text, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  pr payroll_periods;
  v_first date; v_last date;
  v_max_ot numeric := setting_num('max_ot_per_day', 6);
  e employees; en payroll_entries;
  v_missing int; v_first_missing date; v_bad_ot int; v_high_ot int;
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

create or replace function approve_payroll(p_period uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  pr payroll_periods; v_errors int; v_label text; en record; sl salary_slips; v_n int := 0;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into pr from payroll_periods where id = p_period and company_id = v_co for update;
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
      insert into salary_slips (company_id, entry_id, period_id, employee_id, slip_no, net_snapshot)
      values (v_co, en.id, p_period, en.employee_id,
              'SS-' || pr.year || lpad(pr.month::text, 2, '0') || '-' || en.emp_code, en.net_salary);
      v_n := v_n + 1;
    elsif sl.net_snapshot <> en.net_salary then
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

create or replace function reopen_payroll(p_period uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); pr payroll_periods;
begin
  if not has_role('administrator') then
    raise exception 'Only an administrator can reopen payroll' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'A reason (at least 5 characters) is required to reopen payroll.';
  end if;
  select * into pr from payroll_periods where id = p_period and company_id = v_co for update;
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

create or replace function mark_slip_printed(p_slip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company();
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  update salary_slips set printed_at = coalesce(printed_at, now()),
    status = case when status = 'generated' then 'awaiting_signature'::slip_status else status end
  where id = p_slip and company_id = v_co;
end $$;

create or replace function signed_slip_path(p_slip uuid) returns text
language sql stable security definer set search_path = public as $$
  select 'salary-slips/' || s.company_id || '/' || pr.year || '/' || lpad(pr.month::text, 2, '0') || '/' || e.emp_code || '/signed-slip.pdf'
  from salary_slips s
  join payroll_periods pr on pr.id = s.period_id
  join employees e on e.id = s.employee_id
  where s.id = p_slip and s.company_id = current_company()
$$;

create or replace function register_signed_slip(p_slip uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); sl salary_slips;
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into sl from salary_slips where id = p_slip and company_id = v_co for update;
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

-- ---------------------------------------------------------------- quotation functions
create or replace function create_quotation(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  v_code text; v_year int; v_seq int; v_number text; v_id uuid; v_rev quotation_revisions;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select code into v_code from companies where id = v_co;
  v_year := extract(year from coalesce((p ->> 'quote_date')::date, current_date))::int;
  perform pg_advisory_xact_lock(hashtext('quotation_number:' || v_co::text));
  select coalesce(max(right(number, 4)::int), 0) + 1 into v_seq
  from quotations where company_id = v_co and number like v_code || '-QT-' || v_year || '-%';
  v_number := v_code || '-QT-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  insert into quotations (company_id, number, created_by) values (v_co, v_number, auth.uid()) returning id into v_id;
  v_rev := write_quotation_revision(v_id, 0, p, 'Original');
  update quotations set client = v_rev.client, project = v_rev.project, quote_date = v_rev.quote_date,
    amount = v_rev.grand_total where id = v_id;

  perform log_audit('quotation.created', 'quotation', v_id::text, v_number, null,
    jsonb_build_object('client', v_rev.client, 'project', v_rev.project, 'grand_total', v_rev.grand_total));
  return v_id;
end $$;

create or replace function revise_quotation(p_id uuid, p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  q quotations; v_rev quotation_revisions; v_next int;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'Quotation not found'; end if;
  v_next := q.current_revision + 1;
  v_rev := write_quotation_revision(p_id, v_next, p, p ->> 'revision_note');
  update quotations set current_revision = v_next, status = 'revised', client = v_rev.client,
    project = v_rev.project, quote_date = v_rev.quote_date, amount = v_rev.grand_total, updated_at = now()
  where id = p_id;

  perform log_audit('quotation.revised', 'quotation', p_id::text, q.number || ' R' || v_next,
    jsonb_build_object('revision', q.current_revision, 'grand_total', q.amount),
    jsonb_build_object('revision', v_next, 'grand_total', v_rev.grand_total));
  return v_next;
end $$;

create or replace function set_quotation_status(p_id uuid, p_status quotation_status) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); q quotations;
begin
  if not has_role('administrator', 'quotations') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select * into q from quotations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'Quotation not found'; end if;
  if q.status = p_status then return; end if;
  update quotations set status = p_status, updated_at = now() where id = p_id;
  perform log_audit('quotation.status_changed', 'quotation', p_id::text, q.number,
    jsonb_build_object('status', q.status), jsonb_build_object('status', p_status));
end $$;

-- ---------------------------------------------------------------- team management (per company)
create or replace function list_company_team()
returns table (user_id uuid, full_name text, email text, role app_role)
language plpgsql stable security definer set search_path = public as $$
declare v_co uuid := require_company();
begin
  if not has_role('administrator') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.email, m.role
    from profiles p
    left join company_members m on m.user_id = p.id and m.company_id = v_co
    order by p.created_at;
end $$;

-- p_role = null removes the user from the current company
create or replace function set_company_member(p_user uuid, p_role app_role) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := require_company();
  v_old app_role; v_name text;
begin
  if not has_role('administrator') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select full_name into v_name from profiles where id = p_user;
  if not found then raise exception 'User not found'; end if;
  select role into v_old from company_members where user_id = p_user and company_id = v_co;

  if v_old = 'administrator' and p_role is distinct from 'administrator'
     and (select count(*) from company_members where company_id = v_co and role = 'administrator') <= 1 then
    raise exception 'A company must keep at least one administrator.';
  end if;

  if p_role is null then
    delete from company_members where user_id = p_user and company_id = v_co;
  else
    insert into company_members (user_id, company_id, role) values (p_user, v_co, p_role)
    on conflict (user_id, company_id) do update set role = excluded.role;
  end if;

  perform log_audit('user.role_changed', 'user', p_user::text, v_name,
    jsonb_build_object('role', v_old), jsonb_build_object('role', p_role));
end $$;

grant execute on function list_company_team(), set_company_member(uuid, app_role) to authenticated;

-- ---------------------------------------------------------------- storage (signed salary slips)
-- New paths: salary-slips/<company_id>/<yyyy>/<mm>/<emp_code>/signed-slip.pdf
-- Legacy paths (salary-slips/<yyyy>/...) have no company segment and belong to Company 1.
create or replace function storage_path_company(p_name text) returns uuid
language sql stable security definer set search_path = public as $$
  select case
    when (string_to_array(p_name, '/'))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((string_to_array(p_name, '/'))[2])::uuid
    else (select id from companies where code = 'HBC')
  end
$$;

drop policy signed_slips_read on storage.objects;
drop policy signed_slips_insert on storage.objects;
drop policy signed_slips_update on storage.objects;

create policy signed_slips_read on storage.objects for select to authenticated
  using (bucket_id = 'signed-salary-slips'
         and has_role_in(storage_path_company(name), 'administrator', 'payroll', 'viewer'));

create policy signed_slips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%'
              and has_role_in(storage_path_company(name), 'administrator', 'payroll'));

create policy signed_slips_update on storage.objects for update to authenticated
  using (bucket_id = 'signed-salary-slips' and has_role_in(storage_path_company(name), 'administrator', 'payroll'))
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%'
              and has_role_in(storage_path_company(name), 'administrator', 'payroll'));

-- ======== migrations/0008_petty_cash.sql ========
-- Petty cash: cash given to employees, receipts they upload against it, and the net balance.
--
-- Employees do not sign in. Each gets a private link (a long random token) to a phone page.
-- The page talks to the database only through the token-checked functions below, which are the
-- only things granted to the `anon` role. Staff (administrator / payroll write, viewer read)
-- use the normal per-company RLS and security-definer functions.
--
-- balance = cash given - receipts that are not rejected (pending and approved both count).

create table pc_access (
  employee_id uuid primary key references employees (id) on delete cascade,
  company_id uuid not null references companies (id) default current_company(),
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table pc_cash_given (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  employee_id uuid not null references employees (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  given_on date not null default current_date,
  note text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index pc_cash_given_emp_idx on pc_cash_given (employee_id, given_on);
create index pc_cash_given_company_idx on pc_cash_given (company_id);

create table pc_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  employee_id uuid not null references employees (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  spent_on date not null,
  description text not null,
  file_path text not null,                 -- storage object in bucket petty-cash-receipts: {token}/{file}
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text not null default '',
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index pc_receipts_emp_idx on pc_receipts (employee_id, spent_on);
create index pc_receipts_company_idx on pc_receipts (company_id);

alter table pc_access     enable row level security;
alter table pc_cash_given enable row level security;
alter table pc_receipts   enable row level security;

-- tokens are never readable by the client; staff fetch a link through pc_get_link()
create policy pc_cash_read on pc_cash_given for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy pc_receipts_read on pc_receipts for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('petty-cash-receipts', 'petty-cash-receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

create or replace function pc_token_valid(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pc_access a join employees e on e.id = a.employee_id
    where a.token = p_token and e.status = 'active')
$$;

-- employees upload into the folder named by their own token (insert only: no read, update or delete)
create policy pc_receipts_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'petty-cash-receipts'
              and coalesce(array_length(storage.foldername(name), 1), 0) = 1
              and pc_token_valid((storage.foldername(name))[1]));

-- staff view a file only if a receipt in their current company points at it
create policy pc_receipts_view on storage.objects for select to authenticated
  using (bucket_id = 'petty-cash-receipts'
         and has_role('administrator', 'payroll', 'viewer')
         and exists (select 1 from pc_receipts r
                     where r.file_path = name and r.company_id = (select current_company())));

-- ---------------------------------------------------------------- staff functions
create or replace function pc_require_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role('administrator', 'payroll') then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  return require_company();
end $$;
revoke all on function pc_require_staff() from public, anon, authenticated;

create or replace function pc_employee_label(p_employee uuid, p_company uuid) returns text
language sql stable security definer set search_path = public as $$
  select emp_code || ' ' || name from employees where id = p_employee and company_id = p_company
$$;
revoke all on function pc_employee_label(uuid, uuid) from public, anon, authenticated;

-- Given / spent / balance for every employee that has any petty cash activity or a link.
create or replace function pc_summary()
returns table (employee_id uuid, given numeric, spent numeric, pending_count int, rejected_count int, balance numeric, has_link boolean)
language sql stable security definer set search_path = public as $$
  select e.id,
    coalesce(g.total, 0),
    coalesce(r.total, 0),
    coalesce(r.pending, 0),
    coalesce(r.rejected, 0),
    coalesce(g.total, 0) - coalesce(r.total, 0),
    exists (select 1 from pc_access a where a.employee_id = e.id)
  from employees e
  left join (select employee_id, sum(amount) total from pc_cash_given group by employee_id) g on g.employee_id = e.id
  left join (select employee_id,
               coalesce(sum(amount) filter (where status <> 'rejected'), 0) total,
               (count(*) filter (where status = 'pending'))::int pending,
               (count(*) filter (where status = 'rejected'))::int rejected
             from pc_receipts group by employee_id) r on r.employee_id = e.id
  where e.company_id = current_company()
    and has_role('administrator', 'payroll', 'viewer')
$$;
grant execute on function pc_summary() to authenticated;

create or replace function pc_give_cash(p_employee uuid, p_amount numeric, p_date date, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  v_id uuid;
  v_label text := pc_employee_label(p_employee, v_co);
begin
  if v_label is null then raise exception 'Employee not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  insert into pc_cash_given (company_id, employee_id, amount, given_on, note, created_by)
  values (v_co, p_employee, round(p_amount, 2), coalesce(p_date, current_date), btrim(coalesce(p_note, '')), auth.uid())
  returning id into v_id;
  perform log_audit('petty_cash.given', 'petty_cash', v_id::text, v_label, null,
    jsonb_build_object('amount', round(p_amount, 2), 'date', coalesce(p_date, current_date), 'note', btrim(coalesce(p_note, ''))));
  return v_id;
end $$;
grant execute on function pc_give_cash(uuid, numeric, date, text) to authenticated;

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
    jsonb_build_object('amount', c.amount, 'date', c.given_on, 'note', c.note), null);
end $$;
grant execute on function pc_delete_cash(uuid) to authenticated;

-- status = 'approved' | 'rejected' (a reason is required to reject, so the employee knows what to fix)
create or replace function pc_review_receipt(p_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  r pc_receipts;
begin
  if p_status not in ('approved', 'rejected') then raise exception 'Invalid status'; end if;
  if p_status = 'rejected' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Enter a reason so the employee knows what to upload again.';
  end if;
  select * into r from pc_receipts where id = p_id and company_id = v_co;
  if not found then raise exception 'Receipt not found'; end if;
  update pc_receipts set status = p_status,
    reject_reason = case when p_status = 'rejected' then btrim(p_reason) else '' end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;
  perform log_audit('petty_cash.receipt_' || p_status, 'petty_cash', p_id::text, pc_employee_label(r.employee_id, v_co),
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status, 'amount', r.amount, 'reason', btrim(coalesce(p_reason, ''))));
end $$;
grant execute on function pc_review_receipt(uuid, text, text) to authenticated;

-- The employee's private link token (created on first use). Regenerating revokes the old link.
create or replace function pc_get_link(p_employee uuid, p_regenerate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_co uuid := pc_require_staff();
  v_token text;
begin
  if pc_employee_label(p_employee, v_co) is null then raise exception 'Employee not found'; end if;
  if p_regenerate then
    delete from pc_access where employee_id = p_employee;
    perform log_audit('petty_cash.link_regenerated', 'petty_cash', p_employee::text, pc_employee_label(p_employee, v_co), null, null);
  end if;
  insert into pc_access (employee_id, company_id) values (p_employee, v_co)
  on conflict (employee_id) do nothing;
  select token into v_token from pc_access where employee_id = p_employee;
  return v_token;
end $$;
grant execute on function pc_get_link(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- employee functions (token = credential)
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
    'cash', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', given_on, 'note', note)
                                       order by given_on desc, created_at desc)
                      from pc_cash_given where employee_id = e.id), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'date', spent_on, 'description', description,
                                       'status', status, 'reject_reason', reject_reason)
                                       order by spent_on desc, created_at desc)
                          from pc_receipts where employee_id = e.id), '[]'::jsonb)
  );
end $$;
grant execute on function pc_statement(text) to anon, authenticated;

create or replace function pc_add_receipt(p_token text, p_amount numeric, p_date date, p_description text, p_file_path text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a pc_access; v_id uuid;
begin
  select a2.* into a from pc_access a2 join employees e on e.id = a2.employee_id
  where a2.token = p_token and e.status = 'active';
  if not found then raise exception 'This link is no longer valid. Ask the office for a new one.' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Enter the receipt amount.'; end if;
  if p_date is null or p_date > current_date + 1 then raise exception 'Enter the date on the receipt.'; end if;
  if btrim(coalesce(p_description, '')) = '' then raise exception 'Say what the money was spent on.'; end if;
  if p_file_path is null or p_file_path not like p_token || '/%' or length(p_file_path) > 300 then
    raise exception 'Attach a photo of the receipt.';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'petty-cash-receipts' and o.name = p_file_path) is false then
    raise exception 'The receipt photo did not upload. Please try again.';
  end if;
  insert into pc_receipts (company_id, employee_id, amount, spent_on, description, file_path)
  values (a.company_id, a.employee_id, round(p_amount, 2), p_date, btrim(p_description), p_file_path)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function pc_add_receipt(text, numeric, date, text, text) to anon, authenticated;

-- employees may remove a receipt that is still pending or was rejected (to upload it again)
create or replace function pc_delete_receipt(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a pc_access;
begin
  select * into a from pc_access where token = p_token;
  if not found then raise exception 'This link is no longer valid.' using errcode = '42501'; end if;
  delete from pc_receipts where id = p_id and employee_id = a.employee_id and status in ('pending', 'rejected');
  if not found then raise exception 'This receipt is approved and cannot be removed.'; end if;
end $$;
grant execute on function pc_delete_receipt(text, uuid) to anon, authenticated;

-- anon may call only the three employee functions above (nothing else in the schema)
revoke execute on function pc_token_valid(text) from public;
grant execute on function pc_token_valid(text) to anon, authenticated;

-- ======== migrations/0009_clients.sql ========
-- Client profiles: saved once per company, picked on a quotation instead of retyped.
-- Quotations keep their own copy of the client text, so changing a profile never rewrites history.

create table clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  name text not null check (btrim(name) <> ''),
  attention text not null default '',
  email text not null default '',
  phone text not null default '',
  address text not null default '',
  vat_no text not null default '',
  payment_terms text not null default '',
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
create unique index clients_company_name_key on clients (company_id, lower(btrim(name)));

alter table clients enable row level security;
create policy clients_read on clients for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations', 'viewer'));
create policy clients_write on clients for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations'))
  with check (company_id = (select current_company()) and has_role('administrator', 'quotations'));
grant select, insert, update, delete on clients to authenticated;

-- seed profiles from clients already used on quotations (latest revision wins)
insert into clients (company_id, name, attention, payment_terms)
select distinct on (r.company_id, lower(btrim(r.client)))
  r.company_id, btrim(r.client), r.attention, r.payment_terms
from quotation_revisions r
where btrim(r.client) <> ''
order by r.company_id, lower(btrim(r.client)), r.created_at desc;

-- ======== migrations/0010_petty_cash_given_by.sql ========
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
