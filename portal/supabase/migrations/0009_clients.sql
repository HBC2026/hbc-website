-- Client profiles: saved once per company, picked on a quotation instead of retyped.
-- Quotations keep their own copy of the client text, so changing a profile never rewrites history.

create table clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  name text not null check (btrim(name) <> ''),
  attention text not null default '',
  email text not null default '',
  phone text not null default '',
  address text not null default '',
  vat_no text not null default '',
  payment_terms text not null default '',
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
create unique index clients_company_name_key on clients (company_id, lower(btrim(name)));

alter table clients enable row level security;
create policy clients_read on clients for select to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations', 'viewer'));
create policy clients_write on clients for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator', 'quotations'))
  with check (company_id = (select current_company()) and has_role('administrator', 'quotations'));
grant select, insert, update, delete on clients to authenticated;

-- seed profiles from clients already used on quotations (latest revision wins)
insert into clients (company_id, name, attention, payment_terms)
select distinct on (r.company_id, lower(btrim(r.client)))
  r.company_id, btrim(r.client), r.attention, r.payment_terms
from quotation_revisions r
where btrim(r.client) <> ''
order by r.company_id, lower(btrim(r.client)), r.created_at desc;
