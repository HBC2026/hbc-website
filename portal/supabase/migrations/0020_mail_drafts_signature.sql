-- Shared signature and auto-saved drafts for the company inbox (administrators only).

create table mail_settings (
  company_id uuid primary key references companies (id) default current_company(),
  signature text not null default '' check (length(signature) <= 2000),
  updated_at timestamptz not null default now()
);

create table mail_drafts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  to_text text not null default '',
  cc_text text not null default '',
  subject text not null default '' check (length(subject) <= 300),
  body text not null default '' check (length(body) <= 200000),
  in_reply_to text not null default '',
  refs text not null default '',
  updated_by uuid references profiles (id) default auth.uid(),
  updated_at timestamptz not null default now()
);
create index mail_drafts_list_idx on mail_drafts (company_id, updated_at desc);

alter table mail_settings enable row level security;
alter table mail_drafts enable row level security;

create policy mail_settings_all on mail_settings for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));
create policy mail_drafts_all on mail_drafts for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));

grant select, insert, update, delete on mail_settings, mail_drafts to authenticated;
