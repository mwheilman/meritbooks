/**
 * Server-side writer + scope pin for core.events emitters (migration 168).
 *
 * THE HOLE. core.events used to be member-writable over PostgREST (policy org_isolation
 * FOR ALL + INSERT/UPDATE/DELETE granted to authenticated), so any signed-in member could
 * forge e.g. a JOB_BILLING row that the next drain turned into an AR invoice + GL post.
 * Migration 168 makes it SELECT-only for members; only the service role writes it.
 *
 * THE RULE for every emitter:
 *   1. the CALLER (route / service) has already authorized the action that produces the
 *      event (requirePermission / the approval engine's own gates);
 *   2. the event is written with the service-role client returned here — never the
 *      caller's RLS client;
 *   3. org_id is the caller's session-resolved org, and every reference in the payload
 *      that names a tenant object (client / job) is re-checked against that org here,
 *      so a forged id from a request body can never land an event in another tenant.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';

/** The core.events writer. Optional override for tests / callers that already hold one. */
export function eventsWriter(override?: SupabaseClient): SupabaseClient {
  return override ?? createAdminSupabase();
}

export class EventScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventScopeError';
  }
}

/**
 * Fail closed unless the client (and job, when given) belong to `orgId`. Uses the
 * service-role writer so the check cannot be satisfied by an RLS-visible decoy.
 */
export async function assertEventScope(
  writer: SupabaseClient,
  orgId: string,
  refs: { locationId: string; jobId?: string | null },
): Promise<void> {
  if (!orgId) throw new EventScopeError('Event has no organization.');
  const { data: loc, error: locErr } = await writer
    .schema('core').from('locations')
    .select('id')
    .eq('id', refs.locationId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (locErr) throw new EventScopeError(`Could not verify the client: ${locErr.message}`);
  if (!loc) throw new EventScopeError('The client is not part of this organization.');

  if (refs.jobId) {
    const { data: job, error: jobErr } = await writer
      .schema('core').from('jobs')
      .select('id')
      .eq('id', refs.jobId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (jobErr) throw new EventScopeError(`Could not verify the job: ${jobErr.message}`);
    if (!job) throw new EventScopeError('The job is not part of this organization.');
  }
}
