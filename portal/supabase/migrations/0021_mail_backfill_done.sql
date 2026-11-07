-- Remembers that a folder's full history has been imported, so the inbox only ever fetches new mail afterwards.
alter table mail_sync_state add column backfill_done boolean not null default false;
