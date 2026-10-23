/**
 * The receipt chase (FPB-workforce-app §4.9, §15.2) on top of the Wave 1D request engine.
 *
 * `syncReceiptChase(deps, orgId)` — run by `receipts.chase_sync` every 15 minutes:
 *   1. reads the tenant's card charges inside the chase window, the card assignments,
 *      the receipt policy and the tenant / client switches;
 *   2. decides each charge's state (charges.ts) and upserts receipt_charge_states;
 *   3. opens ONE `receipt` request per needed charge once the grace days pass
 *      (dedupe `receipt:<txn>`), to the cardholder: email + in-app (members) + the
 *      Settings → Receipt chase channel; first ask = Settings' first-reminder minutes, then
 *      the policy's reminder days; escalates after the last reminder to the cardholder's
 *      manager (or the bookkeeper); the bookkeeper owns it;
 *   4. cancels live requests whose charge no longer needs chasing (chase switched off,
 *      cardholder opted out or reassigned, receipt arrived elsewhere, marked not required);
 *   5. copies each request's send count to the state (the "chase count" on the desk).
 *
 * The request engine (`requests.remind`) does the sending, quiet hours and escalation.
 * Requests this module pauses carry the cancel reason prefix PAUSE_PREFIX; only those are
 * re-opened when chase resumes — a request a person cancelled stays cancelled.
 *
 * TENANCY: service role with EVERY read and write pinned to orgId (like the engine).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { formatMoney } from '@meritbooks/shared';
import { loadPolicyContext, receiptChannels, type PolicyContext } from '@/lib/requests/policy';
import { cancelRequest, createRequest, fulfilRequest, RequestError, type RecipientInput } from '@/lib/requests/service';
import type { Channel, RequestRow } from '@/lib/requests/types';
import { isCardCharge, decideChargeState, merchantLabel, resolveCardholder, shouldOpenRequest } from './charges';
import { chaseEnabledFor, loadReceiptPolicyContext, memoRequired, mergeReceiptPolicy, type ReceiptPolicy, type ReceiptPolicyContext } from './policy';
import { SYSTEM_ACTOR, type CardAccount, type CardAssignmentRow, type ChargeState, type ChargeStateRow, type ChargeTxn } from './types';

export const PAUSE_PREFIX = 'Receipt chase paused:';
const LIVE = ['open', 'sent', 'snoozed'];
const DAY_MIN = 1440;

export interface ChaseDeps {
  db: SupabaseClient;
  now: () => Date;
}

export interface ChaseSyncSummary {
  charges: number;
  created: number;
  cancelled: number;
  matched: number;
  needed: number;
  noCardholder: number;
  chaseOff: number;
  errors: string[];
}

export const ASSIGNMENT_COLUMNS =
  'id, org_id, location_id, bank_account_id, card_last4, card_label, holder_type, membership_id, employee_id, holder_name, holder_email, holder_phone, holder_timezone, manager_membership_id, active, starts_on, ends_on, chase_opt_out, opt_out_status, opt_out_reason, opt_out_requested_by, opt_out_requested_at, opt_out_decided_by, opt_out_decided_at, created_at, updated_at';

// ── request shaping (pure) ────────────────────────────────────────────────────

/** Minutes after creation for each ask: first = Settings' first reminder, then the policy days. */
export function receiptOffsets(reminderDays: ReadonlyArray<number>, firstReminderMinutes: number): number[] {
  const days = Array.from(new Set(reminderDays.map((d) => Math.max(0, Math.trunc(d))))).sort((a, b) => a - b);
  const out = days.map((d) => (d === 0 ? Math.max(0, firstReminderMinutes) : d * DAY_MIN));
  return Array.from(new Set(out)).sort((a, b) => a - b).slice(0, 12);
}

/** Channels for a receipt ask: email always (until SMS/push are live), in-app for members, + Settings. */
export function receiptRequestChannels(holder: Pick<CardAssignmentRow, 'membership_id' | 'holder_email'>, chaseChannel: string | null): Channel[] {
  const fromSettings = receiptChannels(chaseChannel).filter((c) => c !== 'in_app');
  const out: Channel[] = [];
  if (holder.holder_email) out.push('email');
  if (holder.membership_id) out.push('in_app');
  for (const c of fromSettings) if (!out.includes(c)) out.push(c);
  return out.length ? out : ['email'];
}

