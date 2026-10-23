/**
 * `ar.dunning` — the automated dunning ladder (AR-08, FPB-invoices D6.2).
 *
 * Daily, per tenant, for every open invoice (SENT / PARTIALLY_PAID / OVERDUE with a balance):
 *
 *   1. mirror   reminders the request engine has SENT since yesterday are written to the
 *               invoice timeline as REMINDER_SENT (with the stage), exactly like a reminder
 *               sent by hand from Collections — so the worklist's "last stage" stays right.
 *   2. decide   lib/collections/dunning-plan.ts (pure): the company's policy (company row →
 *               tenant row → off), days past due, what was already sent, and the stop
 *               conditions — paid, customer excluded, disputed, promise-to-pay pending,
 *               under the minimum balance.
 *   3. act      stop → cancel the live reminder (timeline says why). create → the next step
 *               as a core.requests row (lib/collections/dunning-requests.ts). It goes out
 *               through the request engine (`requests.remind`) — quiet hours, unsubscribe,
 *               bounces and send quotas always apply.
 *
 * DRAFT vs SEND — the stricter wins:
 *   • the company's policy send_mode (DRAFT = always a person sends), and
 *   • the tenant's "Scheduled payment reminders" autonomy dial, asked per invoice with its
 *     balance: AUTO_UNDER_LIMIT within the cap → sends on its own; anything else (PROPOSE,
 *     OFF, kill switch, over the cap) → a draft waiting in Requests → Dunning for "Send now".
 *
 * IDEMPOTENT: one live request per invoice + step (dedupe key), a step is never re-sent, and
 * the ladder never goes back down. No GL effect (late fees are a separate job: ar.late_fees).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decideDisposition, loadAutonomyGovernance } from '@/lib/autonomy/disposition';
import { classifyPromise, PROMISE_ACTION } from '@/lib/collections/promises';
import { DUNNING_STEP_STAGES, resolveDunningPolicy, renderDunningStep, type DunningPolicyRow, type DunningStepStage } from '@/lib/collections/dunning-policy';
import { daysPastDue, decideDunning, STOP_REASON_TEXT, supersedeReason, type LiveDunningRequest, type StopReason } from '@/lib/collections/dunning-plan';
import { createDunningReminder, DUNNING_ACTOR } from '@/lib/collections/dunning-requests';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolvePayLinksBatch, payUrlFor, type PayLinkState } from '@/lib/invoices/pay-link';
import { cancelRequest } from '@/lib/requests/service';
import { loadPolicyContext } from '@/lib/requests/policy';
import { fetchCoreMap } from '@/lib/stitch-core';
import { SCHEDULED_DUNNING_FEATURE } from '../posting-gate';
import type { CountValue, JobContext, JobResult } from '../types';
import { dollars, isoDate, loadCompanyNames, notifyTenantAdmins, scopedOrFail } from './shared';

const STAGES = new Set<string>(DUNNING_STEP_STAGES);
const LIVE = ['open', 'sent', 'snoozed'];
/** Furthest a pre-due step may sit before the due date (dunningStepSchema min). */
const PRE_DUE_WINDOW_DAYS = 60;

interface InvoiceRow {
  id: string;
  location_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  balance_cents: number | string;
  status: string;
  disputed_at: string | null;
  public_token: string;
  payment_methods_allowed: string[] | null;
  card_surcharge_enabled: boolean | null;
  ach_surcharge_enabled: boolean | null;
}

