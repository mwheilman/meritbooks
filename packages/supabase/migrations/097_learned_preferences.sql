-- =============================================================================
-- Migration 097: learned_preferences — generic org-scoped learning/memory (M14)
-- =============================================================================
-- Generalizes the single vendor->GL categorization memory into a reusable
-- preference/memory store the whole app can read: scopes CATEGORIZATION,
-- CLOSE_CADENCE, REPORT_PREFS, TONE, METHOD_SSP. Learning only INFORMS proposals/
-- defaults; it never posts or approves (canon §3). Additive + idempotent. RLS
-- org_isolation via get_org_id(). Degrades SAFE (reads null / writes no-op) if
-- absent. Books band; next number: 098.
-- =============================================================================

create table if not exists public.learned_preferences (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  scope text not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  observations integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_learned_preferences_org_scope_key
  on public.learned_preferences (org_id, scope, key);
create index if not exists idx_learned_preferences_org_scope
  on public.learned_preferences (org_id, scope);

alter table public.learned_preferences enable row level security;
do $$ begin
  create policy "org_isolation" on public.learned_preferences
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.learned_preferences
  to anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_learned_preferences_updated
        before update on public.learned_preferences
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null;
    end;
  end if;
end $$;
