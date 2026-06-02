-- Migration 026: source_ref on internal_invoices for DEPT_INVOICE_ISSUE dedupe
--
-- The Books consumer for the Projects→Books internal-invoice seam dedupes on
-- (org_id, event_id) [enforced by core.events] AND on source_ref (the charge
-- identity), so a re-delivered event carrying the same source_ref under a new
-- event_id does not book a second internal invoice. The direct-create path
-- (Projects-absent) leaves source_ref null and is unaffected.
--
-- Additive and non-destructive: one nullable column + one partial unique index.
-- NOT a core.events column (the seam spec forbids that).

alter table internal_invoices add column if not exists source_ref text;

create unique index if not exists uq_internal_invoices_source_ref
  on internal_invoices (org_id, source_ref)
  where source_ref is not null;