interface DunningRequestRow {
  id: string;
  subject_id: string | null;
  status: string;
  sends_count: number;
  cancelled_by: string | null;
  recipient_email: string | null;
  source: string;
  meta: Record<string, unknown> | null;
  created_at: string;
  location_id: string | null;
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function stageOf(meta: Record<string, unknown> | null | undefined): DunningStepStage | null {
  const s = meta?.stage;
  return typeof s === 'string' && STAGES.has(s) ? (s as DunningStepStage) : null;
}

async function loadDunningRequests(db: SupabaseClient, orgId: string, invoiceIds: string[]): Promise<DunningRequestRow[]> {
  const out: DunningRequestRow[] = [];
  for (const ids of chunks(invoiceIds, 200)) {
    const { data, error } = await db
      .schema('core')
      .from('requests')
      .select('id, subject_id, status, sends_count, cancelled_by, recipient_email, source, meta, created_at, location_id')
      .eq('org_id', orgId)
      .eq('kind', 'dunning')
      .eq('subject_type', 'invoice')
      .in('subject_id', ids);
    if (error) throw new Error(`Could not read payment reminders: ${error.message}`);
    out.push(...((data ?? []) as DunningRequestRow[]));
  }
  return out;
}

async function loadReminderStages(db: SupabaseClient, orgId: string, invoiceIds: string[]): Promise<Map<string, Set<DunningStepStage>>> {
  const out = new Map<string, Set<DunningStepStage>>();
  for (const ids of chunks(invoiceIds, 200)) {
    const { data, error } = await db
      .from('invoice_events')
      .select('invoice_id, meta')
      .eq('org_id', orgId)
      .eq('event_type', 'REMINDER_SENT')
      .in('invoice_id', ids);
    if (error) throw new Error(`Could not read reminder history: ${error.message}`);
    for (const r of (data ?? []) as Array<{ invoice_id: string; meta: Record<string, unknown> | null }>) {
      const st = stageOf(r.meta);
      if (!st) continue;
      const set = out.get(r.invoice_id) ?? new Set<DunningStepStage>();
      set.add(st);
      out.set(r.invoice_id, set);
    }
  }
  return out;
}

/** Invoice ids (and customer ids, for customer-wide promises) with a promise still pending at asOf. */
async function loadPendingPromises(
  db: SupabaseClient,
  orgId: string,
  asOf: string,
  balances: Map<string, number>,
  customerOpen: Map<string, number>,
): Promise<{ invoices: Set<string>; customers: Set<string> }> {
  const invoices = new Set<string>();
  const customers = new Set<string>();
  const { data } = await db
    .schema('core')
    .from('action_log')
    .select('id, metadata, created_at')
    .eq('org_id', orgId)
    .eq('action', PROMISE_ACTION)
    .order('created_at', { ascending: false })
    .limit(2000);
  const seen = new Set<string>();
  for (const r of (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const m = r.metadata ?? {};
    const customerId = typeof m.customerId === 'string' ? m.customerId : null;
    const invoiceId = typeof m.invoiceId === 'string' ? m.invoiceId : null;
    const promiseDate = typeof m.promiseDate === 'string' ? m.promiseDate : '';
    if (!customerId || !promiseDate) continue;
    const target = invoiceId ?? `cust:${customerId}`;
    if (seen.has(target)) continue; // newest promise per target is authoritative
    seen.add(target);
    const open = invoiceId ? balances.get(invoiceId) ?? 0 : customerOpen.get(customerId) ?? 0;
    const status = classifyPromise(
      { amountCents: Number(m.amountCents ?? 0), promiseDate },
      { paidSinceCents: 0, openBalanceCents: open, settled: open <= 0 },
      asOf,
    );
    if (status !== 'PENDING') continue;
    if (invoiceId) invoices.add(invoiceId);
    else customers.add(customerId);
  }
  return { invoices, customers };
}

export async function runDunningJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const { db, orgId } = s;
  const admin = ctx.admin;
  const asOf = isoDate(ctx.now);
  const now = ctx.now;

  const { data: policyData, error: polErr } = await db
    .from('dunning_policies')
    .select('location_id, enabled, send_mode, steps, stop_on_promise, stop_on_dispute, excluded_customer_ids, min_balance_cents')
    .eq('org_id', orgId);
  if (polErr) return { status: 'failed', error: `Could not read the dunning policy: ${polErr.message}` };
  const policies = (policyData ?? []) as DunningPolicyRow[];

  // Open invoices within reach of the ladder (incl. pre-due courtesy reminders).
  const horizon = new Date(Date.parse(`${asOf}T00:00:00Z`) + PRE_DUE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: invData, error: invErr } = await db
    .from('invoices')
    .select('id, location_id, customer_id, job_id, invoice_number, invoice_date, due_date, balance_cents, status, disputed_at, public_token, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled')
    .eq('org_id', orgId)
    .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .gt('balance_cents', 0)
    .lte('due_date', horizon)
    .limit(5000);
  if (invErr) return { status: 'failed', error: `Could not read open invoices: ${invErr.message}` };
  const invoices = (invData ?? []) as InvoiceRow[];
  const invoiceIds = invoices.map((i) => i.id);

  const requests = invoiceIds.length ? await loadDunningRequests(db, orgId, invoiceIds) : [];
  const anyEnabled = policies.some((p) => p.enabled);
  const anyLive = requests.some((r) => LIVE.includes(r.status));
  if (!anyEnabled && !anyLive) {
    return { status: 'ok', itemsProcessed: 0, counts: { as_of: asOf, enabled: false }, summary: 'Payment reminders are switched off (Settings → Automation → Dunning).' };
  }

  const counts: Record<string, CountValue> = { as_of: asOf, invoices: invoices.length };
  const failures: string[] = [];

  // ── 1. mirror sent reminders onto the invoice timeline ────────────────────
  let mirrored = 0;
  for (const r of requests) {
    if (r.sends_count <= 0 || r.source !== 'scheduler' || r.meta?.reminder_recorded === true || !r.subject_id) continue;
    const stage = stageOf(r.meta);
    try {
      await recordInvoiceEvent(db, {
        orgId,
        invoiceId: r.subject_id,
        type: 'REMINDER_SENT',
        actor: DUNNING_ACTOR,
        meta: {
          stage: stage ?? 'MANUAL',
          tier: stage ?? 'MANUAL',
          channel: 'dunning',
          request_id: r.id,
          to: r.recipient_email,
          automated: r.meta?.draft !== true,
          human_approved: r.meta?.draft === true,
        },
      });
      await admin.schema('core').from('requests').update({ meta: { ...(r.meta ?? {}), reminder_recorded: true } }).eq('id', r.id).eq('org_id', orgId);
      r.meta = { ...(r.meta ?? {}), reminder_recorded: true };
      mirrored++;
    } catch (e) {
      failures.push(`timeline ${r.subject_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  counts.reminders_recorded = mirrored;

  // ── 2. facts ──────────────────────────────────────────────────────────────
  const customerIds = Array.from(new Set(invoices.map((i) => i.customer_id).filter((x): x is string => !!x)));
  const [customers, names, sentStages, policyCtx, gov] = await Promise.all([
    fetchCoreMap<{ id: string; name: string; display_name: string | null; email: string | null }>(db, 'customers', 'id, name, display_name, email', customerIds),
    loadCompanyNames(db),
    invoiceIds.length ? loadReminderStages(db, orgId, invoiceIds) : Promise.resolve(new Map<string, Set<DunningStepStage>>()),
    loadPolicyContext(admin, orgId),
    loadAutonomyGovernance(admin, orgId, SCHEDULED_DUNNING_FEATURE),
  ]);
  const balances = new Map(invoices.map((i) => [i.id, Number(i.balance_cents)]));
  const customerOpen = new Map<string, number>();
  for (const i of invoices) if (i.customer_id) customerOpen.set(i.customer_id, (customerOpen.get(i.customer_id) ?? 0) + Number(i.balance_cents));
  const promises = await loadPendingPromises(db, orgId, asOf, balances, customerOpen).catch(() => ({ invoices: new Set<string>(), customers: new Set<string>() }));

  let payLinks = new Map<string, PayLinkState>();
  try {
    payLinks = await resolvePayLinksBatch(db, orgId, invoices.map((i) => ({ ...i, balance_cents: Number(i.balance_cents) })));
  } catch (e) {
    console.warn('[ar.dunning] pay links unavailable; reminders link to the invoice page', e instanceof Error ? e.message : e);
  }

  const reqByInvoice = new Map<string, DunningRequestRow[]>();
  for (const r of requests) {
    if (!r.subject_id) continue;
    const arr = reqByInvoice.get(r.subject_id) ?? [];
    arr.push(r);
    reqByInvoice.set(r.subject_id, arr);
  }

  // ── 3. decide + act ───────────────────────────────────────────────────────
  const stops: Record<StopReason, number> = { settled: 0, excluded: 0, disputed: 0, promise: 0, below_minimum: 0, disabled: 0 };
  let drafted = 0;
  let queued = 0;
  let superseded = 0;
  let noEmail = 0;
  let draftCents = 0;
  const deps = { db: admin, now: () => now };

  for (const inv of invoices) {
    if (ctx.signal.aborted) break;
    const policy = resolveDunningPolicy(policies, inv.location_id);
    const mine = reqByInvoice.get(inv.id) ?? [];
    const liveRows = mine.filter((r) => LIVE.includes(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const liveRow = liveRows[0] ?? null;
    const liveStage = liveRow ? stageOf(liveRow.meta) : null;
    const live: LiveDunningRequest | null = liveRow && liveStage ? { id: liveRow.id, stage: liveStage, sent: liveRow.sends_count > 0 } : null;

    const done = new Set<DunningStepStage>(sentStages.get(inv.id) ?? []);
    for (const r of mine) {
      const st = stageOf(r.meta);
      if (!st || LIVE.includes(r.status)) continue;
      // Sent, or a PERSON cancelled it → that step is done. Ladder-made cancellations
      // (superseded, on hold) are not — the step may come back when the hold lifts.
      if (r.sends_count > 0 || (r.status === 'cancelled' && r.cancelled_by !== DUNNING_ACTOR)) done.add(st);
    }

    const cust = inv.customer_id ? customers.get(inv.customer_id) : undefined;
    const email = cust?.email?.trim() || null;
    const decision = decideDunning(
      {
        invoiceId: inv.id,
        customerId: inv.customer_id,
        balanceCents: Number(inv.balance_cents),
        status: inv.status,
        daysPastDue: daysPastDue(inv.due_date, asOf),
        disputed: !!inv.disputed_at,
        hasEmail: !!email,
        promisePending: promises.invoices.has(inv.id) || (!!inv.customer_id && promises.customers.has(inv.customer_id)),
        doneStages: done,
        live,
      },
      policy,
      !!inv.customer_id && policy.excludedCustomerIds.includes(inv.customer_id),
    );

    try {
      if (decision.action === 'stop') {
        if (decision.cancelId) {
          await cancelRequest(deps, orgId, decision.cancelId, DUNNING_ACTOR, STOP_REASON_TEXT[decision.reason]).catch(() => null);
          stops[decision.reason]++;
        }
        continue;
      }
      if (decision.action === 'none') {
        if (decision.reason === 'no_email') noEmail++;
        continue;
      }

      if (decision.supersedeId) {
        await cancelRequest(deps, orgId, decision.supersedeId, DUNNING_ACTOR, supersedeReason(decision.step)).catch(() => null);
        superseded++;
      }
      const pay = payLinks.get(inv.id);
      const facts = {
        customerName: cust?.display_name || cust?.name || 'there',
        supplierName: (inv.location_id && names.get(inv.location_id)) || 'Accounts receivable',
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        dueDate: inv.due_date,
        balanceCents: Number(inv.balance_cents),
        daysOverdue: Math.max(0, daysPastDue(inv.due_date, asOf)),
        payUrl: pay?.payable ? pay.url : null,
        viewUrl: pay?.url ?? payUrlFor(inv.public_token),
      };
      const text = renderDunningStep(decision.step, facts);
      const autoSend =
        policy.sendMode === 'AUTO' &&
        decideDisposition({ killSwitchEngaged: gov.killSwitchEngaged, setting: gov.setting, scoreTier: 'auto', amountCents: Number(inv.balance_cents) }).disposition === 'AUTO';
      const made = await createDunningReminder(
        admin,
        {
          orgId,
          locationId: inv.location_id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          customerId: inv.customer_id,
          customerName: facts.customerName,
          email: email as string,
          dueDate: inv.due_date,
          balanceCents: Number(inv.balance_cents),
          step: decision.step,
          nextStep: decision.nextStep,
          subject: text.subject,
          body: text.body,
          draft: !autoSend,
        },
        policyCtx,
        now,
      );
      if (!made.created) continue;
      if (autoSend) queued++;
      else {
        drafted++;
        draftCents += Number(inv.balance_cents);
      }
    } catch (e) {
      failures.push(`${inv.invoice_number}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stopped = Object.values(stops).reduce((a, b) => a + b, 0);
  Object.assign(counts, {
    drafted,
    queued_to_send: queued,
    superseded,
    stopped,
    stopped_paid: stops.settled,
    stopped_promise: stops.promise,
    stopped_dispute: stops.disputed,
    stopped_excluded: stops.excluded,
    no_email: noEmail,
    failed: failures.length,
  });

  if (drafted > 0) {
    await notifyTenantAdmins(admin, orgId, {
      kind: 'scheduler.dunning',
      title: `${drafted} payment reminder${drafted === 1 ? '' : 's'} ready to send (${dollars(draftCents)} outstanding)`,
      body: 'Each one waits in Requests → Payment reminders. Review the wording and press Send now — quiet hours still apply.',
      deepLink: '/requests',
      dedupeKey: `dunning:${asOf}`,
    });
  }

  const parts: string[] = [];
  if (queued > 0) parts.push(`${queued} reminder(s) queued to send (within your auto-send limit; quiet hours apply).`);
  if (drafted > 0) parts.push(`${drafted} reminder(s) prepared for review in Requests.`);
  if (stopped > 0) parts.push(`${stopped} stopped (${[stops.settled && `${stops.settled} paid`, stops.promise && `${stops.promise} promised to pay`, stops.disputed && `${stops.disputed} disputed`, stops.excluded && `${stops.excluded} excluded`, stops.below_minimum && `${stops.below_minimum} under the minimum`, stops.disabled && `${stops.disabled} ladder off`].filter(Boolean).join(', ')}).`);
  if (noEmail > 0) parts.push(`${noEmail} invoice(s) are due a reminder but the customer has no email on file.`);
  if (mirrored > 0) parts.push(`${mirrored} sent reminder(s) recorded on their invoices.`);

  return {
    status: failures.length === 0 ? 'ok' : drafted + queued + stopped > 0 ? 'partial' : 'failed',
    itemsProcessed: drafted + queued + stopped,
    counts,
    summary: parts.join(' ') || `Checked ${invoices.length} open invoice(s); no reminders are due today.`,
    error: failures.length ? failures.slice(0, 10).join('; ') : undefined,
  };
}
