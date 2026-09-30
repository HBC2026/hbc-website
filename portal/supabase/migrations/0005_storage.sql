-- Private bucket for scanned, signed salary slips.
-- Object path convention: salary-slips/{year}/{month}/{employee_code}/signed-slip.pdf
-- The path is stored in salary_slips.signed_path. The bucket is NOT public: the portal
-- views files through short-lived signed URLs (createSignedUrl), which requires the
-- select policy below.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signed-salary-slips', 'signed-salary-slips', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf'];

create policy signed_slips_read on storage.objects for select to authenticated
  using (bucket_id = 'signed-salary-slips' and has_role('administrator', 'payroll', 'viewer'));

create policy signed_slips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%'
              and has_role('administrator', 'payroll'));

-- update is needed for replacing a signed copy (upload with upsert)
create policy signed_slips_update on storage.objects for update to authenticated
  using (bucket_id = 'signed-salary-slips' and has_role('administrator', 'payroll'))
  with check (bucket_id = 'signed-salary-slips' and name like 'salary-slips/%');

-- No delete policy: signed documents are retained permanently.
