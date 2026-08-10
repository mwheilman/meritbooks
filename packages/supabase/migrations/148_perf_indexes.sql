-- =============================================================================
-- Migration 148: performance indexes on hot list WHERE+ORDER BY paths.
-- =============================================================================
-- Composite indexes serving the default sorts/filters of the highest-volume
-- transactional list endpoints (identified by the performance pass). Purely
-- additive; no data change. CONCURRENTLY is omitted so this runs inside the
-- migration transaction (tables are small today; safe to take a brief lock).
-- =============================================================================

create index if not exists ix_gl_entries_org_date_created
  on public.gl_entries (org_id, entry_date desc, created_at desc);
create index if not exists ix_gl_entries_org_status_date
  on public.gl_entries (org_id, status, entry_date desc);

create index if not exists ix_bank_txn_org_conf_date
  on public.bank_transactions (org_id, ai_confidence, transaction_date desc);

create index if not exists ix_invoices_org_date
  on public.invoices (org_id, invoice_date desc);
create index if not exists ix_invoices_org_status_date
  on public.invoices (org_id, status, invoice_date desc);
create index if not exists ix_invoices_org_customer_date
  on public.invoices (org_id, customer_id, invoice_date desc);

create index if not exists ix_documents_org_created
  on public.documents (org_id, created_at desc);
