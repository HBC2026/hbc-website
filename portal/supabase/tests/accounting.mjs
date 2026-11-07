// DB tests for the accounting migration (0027), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/accounting.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');
const db = new PGlite();
let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const throws = async (sql, n, re) => {
  try { await db.exec(sql); ok(false, `${n} (expected error)`); }
  catch (e) { ok(!re || re.test(e.message), `${n}${re && !re.test(e.message) ? ' — got: ' + e.message : ''}`); }
};
const q = async (sql) => (await db.query(sql)).rows;

await db.exec(`
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create role anon; create role authenticated;
`);
for (const f of ['0001_schema.sql', '0002_helpers_audit_rls.sql', '0003_payroll_functions.sql', '0004_quotation_functions.sql', '0005_storage.sql', '0006_reporting.sql']) await db.exec(mig(f));
const ADMIN = '11111111-1111-1111-1111-111111111111', PAY = '22222222-2222-2222-2222-222222222222', VIEW = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'a@x.test'), ('${PAY}', 'p@x.test'), ('${VIEW}', 'v@x.test');
  update profiles set role = 'payroll' where id = '${PAY}'; update profiles set role = 'viewer' where id = '${VIEW}';`);
await db.exec(mig('0007_multi_company.sql'));
await db.exec(`insert into company_members values ('${VIEW}', (select id from companies where code = 'HBC'), 'viewer') on conflict do nothing;`);

await db.exec(mig('0027_accounting.sql'));
await db.exec(mig('0027_accounting.sql'));   // re-runnable
await db.exec(`grant usage on schema public, storage to authenticated; grant all on all tables in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;`);

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  await db.exec(`select set_config('request.headers', '${company ? JSON.stringify({ 'x-company-id': company }) : '{}'}', false)`);
  await db.exec('set role authenticated');
}
const acct = async (code) => (await q(`select id from acc_accounts where code = '${code}'`))[0].id;
const lines = (a) => JSON.stringify(a).replace(/'/g, "''");

// seeded for both existing companies, no duplicates after the second run
await db.exec('reset role');
ok((await q(`select count(*) c from acc_accounts where company_id = '${HBC}'`))[0].c > 40, 'standard chart seeded for Company 1');
ok((await q(`select count(*) c from acc_accounts where company_id = '${MD}'`))[0].c === (await q(`select count(*) c from acc_accounts where company_id = '${HBC}'`))[0].c, 'and Company 2, same size, no duplicates');

await as(ADMIN, HBC);
const bank = await acct('1010'), capital = await acct('3000'), rev = await acct('4000'), rent = await acct('6100'), ar = await acct('1100');
await as(ADMIN, HBC);
const post = (date, memo, l, id = 'null') => db.query(`select acc_post_entry(${id}, '${date}', '${memo}', '', '${lines(l)}'::jsonb) id`);

// opening balance + a sale + rent
await post('2026-01-01', 'Opening', [{ account_id: bank, debit: 100000 }, { account_id: capital, credit: 100000 }]);
await post('2026-03-10', 'Invoice paid', [{ account_id: bank, debit: 40000 }, { account_id: rev, credit: 40000 }]);
await post('2026-03-15', 'March rent', [{ account_id: rent, debit: 15000 }, { account_id: bank, credit: 15000 }]);
await post('2026-04-01', 'Invoice unpaid', [{ account_id: ar, debit: 10000 }, { account_id: rev, credit: 10000 }]);
ok((await q(`select count(*) c from acc_entries`))[0].c == 4, 'four entries posted');
ok((await q(`select string_agg(entry_no::text, ',' order by entry_no) s from acc_entries`))[0].s === '1,2,3,4', 'entries numbered 1..4');

await throws(`select acc_post_entry(null, '2026-05-01', 'bad', '', '${lines([{ account_id: bank, debit: 100 }, { account_id: rev, credit: 90 }])}'::jsonb)`, 'unbalanced entry refused', /must be equal/);
await throws(`select acc_post_entry(null, '2026-05-01', 'bad', '', '${lines([{ account_id: bank, debit: 100 }])}'::jsonb)`, 'one-line entry refused', /at least two/);
await throws(`select acc_post_entry(null, '2026-05-01', 'bad', '', '${lines([{ account_id: bank, debit: 100, credit: 100 }, { account_id: rev, credit: 0, debit: 0 }])}'::jsonb)`, 'line with both sides refused', /either a debit or a credit/);
await throws(`insert into acc_entries (entry_no, entry_date) values (99, '2026-01-01')`, 'direct insert blocked by RLS', /row-level security/);

// balances: March only vs. up to 30 Apr
const bal = async (f, t) => Object.fromEntries((await q(`select a.code, b.debit, b.credit from acc_balances(${f}, ${t}) b join acc_accounts a on a.id = b.account_id`)).map((r) => [r.code, [Number(r.debit), Number(r.credit)]]));
const march = await bal(`'2026-03-01'`, `'2026-03-31'`);
ok(march['4000'][1] === 40000 && march['6100'][0] === 15000 && !march['1100'], 'March P&L balances only include March');
const upto = await bal('null', `'2026-04-30'`);
ok(upto['1010'][0] === 140000 && upto['1010'][1] === 15000 && upto['1100'][0] === 10000, 'balance sheet balances accumulate to the as-at date');
const tot = Object.values(upto).reduce((s, [d, c]) => [s[0] + d, s[1] + c], [0, 0]);
ok(tot[0] === tot[1], 'trial balance: total debits = total credits');

// edit replaces lines; delete removes
const e3 = (await q(`select id from acc_entries where entry_no = 3`))[0].id;
await post('2026-03-15', 'March rent (corrected)', [{ account_id: rent, debit: 12000 }, { account_id: bank, credit: 12000 }], `'${e3}'`);
ok(Number((await q(`select sum(debit) s from acc_lines where entry_id = '${e3}'`))[0].s) === 12000, 'editing an entry replaces its lines');
await db.exec(`select acc_delete_entry('${e3}')`);
ok((await q(`select count(*) c from acc_entries`))[0].c == 3 && (await q(`select count(*) c from acc_lines where entry_id = '${e3}'`))[0].c == 0, 'delete removes entry and lines');
ok((await q(`select count(*) c from audit_logs where record_type = 'accounting'`))[0].c >= 6, 'postings, edits and deletes are audit-logged');

// accounts
await db.exec(`select acc_save_account(null, '6130', 'Site Cameras', 'expense', 'operating_expense', true)`);
await throws(`select acc_save_account(null, '6130', 'Dup', 'expense', 'operating_expense', true)`, 'duplicate code refused', /already used/);
await throws(`select acc_save_account(null, '9999', 'Odd', 'expense', 'revenue', true)`, 'section/type mismatch refused', /does not belong/);
await throws(`select acc_save_account('${bank}', '1010', 'Bank Account', 'liability', 'current_liability', true)`, 'type change blocked once posted', /already has entries/);

// roles and isolation
await as(VIEW, HBC);
ok((await q(`select count(*) c from acc_entries`))[0].c == 3, 'viewer can read the journal');
ok(Object.keys(await bal('null', 'null')).length > 0, 'viewer can run reports');
await throws(`select acc_post_entry(null, '2026-05-01', 'x', '', '${lines([{ account_id: bank, debit: 1 }, { account_id: rev, credit: 1 }])}'::jsonb)`, 'viewer cannot post', /Not permitted/);
await as(PAY, HBC);
ok((await q(`select count(*) c from acc_entries`))[0].c == 0, 'payroll role cannot see accounting');
await as(ADMIN, MD);
ok((await q(`select count(*) c from acc_entries`))[0].c == 0 && Object.keys(await bal('null', 'null')).length === 0, 'Company 2 sees none of Company 1’s books');
await throws(`select acc_post_entry(null, '2026-05-01', 'x', '', '${lines([{ account_id: bank, debit: 1 }, { account_id: rev, credit: 1 }])}'::jsonb)`, 'cannot post to another company’s accounts', /active account/);

console.log(failed ? `\n${failed} FAILED` : '\nAll accounting tests passed');
process.exit(failed ? 1 : 0);
