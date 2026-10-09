-- Payroll runs created before pay periods existed have no dates; give them their calendar month so every run (and its salary slips) shows a pay period.
update payroll_periods
set start_date = make_date(year, month, 1),
    end_date = (make_date(year, month, 1) + interval '1 month - 1 day')::date
where start_date is null or end_date is null;
