/**
 * JOB_DEPOSIT_REQUEST consumer (Projects -> Books, schema_version 1, migration 173).
 *
 * Payload (pm.emit_deposit_request, 1102 §14):
 *   { event_id, event_type, source_module, org_id, location_id, job_id, customer_id,
 *     amount_cents, memo, occurred_on, source_ref 'pm:deposit:{id}', schema_version 1 }
 *
 * Books runs it through its EXISTING customer-deposits feature (one way to hold and
 * apply deposits — BOOKS-PROJECTS-INTERACTION.md §2):
 *   1. a deposit invoice through the standard invoice creator, one balance-sheet line:
 *        DR Accounts Receivable / CR Customer Deposits (role CUSTOMER_DEPOSITS, 2420)
 *      (no revenue, no sales tax; GL source_ref 'job_deposit:<source_ref>');
 *   2. the deposits subledger row (customer_deposits, source_ref unique, HELD);
 *   3. at the job's final invoice the billing consumer applies the collected deposit
 *      through the existing apply flow (DR 2420 / CR AR).
 *
 * Exactly-once: claim + lease (167); invoices.source_event_id / source_ref and
 * customer_deposits.source_ref unique per org (173); GL source_ref unique (064).
 * A crash between steps 1 and 2 self-heals: the re-run finds the deposit invoice by
 * source_ref and records the missing subledger row.
 *
 * Gate: entitlements.projects = true only; an unsupported schema_version is rejected
 * regardless. Ack (event row): status, invoice_id, invoice_number, gl_entry_id,
 * ack_meta.deposit_id; error + error_code on rejection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { resolveRole } from '@/lib/posting/account-roles';
import { claimPendingEvents, releaseEventClaims, renewEventClaim, type ClaimedEvent } from '@/lib/events/claim';
import {
  ackClaimedEvent,
  projectsEntitlementCache,
  rejectClaimedEvent,
  SeamRejection,
  versionRejection,
} from '@/lib/events/seam';
import { recordBilledDeposit } from '@/lib/customer-deposits/seam-deposits';

type DB = SupabaseClient;

export interface DepositRequestPayload {
  event_id: string;
  job_id: string;
  location_id: string;
  customer_id: string | null;
  amount_cents: number;
  memo: string | null;
  occurred_on: string;
  source_ref: string;
  schema_version?: number;
}

export interface DepositDrainResult {
  processed: number;
  rejected: number;
  skipped: number;
  results: { event_id: string; status: 'processed' | 'rejected' | 'skipped'; invoice_number?: string; deposit_id?: string; error?: string; error_code?: string }[];
}

/** The GL source_ref of a deposit invoice (064 unique index). */
export function depositGlSourceRef(sourceRef: string): string {
  return `job_deposit:${sourceRef}`;
}

