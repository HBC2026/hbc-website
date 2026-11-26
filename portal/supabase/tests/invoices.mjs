// DB tests for invoices, bills and the payments against them (0042), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/invoices.mjs
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
await db.exec(mig('0009_clients.sql'));
await db.exec(mig('0027_accounting.sql'));
await db.exec(mig('0040_vendors_payments.sql'));
await db.exec(mig('0041_coa_without_codes.sql'));
await db.exec(mig('0042_invoices_bills.sql'));
await db.exec(mig('0042_invoices_bills.sql'));   // re-runnable
// Supabase grants table privileges by default; RLS is the guard
await db.exec(`grant usage on schema public, storage to authenticated; grant all on all tables in schema public to authenticated;`);

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  await db.exec(`select set_config('request.headers', '${company ? JSON.stringify({ 'x-company-id': company }) : '{}'}', false)`);
  await db.exec('set role authenticated');
}
const acct = async (name) => (await q(`select id from acc_accounts where name = '${name}'`))[0].id;

await as(ADMIN, HBC);
const bank = await acct('Bank Account'), ar = await acct('Accounts Receivable'), ap = await acct('Accounts Payable');
const revenue = await acct('Contract Revenue'), variation = await acct('Variation Orders'), materials = await acct('Materials');
const outVat = await acct('VAT Payable (Output VAT)'), inVat = await acct('VAT Receivable (Input VAT)');
const client = (await q(`insert into clients (name) values ('Aramco Site') returning id`))[0].id;
const vendor = (await q(`select acc_save_vendor(null, 'Gulf Steel', '', '', '', true) id`))[0].id;

const lit = (v) => (v === null ? 'null' : `'${v}'`);
const line = (account_id, qty, unit_price, description = 'Work') => ({ account_id, qty, unit_price, description });
const save = ({ id = null, kind = 'invoice', party = client, date = '2026-05-01', due = '2026-05-31', control = ar, rate = 0, vat = null, ref = '', memo = '', lines = [line(revenue, 1, 1000)] } = {}) =>
  `select acc_save_doc(${lit(id)}, '${kind}', '${party}', '${date}', '${due}', '${control}', ${rate}, ${lit(vat)}, '${ref}', '${memo}', '${JSON.stringify(lines)}'::jsonb) id`;
const make = async (o) => (await q(save(o)))[0].id;
const doc = async (id) => (await q(`select * from acc_docs where id = '${id}'`))[0];
const entryLines = async (entry) => (await q(`select account_id, debit, credit from acc_lines where entry_id = '${entry}'`))
  .map((l) => ({ a: l.account_id, dr: Number(l.debit), cr: Number(l.credit) }));
const has = (lines, a, dr, cr) => lines.some((l) => l.a === a && l.dr === dr && l.cr === cr);
const balanceOf = async (kind, id, asAt = null) => {
  const r = (await q(`select total, paid from acc_doc_list('${kind}', ${lit(asAt)}) where id = '${id}'`))[0];
  return r ? Math.round((Number(r.total) - Number(r.paid)) * 100) / 100 : undefined;
};

// invoice
const inv = await make({ rate: 0.15, vat: outVat, lines: [line(revenue, 2, 500), line(variation, 3, 33.33, 'Extra cores')] });
let d = await doc(inv);
ok(d.doc_no === 1 && Number(d.subtotal) === 1099.99 && Number(d.vat) === 165 && Number(d.total) === 1264.99, 'totals worked out from the lines, VAT rounded');
let l = await entryLines(d.entry_id);
ok(l.length === 4 && has(l, ar, 1264.99, 0) && has(l, revenue, 0, 1000) && has(l, variation, 0, 99.99) && has(l, outVat, 0, 165), 'invoice debits receivable, credits revenue and output VAT');
ok((await q(`select reference from acc_entries where id = '${d.entry_id}'`))[0].reference === 'INV-0001', 'journal entry carries the invoice number');
ok((await q(`select count(*) c from acc_doc_lines where doc_id = '${inv}'`))[0].c == 2, 'invoice lines kept');
const inv2 = await make({});
ok((await doc(inv2)).doc_no === 2 && (await doc(inv2)).vat_account_id === null, 'invoices number on, no VAT account without VAT');

