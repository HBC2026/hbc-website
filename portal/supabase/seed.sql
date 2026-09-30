-- DEMO DATA for the HBC Admin Portal. Run once after the migrations. Safe to delete later:
--   truncate employees, quotations restart identity cascade;   (and payroll_periods cascade)
-- Names, clients and amounts are fictional.

insert into employees (emp_code, name, job_title, department, joining_date, basic_salary, allowances, ot_method, ot_rate) values
  ('HBC-001', 'Abdullah Al-Harbi',   'Site Manager',          'Operations',   '2021-03-01', 9500, 2500, 'multiplier', null),
  ('HBC-002', 'Muhammad Usman',      'Civil Engineer',        'Engineering',  '2022-01-15', 7200, 1800, 'multiplier', null),
  ('HBC-003', 'Faisal Al-Qahtani',   'Safety Officer',        'HSE',          '2022-06-01', 6000, 1500, 'multiplier', null),
  ('HBC-004', 'Rashid Ahmed',        'Foreman',               'Operations',   '2020-09-10', 4200, 1000, 'multiplier', null),
  ('HBC-005', 'Imran Khan',          'Electrician',           'MEP',          '2023-02-01', 3200,  800, 'multiplier', null),
  ('HBC-006', 'Sanjay Kumar',        'Plumber',               'MEP',          '2023-04-20', 2800,  700, 'multiplier', null),
  ('HBC-007', 'Mohammed Ali',        'Mason',                 'Operations',   '2021-11-05', 2400,  600, 'fixed',      14),
  ('HBC-008', 'Bilal Hussain',       'Steel Fixer',           'Operations',   '2022-08-18', 2400,  600, 'fixed',      14),
  ('HBC-009', 'Yasir Mahmood',       'Welder',                'Fabrication',  '2022-10-01', 3000,  750, 'multiplier', null),
  ('HBC-010', 'Nasser Al-Dosari',    'Procurement Officer',   'Procurement',  '2021-05-12', 5500, 1400, 'multiplier', null),
  ('HBC-011', 'Zahid Iqbal',         'Heavy Equipment Operator','Operations', '2023-07-01', 3400,  900, 'multiplier', null),
  ('HBC-012', 'Omar Al-Shehri',      'Accounts Assistant',    'Administration','2024-01-10', 4800, 1200, 'multiplier', null);

-- Attendance: 1 Aug 2026 → 29 Sep 2026 (today, 30 Sep, is left open for you to mark).
-- Fridays are weekly off, 23 Sep (National Day) is a holiday; a few deterministic exceptions and OT days.
alter table attendance disable trigger attendance_guard_trg;

insert into attendance (employee_id, work_date, status, regular_hours, ot_hours, remarks)
select e.id, d::date, s.status,
       case when s.status = 'present' then 8 else 0 end,
       case when s.status = 'present' and s.h % 100 between 60 and 74 then 1 + (s.h % 3) else 0 end,
       case s.status when 'absent' then 'No show' when 'sick_leave' then 'Medical certificate' else '' end
from employees e
cross join generate_series('2026-08-01'::date, '2026-09-29'::date, interval '1 day') d
cross join lateral (select abs(hashtext(e.emp_code || d::text)) as h) x
cross join lateral (
  select x.h,
    case
      when extract(dow from d) = 5 then 'weekly_off'
      when d::date = '2026-09-23' then 'holiday'
      when x.h % 100 < 2 then 'absent'
      when x.h % 100 between 2 and 3 then 'sick_leave'
      when x.h % 100 = 4 and e.emp_code in ('HBC-005', 'HBC-010') then 'annual_leave'
      else 'present'
    end::attendance_status as status
) s
where d::date >= e.joining_date;

alter table attendance enable trigger attendance_guard_trg;

