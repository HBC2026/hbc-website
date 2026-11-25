-- Employee compliance: work permit and Tamin (insurance) expiry dates, plus a renewal / fee history
-- for work permit, iqama and Tamin.
-- Run once in the SQL editor, after 0038, BEFORE deploying the app version that uses it.

alter table employees
  add column if not exists work_permit_expiry_date date,
  add column if not exists tamin_expiry_date date;

create table if not exists employee_renewals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default current_company() references companies (id),
  employee_id uuid not null references employees (id) on delete cascade,
  item text not null check (item in ('work_permit', 'iqama', 'tamin')),
  expiry_date date,                       -- new expiry given by this renewal (blank = fee payment only)
  previous_expiry date,                   -- what the employee held before; used if this entry is deleted
  fee_paid numeric(12, 2) check (fee_paid >= 0),
  paid_date date,
  note text not null default '',
  created_by uuid references profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (expiry_date is not null or fee_paid is not null)
);
create index if not exists employee_renewals_emp_idx on employee_renewals (employee_id, item);
create index if not exists employee_renewals_company_idx on employee_renewals (company_id);

-- Fees are payroll information: the attendance role does not see them. No update policy: a wrong entry
-- is deleted and recorded again, so history is never silently rewritten.
alter table employee_renewals enable row level security;
create policy employee_renewals_read on employee_renewals for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll', 'viewer'));
create policy employee_renewals_insert on employee_renewals for insert to authenticated
  with check (company_id = (select current_company()) and has_role('administrator', 'payroll'));
create policy employee_renewals_delete on employee_renewals for delete to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'payroll'));

-- Keeps the employee's current expiry dates in step with the history.
create or replace function employee_renewal_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r employee_renewals;
  e employees;
  v_col text;
  v_current date;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  v_col := case r.item when 'work_permit' then 'work_permit_expiry_date'
                       when 'iqama' then 'iqama_expiry_date' else 'tamin_expiry_date' end;

  select * into e from employees where id = r.employee_id and company_id = r.company_id for update;
  if not found then
    if tg_op = 'INSERT' then raise exception 'Employee not found in this company'; end if;
    return old;                           -- the employee is being deleted
  end if;
  v_current := (to_jsonb(e) ->> v_col)::date;

  if tg_op = 'INSERT' then
    new.previous_expiry := v_current;
    if new.expiry_date is not null then   -- greatest(): back-filling an old renewal never moves the date back
      execute format('update employees set %I = $1 where id = $2', v_col)
        using greatest(v_current, new.expiry_date), r.employee_id;
    end if;
  else
    -- entries recorded on top of this one must not fall back to a date that no longer exists
    update employee_renewals set previous_expiry = old.previous_expiry
    where employee_id = old.employee_id and item = old.item and previous_expiry = old.expiry_date;
    if old.expiry_date is not null and v_current = old.expiry_date then
      execute format('update employees set %I = $1 where id = $2', v_col)
        using greatest(old.previous_expiry,
                       (select max(expiry_date) from employee_renewals
                        where employee_id = old.employee_id and item = old.item and id <> old.id)), r.employee_id;
    end if;
  end if;

  if auth.uid() is not null then          -- no fee amounts here: the attendance role can read the audit log
    perform log_audit(
      case when tg_op = 'INSERT' then 'employee.renewal_added' else 'employee.renewal_deleted' end,
      'employee', r.employee_id::text, e.emp_code || ' ' || e.name,
      case when tg_op = 'DELETE' then jsonb_build_object('item', r.item, 'expiry_date', r.expiry_date, 'paid_date', r.paid_date) end,
      case when tg_op = 'INSERT' then jsonb_build_object('item', r.item, 'expiry_date', r.expiry_date, 'paid_date', r.paid_date) end);
  end if;

  if tg_op = 'INSERT' then return new; end if;
  return old;
end $$;
revoke execute on function employee_renewal_apply() from public, anon, authenticated;

drop trigger if exists employee_renewals_apply_trg on employee_renewals;
create trigger employee_renewals_apply_trg before insert or delete on employee_renewals
  for each row execute function employee_renewal_apply();
