-- =============================================================================
-- Migration 187: flux review — materiality policy, explanations, close gate (Wave 3E).
-- =============================================================================
-- Audit rows CL-05 (flux with materiality + required explanations before sign-off) and
-- CL-03 (close gate + controller override) — docs/audit-2026-10/FEATURE-GAP-AUDIT.md §6.3
-- Wave 3E; docs/FPB-financial-reports.md §5 (Amendment A-3E).
--
-- §1  public.flux_materiality_policies   per tenant (location_id NULL) or per company (a
--                                        company row overrides the tenant row): $ and % thresholds,
--                                        EITHER / BOTH / ABS_ONLY / PCT_ONLY, comparison basis
--                                        (prior month, same month PY, budget, trailing-3 average),
--                                        type / group / account overrides, excluded accounts,
--                                        dimension (account, × department, × class), and whether a
--                                        flux review is required to close at all.
-- §2  public.flux_explanations           one row per (company, month, flux line). The server
--                                        snapshots current / comparison / change at submit; the
--                                        explanation (text + category + optional attachment) is
--                                        prepared by one person and REVIEWED by another — the DB
--                                        refuses reviewed_by = prepared_by. AI drafts are recorded
--                                        (drafted_by_ai, ai_decision_id) only after a person accepts.
-- §3  public.flux_reviews                one row per (company, month): the controller waiver that
--                                        lets the "Flux review" close task pass without every line
--                                        reviewed. A waiver needs a reason (≥ 10 chars) and an actor.
-- §4  RLS + grants: members SELECT their org only; every write is the service role (the app,
--     after its permission check, org pinned — the 171/179/184 pattern). No member write grants.
--     M1 lesson: no new functions.
-- §5  core.apply_client_scope_rls() re-run (every new table carries location_id).
--
-- No GL effect: nothing here references gl_entries for write and nothing touches fiscal_periods,
-- so the period lock (enforce_period_lock) is unaffected. Idempotent. PGlite-compatible (no
-- subqueries in CHECKs). Apply to Supabase FIRST, then commit the code that depends on it.
-- =============================================================================

-- ── §1 materiality policies ──────────────────────────────────────────────────
create table if not exists public.flux_materiality_policies (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid references core.locations(id) on delete cascade,
  review_required       boolean not null default true,
  threshold_mode        text not null default 'EITHER',
  abs_threshold_cents   bigint not null default 500000,
  pct_threshold_bps     integer not null default 1000,
  comparison_basis      text not null default 'PRIOR_MONTH',
  dimension             text not null default 'ACCOUNT',
  include_pnl           boolean not null default true,
  include_balance_sheet boolean not null default true,
  overrides             jsonb not null default '[]'::jsonb,
  excluded_account_ids  uuid[] not null default array[]::uuid[],
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'flux_materiality_policies_chk') then
    alter table public.flux_materiality_policies add constraint flux_materiality_policies_chk
      check (threshold_mode in ('EITHER', 'BOTH', 'ABS_ONLY', 'PCT_ONLY')
             and comparison_basis in ('PRIOR_MONTH', 'PRIOR_YEAR_MONTH', 'BUDGET', 'TRAILING_3_AVG')
             and dimension in ('ACCOUNT', 'ACCOUNT_DEPARTMENT', 'ACCOUNT_CLASS')
             and abs_threshold_cents >= 0
             and pct_threshold_bps between 0 and 1000000
             and jsonb_typeof(overrides) = 'array'
             and jsonb_array_length(overrides) <= 100
             and cardinality(excluded_account_ids) <= 1000
             and (include_pnl or include_balance_sheet));
  end if;
end $$;
create unique index if not exists uq_flux_materiality_policies_scope
  on public.flux_materiality_policies (org_id, location_id) nulls not distinct;
comment on table public.flux_materiality_policies is
  'Mig 187: flux materiality per tenant (location_id NULL) or company (company row wins). threshold_mode EITHER = $ or %, BOTH = $ and %. pct_threshold_bps 1000 = 10%. overrides = [{scope: TYPE|GROUP|ACCOUNT, key, absThresholdCents?, pctThresholdBps?, mode?, excluded?}] (ACCOUNT > GROUP > TYPE > policy). review_required = false ⇒ the Flux review close task passes. Written only by the service role.';

