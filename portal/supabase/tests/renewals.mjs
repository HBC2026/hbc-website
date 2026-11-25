// DB tests for work permit / iqama / Tamin renewals (0039), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/renewals.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'migrations');
const mig = (f) => readFileSync(join(dir, f), 'utf8');
const db = new PGlite();

let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const throws = async (sql, name, re) => {
  try { await db.exec(sql); ok(false, `${name} (expected error)`); }
  catch (e) { ok(re.test(e.message), `${name}${re.test(e.message) ? '' : ' — got: ' + e.message}`); }
};
const q = async (sql) => (await db.query(sql)).rows;

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

// schema migrations only; 0033, 0034, 0036 and 0037 are one-off data changes
const skip = /^00(33|34|36|37)_/;
const U1 = '11111111-1111-1111-1111-111111111111'; // administrator
const U2 = '22222222-2222-2222-2222-222222222222'; // payroll
const U3 = '33333333-3333-3333-3333-333333333333'; // attendance
const U4 = '44444444-4444-4444-4444-444444444444'; // viewer
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql') && !skip.test(f)).sort()) {
  // users exist before multi-company so they get memberships
  if (f.startsWith('0007_')) await db.exec(`
    insert into auth.users (id, email) values ('${U1}', 'a@x.test'), ('${U2}', 'p@x.test'), ('${U3}', 't@x.test'), ('${U4}', 'v@x.test');
    update profiles set role = 'payroll' where id = '${U2}';
    update profiles set role = 'attendance' where id = '${U3}';
    update profiles set role = 'viewer' where id = '${U4}';`);
  try { await db.exec(mig(f)); }
  catch (e) { console.log(`FAIL  migration ${f}: ${e.message}`); process.exit(1); }
}
await db.exec(`grant usage on schema public, storage to authenticated;
  grant all on all tables in schema public to authenticated;`);

const companies = await q(`select id from companies order by code`);
const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const OTHER = companies.find((c) => c.id !== HBC).id;
async function as(user, company = HBC) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false)`);
  await db.exec(`select set_config('request.headers', '${JSON.stringify({ 'x-company-id': company })}', false)`);
  await db.exec('set role authenticated');
}

await as(U1);
await db.exec(`insert into employees (emp_code, name, job_title, department, joining_date, basic_salary, iqama_expiry_date)
  values ('HBC-001', 'Test Emp', 'Mason', 'Ops', '2026-01-01', 3000, '2026-12-01')`);
const EMP = (await q(`select id from employees where emp_code = 'HBC-001'`))[0].id;

const expiry = async (col) => (await q(`select to_char(${col}, 'YYYY-MM-DD') d from employees where id = '${EMP}'`))[0].d;
const add = (item, exp, fee = 'null') => db.query(
  `insert into employee_renewals (employee_id, item, expiry_date, fee_paid, paid_date)
   values ('${EMP}', '${item}', ${exp ? `'${exp}'` : 'null'}, ${fee}, '2026-11-25') returning id`).then((r) => r.rows[0].id);
const del = (id) => db.exec(`delete from employee_renewals where id = '${id}'`);

// ---- current expiry follows the history
await as(U2);
const wp = await add('work_permit', '2027-03-01', 9700);
ok(await expiry('work_permit_expiry_date') === '2027-03-01', 'work permit renewal sets the current expiry');
await add('tamin', '2027-05-01', 1200);
ok(await expiry('tamin_expiry_date') === '2027-05-01', 'tamin renewal sets the current expiry');
const iq1 = await add('iqama', '2027-12-01', 650);
ok(await expiry('iqama_expiry_date') === '2027-12-01', 'iqama renewal moves the existing expiry forward');
await add('iqama', '2025-12-01', 600);
ok(await expiry('iqama_expiry_date') === '2027-12-01', 'back-filling an old renewal keeps the newer expiry');
await add('work_permit', null, 500);
ok(await expiry('work_permit_expiry_date') === '2027-03-01', 'fee without a new expiry leaves the expiry alone');

// ---- deleting a mistake rolls the expiry back
await del(iq1);
ok(await expiry('iqama_expiry_date') === '2026-12-01', 'deleting the latest renewal restores the date held before it');
await del(wp);
ok(await expiry('work_permit_expiry_date') === null, 'deleting the only dated renewal clears the expiry');
const a = await add('work_permit', '2027-01-01');
const b = await add('work_permit', '2028-01-01');
await del(a);
await del(b);
ok(await expiry('work_permit_expiry_date') === null, 'deleting out of order never revives a deleted date');

// ---- validation
await throws(`insert into employee_renewals (employee_id, item) values ('${EMP}', 'iqama')`, 'needs an expiry date or a fee', /check constraint/);
await throws(`insert into employee_renewals (employee_id, item, fee_paid) values ('${EMP}', 'iqama', -1)`, 'rejects a negative fee', /check constraint/);
await throws(`insert into employee_renewals (employee_id, item, fee_paid) values ('${EMP}', 'visa', 1)`, 'rejects an unknown item', /check constraint/);

// ---- access
const seen = async () => Number((await q(`select count(*) c from employee_renewals`))[0].c);
await as(U4);
ok(await seen() > 0, 'viewer can read the history');
await throws(`insert into employee_renewals (employee_id, item, fee_paid) values ('${EMP}', 'iqama', 1)`, 'viewer cannot add', /row-level security/);
await as(U3);
ok(await seen() === 0, 'attendance role cannot see fees');
await as(U1, OTHER);
ok(await seen() === 0, 'another company cannot see the history');
await throws(`insert into employee_renewals (employee_id, item, expiry_date) values ('${EMP}', 'iqama', '2030-01-01')`,
  'cannot record against another company\'s employee', /not found in this company/);

// ---- history is kept as entered, and goes when the employee goes
await as(U1);
await db.exec(`update employee_renewals set fee_paid = 1`);
ok((await q(`select count(*) c from employee_renewals where fee_paid = 1`))[0].c == 0, 'history rows cannot be edited');
ok((await q(`select count(*) c from audit_logs where action = 'employee.renewal_added' and new_value ? 'fee_paid'`))[0].c == 0, 'audit log does not carry fee amounts');
await db.exec('reset role');
await db.exec(`select set_config('request.jwt.claim.sub', '', false); select set_config('request.headers', '{}', false)`);
await db.exec(`delete from employees where id = '${EMP}'`);
ok((await q(`select count(*) c from employee_renewals`))[0].c == 0, 'deleting an employee (SQL editor) removes their history');

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
