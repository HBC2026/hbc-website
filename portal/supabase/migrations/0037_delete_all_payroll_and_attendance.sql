-- DESTRUCTIVE, ONE-OFF: delete ALL payroll runs and ALL attendance for BOTH companies (HBC and Micro Data / MDGC).
-- Removes: salary_slips, payroll_entries, payroll_periods, attendance. This cannot be undone.
--
-- Not touched: employees, companies, settings, petty cash, documents, audit-log history.
-- Take a database backup first (Supabase > Database > Backups).
-- To preview: run it inside  begin; ... rollback;  and read the NOTICE lines.

do $$
begin
  raise notice 'Before: % slips, % payroll entries, % payroll periods, % attendance rows',
    (select count(*) from salary_slips), (select count(*) from payroll_entries),
    (select count(*) from payroll_periods), (select count(*) from attendance);

  alter table attendance disable trigger attendance_guard_trg;   -- deletes must not hit the approved-month lock

  delete from salary_slips;
  delete from payroll_entries;
  delete from payroll_periods;
  delete from attendance;

  alter table attendance enable trigger attendance_guard_trg;

  raise notice 'After: % slips, % payroll entries, % payroll periods, % attendance rows',
    (select count(*) from salary_slips), (select count(*) from payroll_entries),
    (select count(*) from payroll_periods), (select count(*) from attendance);
end $$;