await throws(save({ lines: [] }), 'no lines refused', /at least one line/i);
await throws(save({ lines: [line(revenue, 0, 10)] }), 'zero quantity refused', /quantity/i);
await throws(save({ lines: [line(revenue, 1, -10)] }), 'negative price refused', /price/i);
await throws(save({ lines: [line(materials, 1, 10)] }), 'invoice line must be an income account', /income/i);
await throws(save({ control: bank }), 'invoice must use a receivable account', /receivable/i);
await throws(save({ rate: 0.15 }), 'VAT without a VAT account refused', /VAT account/i);
await throws(save({ rate: 0.15, vat: inVat }), 'output VAT must be a liability', /VAT account/i);
await throws(save({ due: '2026-04-30' }), 'due date before invoice date refused', /due date/i);
await throws(save({ party: vendor }), 'a vendor cannot be invoiced', /client/i);

// bill
const bill = await make({ kind: 'bill', party: vendor, control: ap, rate: 0.15, vat: inVat, ref: 'GS-77', lines: [line(materials, 10, 200)] });
d = await doc(bill);
l = await entryLines(d.entry_id);
ok(d.doc_no === 1 && d.reference === 'GS-77' && has(l, materials, 2000, 0) && has(l, inVat, 300, 0) && has(l, ap, 0, 2300), 'bill debits cost and input VAT, credits payable');
ok((await q(`select vendor_id from acc_entries where id = '${d.entry_id}'`))[0].vendor_id === null, 'a bill is not counted as money paid to the vendor');
await throws(save({ kind: 'bill', party: vendor, control: ar, lines: [line(materials, 1, 1)] }), 'bill must use a payable account', /payable/i);
await throws(save({ kind: 'bill', party: vendor, control: ap, lines: [line(revenue, 1, 1)] }), 'bill line cannot be an income account', /expense or asset/i);

// payments
const pay = (id, amount, account = bank, date = '2026-05-20') => `select acc_pay_doc('${id}', '${date}', '${account}', ${amount}, 'TRF-9', '') id`;
const receipt = (await q(pay(inv, 264.99)))[0].id;
l = await entryLines(receipt);
ok(l.length === 2 && has(l, bank, 264.99, 0) && has(l, ar, 0, 264.99), 'money received debits bank, credits receivable');
ok(await balanceOf('invoice', inv) === 1000, 'invoice balance drops by what was received');
ok(await balanceOf('invoice', inv, '2026-05-10') === 1264.99, 'as at an earlier date the later receipt does not count');
ok(await balanceOf('invoice', inv, '2026-04-01') === undefined, 'an invoice dated after the as-at date is left out');
await throws(pay(inv, 1000.01), 'cannot receive more than is owed', /more than/i);
await throws(pay(inv, 0), 'zero payment refused', /amount/i);
await throws(pay(inv, 10, revenue), 'payment must go to a cash or bank account', /cash or bank/i);
await throws(pay(inv, 10, bank, '2026-04-30'), 'payment dated before the invoice refused', /before/i);

const billPay = (await q(pay(bill, 2300)))[0].id;
l = await entryLines(billPay);
ok(has(l, ap, 2300, 0) && has(l, bank, 0, 2300), 'bill payment debits payable, credits bank');
ok((await q(`select vendor_id from acc_entries where id = '${billPay}'`))[0].vendor_id === vendor, 'bill payment shows under the vendor’s payments');
ok(await balanceOf('bill', bill) === 0, 'bill fully paid');

// protection against changes from the Journal, Register or Payments screens
const invEntry = (await doc(inv)).entry_id;
const two = `'[{"account_id":"${bank}","debit":1},{"account_id":"${revenue}","credit":1}]'::jsonb`;
await throws(`select acc_post_entry('${invEntry}', '2026-05-01', '', '', ${two})`, 'an invoice entry cannot be edited in the Journal', /invoice or bill/i);
await throws(`select acc_delete_entry('${invEntry}')`, 'an invoice entry cannot be deleted in the Journal', /invoice or bill/i);
await throws(`select acc_post_entry('${receipt}', '2026-05-01', '', '', ${two})`, 'a receipt cannot be edited in the Journal', /invoice or bill/i);
await throws(`select acc_save_payment('${billPay}', '${vendor}', '2026-05-20', '${bank}', '${materials}', 5, '', '')`, 'a bill payment cannot be edited on Payments', /invoice or bill/i);

