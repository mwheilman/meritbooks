/**
 * The vendor-compliance audit trail (public.vendor_compliance_events — append-only,
 * SELECT-only for members since 172; widened vocabulary in 180, FPB §10).
 *
 * Every compliance action writes one row with its actor: a Clerk user id, `system:*` for
 * engine actions, or `vendor_token:<token id>` for portal actions. Audit logging must
 * never break the action it accompanies, so failures are logged and swallowed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { writerFor } from '@/lib/db/scoped-writer';

export const VENDOR_COMPLIANCE_EVENT_TYPES = [
  'PAYMENT_BLOCKED', 'OVERRIDE_GRANTED', 'OVERRIDE_CONSUMED', 'OVERRIDE_RELEASED', 'DOC_EXPIRED', 'CHASE_SCHEDULED',
  'REQUEST_CREATED', 'UPLOAD_RECEIVED', 'W9_FORM_SUBMITTED', 'AI_CHECKED', 'AI_UNAVAILABLE', 'REQUIREMENT_FAILED',
  'DOC_ACCEPTED', 'DOC_REJECTED', 'HOLD_APPLIED', 'HOLD_LIFTED', 'BILL_HOLD_RELEASED',
  'BANK_CHANGE_OPENED', 'BANK_CHANGE_VERIFIED', 'BANK_CHANGE_REJECTED',
  'PROFILE_CHANGED',
] as const;
export type VendorComplianceEventType = (typeof VENDOR_COMPLIANCE_EVENT_TYPES)[number];

export interface AuditExtra {
  billId?: string | null;
  overrideId?: string | null;
  docId?: string | null;
  submissionId?: string | null;
  actor?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append one event. `db` is the caller's client: a member client escalates to the service
 * role (writerFor — the caller already ran its permission check); a service-role client
 * writes as itself.
 */
export async function logVendorComplianceEvent(
  db: SupabaseClient,
  orgId: string,
  vendorId: string,
  eventType: VendorComplianceEventType,
  detail: string,
  extra: AuditExtra = {},
): Promise<void> {
  try {
    const row: Record<string, unknown> = {
      org_id: orgId,
      vendor_id: vendorId,
      event_type: eventType,
      detail: detail.slice(0, 2000),
      bill_id: extra.billId ?? null,
      override_id: extra.overrideId ?? null,
      doc_id: extra.docId ?? null,
      created_by_user: extra.actor ?? null,
    };
    // 180 columns: only sent when used, so an un-migrated database still records the core event.
    if (extra.submissionId) row.submission_id = extra.submissionId;
    if (extra.meta && Object.keys(extra.meta).length) row.meta = extra.meta;
    const { error } = await writerFor(db).from('vendor_compliance_events').insert(row);
    if (error) console.warn('[vendor-compliance] audit log failed:', error.message);
  } catch (e) {
    console.warn('[vendor-compliance] audit log failed:', e);
  }
}
