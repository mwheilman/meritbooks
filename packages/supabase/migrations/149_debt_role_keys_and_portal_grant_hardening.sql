-- =============================================================================
-- Migration 149: debt/interest role-key vocabulary + portal-token grant hardening.
-- =============================================================================
-- (a) Register NOTES_PAYABLE (term-debt liability) and INTEREST_EXPENSE role keys so
--     the new debt-origination + payment posting resolves its accounts by ROLE (the
--     resolver's step-2 default-number fallback needs these rows). Numbers verified
--     against the seeded COA: 2500 Term Loan (company-specific → LOCATION scope),
--     8000 Interest Expense (ORG scope, already exists). Idempotent upsert.
-- (b) Security hardening (audit LOW-1): the portal-token tables were granted
--     insert/update/delete/select to `anon`; the portals only ever touch them via the
--     service-role admin client, so anon needs no access. Revoke it.
--
-- SAFETY / CANON §3: additive vocabulary + a grant tightening; no data change, no GL
-- effect. seed_account_roles is NOT force-re-run here (avoids any chance of touching a
-- tenant override) — resolveRole resolves NOTES_PAYABLE/INTEREST_EXPENSE via the
-- default account number below (and per-tenant maps fill in on the next natural seed).
-- =============================================================================

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('NOTES_PAYABLE',    'Notes payable / term debt liability', 'LOCATION', '2500'),
  ('INTEREST_EXPENSE', 'Interest expense',                    'ORG',      '8000')
on conflict (role_key) do update
  set label = excluded.label,
      scope = excluded.scope,
      default_account_number = excluded.default_account_number;

revoke insert, update, delete, select on public.customer_portal_tokens from anon;
revoke insert, update, delete, select on public.vendor_portal_tokens   from anon;