// editing a document
await db.exec(save({ id: inv, rate: 0.15, vat: outVat, lines: [line(revenue, 1, 800)] }));
d = await doc(inv);
l = await entryLines(d.entry_id);
ok(d.doc_no === 1 && d.entry_id === invEntry && Number(d.total) === 920 && l.length === 3 && has(l, ar, 920, 0), 'editing keeps the number and rewrites the journal entry');
await throws(`select acc_delete_entry('${invEntry}')`, 'protection is back on after a save', /invoice or bill/i);
await throws(save({ id: inv, lines: [line(revenue, 1, 100)] }), 'total cannot drop below what was received', /already/i);
const client2 = (await q(`insert into clients (name) values ('Other Client') returning id`))[0].id;
await throws(save({ id: inv, party: client2 }), 'client cannot change once money is received', /payment/i);
await throws(save({ id: inv, date: '2026-05-25' }), 'invoice date cannot move after a payment', /payment/i);
await throws(save({ id: bill, kind: 'invoice' }), 'a bill cannot be saved as an invoice', /not found/i);

// deleting
await throws(`select acc_delete_doc('${inv}')`, 'an invoice with money received cannot be deleted', /payment/i);
await db.exec(`select acc_delete_entry('${receipt}')`);
ok(await balanceOf('invoice', inv) === 920, 'deleting a receipt puts the balance back');
await db.exec(`select acc_delete_doc('${inv}')`);
ok((await q(`select count(*) c from acc_docs where id = '${inv}'`))[0].c == 0
  && (await q(`select count(*) c from acc_entries where id = '${invEntry}'`))[0].c == 0, 'deleting an invoice removes its journal entry');
await db.exec(`select acc_delete_entry('${billPay}')`);
ok(await balanceOf('bill', bill) === 2300, 'deleting a bill payment puts the balance back');

// roles and isolation
await throws(`insert into acc_docs (kind, doc_no, doc_date, due_date, client_id, control_account_id, entry_id) values ('invoice', 99, '2026-05-01', '2026-05-01', '${client}', '${ar}', '${(await doc(inv2)).entry_id}')`, 'direct insert blocked by RLS', /row-level security/);
await as(VIEW, HBC);
ok((await q(`select count(*) c from acc_doc_list('invoice', null)`))[0].c == 1, 'viewer can read invoices');
await throws(save({}), 'viewer cannot create an invoice', /Not permitted/);
await throws(pay(inv2, 1), 'viewer cannot record money received', /Not permitted/);
await throws(`select acc_delete_doc('${inv2}')`, 'viewer cannot delete an invoice', /Not permitted/);
await as(ADMIN, MD);
ok((await q(`select count(*) c from acc_doc_list('invoice', null)`))[0].c == 0, 'Company 2 does not see Company 1’s invoices');
await throws(pay(inv2, 1), 'cannot pay another company’s invoice', /not found/i);
await throws(save({ control: await acct('Accounts Receivable'), lines: [line(await acct('Contract Revenue'), 1, 1)] }), 'cannot invoice another company’s client', /client/i);

await db.exec('reset role');
for (const fn of ['acc_save_doc(uuid,text,uuid,date,date,uuid,numeric,uuid,text,text,jsonb)', 'acc_pay_doc(uuid,date,uuid,numeric,text,text)', 'acc_delete_doc(uuid)', 'acc_doc_list(text,date)']) {
  ok(!(await q(`select has_function_privilege('anon', '${fn}', 'execute') c`))[0].c, `anonymous cannot execute ${fn.split('(')[0]}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll invoice and bill tests passed');
process.exit(failed ? 1 : 0);
