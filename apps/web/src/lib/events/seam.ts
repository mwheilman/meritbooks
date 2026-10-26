/**
 * Projects ⇄ Books seam mechanics shared by the Books consumers (migration 173).
 *
 *  - VERSION GATE. Every Projects → Books event carries `schema_version` (absent = 1,
 *    the FROZEN v3 shape). A consumer accepts only the versions it implements and
 *    REJECTS anything else with an error_code — it never silently ignores keys it does
 *    not understand (BOOKS-PROJECTS-INTERACTION.md §2 "Stop-gap").
 *  - UNKNOWN TYPES. A Projects event type Books has never heard of is rejected
 *    (UNSUPPORTED_EVENT_TYPE) so the sender's "Waiting on Merit Books" is accurate.
 *    Types Books has accepted but not built yet (JOB_COMMITMENT, JOB_TIME, …) stay
 *    pending — the agreed "waiting" state — until their consumer lands.
 *  - ACKS. Projects reads the ack IN PLACE on the event row (pm.reconcile_billing_internal):
 *    status, invoice_id, invoice_number, gl_entry_id, error, processed_at. Books also
 *    writes error_code and ack_meta (173). A rejection writes error = "<CODE>: <message>"
 *    so the code shows in Projects' error_text without a Projects change.
 *  - INDEPENDENCE. The seam consumers run only for orgs with entitlements.projects = true;
 *    Books never needs Projects to exist.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { finalizeClaimedEvent } from '@/lib/events/claim';
import { hasModule } from '@/lib/services/entitlements';

type DB = SupabaseClient;

/** Versions each Books consumer implements. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<string, readonly number[]>> = {
  JOB_BILLING: [1, 2],
  JOB_DEPOSIT_REQUEST: [1],
  // migration 194 (seam part 2)
  JOB_COMMITMENT: [1],
  JOB_TIME: [1],
  JOB_PROGRESS: [1, 2],
};

/** Projects → Books event types Books consumes today. */
export const CONSUMED_PROJECTS_EVENT_TYPES = [
  'JOB_BILLING', 'JOB_PROGRESS', 'JOB_DEPOSIT_REQUEST', 'DEPT_INVOICE_ISSUE', 'JOB_COMMITMENT', 'JOB_TIME',
] as const;

/**
 * Accepted by Books (BOOKS-PROJECTS-INTERACTION.md §2) but not built yet: they wait,
 * pending, instead of being rejected. JOB_COST is Books → Projects (Projects drains it).
 */
export const PLANNED_PROJECTS_EVENT_TYPES = ['JOB_MATERIAL', 'JOB_PAYABLE_REQUEST', 'JOB_COST'] as const;

export type SeamErrorCode =
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'UNSUPPORTED_BILLING_SUBTYPE'
  | 'UNSUPPORTED_LINE_TYPE'
  | 'MISSING_SOURCE_REF'
  | 'NO_BILLABLE_LINES'
  | 'INVALID_AMOUNT'
  | 'RETAINAGE_TIE'
  | 'GROSS_TIE'
  | 'COMPANY_NOT_FOUND'
  | 'NO_CUSTOMER'
  | 'NO_FISCAL_PERIOD'
  | 'PERIOD_CLOSED'
  | 'ACCOUNT_UNRESOLVED'
  | 'REV_REC_UNRESOLVED'
  | 'PARTIAL_INVOICE'
  | 'INVOICE_FAILED'
  | 'GL_POST_FAILED'
  | 'DEPOSIT_FAILED'
  | 'JOB_NOT_FOUND'
  | 'VENDOR_NOT_FOUND'
  | 'INVALID_PAYLOAD'
  | 'INVALID_HOURS'
  | 'COMMITMENT_FAILED'
  | 'LABOR_FAILED'
  | 'PROGRESS_FAILED'
  | 'CONSUMER_ERROR';

export class SeamRejection extends Error {
  constructor(readonly code: SeamErrorCode, message: string) {
    super(message);
    this.name = 'SeamRejection';
  }
}

/** The payload's schema_version (absent = 1). NaN when present but not an integer. */
export function schemaVersionOf(payload: unknown): number {
  const raw = (payload as { schema_version?: unknown } | null)?.schema_version;
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? n : Number.NaN;
}

