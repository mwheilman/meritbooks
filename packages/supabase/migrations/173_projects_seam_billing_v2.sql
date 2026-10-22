-- =============================================================================
-- Migration 173: Projects seam, Books side part 1 — version rejection, exactly-once
--                billing by business key, retainage (seam v2), deposit requests.
-- =============================================================================
--
-- Request : docs/projects/BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md (A1–A3, B: JOB_BILLING
--           schema_version 2, JOB_DEPOSIT_REQUEST).
-- Answer  : docs/projects/BOOKS-PROJECTS-INTERACTION.md (Books stands alone; the seam
--           consumers only run for orgs with entitlements.projects = true).
-- Code    : lib/services/billing-consumer.ts (thin adapter over lib/invoices/create-invoice.ts),
--           lib/services/deposit-request-consumer.ts, lib/events/seam.ts.
--
-- §1 core.events ack columns. Projects reads the ack IN PLACE on the event row
--    (pm.reconcile_billing_internal: status, invoice_id, invoice_number, gl_entry_id,
--    error, processed_at). Books adds:
--      error_code  machine-readable reason for a rejection (UNSUPPORTED_SCHEMA_VERSION,
--                  UNSUPPORTED_EVENT_TYPE, RETAINAGE_TIE, PERIOD_CLOSED, …). The human
--                  message stays in `error` as "<CODE>: <message>", so Projects' existing
--                  error_text shows the code without any Projects change.
--      ack_meta    extra ids Books hands back (deposit_id, applied deposits, …).
-- §2 invoices.source_ref — the emitter's business key (Projects payload.source_ref,
--    'pm:bill:{id}' / 'pm:deposit:{id}'). UNIQUE per org (partial, not null), so a
--    re-emitted billing (new event id, same source_ref) can never mint a second invoice.
--    source_event_id (170) stays. Backfilled from the event for invoices already issued
--    by the consumer (only where the key is unambiguous). invoices.billing_subtype records
--    the seam subtype (SOV, RETAINAGE_RELEASE, ALLOWANCE, FIXED, RECURRING, DEPOSIT).
-- §3 customer_deposits.source_ref (unique per org, partial) + deposit_invoice_id: a
--    JOB_DEPOSIT_REQUEST becomes ONE deposit invoice (DR AR / CR CUSTOMER_DEPOSITS) and
--    ONE subledger row in Books' existing customer-deposits feature.
-- §4 Books advertises seam v2: entitlements.books_seam_version = 2 for every org entitled
--    to Projects (Projects blocks retainage-release emission below 2), and a trigger keeps
--    it so when Projects is switched on later. Books never lowers a higher value.
--
-- GL idempotency: seam GL entries carry source_ref 'job_billing:<payload.source_ref>' /
-- 'job_deposit:<payload.source_ref>'; 064's uq_gl_entries_org_source_type makes the DB
-- the double-post guarantor ON THE BUSINESS KEY (not just the event row).
--
-- SAFETY: additive + idempotent; no GL effect; no subqueries in CHECKs (PGlite);
-- invoices / customer_deposits grants and policies are untouched (171/172 own them).
-- =============================================================================

-- ── §1 core.events ack columns ───────────────────────────────────────────────
alter table core.events add column if not exists error_code text;
alter table core.events add column if not exists ack_meta jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'events_error_code_format') then
    alter table core.events add constraint events_error_code_format
      check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,63}$');
  end if;
end $$;

comment on column core.events.error_code is
  'Machine-readable rejection reason written by the consumer (mig 173). The human message is in error as "<CODE>: <message>".';
comment on column core.events.ack_meta is
  'Extra ids the consumer acknowledges with (e.g. deposit_id, applied_deposits) beyond invoice_id / invoice_number / gl_entry_id (mig 173).';

-- ── §2 invoices: business key + seam subtype ─────────────────────────────────
alter table public.invoices add column if not exists source_ref text;
alter table public.invoices add column if not exists billing_subtype text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_billing_subtype_check') then
    alter table public.invoices add constraint invoices_billing_subtype_check
      check (billing_subtype is null or billing_subtype in
        ('PROGRESS','SOV','RETAINAGE_RELEASE','ALLOWANCE','FIXED','RECURRING','MILESTONE','TIME_MATERIALS','DRAW','DEPOSIT'));
  end if;
