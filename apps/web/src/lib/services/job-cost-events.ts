/**
 * JOB_COST emitter (Books -> Projects) — Event & Cost/Billing Contract (FROZEN v2) §3.
 *
 * Books is the sole cost processor. Whenever a cost is attributed to a job and
 * its lifecycle changes, Books writes a JOB_COST event to core.events. Projects
 * consumes it into its operational figure. We never write Projects tables here.
 *
 * Event shapes and field names are FROZEN — do not change them here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

type DB = SupabaseClient;

export type CostType = 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER';
export type Gate = 'PAYABLE_APPROVAL' | 'BANKFEED_CATEGORIZATION' | 'TIMESHEET_PAYROLL';
export type Lifecycle = 'PENDING' | 'CLEARED' | 'VOIDED';

export interface JobCostEventInput {
  orgId: string;
  locationId: string;
  jobId: string;
  departmentId?: string | null;
  costType: CostType;
  amountCents: number;
  occurredOn: string; // YYYY-MM-DD
  lifecycle: Lifecycle;
  gate: Gate;
  sourceRef: string;
  glEntryId?: string | null;
  memo?: string | null;
}

/**
 * Emit one JOB_COST lifecycle event (contract §3). Each lifecycle transition is
 * its own event with a fresh event_id; the consumer dedupes on event_id.
 * Returns the emitted event_id.
 */
export async function emitJobCostEvent(db: DB, input: JobCostEventInput): Promise<string> {
  // Emit-side idempotency guard (migration 025): if a PENDING JOB_COST event
  // with the same (org_id, source_ref, lifecycle) already sits on the queue, do
  // not emit a duplicate — return the existing event_id. This is defense-in-depth
  // on top of the consumer's event_id dedupe + source_ref cost identity, and
  // matters once automatic cost emission (AP / bank-feed / payroll) is wired.
  const findPending = async () => {
    const { data } = await db
      .schema('core').from('events')
      .select('event_id')
      .eq('org_id', input.orgId)
      .eq('event_type', 'JOB_COST')
      .eq('status', 'pending')
      .eq('payload->>source_ref', input.sourceRef)
      .eq('payload->>lifecycle', input.lifecycle)
      .limit(1)
      .maybeSingle();
    return (data as { event_id: string } | null)?.event_id ?? null;
  };

  const already = await findPending();
  if (already) return already;

  const eventId = randomUUID();
  const payload = {
    event_id: eventId,
    event_type: 'JOB_COST',
    source_module: 'BOOKS',
    org_id: input.orgId,
    location_id: input.locationId,
    job_id: input.jobId,
    department_id: input.departmentId ?? null,
    cost_type: input.costType,
    amount_cents: input.amountCents,
    occurred_on: input.occurredOn,
    lifecycle: input.lifecycle,
    gate: input.gate,
    source_ref: input.sourceRef,
    gl_entry_id: input.glEntryId ?? null,
    memo: input.memo ?? null,
  };

  const { error } = await db.schema('core').from('events').insert({
    org_id: input.orgId,
    event_id: eventId,
    event_type: 'JOB_COST',
    source_module: 'BOOKS',
    payload,
    occurred_on: input.occurredOn,
    status: 'pending', // awaiting consumption by Projects
  });
  if (error) {
    // A concurrent emit may have lost the race to the partial unique index;
    // treat that as a no-op and return the winning row's event_id.
    if (/duplicate key|unique constraint|uq_core_events_pending_jobcost_identity/i.test(error.message)) {
      const winner = await findPending();
      if (winner) return winner;
    }
    throw new Error(`emitJobCostEvent: ${error.message}`);
  }
  return eventId;
}

/**
 * Stamp the job dimension onto a posted GL line (contract §6) and write the
 * interim job_cost_entries bridge row. Call this when Books posts the cost.
 */
export async function stampGlLineJob(
  db: DB,
  args: { orgId: string; glEntryLineId: string; jobId: string; amountCents: number; occurredOn: string; description?: string | null }
): Promise<void> {
  const { error: upErr } = await db
    .from('gl_entry_lines')
    .update({ job_id: args.jobId })
    .eq('id', args.glEntryLineId);
  if (upErr) throw new Error(`stampGlLineJob (gl line): ${upErr.message}`);

  const { error: bridgeErr } = await db.from('job_cost_entries').insert({
    org_id: args.orgId,
    job_id: args.jobId,
    gl_entry_line_id: args.glEntryLineId,
    amount_cents: args.amountCents,
    description: args.description ?? null,
    entry_date: args.occurredOn,
  });
  if (bridgeErr) throw new Error(`stampGlLineJob (bridge): ${bridgeErr.message}`);
}
