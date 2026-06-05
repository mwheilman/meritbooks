-- Migration 039: AI Decision Log & Explainability Layer (GATE 3 — Session 22)
-- =============================================================
-- Foundational GATE 3 plumbing: every AI proposal writes an immutable decision
-- record — its inputs, the proposed output, confidence, reasoning, the model that
-- ran (via the Core gateway, with the gateway correlation_id), and the human
-- disposition (approved / rejected). Nothing AI-originated posts to the ledger
-- without a row here, and the approved row links to the GL entry it produced.
-- This is the audit + explainability spine the rest of GATE 3 (categorization,
-- predictor, ingestion) reuses.
--
-- Additive + idempotent. Requires 019 (core carve), 027 (AI gateway / usage log).
-- Next migration number: 040.
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 before 039.';
  end if;
end $$;

create table if not exists public.ai_decisions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  feature text not null,                               -- 'JE_COMPOSER', 'CATEGORIZATION', ...
  model_requested text,
  model_used text,
  correlation_id text,                                 -- links to core.ai_usage_log (gateway)
  input_summary text not null,                         -- what the human/source asked
  proposed_output jsonb not null,                      -- the proposed entry (memo, lines, prediction, etc.)
  confidence numeric(5,4),
  reasoning text,                                      -- model's notes / judgment calls
  clarifying_question text,                            -- one disambiguating question, if any
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED')),
  disposition_by_user text,                            -- Clerk actor who approved/rejected
  disposition_at timestamptz,
  disposition_note text,
  posted_gl_entry_id uuid references public.gl_entries(id),
  tokens_input int,
  tokens_output int,
  cost_cents numeric(12,4),
  created_by_user text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_decisions_org on public.ai_decisions(org_id, created_at desc);
create index if not exists idx_ai_decisions_status on public.ai_decisions(org_id, status, created_at desc);
create index if not exists idx_ai_decisions_feature on public.ai_decisions(org_id, feature, created_at desc);

alter table public.ai_decisions enable row level security;
do $$ begin
  create policy "org_isolation" on public.ai_decisions
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.ai_decisions
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Every AI proposal records here; approvals link to their GL entry.
-- =============================================================
