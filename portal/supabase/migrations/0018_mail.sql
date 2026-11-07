-- Shared company inbox (contact@hbcgcc.com on IONOS). Mail is synced over IMAP by /api/mail/sync,
-- running AS THE SIGNED-IN ADMINISTRATOR (no service-role key), so every table is administrator-only via RLS.

create table mail_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  folder text not null check (folder in ('inbox', 'sent')),
  uid bigint not null,                        -- IMAP UID inside that folder
  message_id text not null default '',        -- RFC 5322 Message-ID
  thread_key text not null,                   -- root Message-ID of the conversation
  in_reply_to text not null default '',
  from_name text not null default '',
  from_addr text not null default '',
  to_addrs jsonb not null default '[]',       -- [{name, address}]
  cc_addrs jsonb not null default '[]',
  subject text not null default '',
  snippet text not null default '',
  text_body text not null default '',
  html_body text not null default '',         -- sanitised at sync time
  sent_at timestamptz not null,
  is_read boolean not null default false,
  has_attachments boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, folder, uid)
);
create index mail_messages_list_idx on mail_messages (company_id, folder, sent_at desc);
create index mail_messages_thread_idx on mail_messages (company_id, thread_key);

create table mail_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) default current_company(),
  message_id uuid not null references mail_messages (id) on delete cascade,
  filename text not null,
  content_type text not null default 'application/octet-stream',
  size integer not null default 0,
  storage_path text not null                  -- object in bucket mail-attachments: {company_id}/{message uuid}/{n}-{file}
);
create index mail_attachments_msg_idx on mail_attachments (message_id);

create table mail_sync_state (
  company_id uuid not null references companies (id) default current_company(),
  folder text not null check (folder in ('inbox', 'sent')),
  uidvalidity bigint,
  last_uid bigint not null default 0,
  last_synced_at timestamptz,
  last_error text not null default '',
  primary key (company_id, folder)
);

alter table mail_messages enable row level security;
alter table mail_attachments enable row level security;
alter table mail_sync_state enable row level security;

create policy mail_messages_all on mail_messages for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));
create policy mail_attachments_all on mail_attachments for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));
create policy mail_sync_state_all on mail_sync_state for all to authenticated
  using (company_id = (select current_company()) and has_role('administrator'))
  with check (company_id = (select current_company()) and has_role('administrator'));

grant select, insert, update, delete on mail_messages, mail_attachments, mail_sync_state to authenticated;

-- ---------------------------------------------------------------- storage (private)
insert into storage.buckets (id, name, public, file_size_limit)
values ('mail-attachments', 'mail-attachments', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- object path starts with the company id: {company_id}/...
create policy mail_att_read on storage.objects for select to authenticated
  using (bucket_id = 'mail-attachments' and has_role('administrator')
         and (storage.foldername(name))[1] = (select current_company())::text);
create policy mail_att_write on storage.objects for insert to authenticated
  with check (bucket_id = 'mail-attachments' and has_role('administrator')
              and (storage.foldername(name))[1] = (select current_company())::text);

-- ---------------------------------------------------------------- helpers for the API routes
create or replace function mail_can_use() returns boolean
language sql stable security definer set search_path = public as $$
  select current_company() is not null and coalesce(has_role('administrator'), false)
$$;
revoke all on function mail_can_use() from public, anon;
grant execute on function mail_can_use() to authenticated;

-- audit entry written by the send route (log_audit itself is not callable by users)
create or replace function mail_audit_send(p_to text, p_subject text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not mail_can_use() then raise exception 'Only an administrator can send mail' using errcode = '42501'; end if;
  perform log_audit('mail.sent', 'mail', '', left(p_subject, 120), null, jsonb_build_object('to', left(p_to, 300)));
end $$;
revoke all on function mail_audit_send(text, text) from public, anon;
grant execute on function mail_audit_send(text, text) to authenticated;