export function escalationTarget(holder: Pick<CardAssignmentRow, 'manager_membership_id'>, policy: Pick<ReceiptPolicy, 'escalateTo' | 'bookkeeperMembershipId'>): string | null {
  if (policy.escalateTo === 'none') return null;
  if (policy.escalateTo === 'manager') return holder.manager_membership_id ?? policy.bookkeeperMembershipId;
  return policy.bookkeeperMembershipId ?? holder.manager_membership_id;
}

export function recipientFor(holder: CardAssignmentRow): RecipientInput {
  const base = { name: holder.holder_name, email: holder.holder_email, phone: holder.holder_phone, timezone: holder.holder_timezone };
  if (holder.holder_type === 'member' && holder.membership_id) return { type: 'member', membershipId: holder.membership_id, ...base };
  if (holder.holder_type === 'employee' && holder.employee_id) return { type: 'employee', employeeId: holder.employee_id, ...base };
  return { type: 'email', ...base };
}

export function requestTitle(merchant: string, amountCents: number, chargeDate: string): string {
  return `Receipt for ${merchant} · ${formatMoney(Math.abs(amountCents))} on ${chargeDate}`.slice(0, 200);
}

export function requestMessage(holder: Pick<CardAssignmentRow, 'card_last4' | 'card_label'>, needMemo: boolean): string {
  const card = holder.card_last4 ? `card ending ${holder.card_last4}` : holder.card_label ? holder.card_label : 'your company card';
  return [
    `This charge on ${card} needs a receipt.`,
    'Open the link to snap a photo or upload the file — or forward the e-receipt to your company’s receipts address.',
    needMemo ? 'Add a short note on what it was for.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

// ── loaders ───────────────────────────────────────────────────────────────────

async function loadAssignments(db: SupabaseClient, orgId: string): Promise<CardAssignmentRow[]> {
  const { data, error } = await db.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId);
  if (error) throw new Error(`Could not read card assignments: ${error.message}`);
  return (data ?? []) as CardAssignmentRow[];
}

async function loadAccounts(db: SupabaseClient, orgId: string): Promise<Map<string, CardAccount>> {
  const { data, error } = await db.from('bank_accounts').select('id, location_id, account_type, account_mask, account_name, is_active').eq('org_id', orgId);
  if (error) throw new Error(`Could not read bank accounts: ${error.message}`);
  return new Map(((data ?? []) as CardAccount[]).map((a) => [a.id, a]));
}

interface RequestLite {
  id: string;
  status: RequestRow['status'];
  sends_count: number;
  cancel_reason: string | null;
}

async function loadRequests(db: SupabaseClient, orgId: string, ids: string[]): Promise<Map<string, RequestLite>> {
  const out = new Map<string, RequestLite>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db.schema('core').from('requests').select('id, status, sends_count, cancel_reason').eq('org_id', orgId).in('id', chunk);
    if (error) throw new Error(`Could not read receipt requests: ${error.message}`);
    for (const r of (data ?? []) as RequestLite[]) out.set(r.id, r);
  }
  return out;
}

function isLive(r: RequestLite | undefined): boolean {
  return !!r && LIVE.includes(r.status);
}

/** A request may be (re)opened for a needed charge: none yet, or one this module paused. */
export function mayOpenRequest(existing: Pick<RequestLite, 'status' | 'cancel_reason'> | undefined): boolean {
  if (!existing) return true;
  if (LIVE.includes(existing.status)) return false;
  return existing.status === 'cancelled' && !!existing.cancel_reason?.startsWith(PAUSE_PREFIX);
}

function pauseReason(state: ChargeState): string {
  switch (state) {
    case 'chase_off':
      return `${PAUSE_PREFIX} receipt chase is turned off for this company.`;
    case 'opted_out':
      return `${PAUSE_PREFIX} the cardholder is opted out of receipt chase.`;
    case 'no_cardholder':
      return `${PAUSE_PREFIX} the card has no active cardholder.`;
    case 'below_threshold':
      return `${PAUSE_PREFIX} the charge is under the receipt limit.`;
    case 'not_required':
      return 'Marked not required.';
    case 'matched':
      return 'A receipt is already in.';
    default:
      return `${PAUSE_PREFIX} reassigned.`;
  }
}

