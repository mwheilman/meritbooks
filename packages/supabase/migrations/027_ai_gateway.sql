-- Migration 027: AI Gateway & Cost Governance (Suite Core — Architecture §3A)
-- =============================================================================
-- Core-owned shared infrastructure. Every module (Books, Projects, all future
-- modules) calls the single Core AI gateway; NONE reimplements any part of it and
-- NONE holds an Anthropic key. This migration creates only the Core-owned tables
-- (all in the `core` schema) and the atomic RPCs the gateway relies on:
--
--   core.ai_model_prices    — model -> cents-per-million-tokens (editable, no code change)   §3A.2
--   core.ai_tier_config     — per-tier caps/thresholds/guards/overage policy (numbers later) §3A.7
--   core.ai_feature_caps    — optional per (tier, module, feature) sub-caps                  §3A.3(1)
--   core.ai_usage_log       — the metering ledger: one row per call, by correlation_id       §3A.2 / §3A.8
--   core.ai_usage_counters  — running monthly counters (tenant / user / feature)             §3A.2
--   core.ai_rate_buckets    — per-minute call counters for rate limits                       §3A.5
--   core.ai_inflight        — in-flight calls per tenant for the concurrency guard           §3A.5
--   core.organizations.ai_tier — the tenant's tier assignment (cents limits resolve from
--                                 ai_tier_config, NOT stored on the org row)                  §3A.8
--
-- REQUIRES migration 019 (core carve) + 023 (entitlements on core.organizations).
-- Idempotent. Money is bigint cents throughout; prices are numeric cents/MTok.
-- =============================================================================

-- ---- Guard: confirm the core carve is deployed ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (Suite Core carve) before 027.';
  end if;
end $$;

-- =============================================================================
-- 0. Tenant tier assignment (the tier lives on the org; the cents limits do NOT)
-- =============================================================================
alter table core.organizations
  add column if not exists ai_tier text not null default 'default';
comment on column core.organizations.ai_tier is
  'AI cost-governance tier. Resolves to a row in core.ai_tier_config (§3A.8). Cents limits are NOT stored here.';

-- =============================================================================
-- 1. Model price table (cents per MILLION tokens) — editable without a code change
-- =============================================================================
create table if not exists core.ai_model_prices (
  model text primary key,
  input_price_per_mtok_cents  numeric(14,4) not null default 0,
  output_price_per_mtok_cents numeric(14,4) not null default 0,
  is_active boolean not null default true,
  note text,
  updated_at timestamptz not null default now()
);
comment on table core.ai_model_prices is
  'Token->cents conversion. Prices in cents per 1,000,000 tokens. Edit via SQL/dashboard — no code change. §3A.2';

-- Seed the suite''s models. PLACEHOLDER prices — confirm against current Anthropic
-- list pricing and edit in place; the gateway reads these live. A model missing
-- here meters at cost_cents = 0 and the response flags "price not configured".
insert into core.ai_model_prices (model, input_price_per_mtok_cents, output_price_per_mtok_cents, note) values
  ('claude-opus-4-8',          1500.0000, 7500.0000, 'PLACEHOLDER — verify/edit to current list price'),
  ('claude-opus-4-7',          1500.0000, 7500.0000, 'PLACEHOLDER — verify/edit to current list price'),
  ('claude-opus-4-6',          1500.0000, 7500.0000, 'PLACEHOLDER — verify/edit to current list price'),
  ('claude-sonnet-4-6',         300.0000, 1500.0000, 'PLACEHOLDER — verify/edit to current list price'),
  ('claude-haiku-4-5-20251001',  80.0000,  400.0000, 'PLACEHOLDER — verify/edit to current list price')
on conflict (model) do nothing;

