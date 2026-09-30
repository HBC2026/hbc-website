// DB tests for multi-company support, run on PGlite (in-process Postgres) with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/run.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');
const db = new PGlite();

let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const throws = async (sql, name, re) => {
  try { await db.exec(sql); ok(false, `${name} (expected error)`); }
  catch (e) { ok(!re || re.test(e.message), `${name}${re && !re.test(e.message) ? ' — got: ' + e.message : ''}`); }
};
const q = async (sql) => (await db.query(sql)).rows;

// ---- Supabase stubs
await db.exec(`
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create role anon; create role authenticated;
`);

for (const f of ['0001_schema.sql', '0002_helpers_audit_rls.sql', '0003_payroll_functions.sql',
  '0004_quotation_functions.sql', '0005_storage.sql', '0006_reporting.sql']) await db.exec(mig(f));

// ---- legacy single-company data
const U1 = '11111111-1111-1111-1111-111111111111'; // first user -> administrator
const U2 = '22222222-2222-2222-2222-222222222222'; // payroll
const U3 = '33333333-3333-3333-3333-333333333333'; // Company 2 viewer
await db.exec(`
  insert into auth.users (id, email) values ('${U1}', 'admin@x.test'), ('${U2}', 'pay@x.test'), ('${U3}', 'md@x.test');
  insert into employees (emp_code, name, job_title, department, joining_date, basic_salary)
    values ('E-001', 'Legacy Emp', 'Mason', 'Ops', '2026-01-01', 3000);
  insert into attendance (employee_id, work_date, status, regular_hours)
    select id, '2026-08-03', 'present', 8 from employees;
  update profiles set role = 'payroll' where id = '${U2}';
  insert into payroll_periods (year, month, status) values (2026, 8, 'approved');
  insert into quotations (number, client) values ('HBC-QT-2026-0001', 'Old Client');
  insert into audit_logs (action, record_type) values ('x', 'y');
`);

if (!existsSync(join(here, '..', 'migrations', '0007_multi_company.sql'))) {
  console.log('FAIL  0007_multi_company.sql does not exist yet'); process.exit(1);
}
await db.exec(mig('0007_multi_company.sql'));
await db.exec(`grant usage on schema public, storage to authenticated;
  grant all on all tables in schema public to authenticated;
  grant all on all tables in schema storage to authenticated;
  grant execute on all functions in schema public to authenticated;`);

// ---- helpers: act as a user in a company
const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  const hdr = company ? JSON.stringify({ 'x-company-id': company }) : '{}';
  await db.exec(`select set_config('request.headers', '${hdr}', false)`);
  await db.exec('set role authenticated');
}
const count = async (t) => Number((await q(`select count(*) c from ${t}`))[0].c);

// ---- backfill
await db.exec('reset role');
ok((await q(`select count(*) c from employees where company_id = '${HBC}'`))[0].c == 1, 'legacy employee backfilled to Company 1');
ok((await q(`select count(*) c from attendance where company_id = '${HBC}'`))[0].c == 1, 'legacy attendance backfilled despite approved month lock');
ok((await q(`select count(*) c from quotations where company_id = '${HBC}'`))[0].c == 1, 'legacy quotation backfilled');
ok((await q(`select count(*) c from settings where company_id = '${HBC}'`))[0].c >= 6, 'Company 1 settings backfilled');
ok((await q(`select count(*) c from settings where company_id = '${MD}'`))[0].c >= 6, 'Company 2 has its own settings');
ok((await q(`select value->>'name' n from settings where company_id='${MD}' and key='company'`))[0].n === 'Micro Data General Contracting Corporation', 'Company 2 name set');
const mem = await q(`select user_id, company_id, role from company_members order by user_id, company_id`);
ok(mem.some((m) => m.user_id === U1 && m.company_id === HBC && m.role === 'administrator'), 'admin is administrator of Company 1');
ok(mem.some((m) => m.user_id === U1 && m.company_id === MD && m.role === 'administrator'), 'admin is administrator of Company 2');
ok(mem.some((m) => m.user_id === U2 && m.company_id === HBC && m.role === 'payroll'), 'payroll user keeps role in Company 1');
ok(!mem.some((m) => m.user_id === U2 && m.company_id === MD), 'payroll user has no Company 2 access');

// U3 gets Company 2 only, as viewer (legacy signup had no company access)
await db.exec(`delete from company_members where user_id = '${U3}'`);
await db.exec(`insert into company_members values ('${U3}', '${MD}', 'viewer')`);

// ---- isolation
await as(U2, HBC);
ok(await count('employees') === 1, 'payroll user sees Company 1 employees');
await as(U2, MD);
ok(await count('employees') === 0 && await count('settings') === 0, 'payroll user with forged Company 2 header sees nothing');
await as(U2, null);
ok(await count('employees') === 0, 'no company header -> no rows');
await as(U2, '00000000-0000-0000-0000-000000000000');
ok(await count('employees') === 0, 'unknown company header -> no rows');
await as(U3, HBC);
ok(await count('employees') === 0 && await count('quotations') === 0, 'Company 2 viewer cannot read Company 1 via header');
await as(U3, MD);
ok(await count('settings') >= 6, 'Company 2 viewer reads Company 2 settings');
await throws(`insert into employees (emp_code, name, joining_date) values ('X', 'Nope', '2026-01-01')`, 'viewer cannot insert employees', /row-level security/);

// ---- same codes in both companies; writes land in the current company
await as(U1, MD);
await db.exec(`insert into employees (emp_code, name, job_title, department, joining_date, basic_salary)
  values ('E-001', 'MD Emp', 'Engineer', 'Eng', '2026-01-01', 6000)`);
