-- =============================================================================
-- Migration 051: Stripe webhook idempotency log
-- =============================================================================
-- Records every Stripe event id we've processed so redelivered webhooks are
-- no-ops. The AR collection roles (SETTLEMENT_CLEARING, MERCHANT_FEE_EXPENSE,
-- AR_CONTROL, OPERATING_BANK) already exist from migration 043.
-- =============================================================================

create table if not exists public.stripe_events (
  id          text primary key,           -- Stripe event id (evt_...)
  type        text not null,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='stripe_events' and policyname='stripe_events_service') then
    create policy stripe_events_service on public.stripe_events
      for all to service_role using (true) with check (true);
  end if;
end $$;