// ── the sync ──────────────────────────────────────────────────────────────────

export async function syncReceiptChase(
  deps: ChaseDeps,
  orgId: string,
  opts: { ctx?: ReceiptPolicyContext; requestCtx?: PolicyContext; signal?: AbortSignal; limit?: number; onlyTxnIds?: string[] } = {},
): Promise<ChaseSyncSummary> {
  const db = deps.db;
  const now = deps.now();
  const summary: ChaseSyncSummary = { charges: 0, created: 0, cancelled: 0, matched: 0, needed: 0, noCardholder: 0, chaseOff: 0, errors: [] };
  const ctx = opts.ctx ?? (await loadReceiptPolicyContext(db, orgId));
  const [assignments, accounts] = await Promise.all([loadAssignments(db, orgId), loadAccounts(db, orgId)]);

  // Look back over the widest window any client uses (+ the largest grace).
  const policies = [mergeReceiptPolicy(ctx.rows, null), ...ctx.rows.filter((r) => r.location_id).map((r) => mergeReceiptPolicy(ctx.rows, r.location_id))];
  const lookback = Math.max(...policies.map((p) => p.chaseWindowDays + p.graceDays));
  const from = new Date(now.getTime() - lookback * 86_400_000).toISOString().slice(0, 10);

  let txq = serviceWriter(db)
    .from('bank_transactions')
    .select('id, org_id, location_id, bank_account_id, transaction_date, description, amount_cents, matched_receipt_id, matched_bill_id')
    .eq('org_id', orgId)
    .lt('amount_cents', 0)
    .gte('transaction_date', from);
  if (opts.onlyTxnIds?.length) txq = txq.in('id', opts.onlyTxnIds);
  const { data: txData, error: txErr } = await txq.order('transaction_date', { ascending: true }).limit(opts.limit ?? 2000);
  if (txErr) throw new Error(`Could not read card charges: ${txErr.message}`);
  const charges = ((txData ?? []) as ChargeTxn[])
    .map((t) => ({ ...t, amount_cents: Number(t.amount_cents) }))
    .filter((t) => isCardCharge(t, accounts.get(t.bank_account_id), assignments));
  summary.charges = charges.length;
  if (charges.length === 0) return summary;

  const ids = charges.map((c) => c.id);
  const states = new Map<string, ChargeStateRow>();
  const receiptsByTxn = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [{ data: st, error: stErr }, { data: rc, error: rcErr }] = await Promise.all([
      db.from('receipt_charge_states').select('*').eq('org_id', orgId).in('bank_transaction_id', chunk),
      serviceWriter(db).from('receipts').select('id, bank_transaction_id').eq('org_id', orgId).in('bank_transaction_id', chunk),
    ]);
    if (stErr) throw new Error(`Could not read charge states: ${stErr.message}`);
    if (rcErr) throw new Error(`Could not read receipts: ${rcErr.message}`);
    for (const s of (st ?? []) as ChargeStateRow[]) states.set(s.bank_transaction_id, s);
    for (const r of (rc ?? []) as Array<{ id: string; bank_transaction_id: string }>) receiptsByTxn.set(r.bank_transaction_id, r.id);
  }
  const requests = await loadRequests(
    db,
    orgId,
    Array.from(states.values()).map((s) => s.request_id).filter((x): x is string => !!x),
  );
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  let requestCtx = opts.requestCtx ?? null;

  for (const txn of charges) {
    if (opts.signal?.aborted) break;
    try {
      const prev = states.get(txn.id) ?? null;
      const policy = mergeReceiptPolicy(ctx.rows, txn.location_id);
      const resolved = resolveCardholder(txn, accounts.get(txn.bank_account_id), assignments);
      const override = prev?.holder_override && prev.card_assignment_id ? assignmentById.get(prev.card_assignment_id) ?? null : null;
      const holder = override && override.active ? override : resolved;
      const receiptId = receiptsByTxn.get(txn.id) ?? txn.matched_receipt_id ?? null;
      let status = decideChargeState({
        txn,
        holder,
        policy,
        chaseOn: chaseEnabledFor(ctx.switches, txn.location_id),
        hasReceipt: !!receiptId,
        waived: prev?.status === 'not_required',
      });
      const existing = prev?.request_id ? requests.get(prev.request_id) : undefined;
      let requestId = prev?.request_id ?? null;
      let chaseCount = existing?.sends_count ?? prev?.chase_count ?? 0;

      // A live request on a charge that should no longer be chased (or moved holder) → pause / close it.
      const holderMoved = !!existing && isLive(existing) && !!prev?.card_assignment_id && holder?.id !== prev.card_assignment_id;
      if (existing && isLive(existing) && (status !== 'needed' || holderMoved)) {
        try {
          if (status === 'matched') {
            await fulfilRequest({ db, now: deps.now }, orgId, existing.id, SYSTEM_ACTOR, { via: 'app', note: 'A receipt came in for this charge.' });
          } else {
            await cancelRequest({ db, now: deps.now }, orgId, existing.id, SYSTEM_ACTOR, pauseReason(holderMoved ? 'needed' : status));
            summary.cancelled++;
          }
          existing.status = status === 'matched' ? 'fulfilled' : 'cancelled';
          existing.cancel_reason = status === 'matched' ? null : pauseReason(holderMoved ? 'needed' : status);
        } catch (e) {
          if (!(e instanceof RequestError && e.status === 409)) throw e;
        }
      }

      if (status === 'needed' && holder) {
        if (isLive(existing)) status = 'requested';
        else if (shouldOpenRequest(txn.transaction_date, policy, now) && mayOpenRequest(existing)) {
          requestCtx = requestCtx ?? (await loadPolicyContext(db, orgId));
          const merchant = merchantLabel(txn.description);
          const offsets = receiptOffsets(policy.reminderDays, ctx.firstReminderMinutes);
          const escalateTo = escalationTarget(holder, policy);
          const res = await createRequest(
            { db, now: deps.now },
            {
              orgId,
              locationId: txn.location_id,
              kind: 'receipt',
              subjectType: 'bank_transaction',
              subjectId: txn.id,
              dedupeKey: `receipt:${txn.id}`,
              title: requestTitle(merchant, txn.amount_cents, txn.transaction_date),
              message: requestMessage(holder, memoRequired(policy, txn.amount_cents)),
              deepLink: '/w',
              recipient: recipientFor(holder),
              channels: receiptRequestChannels(holder, ctx.chaseChannel),
              cadence: { anchor: 'created', offsetsMinutes: offsets, repeatEveryMinutes: null, maxSends: offsets.length },
              escalateAfter: policy.escalateTo === 'none' ? null : offsets.length,
              escalateToMembershipId: escalateTo,
              ownerMembershipId: policy.bookkeeperMembershipId,
              source: 'rule',
              meta: {
                card_assignment_id: holder.id,
                charge_date: txn.transaction_date,
                amount_cents: Math.abs(txn.amount_cents),
                merchant,
                card_last4: holder.card_last4,
              },
              createdBy: SYSTEM_ACTOR,
            },
            requestCtx,
          );
          requestId = res.request.id;
          chaseCount = res.request.sends_count;
          if (res.created) summary.created++;
          status = 'requested';
        }
      }

      if (status === 'matched') summary.matched++;
      else if (status === 'needed' || status === 'requested') summary.needed++;
      else if (status === 'no_cardholder') summary.noCardholder++;
      else if (status === 'chase_off') summary.chaseOff++;

      const row = {
        location_id: txn.location_id,
        bank_account_id: txn.bank_account_id,
        card_assignment_id: holder?.id ?? null,
        holder_override: !!override && override.active,
        charge_date: txn.transaction_date,
        amount_cents: Math.abs(txn.amount_cents),
        merchant: merchantLabel(txn.description),
        status,
        request_id: requestId,
        receipt_id: receiptId,
        chase_count: chaseCount,
        updated_at: now.toISOString(),
      };
      if (prev) {
        const changed =
          prev.status !== row.status ||
          prev.request_id !== row.request_id ||
          prev.receipt_id !== row.receipt_id ||
          prev.card_assignment_id !== row.card_assignment_id ||
          prev.chase_count !== row.chase_count;
        if (changed) {
          const { error } = await db.from('receipt_charge_states').update(row).eq('org_id', orgId).eq('id', prev.id);
          if (error) throw new Error(error.message);
        }
      } else {
        const { error } = await db.from('receipt_charge_states').insert({ org_id: orgId, bank_transaction_id: txn.id, first_seen_at: now.toISOString(), ...row });
        if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
      }
    } catch (e) {
      summary.errors.push(`${txn.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

// ── closing the chase for one charge ──────────────────────────────────────────

/**
 * A receipt is now linked to the charge (any path): fulfil the live request, mark the
 * state matched, copy the chase count onto the receipt. Idempotent; never throws for an
 * already-closed request.
 */
export async function closeChaseForCharge(
  db: SupabaseClient,
  orgId: string,
  txnId: string,
  opts: { receiptId: string; actor: string; now: Date },
): Promise<{ chaseCount: number }> {
  const iso = opts.now.toISOString();
  const { data: st } = await db.from('receipt_charge_states').select('id, request_id, chase_count').eq('org_id', orgId).eq('bank_transaction_id', txnId).maybeSingle();
  const state = st as { id: string; request_id: string | null; chase_count: number } | null;
  let requestId = state?.request_id ?? null;
  if (!requestId) {
    const { data: r } = await db
      .schema('core')
      .from('requests')
      .select('id')
      .eq('org_id', orgId)
      .eq('kind', 'receipt')
      .eq('subject_id', txnId)
      .in('status', LIVE)
      .limit(1)
      .maybeSingle();
    requestId = (r as { id?: string } | null)?.id ?? null;
  }
  let chaseCount = state?.chase_count ?? 0;
  if (requestId) {
    const { data: req } = await db.schema('core').from('requests').select('id, status, sends_count').eq('org_id', orgId).eq('id', requestId).maybeSingle();
    const rq = req as { id: string; status: string; sends_count: number } | null;
    if (rq) {
      chaseCount = rq.sends_count;
      if (LIVE.includes(rq.status)) {
        try {
          await fulfilRequest({ db, now: () => opts.now }, orgId, rq.id, opts.actor, { via: 'app', note: 'Receipt received.' });
        } catch (e) {
          if (!(e instanceof RequestError && e.status === 409)) throw e;
        }
      }
    }
  }
  if (state) {
    await db
      .from('receipt_charge_states')
      .update({ status: 'matched', receipt_id: opts.receiptId, chase_count: chaseCount, request_id: requestId, updated_at: iso })
      .eq('org_id', orgId)
      .eq('id', state.id);
  }
  await serviceWriter(db)
    .from('receipts')
    .update({ chase_reminder_count: chaseCount, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', opts.receiptId);
  return { chaseCount };
}

/**
 * Pause every live receipt request in a scope (chase switched off, cardholder opted out).
 * The states take `state`; the requests are cancelled with the PAUSE_PREFIX reason so a
 * later switch-on re-opens only in-window charges. Returns how many were cancelled.
 */
export async function pauseChase(
  db: SupabaseClient,
  orgId: string,
  scope: { locationId?: string | null; cardAssignmentId?: string | null },
  state: 'chase_off' | 'opted_out',
  actor: string,
  now: Date,
): Promise<number> {
  let q = db.from('receipt_charge_states').select('id, request_id').eq('org_id', orgId).in('status', ['needed', 'requested']);
  if (scope.locationId) q = q.eq('location_id', scope.locationId);
  if (scope.cardAssignmentId) q = q.eq('card_assignment_id', scope.cardAssignmentId);
  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`Could not read charge states: ${error.message}`);
  let cancelled = 0;
  const reason = pauseReason(state);
  for (const s of (data ?? []) as Array<{ id: string; request_id: string | null }>) {
    if (s.request_id) {
      try {
        await cancelRequest({ db, now: () => now }, orgId, s.request_id, actor, reason);
        cancelled++;
      } catch (e) {
        if (!(e instanceof RequestError && e.status === 409)) throw e;
      }
    }
    await db.from('receipt_charge_states').update({ status: state, updated_at: now.toISOString() }).eq('org_id', orgId).eq('id', s.id);
  }
  return cancelled;
}
