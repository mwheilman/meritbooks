/**
 * The request timeline (core.request_events) and the claim-before-send guarantee.
 *
 * A send first INSERTS a `sent` row with delivery_status 'claimed' and a UNIQUE
 * dispatch_key `<request>:<step>:<channel>`. Only the inserter goes on to call the
 * provider; a rerun (or a parallel tick) hits the unique index and sends nothing. On
 * success the row becomes 'sent' with the provider id; on failure it becomes 'failed'
 * and its key is released so the next cycle can retry. A crash between claim and
 * provider leaves 'claimed' — treated as sent (at-most-once beats a duplicate email).
 *
 * Service role only; every write carries the request's org_id + location_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Channel, RequestEventType, RequestRow } from './types';

export interface EventInput {
  event_type: RequestEventType;
  step?: number | null;
  channel?: Channel | null;
  delivery_status?: 'claimed' | 'sent' | 'failed' | 'skipped' | null;
  dispatch_key?: string | null;
  provider?: string | null;
  provider_message_id?: string | null;
  detail?: string | null;
  meta?: Record<string, unknown>;
  actor?: string | null;
}

type ReqRef = Pick<RequestRow, 'id' | 'org_id' | 'location_id'>;

function isUniqueViolation(e: { message: string; code?: string } | null): boolean {
  return !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message));
}

/** Append an event. `duplicate` = its dispatch_key was already taken (a rerun). */
export async function recordEvent(
  db: SupabaseClient,
  req: ReqRef,
  e: EventInput,
  now: Date,
): Promise<{ id: string | null; duplicate: boolean }> {
  const { data, error } = await db
    .schema('core')
    .from('request_events')
    .insert({
      org_id: req.org_id,
      location_id: req.location_id,
      request_id: req.id,
      event_type: e.event_type,
      step: e.step ?? null,
      channel: e.channel ?? null,
      delivery_status: e.delivery_status ?? null,
      dispatch_key: e.dispatch_key ?? null,
      provider: e.provider ?? null,
      provider_message_id: e.provider_message_id ?? null,
      detail: e.detail ? e.detail.slice(0, 1000) : null,
      meta: e.meta ?? {},
      actor: e.actor ?? null,
      occurred_at: now.toISOString(),
    })
    .select('id')
    .single();
  if (error) {
    if (isUniqueViolation(error as { message: string; code?: string })) return { id: null, duplicate: true };
    throw new Error(`Could not record the request event: ${error.message}`);
  }
  return { id: (data as { id: string }).id, duplicate: false };
}

export function sendKey(requestId: string, step: number, channel: Channel): string {
  return `${requestId}:${step}:${channel}`;
}

/** Claim one (request, step, channel). null = already claimed/sent — do NOT send. */
export async function claimSend(db: SupabaseClient, req: ReqRef, step: number, channel: Channel, now: Date, actor: string): Promise<string | null> {
  const r = await recordEvent(
    db,
    req,
    { event_type: 'sent', step, channel, delivery_status: 'claimed', dispatch_key: sendKey(req.id, step, channel), actor },
    now,
  );
  return r.duplicate ? null : r.id;
}

export async function markSent(db: SupabaseClient, orgId: string, eventId: string, provider: string, providerMessageId: string | null, detail?: string): Promise<void> {
  const { error } = await db
    .schema('core')
    .from('request_events')
    .update({ delivery_status: 'sent', provider, provider_message_id: providerMessageId, detail: detail ?? null })
    .eq('id', eventId)
    .eq('org_id', orgId);
  if (error) throw new Error(`Could not mark the send: ${error.message}`);
}

/** Release a claim: the row stays on the timeline as failed/skipped, the key is freed for a retry. */
export async function releaseClaim(
  db: SupabaseClient,
  orgId: string,
  eventId: string,
  as: 'failed' | 'skipped',
  detail: string,
  provider?: string | null,
): Promise<void> {
  const { error } = await db
    .schema('core')
    .from('request_events')
    .update({ event_type: as, delivery_status: as, dispatch_key: null, detail: detail.slice(0, 1000), provider: provider ?? null })
    .eq('id', eventId)
    .eq('org_id', orgId);
  if (error) throw new Error(`Could not release the send claim: ${error.message}`);
}

/** A once-per-slot note (skip / defer) so a rerun doesn't spam the timeline. */
export async function recordOnce(db: SupabaseClient, req: ReqRef, key: string, e: EventInput, now: Date): Promise<boolean> {
  const r = await recordEvent(db, req, { ...e, dispatch_key: key }, now);
  return !r.duplicate;
}

export async function listEvents(db: SupabaseClient, orgId: string, requestId: string) {
  const { data, error } = await db
    .schema('core')
    .from('request_events')
    .select('id, request_id, event_type, step, channel, delivery_status, provider, provider_message_id, detail, actor, occurred_at')
    .eq('org_id', orgId)
    .eq('request_id', requestId)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(`Could not read the request timeline: ${error.message}`);
  return data ?? [];
}