/** Null when this consumer supports the event's version, else the rejection. */
export function versionRejection(eventType: string, payload: unknown): SeamRejection | null {
  const supported = SUPPORTED_SCHEMA_VERSIONS[eventType];
  if (!supported) {
    return new SeamRejection('UNSUPPORTED_EVENT_TYPE', `Merit Books does not process ${eventType} events`);
  }
  const v = schemaVersionOf(payload);
  if (!supported.includes(v)) {
    const raw = (payload as { schema_version?: unknown } | null)?.schema_version;
    return new SeamRejection(
      'UNSUPPORTED_SCHEMA_VERSION',
      `${eventType} schema_version ${String(raw)} is not supported by Merit Books (supported: ${supported.join(', ')})`,
    );
  }
  return null;
}

/** The `error` text Books writes for a rejection: "<CODE>: <message>". */
export function rejectionText(r: SeamRejection): string {
  return `${r.code}: ${r.message}`.slice(0, 1000);
}

/** Reject a claimed event (only while this drain still holds it). */
export async function rejectClaimedEvent(db: DB, eventRowId: string, token: string, r: SeamRejection): Promise<boolean> {
  return finalizeClaimedEvent(db, eventRowId, token, {
    status: 'rejected',
    error: rejectionText(r),
    error_code: r.code,
    processed_at: new Date().toISOString(),
  });
}

export interface SeamAck {
  invoice_id: string;
  invoice_number: string;
  gl_entry_id: string | null;
  meta?: Record<string, unknown> | null;
}

/** Ack a claimed event as processed with the columns Projects reads. */
export async function ackClaimedEvent(db: DB, eventRowId: string, token: string, ack: SeamAck): Promise<boolean> {
  return finalizeClaimedEvent(db, eventRowId, token, {
    status: 'processed',
    invoice_id: ack.invoice_id,
    invoice_number: ack.invoice_number,
    gl_entry_id: ack.gl_entry_id,
    error: null,
    error_code: null,
    ack_meta: ack.meta ?? null,
    processed_at: new Date().toISOString(),
  });
}

/**
 * Ack a claimed NON-INVOICE event (JOB_COMMITMENT, JOB_TIME, JOB_PROGRESS v2) as processed:
 * status + processed_at + ack_meta (the Books ids), error cleared. invoice_* stay null.
 */
export async function ackClaimedNonInvoiceEvent(
  db: DB,
  eventRowId: string,
  token: string,
  meta: Record<string, unknown>,
  glEntryId: string | null = null,
): Promise<boolean> {
  return finalizeClaimedEvent(db, eventRowId, token, {
    status: 'processed',
    gl_entry_id: glEntryId,
    error: null,
    error_code: null,
    ack_meta: meta,
    processed_at: new Date().toISOString(),
  });
}

/** Per-drain cache of "is Projects switched on for this org". */
export function projectsEntitlementCache(db: DB): (orgId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (orgId: string) => {
    let p = cache.get(orgId);
    if (!p) {
      p = hasModule(db, orgId, 'projects').catch(() => false);
      cache.set(orgId, p);
    }
    return p;
  };
}

/**
 * Reject pending Projects events of a type Books neither consumes nor plans to
 * (UNSUPPORTED_EVENT_TYPE). Unclaimed rows only; `orgId` null = every tenant (cron).
 * Returns the number rejected.
 */
export async function rejectUnknownProjectsEventTypes(db: DB, orgId: string | null): Promise<number> {
  const known = [...CONSUMED_PROJECTS_EVENT_TYPES, ...PLANNED_PROJECTS_EVENT_TYPES];
  let q = db
    .schema('core')
    .from('events')
    .select('id, event_type')
    .eq('status', 'pending')
    .in('source_module', ['PROJECTS', 'projects'])
    .not('event_type', 'in', `(${known.join(',')})`)
    .is('claimed_by', null)
    .limit(500);
  if (orgId) q = q.eq('org_id', orgId);
  const { data, error } = await q;
  if (error) throw new Error(`seam unknown-type sweep: ${error.message}`);
  let n = 0;
  for (const row of (data ?? []) as { id: string; event_type: string }[]) {
    const r = new SeamRejection('UNSUPPORTED_EVENT_TYPE', `Merit Books does not process ${row.event_type} events`);
    const { data: upd, error: updErr } = await db
      .schema('core')
      .from('events')
      .update({ status: 'rejected', error: rejectionText(r), error_code: r.code, processed_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .is('claimed_by', null)
      .select('id');
    if (updErr) throw new Error(`seam unknown-type reject: ${updErr.message}`);
    if (Array.isArray(upd) && upd.length > 0) n++;
  }
  return n;
}
