/**
 * The bookkeeper's receipt chase board (FPB-workforce-app §15.2): outstanding charges by
 * cardholder with age, amount, asks sent, last opened, escalation — and the actions
 * Remind now · Not required (reason) · Reopen · Reassign.
 *
 * READS take the caller's RLS-scoped client (members SELECT the 181 tables and
 * core.requests / request_events for their org, client scope applies). WRITES take the
 * service role after the route's permission check and an RLS read of the charge state
 * (lib/db/scoped-writer.ts rule 4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { cancelRequest, RequestError, sendNow } from '@/lib/requests/service';
import type { EngineDeps } from '@/lib/requests/dispatch';
import { PAUSE_PREFIX, syncReceiptChase } from './chase';
import { OUTSTANDING_STATES, SYSTEM_ACTOR, type ChargeState } from './types';

const LIVE = ['open', 'sent', 'snoozed'];
const DAY = 86_400_000;

export interface OutstandingCharge {
  transactionId: string;
  merchant: string;
  chargeDate: string;
  amountCents: number;
  ageDays: number;
  status: ChargeState;
  asks: number;
  requestId: string | null;
  requestStatus: string | null;
  lastAskedAt: string | null;
  nextAskAt: string | null;
  lastOpenedAt: string | null;
  escalated: boolean;
  reason: string | null;
  locationId: string;
}

export interface OutstandingGroup {
  assignmentId: string | null;
  holderName: string;
  holderEmail: string | null;
  cardLabel: string | null;
  count: number;
  totalCents: number;
  oldestDays: number;
  charges: OutstandingCharge[];
}

export interface OutstandingStrip {
  outstanding: number;
  totalCents: number;
  over30: number;
  escalated: number;
  noCardholder: number;
  matchedThisWeek: number;
}

interface StateRow {
  bank_transaction_id: string;
  card_assignment_id: string | null;
  merchant: string | null;
  charge_date: string;
  amount_cents: number;
  status: ChargeState;
  request_id: string | null;
  chase_count: number;
  reason: string | null;
  location_id: string;
  updated_at: string;
}

/** Group + sort (pure): people with the oldest / largest owed first; "No cardholder" last. */
export function groupOutstanding(
  rows: ReadonlyArray<OutstandingCharge & { assignmentId: string | null }>,
  holders: ReadonlyMap<string, { name: string; email: string | null; card: string | null }>,
): OutstandingGroup[] {
  const groups = new Map<string, OutstandingGroup>();
  for (const r of rows) {
    const key = r.assignmentId ?? 'none';
    let g = groups.get(key);
    if (!g) {
      const h = r.assignmentId ? holders.get(r.assignmentId) : null;
      g = {
        assignmentId: r.assignmentId,
        holderName: h?.name ?? (r.assignmentId ? 'Cardholder' : 'No cardholder'),
        holderEmail: h?.email ?? null,
        cardLabel: h?.card ?? null,
        count: 0,
        totalCents: 0,
        oldestDays: 0,
        charges: [],
      };
      groups.set(key, g);
    }
    g.count++;
    g.totalCents += r.amountCents;
    g.oldestDays = Math.max(g.oldestDays, r.ageDays);
    const { assignmentId: _drop, ...charge } = r;
    void _drop;
    g.charges.push(charge);
  }
  const out = Array.from(groups.values());
  for (const g of out) g.charges.sort((a, b) => b.ageDays - a.ageDays || b.amountCents - a.amountCents);
  return out.sort((a, b) => {
    if (!a.assignmentId !== !b.assignmentId) return a.assignmentId ? -1 : 1;
    return b.oldestDays - a.oldestDays || b.totalCents - a.totalCents;
  });
}

