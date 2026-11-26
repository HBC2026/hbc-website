// DB tests for the code-free chart of accounts (0041), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/coa.mjs
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
  catch (e) { ok(!re || re.test(e.message), `${n}${re && !re.test(e.message) ? ' - got: ' + e.message : ''}`); }
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
const ADMIN = '11111111-1111-1111-1111-111111111111', VIEW = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'a@x.test'), ('${VIEW}', 'v@x.test');
  update profiles set role = 'viewer' where id = '${VIEW}';`);
await db.exec(mig('0007_multi_company.sql'));
await db.exec(`insert into company_members values ('${VIEW}', (select id from companies where code = 'HBC'), 'viewer') on conflict do nothing;`);
await db.exec(mig('0027_accounting.sql'));
await db.exec(`grant usage on schema public, storage to authenticated; grant all on all tables in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;`);
await db.exec(mig('0041_coa_without_codes.sql'));

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
const kindOf = async (name) => (await q(`select kind from acc_accounts where name = '${name}' and company_id = '${HBC}'`))[0].kind;
ok(await kindOf('Bank Account') === 'cash' && await kindOf('Petty Cash') === 'cash', 'existing cash accounts marked');
ok(await kindOf('Accounts Receivable') === 'receivable' && await kindOf('Retention Receivable') === 'receivable', 'existing receivables marked');
ok(await kindOf('Accounts Payable') === 'payable' && await kindOf('Rent') === '', 'existing payable marked, others left alone');

await db.exec(`update acc_accounts set kind = '' where name = 'Petty Cash'`);
await db.exec(mig('0041_coa_without_codes.sql'));
ok(await kindOf('Petty Cash') === '', 're-running does not undo a user choice');

async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  await db.exec(`select set_config('request.headers', '${company ? JSON.stringify({ 'x-company-id': company }) : '{}'}', false)`);
  await db.exec('set role authenticated');
}
const save = (id, name, type, section, kind = '') =>
  `select acc_save_account(${id ? `'${id}'` : 'null'}, '${name}', '${type}', '${section}', '${kind}', true) id`;
const row = async (id) => (await q(`select * from acc_accounts where id = '${id}'`))[0];
const acct = async (name) => (await q(`select id from acc_accounts where name = '${name}'`))[0].id;

await as(ADMIN, HBC);
const stc = (await q(save(null, 'STC Bank', 'asset', 'current_asset', 'cash')))[0].id;
ok((await row(stc)).code === null && (await row(stc)).kind === 'cash', 'new account needs no code and can be a cash account');
await db.query(save(null, 'Second no-code account', 'expense', 'operating_expense'));
ok(true, 'more than one account without a code is allowed');
await throws(save(null, 'stc bank', 'asset', 'current_asset'), 'duplicate name refused', /already/);
await throws(save(null, '  ', 'asset', 'current_asset'), 'empty name refused', /account name/i);
await throws(save(null, 'Odd', 'expense', 'operating_expense', 'cash'), 'an expense cannot be a cash account', /asset/i);
await throws(save(null, 'Odd', 'asset', 'current_asset', 'payable'), 'an asset cannot be a payable account', /liability/i);
await throws(save(null, 'Odd', 'expense', 'revenue'), 'section/type mismatch refused', /does not belong/);

// ordering
const order = (section, ids) => `select acc_order_accounts('${section}', array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`;
const rent = await acct('Rent'), util = await acct('Utilities');
await db.exec(order('operating_expense', [util, rent]));
ok((await row(util)).sort_order === 1 && (await row(rent)).sort_order === 2, 'order saved');
await throws(order('operating_expense', [stc]), 'an account from another section is refused', /section/);
await db.exec(save(rent, 'Rent', 'expense', 'operating_expense'));
ok((await row(rent)).sort_order === 2, 'editing an account keeps its place');
await db.exec(save(rent, 'Rent', 'expense', 'cost_of_sales'));
ok((await row(rent)).sort_order === null, 'moving to another section drops the old place');
await db.exec(order('operating_expense', []));
ok((await q(`select count(*) c from acc_accounts where section = 'operating_expense' and sort_order is not null`))[0].c == 0, 'empty list goes back to sorting by name');

await as(VIEW, HBC);
await throws(order('operating_expense', [util]), 'viewer cannot reorder', /Not permitted/);
await throws(save(null, 'X', 'asset', 'current_asset'), 'viewer cannot add an account', /Not permitted/);
await as(ADMIN, MD);
await throws(order('operating_expense', [util]), 'cannot reorder another company accounts', /section/);

// a company with no accounts gets the standard chart, without codes
await db.exec('reset role');
await db.exec(`delete from acc_accounts where company_id = '${MD}'`);
await as(ADMIN, MD);
await db.exec(`select acc_seed_accounts()`);
const seeded = (await q(`select count(*) c, count(code) codes, count(*) filter (where kind = 'cash') cash, count(*) filter (where kind = 'payable') payable from acc_accounts`))[0];
ok(seeded.c == 50&& seeded.codes == 0 && seeded.cash == 3 && seeded.payable == 1, `standard chart seeded without codes (${seeded.c})`);

await db.exec('reset role');
for (const fn of ['acc_save_account(uuid,text,acc_type,text,text,boolean)', 'acc_order_accounts(text,uuid[])']) {
  ok(!(await q(`select has_function_privilege('anon', '${fn}', 'execute') c`))[0].c, `anonymous cannot execute ${fn.split('(')[0]}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll chart of accounts DB tests passed');
process.exit(failed ? 1 : 0);
