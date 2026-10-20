/**
 * The core.vendors columns a member's RLS client may read. `tin_encrypted` is NOT
 * here: migration 167 (05 R-6) revokes SELECT on it from anon / authenticated, so a
 * `select('*')` on core.vendors with the user client now fails — list columns
 * explicitly. TIN access goes through lib/vendors/tin-store.ts (server, org-pinned)
 * and is masked by lib/rbac/field-masks.ts before it reaches a client.
 */
export const VENDOR_READ_COLUMNS = [
  'id', 'org_id', 'name', 'display_name', 'default_account_id', 'default_department_id', 'default_class_id',
  'ai_confidence', 'auto_approve', 'transaction_count', 'ytd_spend_cents', 'is_1099_eligible', 'w9_status',
  'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'payment_terms_days',
  'is_active', 'created_at', 'updated_at', 'website', 'created_by', 'deleted_at', 'default_retainage_pct',
] as const;

export const VENDOR_READ_SELECT = VENDOR_READ_COLUMNS.join(', ');