-- Quotations (with one revised example)
create or replace function pg_temp.seed_q(
  p_number text, p_status quotation_status, p_client text, p_attn text, p_project text, p_date date,
  p_terms text, p_items jsonb, p_disc numeric, p_revs int
) returns void language plpgsql as $$
declare v_id uuid; v_sub numeric; v_vat numeric; v_grand numeric; v_rev int; v_rid uuid; it jsonb; pos int;
begin
  select coalesce(sum((i ->> 'qty')::numeric * (i ->> 'unit_price')::numeric), 0) into v_sub from jsonb_array_elements(p_items) i;
  insert into quotations (number, status, client, project, quote_date, amount, current_revision)
  values (p_number, p_status, p_client, p_project, p_date, 0, p_revs) returning id into v_id;
  for v_rev in 0..p_revs loop
    -- earlier revisions carry a slightly higher price so the history is visible
    v_sub := (select sum((i ->> 'qty')::numeric * (i ->> 'unit_price')::numeric) from jsonb_array_elements(p_items) i)
             * (1 + 0.05 * (p_revs - v_rev));
    v_vat := round((v_sub - p_disc) * 0.15, 2);
    v_grand := v_sub - p_disc + v_vat;
    insert into quotation_revisions (quotation_id, revision, client, attention, project, quote_date, validity_days, reference,
      subtotal, discount, vat_rate, vat_amount, grand_total, payment_terms, delivery, notes, revision_note)
    values (v_id, v_rev, p_client, p_attn, p_project, p_date, 30, 'RFQ-' || right(p_number, 4),
      v_sub, p_disc, 0.15, v_vat, v_grand, p_terms, '2-3 weeks from PO', 'Prices are valid for the stated period. Site access to be provided by client.',
      case when v_rev = 0 then 'Original' else 'Revised pricing' end) returning id into v_rid;
    pos := 0;
    for it in select * from jsonb_array_elements(p_items) loop
      pos := pos + 1;
      insert into quotation_items (revision_id, position, description, qty, unit, unit_price)
      values (v_rid, pos, it ->> 'd', (it ->> 'qty')::numeric, it ->> 'u',
              round((it ->> 'unit_price')::numeric * (1 + 0.05 * (p_revs - v_rev)), 2));
    end loop;
    if v_rev = p_revs then
      update quotations set amount = v_grand where id = v_id;
    end if;
  end loop;
end $$;

select pg_temp.seed_q('HBC-QT-2026-0148', 'draft', 'Eastern Steel Pipe Co.', 'Eng. Khalid Al-Mutairi', 'Pipe rack foundation works', '2026-09-30',
  '30% advance, 60% progress, 10% on completion',
  '[{"d":"Excavation and backfill","qty":420,"u":"m3","unit_price":38},{"d":"Reinforced concrete C35 foundations","qty":185,"u":"m3","unit_price":690},{"d":"Anchor bolt installation","qty":96,"u":"Nos","unit_price":210}]', 0, 0);
select pg_temp.seed_q('HBC-QT-2026-0147', 'submitted', 'Al-Rajhi Development', 'Mr. Saad Al-Rajhi', 'Warehouse fit-out, Dammam', '2026-09-27',
  '50% advance, 50% on handover',
  '[{"d":"Partition walls and finishing","qty":640,"u":"m2","unit_price":145},{"d":"HVAC ducting and installation","qty":1,"u":"Lot","unit_price":48500},{"d":"Electrical lighting works","qty":1,"u":"Lot","unit_price":32000}]', 2500, 0);
select pg_temp.seed_q('HBC-QT-2026-0146', 'revised', 'Gulf Petrochem Services', 'Eng. Tariq Zaidi', 'Plant maintenance shutdown support', '2026-09-22',
  '30 days from invoice',
  '[{"d":"Skilled manpower - mechanical","qty":24,"u":"Man-month","unit_price":6800},{"d":"Scaffolding erection and dismantling","qty":1,"u":"Lot","unit_price":41000}]', 0, 2);
select pg_temp.seed_q('HBC-QT-2026-0145', 'submitted', 'Najd Logistics', 'Ms. Huda Al-Anazi', 'Yard paving and drainage', '2026-09-19',
  '40% advance, 60% progress',
  '[{"d":"Asphalt paving 60mm","qty":5200,"u":"m2","unit_price":52},{"d":"Storm drainage pipework","qty":380,"u":"m","unit_price":215}]', 5000, 0);
select pg_temp.seed_q('HBC-QT-2026-0144', 'approved', 'Red Sea Contracting', 'Eng. Amjad Farooq', 'Site office cabins supply', '2026-09-12',
  '50% advance, 50% on delivery',
  '[{"d":"Prefab site office cabin 6x3m","qty":4,"u":"Nos","unit_price":18500},{"d":"Installation and connection","qty":4,"u":"Nos","unit_price":2200}]', 0, 0);
select pg_temp.seed_q('HBC-QT-2026-0143', 'rejected', 'Sahara Facilities', 'Mr. Yousef Al-Otaibi', 'Annual MEP maintenance contract', '2026-09-05',
  'Quarterly in advance',
  '[{"d":"Preventive maintenance visits","qty":52,"u":"Visit","unit_price":1450}]', 0, 0);
select pg_temp.seed_q('HBC-QT-2026-0142', 'approved', 'Tenaris Saudi Steel Pipe', 'Eng. Nabil Sharif', 'Access road resurfacing', '2026-08-28',
  '30% advance, 70% on completion',
  '[{"d":"Road resurfacing works","qty":1,"u":"Lot","unit_price":73500}]', 0, 0);
select pg_temp.seed_q('HBC-QT-2026-0141', 'expired', 'Alsafi Foods', 'Mr. Waleed Bakr', 'Cold room civil works', '2026-07-20',
  '50% advance, 50% on completion',
  '[{"d":"Cold room slab and insulation base","qty":1,"u":"Lot","unit_price":62000}]', 0, 0);
