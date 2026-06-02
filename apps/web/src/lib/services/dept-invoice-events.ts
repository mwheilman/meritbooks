/**
 * DEPT_INVOICE_ISSUE emitter (Projects -> Books) — Merit Suite arch spec §3.2.
 *
 * Projects side of the internal-invoice seam. In Projects, a department head
 * creates an internal invoice and the RECEIVER department head approves it
 * (approval lives in Projects). On approval, Projects emits a single core.events
 * row for Books to consume and issue.
 *
 * Boundary: this function writes ONLY the core.events row (and, in the real
 * Projects module, its own proj.* tables — none here). It never writes Books
 * ledger/core master tables. charge_method is intentionally NOT on the payload;
 * Books resolves it from its own per-company/per-department config.
 *
 * Entitlement: emit only when the org has the Projects module
 * (organizations.entitlements.projects). With Projects absent, no event flows and
 * the user uses the Books direct-create internal-invoice path instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

type DB = SupabaseClient;

export interface DeptInvoiceLine {
  description: string;
  amount_cents: number;
  item_id?: string | null;
}

export interface DeptInvoiceIssueInput {
  orgId: string;
  locationId: string;
  providerDepartmentId: string;
  receiverDepartmentId: string;
  occurredOn: string; // YYYY-MM-DD (invoice/issue date)
  sourceRef: string; // charge identity; dedupe key
  lines: DeptInvoiceLine[];
  memo?: string | null;
  projectsDocumentId: string; // the Projects-side document this issue came from
}

/** True when the org has the Projects module entitled. */
export async function orgHasProjects(db: DB, orgId: string): Promise<boolean> {
  const { data } = await db
    .schema('core').from('organizations')
    .select('entitlements')
    .eq('id', orgId)
    .maybeSingle();
  const ent = (data as { entitlements: Record<string, unknown> | null } | null)?.entitlements ?? null;
  return ent?.projects === true;
}

/**
 * Emit one DEPT_INVOICE_ISSUE event. Returns the event_id. Throws if Projects is
 * not entitled for the org (Projects would never have produced the invoice).
 * Idempotent-ish: if a pending event with the same source_ref already sits on the
 * queue, returns that event_id instead of emitting a duplicate.
 */
export async function emitDeptInvoiceIssue(db: DB, input: DeptInvoiceIssueInput): Promise<string> {
  if (!(await orgHasProjects(db, input.orgId))) {
    throw new Error('Projects module is not entitled for this org; use the Books direct-create internal-invoice path.');
  }

  const findPending = async () => {
    const { data } = await db
      .schema('core').from('events')
      .select('event_id')
      .eq('org_id', input.orgId)
      .eq('event_type', 'DEPT_INVOICE_ISSUE')
      .eq('status', 'pending')
      .eq('payload->>source_ref', input.sourceRef)
      .limit(1)
      .maybeSingle();
    return (data as { event_id: string } | null)?.event_id ?? null;
  };

  const already = await findPending();
  if (already) return already;

  const eventId = randomUUID();
  const payload = {
    event_id: eventId,
    event_type: 'DEPT_INVOICE_ISSUE',
    source_module: 'projects',
    org_id: input.orgId,
    location_id: input.locationId,
    provider_department_id: input.providerDepartmentId,
    receiver_department_id: input.receiverDepartmentId,
    source_ref: input.sourceRef,
    lines: input.lines.map((l) => ({
      description: l.description,
      amount_cents: Math.round(Number(l.amount_cents)),
      item_id: l.item_id ?? null,
    })),
    memo: input.memo ?? null,
    projects_document_id: input.projectsDocumentId,
  };

  const { error } = await db.schema('core').from('events').insert({
    org_id: input.orgId,
    event_id: eventId,
    event_type: 'DEPT_INVOICE_ISSUE',
    source_module: 'projects',
    payload,
    occurred_on: input.occurredOn,
    status: 'pending',
  });
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      const winner = await findPending();
      if (winner) return winner;
    }
    throw new Error(`emitDeptInvoiceIssue: ${error.message}`);
  }
  return eventId;
}
