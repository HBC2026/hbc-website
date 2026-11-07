-- Rich-text (HTML) signature and drafts, and Bcc on drafts.
alter table mail_settings drop constraint if exists mail_settings_signature_check;
alter table mail_settings add constraint mail_settings_signature_check check (length(signature) <= 20000);

alter table mail_drafts add column bcc_text text not null default '';
