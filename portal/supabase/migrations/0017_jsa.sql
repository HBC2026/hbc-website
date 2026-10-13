-- JSA Management: AI-assisted Job Safety Analysis documents, safety knowledge base, templates and settings.
-- Administrator-only. Every table is scoped to the current company (x-company-id header), like the rest of the portal.
-- The JSA tree (jsas -> activities -> hazards -> controls) is written ONLY through the security-definer functions below,
-- so finalized revisions can be made immutable; knowledge base / rules / templates / settings use plain RLS CRUD.

-- ---------------------------------------------------------------- JSA documents
create table jsas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  number text not null check (btrim(number) <> ''),
  revision int not null default 0,
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  project text not null default '',
  client text not null default 'TENARIS',
  location text not null default '',
  work_description text not null default '',
  jsa_date date not null default current_date,
  prepared_by text not null default '',
  equipment text not null default '',
  additional_instructions text not null default '',
  ai_instructions text not null default '',
  version int not null default 1,                       -- optimistic-concurrency counter, bumped on every save
  finalized_at timestamptz,
  deleted_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jsas_company_number_key on jsas (company_id, lower(btrim(number)));
create index jsas_company_idx on jsas (company_id, deleted_at, updated_at desc);

create table jsa_activities (
  id uuid primary key,
  company_id uuid not null references companies (id) default current_company(),
  jsa_id uuid not null references jsas (id) on delete cascade,
  position int not null default 0,
  title text not null default '',
  equipment text not null default '',
  instructions text not null default '',
  created_at timestamptz not null default now()
);
create index jsa_activities_jsa_idx on jsa_activities (jsa_id, position);

create table jsa_hazards (
  id uuid primary key,
  company_id uuid not null references companies (id) default current_company(),
  jsa_id uuid not null references jsas (id) on delete cascade,
  activity_id uuid not null references jsa_activities (id) on delete cascade,
  position int not null default 0,
  category text not null default 'Other / Custom Hazard',
  custom_name text not null default '',
  instructions text not null default '',
  created_at timestamptz not null default now()
);
create index jsa_hazards_activity_idx on jsa_hazards (activity_id, position);
create index jsa_hazards_jsa_idx on jsa_hazards (jsa_id);

create table jsa_controls (
  id uuid primary key,
  company_id uuid not null references companies (id) default current_company(),
  jsa_id uuid not null references jsas (id) on delete cascade,
  hazard_id uuid not null references jsa_hazards (id) on delete cascade,
  position int not null default 0,
  text text not null check (btrim(text) <> ''),
  origin text not null default 'manual' check (origin in ('manual', 'ai', 'kb', 'template')),
  edited boolean not null default false,               -- the administrator changed it: never overwritten without confirmation
  created_at timestamptz not null default now()
);
create index jsa_controls_hazard_idx on jsa_controls (hazard_id, position);
create index jsa_controls_jsa_idx on jsa_controls (jsa_id);

-- Immutable snapshots, one per finalization
create table jsa_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  jsa_id uuid not null references jsas (id) on delete cascade,
  revision int not null,
  snapshot jsonb not null,
  finalized_by uuid default auth.uid(),
  finalized_by_name text not null default '',
  created_at timestamptz not null default now(),
  unique (jsa_id, revision)
);

-- ---------------------------------------------------------------- templates, knowledge base, rules, settings
create table jsa_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  content jsonb not null default '{"activities": []}'::jsonb,   -- activities -> hazards -> controls
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jsa_templates_company_idx on jsa_templates (company_id, deleted_at);