export async function listOutstanding(
  db: SupabaseClient,
  orgId: string,
  opts: { locationId?: string | null; now: Date; q?: string | null },
): Promise<{ groups: OutstandingGroup[]; strip: OutstandingStrip }> {
  let q = db
    .from('receipt_charge_states')
    .select('bank_transaction_id, card_assignment_id, merchant, charge_date, amount_cents, status, request_id, chase_count, reason, location_id, updated_at')
    .eq('org_id', orgId)
    .in('status', [...OUTSTANDING_STATES])
    .order('charge_date', { ascending: true })
    .limit(1000);
  if (opts.locationId) q = q.eq('location_id', opts.locationId);
  if (opts.q?.trim()) q = q.ilike('merchant', `%${opts.q.trim().replace(/[%_]/g, '')}%`);
  const { data, error } = await q;
  if (error) throw new Error(`Could not read outstanding receipts: ${error.message}`);
  const states = (data ?? []) as StateRow[];

  const reqIds = states.map((s) => s.request_id).filter((x): x is string => !!x);
  const reqs = new Map<string, { status: string; last_sent_at: string | null; next_send_at: string | null; escalated_at: string | null; sends_count: number }>();
  const opened = new Map<string, string>();
  for (let i = 0; i < reqIds.length; i += 200) {
    const chunk = reqIds.slice(i, i + 200);
    const [{ data: rq }, { data: ev }] = await Promise.all([
      db.schema('core').from('requests').select('id, status, last_sent_at, next_send_at, escalated_at, sends_count').eq('org_id', orgId).in('id', chunk),
      db.schema('core').from('request_events').select('request_id, event_type, occurred_at').eq('org_id', orgId).in('request_id', chunk).in('event_type', ['opened', 'clicked']),
    ]);
    for (const r of (rq ?? []) as Array<{ id: string; status: string; last_sent_at: string | null; next_send_at: string | null; escalated_at: string | null; sends_count: number }>) reqs.set(r.id, r);
    for (const e of (ev ?? []) as Array<{ request_id: string; occurred_at: string }>) {
      const prev = opened.get(e.request_id);
      if (!prev || e.occurred_at > prev) opened.set(e.request_id, e.occurred_at);
    }
  }

  const holderIds = Array.from(new Set(states.map((s) => s.card_assignment_id).filter((x): x is string => !!x)));
  const holders = new Map<string, { name: string; email: string | null; card: string | null }>();
  if (holderIds.length) {
    const { data: hs } = await db.from('card_assignments').select('id, holder_name, holder_email, card_last4, card_label').eq('org_id', orgId).in('id', holderIds);
    for (const h of (hs ?? []) as Array<{ id: string; holder_name: string; holder_email: string | null; card_last4: string | null; card_label: string | null }>) {
      holders.set(h.id, { name: h.holder_name, email: h.holder_email, card: h.card_last4 ? `••${h.card_last4}` : h.card_label });
    }
  }

  const nowMs = opts.now.getTime();
  const rows = states.map((s) => {
    const r = s.request_id ? reqs.get(s.request_id) : undefined;
    return {
      assignmentId: s.card_assignment_id,
      transactionId: s.bank_transaction_id,
      merchant: s.merchant ?? 'Card charge',
      chargeDate: s.charge_date,
      amountCents: Number(s.amount_cents),
      ageDays: Math.max(0, Math.floor((nowMs - Date.parse(`${s.charge_date}T00:00:00Z`)) / DAY)),
      status: s.status,
      asks: r?.sends_count ?? s.chase_count,
      requestId: s.request_id,
      requestStatus: r?.status ?? null,
      lastAskedAt: r?.last_sent_at ?? null,
      nextAskAt: r && LIVE.includes(r.status) ? r.next_send_at : null,
      lastOpenedAt: s.request_id ? opened.get(s.request_id) ?? null : null,
      escalated: !!r?.escalated_at,
      reason: s.reason,
      locationId: s.location_id,
    };
  });

  const weekAgo = new Date(nowMs - 7 * DAY).toISOString();
  let mq = db.from('receipt_charge_states').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'matched').gte('updated_at', weekAgo);
  if (opts.locationId) mq = mq.eq('location_id', opts.locationId);
  const { count: matchedThisWeek } = await mq;

  const strip: OutstandingStrip = {
    outstanding: rows.length,
    totalCents: rows.reduce((n, r) => n + r.amountCents, 0),
    over30: rows.filter((r) => r.ageDays > 30).length,
    escalated: rows.filter((r) => r.escalated).length,
    noCardholder: rows.filter((r) => r.status === 'no_cardholder').length,
    matchedThisWeek: matchedThisWeek ?? 0,
  };
  return { groups: groupOutstanding(rows, holders), strip };
}

// ── actions (service role; the route authorized and read the state through RLS) ─────────

export class ChaseActionError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'ChaseActionError';
  }
}

interface StateRef {
  id: string;
  status: ChargeState;
  request_id: string | null;
  location_id: string;
  card_assignment_id: string | null;
}

async function stateOf(db: SupabaseClient, orgId: string, txnId: string): Promise<StateRef> {
  const { data } = await db.from('receipt_charge_states').select('id, status, request_id, location_id, card_assignment_id').eq('org_id', orgId).eq('bank_transaction_id', txnId).maybeSingle();
  if (!data) throw new ChaseActionError('That charge is not in the receipt chase.', 404);
  return data as StateRef;
}

async function liveRequest(db: SupabaseClient, orgId: string, id: string | null): Promise<{ id: string; status: string } | null> {
  if (!id) return null;
  const { data } = await db.schema('core').from('requests').select('id, status').eq('org_id', orgId).eq('id', id).maybeSingle();
  const r = data as { id: string; status: string } | null;
  return r && LIVE.includes(r.status) ? r : null;
}

