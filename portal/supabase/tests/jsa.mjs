// DB tests for JSA Management (migration 0017), run on PGlite (in-process Postgres) with Supabase stubs.
//   npm i --no-save @electric-sql/pglite && node supabase/tests/jsa.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const throws = async (sql, name, re) => {
  try { await db.exec(sql); ok(false, `${name} (expected error)`); }
  catch (e) { ok(!re || re.test(e.message), `${name}${re && !re.test(e.message) ? ' — got: ' + e.message : ''}`); }
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
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';
const files = readdirSync(join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  if (f.startsWith('0007')) {
    await db.exec(`insert into auth.users (id, email) values ('${U1}', 'admin@x.test'), ('${U2}', 'pay@x.test');`);
    await db.exec(`update profiles set role = 'payroll' where id = '${U2}';`);
  }
  await db.exec(readFileSync(join(here, '..', 'migrations', f), 'utf8'));
}
await db.exec(`grant usage on schema public, storage to authenticated;`);

const MD = (await q(`select id from companies where code = 'MDGC'`))[0].id;
const HBC = (await q(`select id from companies where code = 'HBC'`))[0].id;
await db.exec(`update company_members set role = 'payroll' where user_id = '${U2}'`);
async function as(user, company) {
  await db.exec('reset role');
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  await db.exec(`select set_config('request.headers', '${company ? JSON.stringify({ 'x-company-id': company }) : '{}'}', false)`);
  await db.exec('set role authenticated');
}
const uid = () => crypto.randomUUID();

await as(U1, MD);
const a1 = uid(), h1 = uid(), h2 = uid(), c1 = uid(), c2 = uid();
const tree = (extra = '') => JSON.stringify([{
  id: a1, title: 'Concrete cutting', equipment: 'Grinder',
  hazards: [
    { id: h1, category: 'Machinery & Equipment', controls: [{ id: c1, text: 'Inspect the grinder before use.', origin: 'ai', edited: false }, { id: c2, text: 'Check disc RPM rating.', origin: 'manual', edited: true }] },
    { id: h2, category: 'Noise', controls: [{ id: uid(), text: 'Wear hearing protection.' + extra, origin: 'ai' }] },
  ],
}]);

const id = (await q(`select jsa_create('{"project":"P1","work_description":"Cut slab"}'::jsonb, '${tree()}'::jsonb) id`))[0].id;
const j0 = (await q(`select * from jsas where id = '${id}'`))[0];
ok(/^JSA-\d{4}-001$/.test(j0.number), `auto number (${j0.number})`);
ok(j0.client === 'TENARIS' && j0.status === 'draft' && j0.version === 1, 'defaults: client TENARIS, draft, version 1');
ok((await q(`select count(*) c from jsa_controls where jsa_id = '${id}'`))[0].c == 3, 'tree saved');
const id2 = (await q(`select jsa_create('{}'::jsonb, '[]'::jsonb) id`))[0].id;
ok((await q(`select number from jsas where id = '${id2}'`))[0].number.endsWith('-002'), 'numbering increments');

// settings-driven numbering
await db.exec(`insert into jsa_settings (key, value) values ('numbering_format', '"MDGC/JSA/{YY}/{NNNN}"')`);
const id3 = (await q(`select jsa_create('{}'::jsonb, '[]'::jsonb) id`))[0].id;
ok(/^MDGC\/JSA\/\d\d\/0003$/.test((await q(`select number from jsas where id = '${id3}'`))[0].number), 'custom numbering format');
await throws(`select jsa_create('{"number":"${j0.number}"}'::jsonb, '[]'::jsonb)`, 'duplicate number rejected', /duplicate key/);

// save with optimistic version
const v2 = (await q(`select jsa_save('${id}', 1, '{"project":"P2"}'::jsonb, '${tree(' Also muffs.')}'::jsonb) v`))[0].v;
ok(v2 === 2, 'save returns new version');
ok((await q(`select project from jsas where id='${id}'`))[0].project === 'P2', 'header saved');
ok((await q(`select count(*) c from jsa_controls where jsa_id = '${id}' and text like '%muffs%'`))[0].c == 1, 'control text updated in place');
await throws(`select jsa_save('${id}', 1, '{}'::jsonb, '[]'::jsonb)`, 'stale version rejected', /changed elsewhere/);
// removing a hazard removes its controls
const fewer = JSON.stringify([{ id: a1, title: 'Concrete cutting', hazards: [{ id: h1, category: 'Machinery & Equipment', controls: [{ id: c1, text: 'Inspect the grinder before use.' }] }] }]);
await db.exec(`select jsa_save('${id}', 2, '{}'::jsonb, '${fewer}'::jsonb)`);
ok((await q(`select count(*) c from jsa_controls where jsa_id = '${id}'`))[0].c == 1 && (await q(`select count(*) c from jsa_hazards where jsa_id = '${id}'`))[0].c == 1, 'removed hazard/controls deleted');

const got = (await q(`select jsa_get('${id}') g`))[0].g;
ok(got.version === 3 && got.header.project === 'P2' && got.activities[0].hazards.length === 1 && got.activities[0].hazards[0].controls[0].origin === 'manual', 'jsa_get returns header + tree');
ok((await q(`select jsa_can_use() u`))[0].u === true, 'jsa_can_use true for admin');