-- ── §2 explanations ──────────────────────────────────────────────────────────
create table if not exists public.flux_explanations (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id) on delete cascade,
  fiscal_period_id         uuid references public.fiscal_periods(id) on delete set null,
  period_key               text not null,
  line_key                 text not null,
  account_id               uuid not null references public.accounts(id) on delete cascade,
  department_id            uuid,
  class_id                 uuid,
  comparison_basis         text not null,
  current_cents            bigint not null default 0,
  comparison_cents         bigint not null default 0,
  change_cents             bigint not null default 0,
  change_pct_bps           integer,
  status                   text not null default 'DRAFT',
  explanation              text,
  category                 text,
  attachment_document_id   uuid references public.documents(id) on delete set null,
  drafted_by_ai            boolean not null default false,
  ai_decision_id           uuid,
  ai_citations             jsonb not null default '[]'::jsonb,
  carried_from_id          uuid references public.flux_explanations(id) on delete set null,
  prepared_by              text,
  prepared_by_user_id      uuid,
  prepared_at              timestamptz,
  reviewed_by              text,
  reviewed_at              timestamptz,
  review_note              text,
  -- sha256 hex of (category || E'\n' || explanation) the reviewer approved (pins the text)
  reviewed_explanation_hash text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'flux_explanations_chk') then
    alter table public.flux_explanations add constraint flux_explanations_chk
      check (status in ('DRAFT', 'EXPLAINED', 'REVIEWED')
             and period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
             and length(line_key) between 1 and 200
             and comparison_basis in ('PRIOR_MONTH', 'PRIOR_YEAR_MONTH', 'BUDGET', 'TRAILING_3_AVG')
             and (category is null or category in ('TIMING', 'ONE_TIME', 'VOLUME', 'PRICE', 'RECLASS', 'ERROR_CORRECTED', 'EXPECTED'))
             and (explanation is null or length(explanation) <= 4000)
             and (review_note is null or length(review_note) <= 1000)
             and jsonb_typeof(ai_citations) = 'array'
             -- A submitted explanation carries real text, a category, a preparer and a time.
             and (status = 'DRAFT'
                  or (explanation is not null and length(btrim(explanation)) >= 10
                      and category is not null and prepared_by is not null and prepared_at is not null))
             -- Review: a reviewer + time, and never the preparer (segregation of duties).
             and (status <> 'REVIEWED'
                  or (reviewed_by is not null and reviewed_at is not null and reviewed_by <> prepared_by)));
  end if;
end $$;
-- Security review (MEDIUM): a review pins the exact text + category the reviewer read. A
-- REVIEWED row must carry the hash of its current (category, explanation) — so the preparer
-- (or anyone) can't swap the text after review without the row leaving REVIEWED.
-- hash = encode(sha256(convert_to(coalesce(category,'') || chr(10) || coalesce(explanation,''), 'UTF8')), 'hex')
-- (TS: createHash('sha256').update(`${category ?? ''}\n${explanation ?? ''}`, 'utf8').digest('hex')).
alter table public.flux_explanations add column if not exists reviewed_explanation_hash text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'flux_explanations_review_hash_chk') then
    alter table public.flux_explanations add constraint flux_explanations_review_hash_chk
      check (status <> 'REVIEWED'
             or (reviewed_explanation_hash is not null and reviewed_explanation_hash = encode(sha256(convert_to(coalesce(category, '') || chr(10) || coalesce(explanation, ''), 'UTF8')), 'hex')));
  end if;
end $$;
create unique index if not exists uq_flux_explanations_line
  on public.flux_explanations (org_id, location_id, period_key, line_key);
create index if not exists ix_flux_explanations_period
  on public.flux_explanations (org_id, period_key, location_id);
comment on table public.flux_explanations is
  'Mig 187: one flux explanation per (company, month, line_key). Figures are a SERVER snapshot taken at submit (a later move beyond max($100, 5%) makes it stale). DRAFT → EXPLAINED (preparer) → REVIEWED (a different person; the CHECK refuses reviewed_by = prepared_by). drafted_by_ai/ai_decision_id record an accepted AI draft. Written only by the service role.';

-- ── §3 per-company per-month flux review (waiver) ────────────────────────────
create table if not exists public.flux_reviews (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id) on delete cascade,
  fiscal_period_id    uuid references public.fiscal_periods(id) on delete set null,
  period_key          text not null,
  status              text not null default 'OPEN',
  waived_reason       text,
  waived_by           text,
  waived_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'flux_reviews_chk') then
    alter table public.flux_reviews add constraint flux_reviews_chk
      check (status in ('OPEN', 'WAIVED')
             and period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
             and (waived_reason is null or length(waived_reason) <= 1000)
             and (status <> 'WAIVED'
                  or (waived_reason is not null and length(btrim(waived_reason)) >= 10
                      and waived_by is not null and waived_at is not null)));
  end if;
end $$;
create unique index if not exists uq_flux_reviews_period
  on public.flux_reviews (org_id, location_id, period_key);
comment on table public.flux_reviews is
  'Mig 187: the controller waiver for a company-month flux review. WAIVED lets the Flux review close task pass without every material line reviewed; needs a reason (≥ 10 chars) and an actor, and is logged to core.action_log by the app. Written only by the service role.';

-- ── §4 RLS + grants (members read their org; service role writes) ─────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['flux_materiality_policies', 'flux_explanations', 'flux_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- End migration 187.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- ── Projects-only seat deny (1110 contract; guarded: absent in the PGlite replay) ──
-- Every RLS table this migration creates gets the RESTRICTIVE projects_only_seat_deny policy.
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['flux_materiality_policies', 'flux_explanations', 'flux_reviews'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