/** Remind now: the next ask goes immediately (quiet hours honoured — the result says when). */
export async function remindNow(deps: EngineDeps, orgId: string, txnId: string, actor: string): Promise<string> {
  const s = await stateOf(deps.db, orgId, txnId);
  const live = await liveRequest(deps.db, orgId, s.request_id);
  if (!live) {
    if (s.status === 'chase_off') throw new ChaseActionError('Receipt chase is off for this company. Turn it on to send reminders.', 409);
    if (s.status === 'no_cardholder') throw new ChaseActionError('Assign a cardholder first.', 409);
    if (s.status === 'opted_out') throw new ChaseActionError('This cardholder is opted out of receipt chase.', 409);
    // A needed charge still in its grace days (or whose request ended): open one now.
    await syncReceiptChase({ db: deps.db, now: deps.now }, orgId, { onlyTxnIds: [txnId] });
    const again = await stateOf(deps.db, orgId, txnId);
    const fresh = await liveRequest(deps.db, orgId, again.request_id);
    if (!fresh) throw new ChaseActionError('This charge is no longer being chased (the request ended or was cancelled). Mark it not required or ask in person.', 409);
    return 'Asked — the first reminder goes out on the receipt chase schedule.';
  }
  try {
    const res = await sendNow(deps, orgId, live.id, actor);
    if (res.outcome === 'deferred') return `Quiet hours for the cardholder — it will go at ${res.nextSendAt ?? 'the end of them'}.`;
    if (res.outcome === 'sent') return 'Reminder sent.';
    if (res.outcome === 'fulfilled') return 'A receipt is already in — nothing sent.';
    if (res.outcome === 'undeliverable') return 'Could not reach the cardholder (no email, unsubscribed or bounced). Check their contact details.';
    return 'Reminder queued.';
  } catch (e) {
    if (e instanceof RequestError) throw new ChaseActionError(e.message, e.status);
    throw e;
  }
}

export async function markNotRequired(db: SupabaseClient, orgId: string, txnId: string, actor: string, reason: string, now: Date): Promise<void> {
  const why = reason.trim();
  if (why.length < 3) throw new ChaseActionError('Say why no receipt is needed (it goes on the record).');
  const s = await stateOf(db, orgId, txnId);
  if (s.status === 'matched') throw new ChaseActionError('This charge already has a receipt.', 409);
  const live = await liveRequest(db, orgId, s.request_id);
  if (live) {
    try {
      await cancelRequest({ db, now: () => now }, orgId, live.id, actor, `${PAUSE_PREFIX} marked not required — ${why}`.slice(0, 500));
    } catch (e) {
      if (!(e instanceof RequestError && e.status === 409)) throw e;
    }
  }
  const iso = now.toISOString();
  const { error } = await db
    .from('receipt_charge_states')
    .update({ status: 'not_required', reason: why.slice(0, 500), decided_by: actor, decided_at: iso, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', s.id);
  if (error) throw new ChaseActionError(`Could not save: ${error.message}`, 500);
}

/** Undo "not required": the charge needs a receipt again and the cardholder is asked again. */
export async function reopenCharge(db: SupabaseClient, orgId: string, txnId: string, actor: string, now: Date): Promise<void> {
  const s = await stateOf(db, orgId, txnId);
  if (s.status !== 'not_required') throw new ChaseActionError('Only a charge marked not required can be reopened.', 409);
  const iso = now.toISOString();
  await db.from('receipt_charge_states').update({ status: 'needed', reason: null, decided_by: actor, decided_at: iso, updated_at: iso }).eq('org_id', orgId).eq('id', s.id);
  await syncReceiptChase({ db, now: () => now }, orgId, { onlyTxnIds: [txnId] });
}

/**
 * Reassign a charge to another cardholder of the same company (or assign one where there
 * was none). The old ask is paused, and the new cardholder is asked right away.
 */
export async function reassignCharge(db: SupabaseClient, orgId: string, txnId: string, assignmentId: string, actor: string, now: Date): Promise<void> {
  const s = await stateOf(db, orgId, txnId);
  if (s.status === 'matched') throw new ChaseActionError('This charge already has a receipt.', 409);
  const { data: a } = await db.from('card_assignments').select('id, location_id, active').eq('org_id', orgId).eq('id', assignmentId).maybeSingle();
  const asg = a as { id: string; location_id: string; active: boolean } | null;
  if (!asg) throw new ChaseActionError('That cardholder was not found.', 404);
  if (!asg.active) throw new ChaseActionError('That cardholder’s assignment has ended.', 409);
  if (asg.location_id !== s.location_id) throw new ChaseActionError('That cardholder belongs to another company.', 409);
  if (asg.id === s.card_assignment_id) return;
  const live = await liveRequest(db, orgId, s.request_id);
  if (live) {
    try {
      await cancelRequest({ db, now: () => now }, orgId, live.id, actor, 'Receipt chase paused: reassigned to another cardholder.');
    } catch (e) {
      if (!(e instanceof RequestError && e.status === 409)) throw e;
    }
  }
  const iso = now.toISOString();
  await db
    .from('receipt_charge_states')
    .update({ card_assignment_id: asg.id, holder_override: true, status: 'needed', decided_by: actor, decided_at: iso, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', s.id);
  await syncReceiptChase({ db, now: () => now }, orgId, { onlyTxnIds: [txnId] });
}

export { SYSTEM_ACTOR };
