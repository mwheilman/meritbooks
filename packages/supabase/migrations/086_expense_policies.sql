-- Migration 086: Expense Policy Compiler — versioned, human-approved rulesets
-- =============================================================
-- Upgrades the expense module from HARD-CODED policy checks (lib/expenses/policy.ts)
-- to a POLICY COMPILER + DETERMINISTIC ENFORCEMENT ENGINE. A tenant drops their
-- written expense policy; the Core AI gateway (feature EXPENSE_POLICY_EXTRACT)
-- COMPILES it into a STRUCTURED ruleset that validates against a fixed Zod schema
-- (apps/web/src/lib/expenses/policy-schema.ts) — DATA, never code. A human reviews,
-- edits, and ACTIVATES a version; the deterministic engine (policy-engine.ts) then
-- enforces that active ruleset on every expense line.
--
-- SAFETY (fintech book of record): the AI only ever produces `compiled_rules` jsonb
-- that conforms to the schema. It never generates code or SQL. Clauses the schema
-- can't express are carried in the ruleset's `unmappedClauses` array for a human —
-- they are NEVER turned into behavior. This table just stores the approved ruleset
-- and its lifecycle; the engine that reads it is hand-written and auditable.
--
-- Money is bigint cents inside `compiled_rules` (enforced by the schema, not here).
-- RLS org_isolation via public.get_org_id() (Clerk org_id claim; never auth.uid()).
-- Master data (org) referenced by FK into `core`. ADDITIVE + idempotent (safe to
-- re-run). Books band; next after 085. Requires 019 (core carve → core.organizations).
--
-- DEGRADE-SAFE: with NO ACTIVE policy the engine applies conservative defaults and
-- blocks nothing — absent this table the feature is simply unavailable and nothing
-- else breaks. Apply to Supabase FIRST, then ship the code that depends on it.
-- =============================================================

-- ---- Guard: the FK target we depend on must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (core carve) before 086.';
  end if;
end $$;

-- =============================================================
-- EXPENSE POLICY (a versioned, compiled ruleset)
-- =============================================================
-- Lifecycle: DRAFT → ACTIVE → ARCHIVED. Exactly ONE ACTIVE policy per org at a
-- time (partial unique index below is the guarantor). `version` increments per org.
-- `compiled_rules` is the machine-readable ruleset validated by the fixed Zod
-- schema in app code on every read/write — the DB stores it as opaque jsonb.
create table if not exists public.expense_policies (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,

  name text not null default 'Expense Policy',
  version int not null default 1,

  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),

  -- Effective window (informational + future dating). Enforcement uses status.
  effective_start date,
  effective_end date,

  -- The compiled ruleset (validated against policy-schema.ts in app code).
  compiled_rules jsonb not null default '{}'::jsonb,

  -- Provenance: a note about the source document / how it was produced, plus the
  -- AI decision row id when compiled from a dropped document (PROPOSED → approved).
  source_note text,
  source_decision_id uuid references public.ai_decisions(id) on delete set null,

  created_by_user text,
  activated_by_user text,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expense_policies_org
  on public.expense_policies(org_id, status, version desc);

-- Exactly one ACTIVE policy per org — the DB is the guarantor (app also enforces).
create unique index if not exists uq_expense_policies_one_active
  on public.expense_policies(org_id) where status = 'ACTIVE';

-- Version is unique per org so history is well-ordered.
create unique index if not exists uq_expense_policies_org_version
  on public.expense_policies(org_id, version);

-- =============================================================
-- RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
alter table public.expense_policies enable row level security;
do $$ begin
  create policy "org_isolation" on public.expense_policies
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.expense_policies
  to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_expense_policies_updated
        before update on public.expense_policies
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- =============================================================
-- DONE. Books now stores compiled, versioned, human-approved expense policies
-- (public.expense_policies). The AI compiles a dropped policy document into the
-- `compiled_rules` ruleset (schema-validated in app code, unmapped clauses left for
-- a human); a human activates a version; the deterministic engine enforces the one
-- ACTIVE ruleset per org. No active policy => conservative defaults, nothing blocks.
-- Org-isolated by RLS. Apply this FIRST, then ship the dependent code.
-- =============================================================
