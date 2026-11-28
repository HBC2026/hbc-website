// DB tests for the shared Store Inventory (0044), run on PGlite with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/store_shared.mjs
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
const fails = async (sql) => { try { await db.exec(sql); return false; } catch { return true; } };

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
const U1 = '11111111-1111-1111-1111-111111111111'; // administrator everywhere
const U2 = '22222222-2222-2222-2222-222222222222'; // viewer in HBC, attendance in the other company
const U3 = '33333333-3333-3333-3333-333333333333'; // viewer only
const U4 = '44444444-4444-4444-4444-444444444444'; // member of nothing
const files = readdirSync(dir).filter((f) => f.endsWith('.sql') && !skip.test(f)).sort();
const run = async (f) => {
  try { await db.exec(mig(f)); } catch (e) { console.log(`FAIL  migration ${f}: ${e.message}`); process.exit(1); }
};
for (const f of files.filter((f) => f < '0044')) {
  if (f.startsWith('0007_')) await db.exec(`insert into auth.users (id, email) values ('${U1}', 'a@x.test')`);
  await run(f);
}

const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
const OTHER = (await q(`select id from companies where code <> 'HBC' order by created_at limit 1`))[0].id;
for (const u of [U2, U3, U4]) await db.exec(`insert into auth.users (id, email) values ('${u}', '${u}@x.test')`);
await db.exec(`delete from company_members where user_id <> '${U1}'`);
await db.exec(`insert into company_members (user_id, company_id, role) values ('${U2}', '${HBC}', 'viewer'), ('${U2}', '${OTHER}', 'attendance'), ('${U3}', '${HBC}', 'viewer')`);
await db.exec(`insert into company_members (user_id, company_id, role) values ('${U1}', '${OTHER}', 'administrator') on conflict do nothing`);

// data that exists before the migration, in both companies
const photo = `${OTHER}/old.jpg`;
await db.exec(`insert into store_items (company_id, item, sort_order, attachment) values
  ('${HBC}', 'H0', 0, null), ('${HBC}', 'H1', 1, null), ('${OTHER}', 'O0', 0, '${photo}'), ('${OTHER}', 'O1', 1, null)`);
await db.exec(`insert into storage.objects (bucket_id, name) values ('store-photos', '${photo}')`);
const SIG = 'data:image/png;base64,AAAA';
await db.exec(`insert into store_checks (company_id, checker_name, check_date, signature) values
  ('${HBC}', 'one', '2026-10-01', '${SIG}'), ('${OTHER}', 'two', '2026-10-02', '${SIG}')`);

for (const f of files.filter((f) => f >= '0044')) { await run(f); await run(f); } // re-runnable
await db.exec(`grant usage on schema public, storage to anon, authenticated;
  grant all on all tables in schema public to authenticated;
  grant all on all tables in schema storage to authenticated;`);

async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false)`);
  await db.exec(`select set_config('request.headers', '${JSON.stringify({ 'x-company-id': company })}', false)`);
  await db.exec('set role authenticated');
}
const names = async () => (await q(`select item from store_items order by sort_order`)).map((r) => r.item).join(',');
const save = (rows, removed = []) => `select store_save_all('${JSON.stringify(rows)}'::jsonb, '{${removed.join(',')}}'::uuid[], 'chk', '2026-11-01', '${SIG}')`;
const add = (item) => `select store_add_item('${JSON.stringify(item)}'::jsonb) id`;

await as(U1, HBC);
const merged = await names();
ok(merged === 'H0,H1,O0,O1' || merged === 'O0,O1,H0,H1', `items of both companies are one sheet, each company's order kept together (${merged})`);
ok((await q(`select count(*)::int n from store_checks`))[0].n === 2, 'past checks of both companies are listed');
await as(U1, OTHER);
ok((await names()) === merged, 'the sheet is the same whichever company is selected');

await as(U3, HBC);
ok((await names()) === merged, 'a viewer reads the whole sheet');
ok((await q(`select count(*)::int n from storage.objects where bucket_id = 'store-photos'`))[0].n === 1, "a viewer sees another company's old photo");
ok(await fails(save([{ item: 'x' }])), 'a viewer cannot save');
ok(await fails(`insert into storage.objects (bucket_id, name) values ('store-photos', '${HBC}/v.jpg')`), 'a viewer cannot upload a photo');

await as(U4, HBC);
ok((await names()) === '', 'someone in no company reads nothing');
ok(await fails(save([{ item: 'x' }])), 'someone in no company cannot save');