-- =============================================================================
-- 2. Per-tier config (mechanism now; pricing NUMBERS filled in later — §3A.7)
-- =============================================================================
create table if not exists core.ai_tier_config (
  tier text primary key,
  display_name text,
  -- PRICING CONFIG (fill once tier pricing is set; NULL = not configured = inert / no cap)
  monthly_cap_cents bigint,                       -- tenant monthly ceiling (binding) §3A.3(3)
  per_user_cap_cents bigint,                      -- optional per-user sub-budget    §3A.3(2)
  soft_warn_pct numeric(5,2) not null default 80, -- soft threshold                  §3A.4
  overage_policy text not null default 'HARD_STOP'
    check (overage_policy in ('HARD_STOP','METERED','UPSELL','DEGRADE_MODEL')),
  degrade_model text,                             -- cheaper model for DEGRADE_MODEL  §3A.4
  -- OPERATIONAL GUARDS (sensible non-pricing defaults; adjust as needed) §3A.5
  max_tokens_ceiling int not null default 8192,   -- per-call max_tokens hard ceiling
  rate_per_user_per_min int,                      -- NULL = no rate limit
  rate_per_tenant_per_min int,
  concurrency_limit int,                          -- NULL = no concurrency limit
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
comment on table core.ai_tier_config is
  'Per-tier AI budget + guards. Cents caps are NULL until pricing is set (mechanism is inert, not broken). §3A.7';

-- A working default tier: caps NULL (no spend ceiling until you set them), but the
-- operational runaway guards are live so the mechanism is demonstrable today.
insert into core.ai_tier_config
  (tier, display_name, monthly_cap_cents, per_user_cap_cents, soft_warn_pct, overage_policy,
   degrade_model, max_tokens_ceiling, rate_per_user_per_min, rate_per_tenant_per_min, concurrency_limit)
values
  ('default', 'Default (caps unset)', null, null, 80, 'HARD_STOP',
   'claude-haiku-4-5-20251001', 8192, 60, 600, 20)
on conflict (tier) do nothing;

-- =============================================================================
-- 3. Optional per (tier, module, feature) caps — §3A.3(1)
-- =============================================================================
create table if not exists core.ai_feature_caps (
  id uuid primary key default uuid_generate_v4(),
  tier text not null,
  module text not null,
  feature text not null,
  cap_cents bigint not null,
  max_tokens int,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (tier, module, feature)
);
comment on table core.ai_feature_caps is
  'Optional per-feature spend cap, keyed (tier, module, feature). No row = no feature cap. §3A.3(1)';

-- =============================================================================
-- 4. The metering ledger — one row per call (§3A.2 / §3A.8)
-- =============================================================================
create table if not exists core.ai_usage_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  user_id text,                                   -- Clerk id (text), nullable for system calls
  module text not null,
  feature text not null,
  model text,                                     -- requested model
  model_used text,                                -- actual model (differs on degrade)
  status text not null,                           -- ok | warn | degraded | blocked
  tokens_input bigint not null default 0,
  tokens_output bigint not null default 0,
  cost_cents bigint not null default 0,
  correlation_id uuid not null,                   -- links to the calling module''s own audit log
  occurred_at timestamptz not null default now()
);
comment on table core.ai_usage_log is
  'Core metering ledger: the only place total AI spend is visible; basis for caps + billing. Linked to a module''s local audit log by correlation_id, never merged. §3A.8';
create index if not exists idx_ai_usage_log_org_time on core.ai_usage_log(org_id, occurred_at desc);
create index if not exists idx_ai_usage_log_corr on core.ai_usage_log(correlation_id);
create index if not exists idx_ai_usage_log_feature on core.ai_usage_log(org_id, module, feature);

-- =============================================================================
-- 5. Running monthly counters — caps are checked against these, never by summing the log (§3A.2)
-- =============================================================================
create table if not exists core.ai_usage_counters (
  org_id uuid not null references core.organizations(id) on delete cascade,
  period_month date not null,                     -- first day of the month (UTC)
  scope text not null check (scope in ('TENANT','USER','FEATURE')),
  scope_key text not null default '',             -- '' (tenant) | user_id (user) | 'MODULE:FEATURE' (feature)
  cost_cents bigint not null default 0,
  call_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, period_month, scope, scope_key)
);
comment on table core.ai_usage_counters is 'Running monthly AI spend counters per tenant / user / feature. §3A.2';

-- =============================================================================
-- 6. Runaway-guard substrate: per-minute rate buckets + in-flight concurrency (§3A.5)
-- =============================================================================
create table if not exists core.ai_rate_buckets (
  org_id uuid not null references core.organizations(id) on delete cascade,
  scope text not null check (scope in ('USER','TENANT')),
  scope_key text not null default '',
  minute_bucket timestamptz not null,             -- date_trunc('minute', now())
  count int not null default 0,
  primary key (org_id, scope, scope_key, minute_bucket)
);

create table if not exists core.ai_inflight (
  correlation_id uuid primary key,
  org_id uuid not null references core.organizations(id) on delete cascade,
  started_at timestamptz not null default now()
);
create index if not exists idx_ai_inflight_org on core.ai_inflight(org_id);

