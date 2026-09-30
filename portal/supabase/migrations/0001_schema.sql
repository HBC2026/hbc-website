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
