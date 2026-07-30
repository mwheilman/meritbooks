-- =============================================================================
-- Migration 063: core.users self UPDATE policy
-- =============================================================================
-- 061 gave core.users self_read; 062 added self_provision (insert). This adds a
-- self UPDATE policy so a signed-in user can keep their own profile (name/email)
-- in sync — the /api/me route upserts the user's name/email from their employee
-- record, and the Audit Trail displays those names. Scoped strictly to the
-- caller's own row (clerk sub).
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='users' and policyname='self_update') then
    create policy "self_update" on core.users for update
      using (clerk_user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub'))
      with check (clerk_user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
  end if;
end $$;
