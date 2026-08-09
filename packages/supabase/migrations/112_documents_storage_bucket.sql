-- =============================================================================
-- Migration 112: `documents` Storage bucket + org-scoped object RLS
-- =============================================================================
-- Migration 090 created `public.documents` (metadata + polymorphic attachment spine)
-- and RESERVED — but did not create — the private Storage bucket that holds the file
-- BYTES. The bucket was stood up out-of-band; this migration records it in the
-- migration sequence so a fresh Supabase built purely from migrations is reproducible,
-- and adds defense-in-depth RLS on the objects.
--
-- The bucket is PRIVATE. Object keys are org-namespaced: `<org_id>/<folder>/<id>-<name>`
-- (see lib/documents/schema.ts buildStoragePath). All app object I/O goes through the
-- SERVICE ROLE (createAdminSupabase → bypasses RLS), matching the existing `branding`
-- upload pattern; tenant isolation on the METADATA is enforced by public.documents RLS.
-- The object policies below are belt-and-suspenders: should the authenticated role ever
-- touch storage.objects directly, it can only ever see/write keys under ITS OWN org_id
-- (path prefix = get_org_id()). Without these policies the authenticated role has no
-- access at all (RLS default-deny), which is why everything works today via service role.
--
-- Idempotent + additive. Books band; next number: 113.
-- =============================================================================

-- ---- 1. Ensure the private `documents` bucket exists ----
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- ---- 2. Org-scoped object RLS (defense in depth; service role bypasses these) ----
-- The first path segment is the owning org_id; get_org_id() is the Clerk org claim
-- (uuid). Guarded so re-running the migration is a no-op.
do $$
begin
  create policy "documents_org_select" on storage.objects
    for select to authenticated
    using (
      bucket_id = 'documents'
      and (storage.foldername(name))[1] = public.get_org_id()::text
    );
exception when duplicate_object then null; end $$;

do $$
begin
  create policy "documents_org_insert" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'documents'
      and (storage.foldername(name))[1] = public.get_org_id()::text
    );
exception when duplicate_object then null; end $$;

do $$
begin
  create policy "documents_org_update" on storage.objects
    for update to authenticated
    using (
      bucket_id = 'documents'
      and (storage.foldername(name))[1] = public.get_org_id()::text
    )
    with check (
      bucket_id = 'documents'
      and (storage.foldername(name))[1] = public.get_org_id()::text
    );
exception when duplicate_object then null; end $$;

do $$
begin
  create policy "documents_org_delete" on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'documents'
      and (storage.foldername(name))[1] = public.get_org_id()::text
    );
exception when duplicate_object then null; end $$;

-- =============================================================================
-- DONE. The private `documents` bucket is now recorded in the migration sequence and
-- its objects are org-scoped. Source files from the drop-and-parse flows are retained
-- via lib/documents/store.ts (service-role object I/O + RLS-scoped metadata row).
-- =============================================================================