-- =============================================================================
-- 7. RLS — org isolation on org-scoped tables; read-all on global config tables
-- =============================================================================
do $$
declare t text;
begin
  -- org-scoped: standard tenant isolation
  foreach t in array array['ai_usage_log','ai_usage_counters','ai_rate_buckets','ai_inflight'] loop
    execute format('alter table core.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='core' and tablename=t and policyname='org_isolation') then
      execute format('create policy "org_isolation" on core.%I for all using (org_id = public.get_org_id())', t);
    end if;
    execute format('grant select, insert, update, delete on core.%I to anon, authenticated, service_role', t);
  end loop;

  -- global config: readable by authenticated; writes via service role (admin)
  foreach t in array array['ai_model_prices','ai_tier_config','ai_feature_caps'] loop
    execute format('alter table core.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='core' and tablename=t and policyname='read_all') then
      execute format('create policy "read_all" on core.%I for select using (true)', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='core' and tablename=t and policyname='service_write') then
      execute format($p$create policy "service_write" on core.%I for all to service_role using (true) with check (true)$p$, t);
    end if;
    execute format('grant select on core.%I to anon, authenticated', t);
    execute format('grant select, insert, update, delete on core.%I to service_role', t);
  end loop;
end $$;

-- =============================================================================
-- 8. Atomic RPCs (correctness on serverless — no shared memory between instances)
-- =============================================================================

-- Increment a monthly counter atomically (called AFTER a successful/metered call).
create or replace function core.ai_increment_counter(
  p_org uuid, p_month date, p_scope text, p_key text, p_cost bigint
) returns void
language sql security definer set search_path = core, public as $$
  insert into core.ai_usage_counters (org_id, period_month, scope, scope_key, cost_cents, call_count, updated_at)
  values (p_org, p_month, p_scope, coalesce(p_key,''), greatest(p_cost,0), 1, now())
  on conflict (org_id, period_month, scope, scope_key)
  do update set cost_cents = core.ai_usage_counters.cost_cents + greatest(p_cost,0),
                call_count = core.ai_usage_counters.call_count + 1,
                updated_at = now();
$$;

-- Bump a per-minute rate bucket and return the new count for the current minute.
create or replace function core.ai_bump_rate(
  p_org uuid, p_scope text, p_key text
) returns int
language plpgsql security definer set search_path = core, public as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count int;
begin
  insert into core.ai_rate_buckets (org_id, scope, scope_key, minute_bucket, count)
  values (p_org, p_scope, coalesce(p_key,''), v_bucket, 1)
  on conflict (org_id, scope, scope_key, minute_bucket)
  do update set count = core.ai_rate_buckets.count + 1
  returning count into v_count;
  -- opportunistic cleanup of old buckets for this key
  delete from core.ai_rate_buckets
   where org_id = p_org and scope = p_scope and scope_key = coalesce(p_key,'')
     and minute_bucket < v_bucket - interval '5 minutes';
  return v_count;
end;
$$;

-- Acquire a concurrency slot: reap stale in-flight rows, count active, insert if room.
create or replace function core.ai_concurrency_acquire(
  p_org uuid, p_limit int, p_ttl_seconds int, p_corr uuid
) returns boolean
language plpgsql security definer set search_path = core, public as $$
declare v_active int;
begin
  delete from core.ai_inflight
   where org_id = p_org and started_at < now() - make_interval(secs => greatest(p_ttl_seconds,1));
  if p_limit is null then
    return true;  -- no concurrency limit configured
  end if;
  select count(*) into v_active from core.ai_inflight where org_id = p_org;
  if v_active >= p_limit then
    return false;
  end if;
  insert into core.ai_inflight (correlation_id, org_id) values (p_corr, p_org)
  on conflict (correlation_id) do nothing;
  return true;
end;
$$;

create or replace function core.ai_concurrency_release(p_corr uuid)
returns void language sql security definer set search_path = core, public as $$
  delete from core.ai_inflight where correlation_id = p_corr;
$$;

grant execute on function
  core.ai_increment_counter(uuid, date, text, text, bigint),
  core.ai_bump_rate(uuid, text, text),
  core.ai_concurrency_acquire(uuid, int, int, uuid),
  core.ai_concurrency_release(uuid)
to anon, authenticated, service_role;

-- End migration 027.
