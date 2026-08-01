-- Migration 073: recurring invoice templates (invoice-depth, FPB-invoices — recurring was MISSING)
-- A template that generates real invoices on a cadence (Books mints the number at generation).
-- RLS org_isolation; line money lives in template_data jsonb (bigint cents). Applied to Supabase
-- first (2026-08-01), then committed.
create table if not exists public.recurring_invoice_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid,
  customer_id uuid,
  name text not null,
  frequency text not null check (frequency in ('WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL')),
  interval_count int not null default 1,
  start_date date not null default current_date,
  next_run_date date,
  end_date date,
  occurrences_remaining int,
  is_active boolean not null default true,
  auto_send boolean not null default false,
  template_data jsonb not null default '{}'::jsonb,
  last_generated_at timestamptz,
  last_invoice_id uuid references public.invoices(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_recurring_invoice_templates_org on public.recurring_invoice_templates(org_id);
create index if not exists idx_recurring_invoice_templates_due on public.recurring_invoice_templates(org_id, next_run_date) where is_active;
alter table public.recurring_invoice_templates enable row level security;
create policy org_isolation on public.recurring_invoice_templates for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
