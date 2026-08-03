-- =============================================================================
-- Migration 101: Inventory MVP (GATE 11c) — items + stock movements + valuation
-- =============================================================================
-- Items carry qty-on-hand + valuation (WEIGHTED_AVG or FIFO layers in fifo_layers
-- jsonb, money bigint cents). Movements are RECEIPT (valuation-only, no GL — the
-- linked bill/cash entry books the asset), ISSUE, or ADJUST. ISSUE/ADJUST are created
-- PROPOSED and, on human approval, post a balanced DR COGS / CR Inventory Asset entry
-- resolved BY ROLE (INVENTORY_COGS / INVENTORY_ASSET) through the deterministic engine
-- (canon §3 — no auto-post). Both role keys map to EXISTING standard-COA accounts
-- (1200 Inventory, 5100 Materials/COGS) — no new accounts. Additive + idempotent.
-- RLS org_isolation via get_org_id(). App degrades SAFE if the tables are absent.
-- Books band; next number: 102 (already applied: practice_assignments).
-- RBAC follow-up (reserved permissions.ts): add an `inventory` feature; interim the
-- routes gate on fixed_assets:view/create and the COGS post on journal_entries:post.
-- =============================================================================

create table if not exists public.inventory_items (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  sku               text not null,
  name              text not null,
  description       text,
  uom               text not null default 'each',
  valuation_method  text not null default 'WEIGHTED_AVG' check (valuation_method in ('WEIGHTED_AVG','FIFO')),
  location_id       uuid references core.locations(id),
  asset_account_id  uuid references public.accounts(id),
  cogs_account_id   uuid references public.accounts(id),
  qty_on_hand       numeric not null default 0,
  avg_cost_cents    bigint not null default 0,
  total_value_cents bigint not null default 0,
  fifo_layers       jsonb  not null default '[]'::jsonb,
  reorder_point     numeric,
  is_active         boolean not null default true,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, sku)
);

create table if not exists public.inventory_movements (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  location_id      uuid references core.locations(id),
  movement_type    text not null check (movement_type in ('RECEIPT','ISSUE','ADJUST')),
  status           text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  qty              numeric not null,
  unit_cost_cents  bigint not null default 0,
  total_cost_cents bigint not null default 0,
  cogs_cents       bigint not null default 0,
  reference        text,
  ref_type         text default 'MANUAL',
  ref_id           uuid,
  memo             text,
  movement_date    date not null default current_date,
  gl_entry_id      uuid references public.gl_entries(id),
  posted_at        timestamptz,
  posted_by        text,
  created_by       text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_inv_moves_item on public.inventory_movements(item_id, movement_date desc);

alter table public.inventory_items     enable row level security;
alter table public.inventory_movements enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_items' and policyname='org_isolation')
    then create policy "org_isolation" on public.inventory_items for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_items' and policyname='service_write')
    then create policy "service_write" on public.inventory_items for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_movements' and policyname='org_isolation')
    then create policy "org_isolation" on public.inventory_movements for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_movements' and policyname='service_write')
    then create policy "service_write" on public.inventory_movements for all to service_role using (true) with check (true); end if;
end $$;
grant select, insert, update, delete on public.inventory_items, public.inventory_movements to anon, authenticated, service_role;

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('INVENTORY_ASSET', 'Inventory (asset on hand)', 'ORG', '1200'),
  ('INVENTORY_COGS',  'Inventory cost of goods sold', 'ORG', '5100')
on conflict (role_key) do update
  set label = excluded.label, scope = excluded.scope, default_account_number = excluded.default_account_number;
do $$ declare o record; begin
  for o in select id from core.organizations loop perform public.seed_account_roles(o.id); end loop;
end $$;
