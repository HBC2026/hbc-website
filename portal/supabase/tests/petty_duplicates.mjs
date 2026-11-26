// DB tests for silent duplicate receipt flagging (0043), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/petty_duplicates.mjs
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
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql') && !skip.test(f)).sort()) {
  if (f.startsWith('0007_')) await db.exec(`insert into auth.users (id, email) values ('${U1}', 'a@x.test')`);
  try {
    await db.exec(mig(f));
    if (f.startsWith('0043_')) await db.exec(mig(f)); // re-runnable
  } catch (e) { console.log(`FAIL  migration ${f}: ${e.message}`); process.exit(1); }
}
await db.exec(`grant usage on schema public, storage to anon, authenticated;
  grant all on all tables in schema public to authenticated;
  grant all on all tables in schema storage to authenticated;
  grant insert on storage.objects to anon;`);

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
async function admin() {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${U1}', false)`);
  await db.exec(`select set_config('request.headers', '${JSON.stringify({ 'x-company-id': HBC })}', false)`);
  await db.exec('set role authenticated');
}
async function anon() {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.exec(`select set_config('request.headers', '{}', false)`);
  await db.exec('set role anon');
}

await admin();
await db.exec(`insert into employees (emp_code, name, joining_date) values ('HBC-001', 'First', '2026-01-01'), ('HBC-002', 'Second', '2026-01-01')`);
const [E1, E2] = (await q(`select id from employees order by emp_code`)).map((r) => r.id);
const T1 = (await q(`select pc_get_link('${E1}') t`))[0].t;
const T2 = (await q(`select pc_get_link('${E2}') t`))[0].t;

/** Uploads a file and submits it as the employee, the way the page does (never confirms a duplicate). */
async function submit(token, file, amount, date, hash) {
  await anon();
  await db.exec(`insert into storage.objects (bucket_id, name) values ('petty-cash-receipts', '${token}/${file}')`);
  try {
    return (await q(`select pc_add_receipt('${token}', ${amount}, '${date}', 'x', '${token}/${file}', null, ${hash ? `'${hash}'` : 'null'}, false, 'Site') id`))[0].id;
  } catch (e) { return `ERROR ${e.message}`; }
}
const dupOf = async (id) => { await admin(); return (await q(`select dup_of from pc_receipts where id = '${id}'`))[0]?.dup_of; };
const info = async (id) => { await admin(); return (await q(`select pc_duplicate_info(array['${id}']::uuid[]) i`))[0].i[id]; };
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);

const R1 = await submit(T1, 'r1.jpg', 90, '2026-09-04', A);
ok(!R1.startsWith('ERROR') && (await dupOf(R1)) === null, 'first receipt is not flagged');

const R2 = await submit(T2, 'r2.jpg', 90, '2026-09-04', B);
ok(!R2.startsWith('ERROR'), `same amount and date is accepted without a question (${R2})`);
if (!R2.startsWith('ERROR')) {
  ok((await dupOf(R2)) === R1, 'same amount and date is flagged for the office');
  ok((await info(R2)).same_file === false, 'office is told it is not the same file');
}

const R3 = await submit(T2, 'r3.jpg', 15, '2026-09-20', A);
ok(!R3.startsWith('ERROR'), `same file is accepted without an error (${R3})`);
if (!R3.startsWith('ERROR')) {
  ok((await dupOf(R3)) === R1, 'same file is flagged even with another amount and date');
  ok((await info(R3)).same_file === true, 'office is told it is the same file');
}

// the same file is the stronger evidence, so it wins over an earlier amount-and-date match
const R4 = await submit(T1, 'r4.jpg', 40, '2026-09-21', C);
const R5 = await submit(T1, 'r5.jpg', 90, '2026-09-04', C);
if (!R5.startsWith('ERROR')) ok((await dupOf(R5)) === R4, 'same file match is preferred over amount and date');
else ok(false, `same file with matching amount accepted (${R5})`);

const R6 = await submit(T1, 'r6.jpg', 77, '2026-09-22', D);
ok((await dupOf(R6)) === null, 'a different receipt is not flagged');

// nothing about duplicates reaches the employee
await anon();
const st = (await q(`select pc_statement('${T2}') s`))[0].s;
ok(!/dup|hash|same_file/i.test(JSON.stringify(st)), 'employee statement says nothing about duplicates');

// the office can still approve or reject a flagged receipt
await admin();
if (!R3.startsWith('ERROR')) {
  await db.exec(`select pc_review_receipt('${R3}', 'approved', '')`);
  ok((await q(`select status from pc_receipts where id = '${R3}'`))[0].status === 'approved', 'office can approve a flagged receipt');
}

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
