-- Migration 135: per-tenant inbound AP email address (email-to-bill mapping).
-- =============================================================
-- The "monitored mailbox" AP path forwards vendor invoices to a per-tenant
-- address; the inbound-email webhook resolves the RECIPIENT of the forwarded
-- message to an org via this column. Nullable (a tenant that hasn't been given an
-- address simply cannot receive email-to-bill); UNIQUE so an address maps to at
-- most one tenant. Backfilled deterministically from the org slug so every
-- existing tenant is immediately reachable at ap-<slug>@inbound.meritbooks.app.
--
-- The inbound SOURCE marker ('email' vs 'upload') and the sender/subject live in
-- ai_decisions.proposed_output (feature AP_DOC_INTAKE) — no schema column needed
-- for those; this migration only adds the tenant-resolution key.
--
-- Additive + idempotent. Requires 019 (core carve).
-- Next migration number: 136.
-- =============================================================

alter table core.organizations
  add column if not exists inbound_ap_address text;

-- Backfill any org that doesn't have one yet from its (unique) slug.
update core.organizations
  set inbound_ap_address = 'ap-' || slug || '@inbound.meritbooks.app'
  where inbound_ap_address is null;

comment on column core.organizations.inbound_ap_address is
  'Per-tenant inbound AP email address. The inbound-email webhook maps a forwarded '
  'invoice''s recipient to this org. Backfilled from slug; may be customized per tenant.';

-- Enforce uniqueness (case-insensitive) so one address resolves to one tenant.
create unique index if not exists uq_organizations_inbound_ap_address
  on core.organizations (lower(inbound_ap_address))
  where inbound_ap_address is not null;
