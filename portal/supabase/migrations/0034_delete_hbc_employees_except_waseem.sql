-- DESTRUCTIVE, ONE-OFF: delete every Hassan and Bilal Company (HBC) employee except Waseem, and ALL of their records
-- (attendance, payroll entries, salary slips, documents, petty cash given/receipts/links). This cannot be undone.
--
-- Run it only AFTER 0033 (so Waseem is in HBC), and take a database backup first (Supabase > Database > Backups).
-- Micro Data (MDGC) is not touched. Audit-log history is kept.
-- It stops with an error unless exactly ONE HBC employee matches "Waseem".
-- To preview: run it inside  begin; ... rollback;  and read the NOTICE lines.
--
-- Not removed: the uploaded files themselves (employee documents / petty cash receipt images) stay in Storage as
-- orphans; delete them from Storage > employee-documents / petty-cash-receipts if you want the space back.

do $$
declare
  v_hbc uuid := (select id from companies where code = 'HBC');
  v_keep uuid;
  v_n int;
  v_del uuid[];
begin
  if v_hbc is null then raise exception 'Company HBC not found'; end if;

  select count(*) into v_n from employees where company_id = v_hbc and name ilike '%waseem%';
  if v_n <> 1 then
    raise exception 'Expected exactly 1 HBC employee matching "Waseem", found %. Run 0033 first. Nothing changed.', v_n;
  end if;
  select id into v_keep from employees where company_id = v_hbc and name ilike '%waseem%';

  select coalesce(array_agg(id), '{}') into v_del from employees where company_id = v_hbc and id <> v_keep;
  raise notice 'Keeping %; deleting % employee(s)', (select name from employees where id = v_keep), cardinality(v_del);
  if cardinality(v_del) = 0 then return; end if;

  alter table attendance disable trigger attendance_guard_trg;   -- deletes must not hit the approved-month lock

  delete from salary_slips     where employee_id = any (v_del);
  delete from payroll_entries  where employee_id = any (v_del);
  delete from attendance       where employee_id = any (v_del);

  -- petty cash, documents and private links go with the employee (on delete cascade), but be explicit
  delete from pc_receipts      where employee_id = any (v_del);
  delete from pc_cash_given    where employee_id = any (v_del);
  delete from pc_access        where employee_id = any (v_del);
  delete from employee_documents where employee_id = any (v_del);

  -- payroll periods that listed specific employees must not keep pointing at deleted ids
  update payroll_periods
    set employee_ids = array(select x from unnest(employee_ids) x where x <> all (v_del))
    where company_id = v_hbc and employee_ids is not null;

  delete from employees where id = any (v_del);

  alter table attendance enable trigger attendance_guard_trg;
  raise notice 'Done. HBC now has % employee(s).', (select count(*) from employees where company_id = v_hbc);
end $$;