ok((await q(`select company_id from employees`))[0].company_id === MD && await count('employees') === 1, 'admin in Company 2 creates employee there; does not see Company 1 rows');
await throws(`insert into employees (emp_code, name, joining_date) values ('E-001', 'Dup', '2026-01-01')`, 'emp_code unique within a company', /duplicate key/);
await throws(`insert into employees (company_id, emp_code, name, joining_date) values ('${HBC}', 'E-9', 'Sneaky', '2026-01-01')`, 'cannot insert into another company explicitly', /row-level security/);

// ---- attendance guards
await as(U1, MD);
await db.exec(`insert into attendance (employee_id, work_date, status, regular_hours)
  select id, '2026-09-01', 'present', 8 from employees`);
ok(await count('attendance') === 1, 'attendance recorded in Company 2');
await as(U1, HBC);
const hbcEmp = (await q(`select id from employees`))[0].id;
await as(U1, MD);
await throws(`insert into attendance (employee_id, work_date, status) values ('${hbcEmp}', '2026-09-02', 'present')`,
  "attendance for another company's employee is rejected");
await as(U1, HBC);
await throws(`insert into attendance (employee_id, work_date, status) values ('${hbcEmp}', '2026-08-04', 'present')`,
  'locked month in Company 1 still blocks attendance', /locked/);
await as(U1, MD);
await db.exec(`insert into attendance (employee_id, work_date, status, regular_hours)
  select id, '2026-08-04', 'present', 8 from employees`);
ok(true, 'Company 1 approved month does not lock Company 2 attendance');

// ---- payroll per company
await as(U1, MD);
const mdPeriod = (await q(`select calculate_payroll(2026, 9) as id`))[0].id;
ok((await q(`select company_id from payroll_periods where id = '${mdPeriod}'`))[0].company_id === MD, 'calculate_payroll creates period in current company');
ok(await count('payroll_entries') === 1, 'Company 2 payroll has only its employee');
await as(U1, HBC);
ok(await count('payroll_periods') === 1, 'Company 1 periods unaffected by Company 2 calculation');
await throws(`select approve_payroll('${mdPeriod}')`, "cannot approve another company's period", /not found/i);
await as(U1, MD);
const mdAug = (await q(`select calculate_payroll(2026, 8) as id`))[0].id;
ok(mdAug !== null, 'same month can exist in both companies');

// ---- quotations numbering
const qpayload = `'{"client":"C","items":[{"description":"x","qty":1,"unit_price":100}]}'::jsonb`;
await as(U1, MD);
const mdQ = (await q(`select create_quotation(${qpayload}) id`))[0].id;
ok((await q(`select number from quotations where id = '${mdQ}'`))[0].number.startsWith('MDGC-QT-'), 'Company 2 quotation prefix MDGC');
ok((await q(`select number from quotations`))[0].number.endsWith('-0001'), 'Company 2 numbering starts at 0001');
await as(U1, HBC);
const hbcQ = (await q(`select create_quotation(${qpayload}) id`))[0].id;
ok((await q(`select number from quotations where id = '${hbcQ}'`))[0].number.startsWith('HBC-QT-'), 'Company 1 prefix HBC');
await as(U1, MD);
await throws(`select set_quotation_status('${hbcQ}', 'approved')`, "cannot change another company's quotation", /not found/i);

// ---- audit scoping
await as(U1, HBC);
const hbcAudit = await count('audit_logs');
await as(U1, MD);
ok(await count('audit_logs') > 0 && (await q(`select count(*) c from audit_logs where company_id <> '${MD}'`))[0].c == 0, 'audit log scoped to company');
ok(hbcAudit > 0, 'Company 1 audit visible in Company 1');

// ---- team management
await as(U1, MD);
const team = await q(`select * from list_company_team()`);
ok(team.length === 3, 'administrator lists all users for assignment');
await db.exec(`select set_company_member('${U2}', 'quotations')`);
await db.exec('reset role');
ok((await q(`select role from company_members where user_id='${U2}' and company_id='${MD}'`))[0].role === 'quotations', 'administrator adds a user to the company');
await db.exec(`select set_company_member('${U2}', null)`);
await db.exec('reset role');
ok((await q(`select count(*) c from company_members where user_id='${U2}' and company_id='${MD}'`))[0].c == 0, 'administrator removes a user from the company');
await as(U1, MD);
await throws(`select set_company_member('${U1}', 'viewer')`, 'cannot demote the last administrator', /at least one administrator/);
await as(U2, HBC);
await throws(`select * from list_company_team()`, 'non-admin cannot list team', /Not permitted/);
await throws(`select set_company_member('${U2}', 'administrator')`, 'non-admin cannot assign roles', /Not permitted/);

// ---- storage path policies
await as(U2, HBC);
await db.exec(`insert into storage.objects (bucket_id, name) values ('signed-salary-slips', 'salary-slips/${HBC}/2026/08/E-001/signed-slip.pdf')`);
ok(true, 'payroll user uploads into own company folder');
await throws(`insert into storage.objects (bucket_id, name) values ('signed-salary-slips', 'salary-slips/${MD}/2026/08/E-001/signed-slip.pdf')`,
  'cannot upload into another company folder', /row-level security/);
await db.exec(`insert into storage.objects (bucket_id, name) values ('signed-salary-slips', 'salary-slips/2026/07/E-001/signed-slip.pdf')`);
ok(true, 'legacy path (no company segment) treated as Company 1');
await as(U3, MD);
ok(await count(`storage.objects where bucket_id = 'signed-salary-slips'`) === 0, 'Company 2 viewer sees no Company 1 files');

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