// finalize
await throws(`select jsa_finalize('${id2}', 1)`, 'cannot finalize without controls', /control measures/);
await db.exec(`select jsa_finalize('${id}', 3)`);
ok((await q(`select status from jsas where id = '${id}'`))[0].status === 'finalized', 'finalized');
ok((await q(`select count(*) c from jsa_revisions where jsa_id = '${id}'`))[0].c == 1, 'snapshot stored');
await throws(`select jsa_save('${id}', 4, '{}'::jsonb, '[]'::jsonb)`, 'finalized JSA cannot be saved', /finalized/);
await throws(`update jsa_controls set text = 'hack' where jsa_id = '${id}'`, 'direct control update blocked (RLS / finalized)');
await throws(`delete from jsa_revisions where jsa_id = '${id}'`, 'snapshots cannot be deleted');
await throws(`update jsa_revisions set revision = 9 where jsa_id = '${id}'`, 'snapshots cannot be updated');

// new revision returns to draft, keeps old snapshot
ok((await q(`select jsa_new_revision('${id}') r`))[0].r === 1, 'new revision = 1');
ok((await q(`select status from jsas where id='${id}'`))[0].status === 'draft', 'revision returns to draft');
const ver = (await q(`select version v from jsas where id='${id}'`))[0].v;
await db.exec(`select jsa_save('${id}', ${ver}, '{}'::jsonb, '${tree(' Rev1.')}'::jsonb)`);
await db.exec(`select jsa_finalize('${id}', ${ver + 1})`);
const revs = await q(`select revision, jsonb_array_length(snapshot->'activities'->0->'hazards') hz from jsa_revisions where jsa_id='${id}' order by revision`);
ok(revs.length === 2 && revs[0].hz == 1 && revs[1].hz == 2, 'previous finalized version preserved unchanged');

// duplicate, soft delete, restore
const dup = (await q(`select jsa_duplicate('${id}') d`))[0].d;
ok((await q(`select status, revision from jsas where id='${dup}'`))[0].status === 'draft', 'duplicate is a fresh draft');
ok((await q(`select count(*) c from jsa_controls where jsa_id='${dup}'`))[0].c == 3, 'duplicate copies controls with new ids');
await db.exec(`select jsa_delete('${dup}')`);
ok((await q(`select deleted_at from jsas where id='${dup}'`))[0].deleted_at !== null, 'soft delete');
await db.exec(`select jsa_restore('${dup}')`);

// to KB
const hz = (await q(`select h.id from jsa_hazards h where h.jsa_id='${dup}' and category='Noise'`))[0].id;
const kb = (await q(`select jsa_to_kb('${hz}') k`))[0].k;
ok((await q(`select jsonb_array_length(controls) n from safety_knowledge_base where id='${kb}'`))[0].n == 1, 'hazard controls saved to knowledge base');
await db.exec(`update safety_knowledge_base set equipment = 'Muffs' where id = '${kb}'`);
ok((await q(`select count(*) c from safety_kb_revisions where kb_id='${kb}'`))[0].c == 1, 'KB edit keeps a revision');
ok((await q(`select count(*) c from safety_knowledge_base where search @@ websearch_to_tsquery('simple', 'muffs')`))[0].c == 1, 'KB full-text search');

// access control
await as(U2, MD);
ok((await q(`select count(*) c from jsas`))[0].c == 0, 'non-admin role sees no JSAs');
await throws(`select jsa_create('{}'::jsonb, '[]'::jsonb)`, 'non-admin cannot create', /Only an administrator|No company/);
await as(U1, HBC);
ok((await q(`select count(*) c from jsas`))[0].c == 0, 'JSAs are isolated per company');
await as(U1, MD);
ok((await q(`select count(*) c from jsas`))[0].c >= 3, 'admin sees their company JSAs');
await throws(`insert into jsas (number, company_id) values ('X-1', '${HBC}')`, 'cannot insert into another company', /row-level security|violates|permission denied/);

// plain CRUD tables: admin only, per company, upsert of settings
await as(U1, MD);
await db.exec(`insert into jsa_templates (name, content) values ('T1', '{"activities": []}')`);
await db.exec(`insert into safety_rules (kind, title, body) values ('client', 'Hot work', 'Permit required')`);
await db.exec(`insert into jsa_settings (company_id, key, value) values ('${MD}', 'default_control_count', '25') on conflict (company_id, key) do update set value = excluded.value`);
await db.exec(`insert into jsa_settings (company_id, key, value) values ('${MD}', 'default_control_count', '30') on conflict (company_id, key) do update set value = excluded.value`);
ok((await q(`select value from jsa_settings where key = 'default_control_count'`))[0].value === 30, 'settings upsert (company_id, key)');
ok((await q(`select company_id from jsa_templates`))[0].company_id === MD, 'rows land in the current company by default');
await as(U1, HBC);
ok((await q(`select count(*) c from jsa_templates`))[0].c == 0 && (await q(`select count(*) c from safety_rules`))[0].c == 0 && (await q(`select count(*) c from safety_knowledge_base`))[0].c == 0, 'templates / rules / knowledge base are isolated per company');
await as(U2, MD);
ok((await q(`select count(*) c from jsa_templates`))[0].c == 0, 'non-admin cannot read templates');
await throws(`insert into safety_rules (kind, title) values ('company', 'x')`, 'non-admin cannot write rules', /row-level security/);
await throws(`insert into safety_knowledge_base (work_activity, hazard) values ('a', 'b')`, 'non-admin cannot write knowledge base', /row-level security/);

console.log(failed ? `\n${failed} FAILED` : '\nAll JSA DB tests passed');
process.exit(failed ? 1 : 0);
