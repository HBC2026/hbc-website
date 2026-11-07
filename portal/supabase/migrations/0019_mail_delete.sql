-- Lets an administrator remove stored mail attachments when a message is moved to the IONOS Trash.
create policy mail_att_delete on storage.objects for delete to authenticated
  using (bucket_id = 'mail-attachments' and has_role('administrator')
         and (storage.foldername(name))[1] = (select current_company())::text);