create table safety_knowledge_base (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  work_activity text not null default '',
  hazard text not null default '',
  equipment text not null default '',
  controls jsonb not null default '[]'::jsonb,        -- array of strings: administrator-approved control measures
  applicable_rules text not null default '',
  source text not null default '',
  tags text[] not null default '{}',
  status text not null default 'approved' check (status in ('approved', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('simple', coalesce(work_activity, '') || ' ' || coalesce(hazard, '') || ' ' || coalesce(equipment, '') || ' ' || coalesce(applicable_rules, ''))
  ) stored
);
create index kb_company_idx on safety_knowledge_base (company_id, status);
create index kb_search_idx on safety_knowledge_base using gin (search);
create index kb_tags_idx on safety_knowledge_base using gin (tags);

create table safety_kb_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  kb_id uuid not null references safety_knowledge_base (id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index kb_rev_idx on safety_kb_revisions (kb_id, created_at desc);

create table safety_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  kind text not null default 'company' check (kind in ('company', 'client', 'equipment')),
  title text not null check (btrim(title) <> ''),
  body text not null default '',
  equipment text not null default '',                  -- for kind = 'equipment'
  source text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index safety_rules_company_idx on safety_rules (company_id, kind, active);

create table jsa_settings (
  company_id uuid not null references companies (id) default current_company(),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);

-- ---------------------------------------------------------------- RLS (administrator of the current company only)
do $$
declare t text;
begin
  foreach t in array array['jsas', 'jsa_activities', 'jsa_hazards', 'jsa_controls', 'jsa_revisions', 'safety_kb_revisions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy %I on %I for select to authenticated
      using (company_id = (select current_company()) and has_role('administrator'))$p$, t || '_read', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
  foreach t in array array['jsa_templates', 'safety_knowledge_base', 'safety_rules', 'jsa_settings']
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy %I on %I for all to authenticated
      using (company_id = (select current_company()) and has_role('administrator'))
      with check (company_id = (select current_company()) and has_role('administrator'))$p$, t || '_admin', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- guards
-- Finalized documents (and their snapshots) cannot change. jsa_new_revision() flips the status first.
create or replace function jsa_tree_guard() returns trigger
language plpgsql as $$
declare v_jsa uuid := coalesce(new.jsa_id, old.jsa_id); v_status text;
begin
  select status into v_status from jsas where id = v_jsa;
  if v_status = 'finalized' then
    raise exception 'This JSA is finalized. Create a new revision to edit it.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger jsa_activities_guard before insert or update or delete on jsa_activities for each row execute function jsa_tree_guard();
create trigger jsa_hazards_guard before insert or update or delete on jsa_hazards for each row execute function jsa_tree_guard();
create trigger jsa_controls_guard before insert or update or delete on jsa_controls for each row execute function jsa_tree_guard();

create or replace function jsa_revision_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from jsas where id = old.jsa_id) then return old; end if;   -- cascade from a purged JSA
  raise exception 'Finalized revisions are immutable.' using errcode = 'P0001';
end $$;
create trigger jsa_revisions_guard before update or delete on jsa_revisions for each row execute function jsa_revision_guard();

create or replace function jsa_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger jsa_templates_touch before update on jsa_templates for each row execute function jsa_touch();
create trigger safety_rules_touch before update on safety_rules for each row execute function jsa_touch();

-- every change to a knowledge-base entry keeps the previous version
create or replace function kb_revision_trg() returns trigger security definer set search_path = public
language plpgsql as $$
begin
  if (to_jsonb(old) - 'search' - 'updated_at') = (to_jsonb(new) - 'search' - 'updated_at') then return new; end if;
  insert into safety_kb_revisions (company_id, kb_id, snapshot) values (old.company_id, old.id, to_jsonb(old) - 'search');
  new.updated_at := now();
  return new;
end $$;
create trigger kb_revision before update on safety_knowledge_base for each row execute function kb_revision_trg();

-- ---------------------------------------------------------------- tree <-> json
create or replace function jsa_tree(p_jsa uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(a_json order by pos), '[]'::jsonb) from (
    select a.position as pos, jsonb_build_object(
      'id', a.id, 'title', a.title, 'equipment', a.equipment, 'instructions', a.instructions,
      'hazards', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', h.id, 'category', h.category, 'custom_name', h.custom_name, 'instructions', h.instructions,
          'controls', coalesce((
            select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'origin', c.origin, 'edited', c.edited) order by c.position)
            from jsa_controls c where c.hazard_id = h.id), '[]'::jsonb)
        ) order by h.position) from jsa_hazards h where h.activity_id = a.id), '[]'::jsonb)
    ) as a_json
    from jsa_activities a where a.jsa_id = p_jsa
  ) s
$$;
revoke all on function jsa_tree(uuid) from public, anon, authenticated;

create or replace function jsa_header_json(j jsas) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'number', j.number, 'revision', j.revision, 'status', j.status, 'project', j.project, 'client', j.client,
    'location', j.location, 'work_description', j.work_description, 'jsa_date', j.jsa_date, 'prepared_by', j.prepared_by,
    'equipment', j.equipment, 'additional_instructions', j.additional_instructions, 'ai_instructions', j.ai_instructions)