/** Amount the autonomy gate is asked about for a claimed batch. */
export function claimedDepositCents(rows: ReadonlyArray<ClaimedEvent<Partial<DepositRequestPayload> | null>>): number {
  return rows.reduce((s, r) => s + Math.abs(Math.round(Number(r.payload?.amount_cents ?? 0))), 0);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function processDepositRequestEvents(
  db: DB,
  orgFilter?: string | null,
  opts: { claimed?: { token: string; rows: ClaimedEvent<DepositRequestPayload>[] } } = {},
): Promise<DepositDrainResult> {
  const claim = opts.claimed ?? (await claimPendingEvents<DepositRequestPayload>(db, { eventType: 'JOB_DEPOSIT_REQUEST', orgId: orgFilter ?? null }));
  const projectsOn = projectsEntitlementCache(db);
  const out: DepositDrainResult = { processed: 0, rejected: 0, skipped: 0, results: [] };

  const skip = (ev: ClaimedEvent<DepositRequestPayload>, why: string) => {
    out.skipped++;
    out.results.push({ event_id: ev.event_id, status: 'skipped', error: why });
  };
  const reject = async (ev: ClaimedEvent<DepositRequestPayload>, r: SeamRejection) => {
    if (!(await rejectClaimedEvent(db, ev.id, claim.token, r))) { skip(ev, 'Claimed by another drain'); return; }
    out.rejected++;
    out.results.push({ event_id: ev.event_id, status: 'rejected', error: r.message, error_code: r.code });
  };

  try {
    for (const ev of claim.rows) {
      const orgId = ev.org_id;
      const p = ev.payload;
      try {
        if (!(await renewEventClaim(db, ev.id, claim.token))) { skip(ev, 'Claimed by another drain'); continue; }

        const vr = versionRejection('JOB_DEPOSIT_REQUEST', p);
        if (vr) { await reject(ev, vr); continue; }

        if (!(await projectsOn(orgId))) {
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Projects is not enabled for this organization');
          continue;
        }

        if (!p?.source_ref) { await reject(ev, new SeamRejection('MISSING_SOURCE_REF', 'The deposit request has no source_ref')); continue; }
        const amount = Number(p.amount_cents);
        if (!Number.isInteger(amount) || amount <= 0) { await reject(ev, new SeamRejection('INVALID_AMOUNT', 'Deposit amount must be a positive whole number of cents')); continue; }

        const r = await issueDeposit(db, ev, amount);
        if (r.kind === 'reject') { await reject(ev, r.rejection); continue; }
        if (r.kind === 'race') {
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Another drain is issuing this deposit');
          continue;
        }
        const ok = await ackClaimedEvent(db, ev.id, claim.token, {
          invoice_id: r.invoiceId, invoice_number: r.invoiceNumber, gl_entry_id: r.glEntryId,
          meta: { deposit_id: r.depositId, amount_cents: amount, ...(r.duplicate ? { duplicate: true } : {}) },
        });
        if (!ok) { skip(ev, 'Booked; finalized by the drain that now holds the event'); continue; }
        out.processed++;
        out.results.push({ event_id: ev.event_id, status: 'processed', invoice_number: r.invoiceNumber, deposit_id: r.depositId });
      } catch (e) {
        await reject(ev, e instanceof SeamRejection ? e : new SeamRejection('CONSUMER_ERROR', e instanceof Error ? e.message : 'consumer error'));
      }
    }
  } finally {
    await releaseEventClaims(db, claim.token).catch(() => 0);
  }
  return out;
}

type IssueDeposit =
  | { kind: 'ok'; invoiceId: string; invoiceNumber: string; glEntryId: string; depositId: string; duplicate: boolean }
  | { kind: 'reject'; rejection: SeamRejection }
  | { kind: 'race' };

async function issueDeposit(db: DB, ev: ClaimedEvent<DepositRequestPayload>, amount: number): Promise<IssueDeposit> {
  const orgId = ev.org_id;
  const p = ev.payload;
  const rej = (code: ConstructorParameters<typeof SeamRejection>[0], msg: string): IssueDeposit => ({ kind: 'reject', rejection: new SeamRejection(code, msg) });

  // Exactly-once: a deposit invoice for this event or business key → finish from it.
  const cols = 'id, invoice_number, gl_entry_id, customer_id, location_id, job_id, invoice_date, created_at';
  type Inv = { id: string; invoice_number: string; gl_entry_id: string | null; customer_id: string; location_id: string; job_id: string | null; invoice_date: string; created_at: string };
  const { data: byEvent } = await db.from('invoices').select(cols).eq('org_id', orgId).eq('source_event_id', ev.id).maybeSingle();
  const { data: byRef } = byEvent ? { data: null } : await db.from('invoices').select(cols).eq('org_id', orgId).eq('source_ref', p.source_ref).maybeSingle();
  const prior = (byEvent ?? byRef) as Inv | null;
  if (prior) {
    if (!prior.gl_entry_id) {
      if (Date.now() - new Date(prior.created_at).getTime() < 15 * 60 * 1000) return { kind: 'race' };
      return rej('PARTIAL_INVOICE', `Deposit invoice ${prior.invoice_number} has no GL entry — review it in Books`);
    }
    const dep = await recordBilledDeposit(db, {
      orgId, actor: 'system', locationId: prior.location_id, customerId: prior.customer_id, jobId: prior.job_id,
      depositDate: prior.invoice_date, amountCents: amount, memo: p.memo ?? 'Deposit', sourceRef: p.source_ref,
      invoiceId: prior.id, glEntryId: prior.gl_entry_id,
    });
    return { kind: 'ok', invoiceId: prior.id, invoiceNumber: prior.invoice_number, glEntryId: prior.gl_entry_id, depositId: dep.id, duplicate: true };
  }

  const { data: loc } = await db.schema('core').from('locations').select('id').eq('id', p.location_id).eq('org_id', orgId).maybeSingle();
  if (!loc) return rej('COMPANY_NOT_FOUND', 'Company not found');
  const { data: jobRow } = await db.schema('core').from('jobs').select('id, customer_id').eq('id', p.job_id).eq('org_id', orgId).maybeSingle();
  const job = jobRow as { id: string; customer_id: string | null } | null;
  const customerId = p.customer_id ?? job?.customer_id ?? null;
  if (!job || !customerId) return rej('NO_CUSTOMER', 'The job has no customer to invoice the deposit to');
  const { data: custRow } = await db.schema('core').from('customers').select('id, payment_terms_days').eq('org_id', orgId).eq('id', customerId).maybeSingle();
  if (!custRow) return rej('NO_CUSTOMER', 'Customer not found in this organization');

  const { data: period } = await db.from('fiscal_periods').select('id, status').eq('org_id', orgId).eq('location_id', p.location_id)
    .lte('start_date', p.occurred_on).gte('end_date', p.occurred_on).maybeSingle();
  if (!period) return rej('NO_FISCAL_PERIOD', `No fiscal period for ${p.occurred_on}`);
  if ((period as { status: string }).status === 'HARD_CLOSE') return rej('PERIOD_CLOSED', `The period for ${p.occurred_on} is closed`);

  let depositsAcct: string;
  try {
    depositsAcct = (await resolveRole(db, orgId, 'CUSTOMER_DEPOSITS', p.location_id)).id;
  } catch (e) {
    return rej('ACCOUNT_UNRESOLVED', e instanceof Error ? e.message : 'Customer deposits account missing');
  }

  const terms = Number((custRow as { payment_terms_days?: unknown }).payment_terms_days ?? 30);
  const outcome = await createInvoice(db, {
    orgId,
    actor: 'system',
    input: {
      location_id: p.location_id,
      customer_id: customerId,
      job_id: p.job_id,
      invoice_date: p.occurred_on,
      due_date: addDays(p.occurred_on, Number.isFinite(terms) && terms >= 0 ? terms : 30),
      memo: p.memo ?? 'Deposit',
      invoice_type: 'Deposit',
      retainage_cents: 0,
      source: { event_row_id: ev.id, source_ref: p.source_ref, billing_subtype: 'DEPOSIT' },
      gl_source_ref: depositGlSourceRef(p.source_ref),
      post_to_gl: true,
      strict_gl: true,
      lines: [{ description: p.memo ?? 'Deposit', account_id: depositsAcct, unit_price_cents: amount, kind: 'BALANCE_SHEET' }],
    },
  });
  if (!outcome.ok) {
    if (outcome.code === 'DUPLICATE_SOURCE') return { kind: 'race' };
    if (outcome.code === 'GL_POST_FAILED' && /duplicate key|uq_gl_entries_org_source_type/i.test(outcome.error)) return { kind: 'race' };
    return rej(outcome.code === 'GL_POST_FAILED' ? 'GL_POST_FAILED' : 'INVOICE_FAILED', outcome.error);
  }
  const glEntryId = outcome.result.gl_entry_id;
  if (!glEntryId) return rej('GL_POST_FAILED', 'The deposit invoice posted without an entry id');

  try {
    const dep = await recordBilledDeposit(db, {
      orgId, actor: 'system', locationId: p.location_id, customerId, jobId: p.job_id, depositDate: p.occurred_on,
      amountCents: amount, memo: p.memo ?? 'Deposit', sourceRef: p.source_ref, invoiceId: outcome.result.invoice_id, glEntryId,
    });
    return { kind: 'ok', invoiceId: outcome.result.invoice_id, invoiceNumber: outcome.result.invoice_number, glEntryId, depositId: dep.id, duplicate: false };
  } catch (e) {
    // The invoice + entry exist; the re-run (Projects re-emit or the next drain after a
    // reject) records the subledger row from them by source_ref.
    return rej('DEPOSIT_FAILED', e instanceof Error ? e.message : 'Deposit subledger insert failed');
  }
}