end $$;

-- Backfill invoices the consumer already issued (source_event_id set, no source_ref):
-- take the event's payload.source_ref, but only where exactly one invoice would carry it
-- (an ambiguous historical key is left null rather than failing the unique index).
do $$ begin
  with cand as (
    select i.id, e.payload ->> 'source_ref' as ref, i.org_id
      from public.invoices i
      join core.events e on e.id = i.source_event_id and e.org_id = i.org_id
     where i.source_ref is null
       and coalesce(e.payload ->> 'source_ref', '') <> ''
  ), uniq as (
    select c.id, c.ref from cand c
     where (select count(*) from cand c2 where c2.org_id = c.org_id and c2.ref = c.ref) = 1
       and not exists (select 1 from public.invoices x where x.org_id = c.org_id and x.source_ref = c.ref)
  )
  update public.invoices i set source_ref = u.ref from uniq u where i.id = u.id;
end $$;

create unique index if not exists uq_invoices_org_source_ref
  on public.invoices (org_id, source_ref)
  where source_ref is not null;

comment on column public.invoices.source_ref is
  'Emitter business key (Projects payload.source_ref). Unique per org: one invoice per billing request however often it is re-emitted (mig 173).';
comment on column public.invoices.billing_subtype is
  'Seam billing subtype (SOV, RETAINAGE_RELEASE, ALLOWANCE, FIXED, RECURRING, …; DEPOSIT for a deposit invoice). Null = manual (mig 173).';

-- ── §3 customer_deposits: business key + the deposit invoice ─────────────────
alter table public.customer_deposits add column if not exists source_ref text;
alter table public.customer_deposits add column if not exists deposit_invoice_id uuid;

create unique index if not exists uq_customer_deposits_org_source_ref
  on public.customer_deposits (org_id, source_ref)
  where source_ref is not null;
create index if not exists ix_customer_deposits_org_job
  on public.customer_deposits (org_id, job_id)
  where job_id is not null;

comment on column public.customer_deposits.source_ref is
  'Emitter business key (Projects JOB_DEPOSIT_REQUEST source_ref pm:deposit:{id}). Unique per org (mig 173).';
comment on column public.customer_deposits.deposit_invoice_id is
  'The deposit invoice that billed this deposit (DR AR / CR Customer Deposits) when it came from a deposit request (mig 173).';

-- ── §4 Books advertises seam v2 to Projects ──────────────────────────────────
-- Trigger: switching Projects on keeps books_seam_version >= 2 (never lowers it).
create or replace function core.m173_books_seam_version() returns trigger
language plpgsql
set search_path = core, public
as $$
begin
  if coalesce(new.entitlements ->> 'projects', '') = 'true'
     and coalesce(case when (new.entitlements ->> 'books_seam_version') ~ '^\d{1,3}$'
                       then (new.entitlements ->> 'books_seam_version')::int end, 0) < 2 then
    new.entitlements := coalesce(new.entitlements, '{}'::jsonb) || jsonb_build_object('books_seam_version', 2);
  end if;
  return new;
end
$$;

revoke all on function core.m173_books_seam_version() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_m173_books_seam_version'
                   and tgrelid = 'core.organizations'::regclass) then
    create trigger trg_m173_books_seam_version
      before insert or update of entitlements on core.organizations
      for each row execute function core.m173_books_seam_version();
  end if;
end $$;

-- Data step: every org entitled to Projects today.
update core.organizations
   set entitlements = coalesce(entitlements, '{}'::jsonb) || jsonb_build_object('books_seam_version', 2)
 where coalesce(entitlements ->> 'projects', '') = 'true'
   and coalesce(case when (entitlements ->> 'books_seam_version') ~ '^\d{1,3}$'
                     then (entitlements ->> 'books_seam_version')::int end, 0) < 2;

-- End migration 173.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