await as(U2, HBC); // only a viewer in the selected company
ok(!(await fails(`insert into storage.objects (bucket_id, name) values ('store-photos', '${HBC}/new.jpg')`)), 'a write role in any company can upload a photo');
const rows = (await q(`select id, item, attachment from store_items order by sort_order`));
const saved = await fails(save([...rows, { item: 'NEW' }])) === false;
ok(saved, 'a write role in any company can save');
ok((await names()) === `${merged},NEW`, 'saving keeps every row and adds the new one');
ok(await fails(`delete from store_items returning id`) || (await names()) === `${merged},NEW`, 'no direct writes to the table');

// adding one item from a phone
await as(U3, HBC);
ok(await fails(add({ item: 'x' })), 'a viewer cannot add an item');
await as(U4, HBC);
ok(await fails(add({ item: 'x' })), 'someone in no company cannot add an item');
await as(U2, HBC);
const loaded = await q(`select id, item from store_items order by sort_order`); // what a second person has on screen
const before = await names();
ok(await fails(add({ item: '  ' })), 'an item needs a name');
ok(await fails(add({ item: 'bad', qty: -1 })), 'quantity cannot be negative');
const PHONE = (await q(add({ item: ' Drill ', qty: 3, location: 'Vehicle', condition: 'Fair', status: 'In store', warranty: '1 year', purchase_date: '2026-11-01', useful_life_years: 2, attachment: `${HBC}/new.jpg` })))[0].id;
const got = (await q(`select * from store_items where id = '${PHONE}'`))[0];
ok(got.item === 'Drill' && Number(got.qty) === 3 && got.location === 'Vehicle' && got.condition === 'Fair' && got.attachment === `${HBC}/new.jpg` && Number(got.useful_life_years) === 2, 'the added item is stored with its details and photo');
ok((await names()) === `${before},Drill`, 'the added item goes to the end of the sheet');

// someone who loaded the sheet before that item existed saves it
await db.exec(save(loaded));
ok((await names()) === `${before},Drill`, 'saving an older sheet does not delete an item added meanwhile');
const snap = (await q(`select row_count, snapshot from store_checks order by created_at desc limit 1`))[0];
ok(snap.row_count === loaded.length && snap.snapshot.length === loaded.length, 'the signed copy holds only the rows the checker had on screen');

// removing a row deletes it, and another stale screen cannot bring it back
const all = await q(`select id, item from store_items order by sort_order`);
const out = await db.query(save(all.filter((r) => r.id !== PHONE), [PHONE]));
ok(!(await names()).includes('Drill'), 'a row removed on screen is deleted');
ok(out.rows[0].store_save_all.includes(`${HBC}/new.jpg`), 'its photo is reported as unused');
await db.exec(save(all));
ok(!(await names()).includes('Drill'), 'a stale screen does not bring a deleted row back');

// 0045: the "New" condition and a short description
await as(U1, HBC);
const sheet = () => q(`select id, item, condition, description from store_items order by sort_order`);
const tryAdd = async (item) => { try { return (await q(add(item)))[0].id; } catch (e) { return `ERROR ${e.message}`; } };
const NEWID = await tryAdd({ item: 'Saw', condition: 'New', description: ' 10 inch, yellow case ' });
ok(!NEWID.startsWith('ERROR'), `an item can be added as New (${NEWID})`);
ok(await fails(add({ item: 'long', description: 'x'.repeat(201) })), 'a description over 200 characters is refused');
if (!NEWID.startsWith('ERROR')) {
  const saw = async () => (await sheet()).find((r) => r.id === NEWID);
  ok((await saw()).description === '10 inch, yellow case', 'the description is stored, trimmed');
  await db.exec(save((await sheet()).map((r) => (r.id === NEWID ? { ...r, description: 'blade replaced' } : r))));
  ok((await saw()).description === 'blade replaced' && (await saw()).condition === 'New', 'saving the sheet updates the description and keeps New');
  const copy = (await q(`select snapshot from store_checks order by created_at desc limit 1`))[0].snapshot;
  ok(copy.some((r) => r.description === 'blade replaced'), 'the signed copy includes the description');
  await db.exec(save((await sheet()).map(({ description, ...r }) => r))); // a page from before this change
  ok((await saw()).description === 'blade replaced', 'a page that does not send descriptions does not wipe them');
  await db.exec(save([...(await sheet()), { item: 'Row', condition: 'New', description: 'from table' }]));
  ok((await sheet()).some((r) => r.item === 'Row' && r.description === 'from table'), 'a new row saved from the table keeps its description');
}

// an old page, still holding one company's rows, must not be able to delete the rest
await as(U1, HBC);
ok(await fails(`select store_save('[{"item":"stale"}]'::jsonb, 'chk', '2026-11-01', '${SIG}')`), 'the old save function is gone');

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