$$;
revoke all on function jsa_header_json(jsas) from public, anon, authenticated;

-- ---------------------------------------------------------------- numbering
create or replace function jsa_next_number(p_co uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_fmt text := coalesce((select value #>> '{}' from jsa_settings where company_id = p_co and key = 'numbering_format'), 'JSA-{YYYY}-{NNN}');
  v_digits int := coalesce(length(substring(v_fmt from '\{(N+)\}')), 3);
  v_seq int := 1 + (select count(*) from jsas where company_id = p_co and extract(year from created_at) = extract(year from now()));
  v_num text;
begin
  loop
    v_num := regexp_replace(
      replace(replace(v_fmt, '{YYYY}', to_char(now(), 'YYYY')), '{YY}', to_char(now(), 'YY')),
      '\{N+\}', lpad(v_seq::text, v_digits, '0'));
    exit when not exists (select 1 from jsas where company_id = p_co and lower(btrim(number)) = lower(btrim(v_num)));
    v_seq := v_seq + 1;
  end loop;
  return v_num;
end $$;
revoke all on function jsa_next_number(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- RPCs
create or replace function jsa_create(p_header jsonb default '{}'::jsonb, p_activities jsonb default '[]'::jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); v_id uuid := gen_random_uuid(); v_num text;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  v_num := coalesce(nullif(btrim(p_header ->> 'number'), ''), jsa_next_number(v_co));
  insert into jsas (id, company_id, number, project, client, location, work_description, jsa_date, prepared_by, equipment, additional_instructions)
  values (v_id, v_co, v_num, coalesce(p_header ->> 'project', ''), coalesce(nullif(p_header ->> 'client', ''), 'TENARIS'),
    coalesce(p_header ->> 'location', ''), coalesce(p_header ->> 'work_description', ''),
    coalesce(nullif(p_header ->> 'jsa_date', '')::date, current_date), coalesce(p_header ->> 'prepared_by', ''),
    coalesce(p_header ->> 'equipment', ''), coalesce(p_header ->> 'additional_instructions', ''));
  perform jsa_write_tree(v_id, v_co, p_activities, true);
  perform log_audit('jsa.created', 'jsa', v_id::text, v_num, null, null);
  return v_id;
end $$;

-- replaces the activities/hazards/controls of a draft with the given tree (client-generated uuids are kept)
create or replace function jsa_write_tree(p_jsa uuid, p_co uuid, p_activities jsonb, p_regen_ids boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare a jsonb; h jsonb; c jsonb; ai int := 0; hi int; ci int;
  v_aid uuid; v_hid uuid; v_cid uuid;
  keep_a uuid[] := '{}'; keep_h uuid[] := '{}'; keep_c uuid[] := '{}';
begin
  if jsonb_typeof(p_activities) <> 'array' then raise exception 'activities must be an array'; end if;
  -- ids must be globally unique: a duplicated JSA/template needs fresh ids
  for a in select * from jsonb_array_elements(p_activities) loop
    v_aid := case when p_regen_ids then gen_random_uuid() else (a ->> 'id')::uuid end;
    keep_a := keep_a || v_aid;
    insert into jsa_activities (id, company_id, jsa_id, position, title, equipment, instructions)
    values (v_aid, p_co, p_jsa, ai, left(coalesce(a ->> 'title', ''), 2000), left(coalesce(a ->> 'equipment', ''), 2000), left(coalesce(a ->> 'instructions', ''), 4000))
    on conflict (id) do update set position = excluded.position, title = excluded.title, equipment = excluded.equipment, instructions = excluded.instructions
      where jsa_activities.jsa_id = p_jsa;
    hi := 0;
    for h in select * from jsonb_array_elements(coalesce(a -> 'hazards', '[]'::jsonb)) loop
      v_hid := case when p_regen_ids then gen_random_uuid() else (h ->> 'id')::uuid end;
      keep_h := keep_h || v_hid;
      insert into jsa_hazards (id, company_id, jsa_id, activity_id, position, category, custom_name, instructions)
      values (v_hid, p_co, p_jsa, v_aid, hi, left(coalesce(nullif(h ->> 'category', ''), 'Other / Custom Hazard'), 200),
        left(coalesce(h ->> 'custom_name', ''), 500), left(coalesce(h ->> 'instructions', ''), 4000))
      on conflict (id) do update set activity_id = excluded.activity_id, position = excluded.position, category = excluded.category,
        custom_name = excluded.custom_name, instructions = excluded.instructions where jsa_hazards.jsa_id = p_jsa;
      ci := 0;
      for c in select * from jsonb_array_elements(coalesce(h -> 'controls', '[]'::jsonb)) loop
        continue when btrim(coalesce(c ->> 'text', '')) = '';
        v_cid := case when p_regen_ids then gen_random_uuid() else (c ->> 'id')::uuid end;
        keep_c := keep_c || v_cid;
        insert into jsa_controls (id, company_id, jsa_id, hazard_id, position, text, origin, edited)
        values (v_cid, p_co, p_jsa, v_hid, ci, left(c ->> 'text', 4000),
          case when (c ->> 'origin') in ('manual', 'ai', 'kb', 'template') then c ->> 'origin' else 'manual' end,
          coalesce((c ->> 'edited')::boolean, false))
        on conflict (id) do update set hazard_id = excluded.hazard_id, position = excluded.position, text = excluded.text,
          origin = excluded.origin, edited = excluded.edited where jsa_controls.jsa_id = p_jsa;
        ci := ci + 1;
      end loop;
      hi := hi + 1;
    end loop;
    ai := ai + 1;
  end loop;
  delete from jsa_controls where jsa_id = p_jsa and not (id = any (keep_c));
  delete from jsa_hazards where jsa_id = p_jsa and not (id = any (keep_h));
  delete from jsa_activities where jsa_id = p_jsa and not (id = any (keep_a));
end $$;
revoke all on function jsa_write_tree(uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- autosave / manual save. p_version is the version the browser last saw; a mismatch means another tab saved in between.
create or replace function jsa_save(p_id uuid, p_version int, p_header jsonb, p_activities jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null for update;
  if not found then raise exception 'JSA not found'; end if;
  if j.status = 'finalized' then raise exception 'This JSA is finalized. Create a new revision to edit it.' using errcode = 'P0001'; end if;
  if j.version <> p_version then
    raise exception 'This JSA was changed elsewhere (another tab or window). Reload it before saving so nothing is overwritten.' using errcode = 'P0001';
  end if;
  update jsas set
    number = coalesce(nullif(btrim(p_header ->> 'number'), ''), number),
    project = left(coalesce(p_header ->> 'project', project), 500),
    client = left(coalesce(p_header ->> 'client', client), 500),
    location = left(coalesce(p_header ->> 'location', location), 500),
    work_description = left(coalesce(p_header ->> 'work_description', work_description), 10000),
    jsa_date = coalesce(nullif(p_header ->> 'jsa_date', '')::date, jsa_date),
    prepared_by = left(coalesce(p_header ->> 'prepared_by', prepared_by), 300),
    equipment = left(coalesce(p_header ->> 'equipment', equipment), 5000),
    additional_instructions = left(coalesce(p_header ->> 'additional_instructions', additional_instructions), 10000),
    ai_instructions = left(coalesce(p_header ->> 'ai_instructions', ai_instructions), 10000),
    version = version + 1, updated_at = now()
  where id = p_id;
  perform jsa_write_tree(p_id, v_co, p_activities);
  return j.version + 1;
end $$;

create or replace function jsa_finalize(p_id uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas; v_name text; v_tree jsonb;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null for update;
  if not found then raise exception 'JSA not found'; end if;
  if j.status = 'finalized' then raise exception 'This JSA is already finalized.'; end if;
  if j.version <> p_version then raise exception 'This JSA was changed elsewhere. Reload it before finalizing.' using errcode = 'P0001'; end if;
  if not exists (select 1 from jsa_controls where jsa_id = p_id) then raise exception 'Add control measures before finalizing.'; end if;
  if exists (select 1 from jsa_hazards h where h.jsa_id = p_id and not exists (select 1 from jsa_controls c where c.hazard_id = h.id)) then
    raise exception 'Every hazard needs control measures before the JSA can be finalized.';
  end if;
  select full_name into v_name from profiles where id = auth.uid();
  v_tree := jsa_tree(p_id);
  insert into jsa_revisions (company_id, jsa_id, revision, snapshot, finalized_by_name)
  values (v_co, p_id, j.revision, jsonb_build_object('header', jsa_header_json(j), 'activities', v_tree), coalesce(v_name, ''));
  update jsas set status = 'finalized', finalized_at = now(), version = version + 1, updated_at = now() where id = p_id;
  perform log_audit('jsa.finalized', 'jsa', p_id::text, j.number || ' Rev ' || j.revision, null, null);
end $$;

create or replace function jsa_new_revision(p_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null for update;
  if not found then raise exception 'JSA not found'; end if;
  if j.status <> 'finalized' then raise exception 'Only a finalized JSA can be revised.'; end if;
  update jsas set status = 'draft', revision = revision + 1, finalized_at = null, version = version + 1, updated_at = now() where id = p_id;
  perform log_audit('jsa.revised', 'jsa', p_id::text, j.number || ' Rev ' || (j.revision + 1), null, null);
  return j.revision + 1;
end $$;

create or replace function jsa_duplicate(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas; v_id uuid;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null;
  if not found then raise exception 'JSA not found'; end if;
  v_id := jsa_create(jsonb_build_object('project', j.project, 'client', j.client, 'location', j.location,
    'work_description', j.work_description, 'prepared_by', j.prepared_by, 'equipment', j.equipment,
    'additional_instructions', j.additional_instructions), jsa_tree(p_id));
  update jsas set ai_instructions = j.ai_instructions where id = v_id;
  return v_id;
end $$;

create or replace function jsa_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null for update;
  if not found then raise exception 'JSA not found'; end if;
  update jsas set deleted_at = now(), updated_at = now() where id = p_id;
  perform log_audit('jsa.deleted', 'jsa', p_id::text, j.number, null, null);
end $$;

create or replace function jsa_restore(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company();
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  update jsas set deleted_at = null, updated_at = now() where id = p_id and company_id = v_co;
end $$;

-- the knowledge base is only fed from confirmed administrator action
create or replace function jsa_to_kb(p_hazard uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_co uuid := require_company(); v_id uuid; h jsa_hazards; a jsa_activities; j jsas; v_controls jsonb;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into h from jsa_hazards where id = p_hazard and company_id = v_co;
  if not found then raise exception 'Hazard not found'; end if;
  select * into a from jsa_activities where id = h.activity_id;
  select * into j from jsas where id = h.jsa_id;
  select coalesce(jsonb_agg(text order by position), '[]'::jsonb) into v_controls from jsa_controls where hazard_id = p_hazard;
  if jsonb_array_length(v_controls) = 0 then raise exception 'This hazard has no control measures to save.'; end if;
  insert into safety_knowledge_base (company_id, work_activity, hazard, equipment, controls, source)
  values (v_co, a.title, case when h.custom_name <> '' then h.custom_name else h.category end, coalesce(nullif(a.equipment, ''), j.equipment),
    v_controls, j.number || ' Rev ' || j.revision)
  returning id into v_id;
  return v_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'jsa_create(jsonb, jsonb)', 'jsa_save(uuid, int, jsonb, jsonb)', 'jsa_finalize(uuid, int)', 'jsa_new_revision(uuid)',
    'jsa_duplicate(uuid)', 'jsa_delete(uuid)', 'jsa_restore(uuid)', 'jsa_to_kb(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- used by the AI route handler to confirm the caller is an administrator of the current company
create or replace function jsa_can_use() returns boolean
language sql stable security definer set search_path = public as $$
  select current_company() is not null and coalesce(has_role('administrator'), false)
$$;
revoke all on function jsa_can_use() from public, anon;
grant execute on function jsa_can_use() to authenticated;

-- one round trip for the whole document (header + tree); avoids PostgREST row limits on very long JSAs
create or replace function jsa_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_co uuid := require_company(); j jsas;
begin
  if not has_role('administrator') then raise exception 'Only an administrator can manage JSAs' using errcode = '42501'; end if;
  select * into j from jsas where id = p_id and company_id = v_co and deleted_at is null;
  if not found then return null; end if;
  return jsonb_build_object('id', j.id, 'version', j.version, 'finalized_at', j.finalized_at,
    'header', jsa_header_json(j), 'activities', jsa_tree(j.id));
end $$;
revoke all on function jsa_get(uuid) from public, anon;
grant execute on function jsa_get(uuid) to authenticated;
