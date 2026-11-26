// DB tests for vendors and vendor payments (0040), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/payments.mjs
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
const ADMIN = '11111111-1111-1111-1111-111111111111', VIEW = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'a@x.test'), ('${VIEW}', 'v@x.test');
  update profiles set role = 'viewer' where id = '${VIEW}';`);
await db.exec(mig('0007_multi_company.sql'));
await db.exec(`insert into company_members values ('${VIEW}', (select id from companies where code = 'HBC'), 'viewer') on conflict do nothing;`);
await db.exec(mig('0027_accounting.sql'));
await db.exec(`grant usage on schema public, storage to authenticated; grant all on all tables in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;`);
await db.exec(mig('0040_vendors_payments.sql'));
await db.exec(mig('0040_vendors_payments.sql'));   // re-runnable
await db.exec(`grant all on acc_vendors to authenticated;`);   // Supabase grants table privileges by default; RLS is the guard

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  await db.exec(`select set_config('request.headers', '${company ? JSON.stringify({ 'x-company-id': company }) : '{}'}', false)`);
  await db.exec('set role authenticated');
}
const acct = async (code) => (await q(`select id from acc_accounts where code = '${code}'`))[0].id;

await as(ADMIN, HBC);
const bank = await acct('1010'), materials = await acct('5000'), rent = await acct('6100');

// vendors
const vendor = (await q(`select acc_save_vendor(null, '  Gulf Steel  ', '0500000000', '300000000000003', 'Rebar', true) id`))[0].id;
const v = (await q(`select * from acc_vendors where id = '${vendor}'`))[0];
ok(v.name === 'Gulf Steel' && v.phone === '0500000000' && v.company_id === HBC, 'vendor saved, name trimmed, in the current company');
await throws(`select acc_save_vendor(null, '   ', '', '', '', true)`, 'vendor without a name refused', /vendor name/i);
await throws(`select acc_save_vendor(null, 'gulf steel', '', '', '', true)`, 'duplicate vendor name refused', /already/);
await db.exec(`select acc_save_vendor('${vendor}', 'Gulf Steel Co.', '0511111111', '', '', true)`);
ok((await q(`select name from acc_vendors`))[0].name === 'Gulf Steel Co.', 'vendor edited');
await throws(`insert into acc_vendors (name) values ('Sneaky')`, 'direct insert blocked by RLS', /row-level security/);

// payments
const pay = (id, vend, from, to, amount) =>
  `select acc_save_payment(${id ? `'${id}'` : 'null'}, '${vend}', '2026-05-02', '${from}', '${to}', ${amount}, 'CHQ-1', 'Rebar order') id`;
const payment = (await q(pay(null, vendor, bank, materials, 2500)))[0].id;
const e = (await q(`select vendor_id, reference, memo from acc_entries where id = '${payment}'`))[0];
ok(e.vendor_id === vendor && e.reference === 'CHQ-1' && e.memo === 'Rebar order', 'payment is a journal entry tagged with the vendor');
const lines = await q(`select account_id, debit, credit from acc_lines where entry_id = '${payment}' order by debit desc`);
ok(lines.length === 2 && lines[0].account_id === materials && Number(lines[0].debit) === 2500
  && lines[1].account_id === bank && Number(lines[1].credit) === 2500, 'debits what was paid for, credits the cash/bank account');

await db.exec(pay(payment, vendor, bank, rent, 3000));
ok((await q(`select count(*) c from acc_entries`))[0].c == 1
  && Number((await q(`select debit from acc_lines where account_id = '${rent}'`))[0].debit) === 3000, 'editing a payment replaces it');

await throws(pay(null, vendor, bank, materials, 0), 'zero amount refused', /amount/i);
await throws(pay(null, vendor, bank, materials, -5), 'negative amount refused', /amount/i);
await throws(pay(null, vendor, bank, bank, 10), 'same account twice refused', /different/);
await throws(pay(null, vendor, materials, rent, 10), 'paying from a non-asset account refused', /cash or bank/i);

const plain = (await q(`select acc_post_entry(null, '2026-05-01', 'Plain', '', '[{"account_id":"${rent}","debit":1},{"account_id":"${bank}","credit":1}]'::jsonb) id`))[0].id;
await throws(pay(plain, vendor, bank, materials, 10), 'an ordinary journal entry cannot be overwritten as a payment', /Payment not found/);

await db.exec(`select acc_save_vendor('${vendor}', 'Gulf Steel Co.', '', '', '', false)`);
await throws(pay(null, vendor, bank, materials, 10), 'no new payments to an inactive vendor', /inactive/i);
await db.exec(pay(payment, vendor, bank, materials, 2600));
ok(true, 'an existing payment to an inactive vendor can still be corrected');

await db.exec(`select acc_delete_entry('${payment}')`);
ok((await q(`select count(*) c from acc_entries where vendor_id is not null`))[0].c == 0, 'deleting the entry removes the payment');

// roles and isolation
await db.exec(`select acc_save_vendor('${vendor}', 'Gulf Steel Co.', '', '', '', true)`);
await as(VIEW, HBC);
ok((await q(`select count(*) c from acc_vendors`))[0].c == 1, 'viewer can read vendors');
await throws(`select acc_save_vendor(null, 'X', '', '', '', true)`, 'viewer cannot add a vendor', /Not permitted/);
await throws(pay(null, vendor, bank, materials, 10), 'viewer cannot record a payment', /Not permitted/);
await as(ADMIN, MD);
ok((await q(`select count(*) c from acc_vendors`))[0].c == 0, 'Company 2 does not see Company 1’s vendors');
await throws(pay(null, vendor, await acct('1010'), await acct('5000'), 10), 'cannot pay another company’s vendor', /vendor/i);
await db.exec(`select acc_save_vendor(null, 'Gulf Steel Co.', '', '', '', true)`);
ok(true, 'the same vendor name is allowed in another company');

// anonymous callers
await db.exec('reset role');
for (const fn of ['acc_save_vendor(uuid,text,text,text,text,boolean)', 'acc_save_payment(uuid,uuid,date,uuid,uuid,numeric,text,text)']) {
  ok(!(await q(`select has_function_privilege('anon', '${fn}', 'execute') c`))[0].c, `anonymous cannot execute ${fn.split('(')[0]}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll vendor payment tests passed');
process.exit(failed ? 1 : 0);
