/**
 * JOB_BILLING consumer (Projects -> Books) — Event & Cost/Billing Contract (FROZEN v3) §4,
 * schema_version 2 (BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md A1–A3, migration 173).
 *
 * A THIN ADAPTER over the standard invoice creator (lib/invoices/create-invoice.ts), so a
 * Projects billing is issued by exactly the code a hand-keyed invoice is: Books-owned
 * numbering, AR by role (AR_CONTROL), per-line revenue accounts through the canonical
 * rev-rec resolver (revenue vs Deferred Revenue), sales tax, retainage, invoice events,
 * and customer terms for the due date.
 *
 * Exactly-once, three guarantors:
 *   1. the atomic claim + lease (167) — two drains never work one event row;
 *   2. invoices.source_event_id (170) AND invoices.source_ref = payload.source_ref (173),
 *      both unique per org — a re-delivered event OR a re-emitted billing (new event id,
 *      same business key) acks with the invoice that already exists;
 *   3. the GL entry's source_ref = 'job_billing:<payload.source_ref>' under 064's unique
 *      index — the ledger itself refuses a second post for the same billing request.
 *
 * Retainage (v2): lines carry the NET due; a negative line_type RETAINAGE line carries the
 * withheld amount. Books books DR AR (net) + DR RETAINAGE_RECEIVABLE (retainage_cents) /
 * CR revenue-or-deferred (gross_earned_cents). billing_subtype RETAINAGE_RELEASE books
 * DR AR / CR RETAINAGE_RECEIVABLE — no revenue.
 *
 * Gate: runs only for orgs with entitlements.projects = true (Books stands alone); for any
 * other org the event is left pending. An unsupported schema_version is REJECTED with an
 * error_code whatever the entitlement (the stop-gap) — keys are never silently ignored.
 *
 * Ack (on the core.events row, what pm.reconcile_billing_internal reads): status,
 * invoice_id, invoice_number, gl_entry_id, processed_at; error + error_code on rejection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice, type CreateInvoiceLineInput } from '@/lib/invoices/create-invoice';
import { resolveRole } from '@/lib/posting/account-roles';
import {
  claimPendingEvents,
  releaseEventClaims,
  renewEventClaim,
  type ClaimedEvent,
} from '@/lib/events/claim';
import {
  ackClaimedEvent,
  projectsEntitlementCache,
  rejectClaimedEvent,
  schemaVersionOf,
  SeamRejection,
  versionRejection,
} from '@/lib/events/seam';
import { applySeamDepositsToFinalInvoice, type AppliedSeamDeposit } from '@/lib/customer-deposits/seam-deposits';

type DB = SupabaseClient;

export type BillingLineType = 'STANDARD' | 'RETAINAGE' | 'RETAINAGE_RELEASE';
export type BillingSubtype = 'SOV' | 'RETAINAGE_RELEASE' | 'ALLOWANCE' | 'FIXED' | 'RECURRING';

interface BillingLine {
  description: string;
  amount_cents: number;
  item_id: string | null;
  /** v2 */
  line_type?: BillingLineType | null;
  /** v2 — a Projects (pm) cost code; informational on the Books side. */
  cost_code_id?: string | null;
}

export interface BillingPayload {
  event_id: string; job_id: string; location_id: string; billing_type: string;
  occurred_on: string; source_ref: string; memo: string | null; lines: BillingLine[];
  /** v2 additive keys (absent = 1). */
  schema_version?: number;
  billing_subtype?: BillingSubtype | null;
  gross_earned_cents?: number | null;
  retainage_cents?: number | null;
  retainage_released_cents?: number | null;
  application_no?: number | null;
  period_end?: string | null;
  /** Forward-compatible: Projects marks its final billing explicitly (open question). */
  is_final?: boolean | null;
}

export interface BillingDrainResult {
  processed: number;
  rejected: number;
  /** Events left pending: another drain owns them, or Projects is not enabled for the org. */
  skipped?: number;
  results: {
    event_id: string;
    status: 'processed' | 'rejected' | 'skipped';
    invoice_number?: string;
    error?: string;
    error_code?: string;
  }[];
}

export const SUPPORTED_BILLING_SUBTYPES: readonly BillingSubtype[] = ['SOV', 'RETAINAGE_RELEASE', 'ALLOWANCE', 'FIXED', 'RECURRING'];
const LINE_TYPES: readonly BillingLineType[] = ['STANDARD', 'RETAINAGE', 'RETAINAGE_RELEASE'];

// ── The billing plan (pure; unit-tested) ─────────────────────────────────────

export interface BillingPlan {
  version: number;
  subtype: BillingSubtype | null;
  /** STANDARD lines → revenue (rev-rec routed). */
  revenueLines: { description: string; amount_cents: number; item_id: string | null }[];
  /** RETAINAGE_RELEASE lines → CR Retainage receivable (no revenue). */
  releaseLines: { description: string; amount_cents: number }[];
  grossCents: number;
  retainageCents: number;
  releasedCents: number;
  /** Amount due on the invoice before tax (= gross − retainage + released). */
  netCents: number;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Validate a JOB_BILLING payload and split it into what Books books. Throws
 * SeamRejection; never ignores a key it does not understand.
 */
export function planBilling(p: BillingPayload): BillingPlan {
  const version = schemaVersionOf(p);
  if (!p.source_ref || typeof p.source_ref !== 'string') {
    throw new SeamRejection('MISSING_SOURCE_REF', 'The billing has no source_ref (business key)');
  }
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length === 0) throw new SeamRejection('NO_BILLABLE_LINES', 'The billing has no lines');
  for (const l of lines) {
    const amt = typeof l.amount_cents === 'string' ? Number(l.amount_cents) : l.amount_cents;
    if (!isInt(amt)) throw new SeamRejection('INVALID_AMOUNT', `Line "${l.description}" amount is not whole cents`);
  }
  const amountOf = (l: BillingLine) => Number(l.amount_cents);

  const subtype = (version >= 2 ? (p.billing_subtype ?? null) : null) as BillingSubtype | null;
  if (subtype !== null && !SUPPORTED_BILLING_SUBTYPES.includes(subtype)) {
    throw new SeamRejection('UNSUPPORTED_BILLING_SUBTYPE', `billing_subtype ${String(subtype)} is not supported by Merit Books`);
  }

  // v1 (FROZEN v3) carries no line_type: a negative line is the withheld retainage.
  const typeOf = (l: BillingLine): BillingLineType => {
    if (version < 2) return amountOf(l) < 0 ? 'RETAINAGE' : 'STANDARD';
    const t = (l.line_type ?? 'STANDARD') as BillingLineType;
    if (!LINE_TYPES.includes(t)) throw new SeamRejection('UNSUPPORTED_LINE_TYPE', `line_type ${String(l.line_type)} is not supported`);
    return t;
  };

  const revenueLines: BillingPlan['revenueLines'] = [];
  const releaseLines: BillingPlan['releaseLines'] = [];
  let retainage = 0;
  for (const l of lines) {
    const t = typeOf(l);
    const amt = amountOf(l);
    if (subtype === 'RETAINAGE_RELEASE') {
      if (t !== 'RETAINAGE_RELEASE') throw new SeamRejection('UNSUPPORTED_LINE_TYPE', `A retainage release may only carry RETAINAGE_RELEASE lines (got ${t})`);
      if (amt <= 0) throw new SeamRejection('INVALID_AMOUNT', 'A retainage release line must be positive');
      releaseLines.push({ description: l.description || 'Retainage release', amount_cents: amt });
      continue;
    }
    if (t === 'RETAINAGE_RELEASE') throw new SeamRejection('UNSUPPORTED_LINE_TYPE', 'RETAINAGE_RELEASE lines need billing_subtype RETAINAGE_RELEASE');
    if (t === 'RETAINAGE') {
      if (amt > 0) throw new SeamRejection('INVALID_AMOUNT', 'A RETAINAGE line must be zero or negative');
      retainage += -amt;
      continue;
    }
    if (amt < 0) throw new SeamRejection('INVALID_AMOUNT', `Line "${l.description}" is negative — reductions go through a credit memo`);
    if (amt === 0) continue;
    revenueLines.push({ description: l.description || 'Billing', amount_cents: amt, item_id: l.item_id ?? null });
  }

  const gross = revenueLines.reduce((s, l) => s + l.amount_cents, 0);
  const released = releaseLines.reduce((s, l) => s + l.amount_cents, 0);

  if (version >= 2) {
    if (subtype === 'RETAINAGE_RELEASE') {
      if (p.retainage_released_cents != null && Number(p.retainage_released_cents) !== released) {
        throw new SeamRejection('RETAINAGE_TIE', `retainage_released_cents ${p.retainage_released_cents} ≠ Σ release lines ${released}`);
      }
    } else {
      if (p.retainage_cents != null && Number(p.retainage_cents) !== retainage) {
        throw new SeamRejection('RETAINAGE_TIE', `retainage_cents ${p.retainage_cents} ≠ −Σ RETAINAGE lines ${retainage}`);
      }
      if (p.gross_earned_cents != null && Number(p.gross_earned_cents) !== gross) {
        throw new SeamRejection('GROSS_TIE', `gross_earned_cents ${p.gross_earned_cents} ≠ Σ STANDARD lines ${gross}`);
      }
    }
  }

  const net = gross - retainage + released;
  if (net <= 0) throw new SeamRejection('NO_BILLABLE_LINES', 'Nothing is due on this billing (net ≤ 0)');
  return { version, subtype, revenueLines, releaseLines, grossCents: gross, retainageCents: retainage, releasedCents: released, netCents: net };
}

/** The GL source_ref of a seam billing (064 unique index: one entry per billing request). */
export function billingGlSourceRef(sourceRef: string): string {
  return `job_billing:${sourceRef}`;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

interface ExistingInvoice { id: string; invoice_number: string; gl_entry_id: string | null; job_id: string | null; customer_id: string; location_id: string; billing_subtype: string | null; created_at: string }

/** A header without its entry younger than this is another drain mid-issue, not a partial. */
const IN_FLIGHT_MS = 15 * 60 * 1000;

async function findExistingInvoice(db: DB, orgId: string, eventRowId: string, sourceRef: string | null): Promise<ExistingInvoice | null> {
  const cols = 'id, invoice_number, gl_entry_id, job_id, customer_id, location_id, billing_subtype, created_at';
  const { data: byEvent } = await db.from('invoices').select(cols).eq('org_id', orgId).eq('source_event_id', eventRowId).maybeSingle();
  if (byEvent) return byEvent as ExistingInvoice;
  if (!sourceRef) return null;
  const { data: byRef } = await db.from('invoices').select(cols).eq('org_id', orgId).eq('source_ref', sourceRef).maybeSingle();
  return (byRef as ExistingInvoice | null) ?? null;
}

/** The org's default operating-revenue account (last resort for a line's revenue account). */
async function defaultRevenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id, account_number, name')
    .eq('org_id', orgId)
    .eq('account_type', 'REVENUE')
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  return (rows.find((r) => /service|sales|contract|operating/i.test(r.name)) ?? rows[0]).id;
}

/** Per-line revenue account: the item's income account → the job's revenue account → org default. */
async function lineRevenueAccount(
  db: DB, orgId: string, itemId: string | null, jobRevenueAccountId: string | null, fallback: () => Promise<string | null>,
): Promise<string | null> {
  if (itemId) {
    const { data } = await db.schema('core').from('items').select('income_account_id').eq('org_id', orgId).eq('id', itemId).maybeSingle();
    const acct = (data as { income_account_id: string | null } | null)?.income_account_id ?? null;
    if (acct) return acct;
  }
  return jobRevenueAccountId ?? (await fallback());
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Is this the job's final billing? Explicit `is_final`, else (pm.guard_final_billed's
 * rule) gross billed on Books' Projects invoices for the job, excluding retainage
 * releases and deposit invoices, has reached the job's contract value (pinned by
 * JOB_PROGRESS).
 */
async function isFinalBilling(db: DB, orgId: string, jobId: string, payload: BillingPayload): Promise<boolean> {
  if (payload.is_final === true) return true;
  const { data: job } = await db.schema('core').from('jobs').select('contract_amount_cents').eq('org_id', orgId).eq('id', jobId).maybeSingle();
  const contract = Number((job as { contract_amount_cents?: unknown } | null)?.contract_amount_cents ?? 0);
  if (!(contract > 0)) return false;
  const { data: invs } = await db.from('invoices').select('subtotal_cents, billing_subtype, status, source_ref')
    .eq('org_id', orgId).eq('job_id', jobId).not('source_ref', 'is', null);
  const billed = ((invs ?? []) as { subtotal_cents: number | string; billing_subtype: string | null; status: string }[])
    .filter((i) => i.status !== 'VOIDED' && i.billing_subtype !== 'RETAINAGE_RELEASE' && i.billing_subtype !== 'DEPOSIT')
    .reduce((s, i) => s + Number(i.subtotal_cents ?? 0), 0);
  return billed >= contract;
}

// ── The drain ────────────────────────────────────────────────────────────────

/**
 * Process pending JOB_BILLING events. Each core.events row carries its own org_id
 * (FROZEN v3), and EVERY read/insert/post below is scoped to THAT event's org — so
 * a single drain safely spans all tenants without cross-tenant posting.
 *
 * `orgFilter` restricts the drain to one tenant (scheduler / member route / tests);
 * omit it to drain all tenants (cron secret). Callers pass the SERVICE-ROLE client.
 */
export async function processBillingEvents(
  db: DB,
  orgFilter?: string | null,
  opts: { claimed?: { token: string; rows: ClaimedEvent<BillingPayload>[] } } = {},
): Promise<BillingDrainResult> {
  const claim = opts.claimed ?? (await claimPendingEvents<BillingPayload>(db, { eventType: 'JOB_BILLING', orgId: orgFilter ?? null }));
  const projectsOn = projectsEntitlementCache(db);
  const out: BillingDrainResult = { processed: 0, rejected: 0, skipped: 0, results: [] };

  const skip = (ev: ClaimedEvent<BillingPayload>, why: string) => {
    out.skipped = (out.skipped ?? 0) + 1;
    out.results.push({ event_id: ev.event_id, status: 'skipped', error: why });
  };
  const reject = async (ev: ClaimedEvent<BillingPayload>, r: SeamRejection) => {
    if (!(await rejectClaimedEvent(db, ev.id, claim.token, r))) { skip(ev, 'Claimed by another drain'); return; }
    out.rejected++;
    out.results.push({ event_id: ev.event_id, status: 'rejected', error: r.message, error_code: r.code });
  };
  const ack = async (ev: ClaimedEvent<BillingPayload>, inv: { id: string; invoice_number: string; gl_entry_id: string | null }, meta: Record<string, unknown> | null) => {
    if (!(await ackClaimedEvent(db, ev.id, claim.token, { invoice_id: inv.id, invoice_number: inv.invoice_number, gl_entry_id: inv.gl_entry_id, meta }))) {
      skip(ev, 'Booked; finalized by the drain that now holds the event');
      return;
    }
    out.processed++;
    out.results.push({ event_id: ev.event_id, status: 'processed', invoice_number: inv.invoice_number });
  };

  try {
    for (const ev of claim.rows) {
      const orgId = ev.org_id;
      const p = ev.payload;
      try {
        // Only while this drain still holds the event (wave 2G).
        if (!(await renewEventClaim(db, ev.id, claim.token))) { skip(ev, 'Claimed by another drain'); continue; }

        // Stop-gap: an unsupported version is rejected whatever the entitlement.
        const vr = versionRejection('JOB_BILLING', p);
        if (vr) { await reject(ev, vr); continue; }

        // Books stands alone: no Projects, no seam work (the event stays pending).
        if (!(await projectsOn(orgId))) {
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Projects is not enabled for this organization');
          continue;
        }

        // Exactly-once: this event, or this business key, already invoiced → ack with it.
        const prior = await findExistingInvoice(db, orgId, ev.id, typeof p?.source_ref === 'string' ? p.source_ref : null);
        if (prior) {
          if (!prior.gl_entry_id) {
            if (Date.now() - new Date(prior.created_at).getTime() < IN_FLIGHT_MS) {
              await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
              skip(ev, 'Another drain is issuing this billing');
              continue;
            }
            await reject(ev, new SeamRejection('PARTIAL_INVOICE', `Invoice ${prior.invoice_number} exists for this billing without a GL entry — review it in Books`));
            continue;
          }
          const meta: Record<string, unknown> = { duplicate_of: prior.id };
          if (prior.job_id && prior.billing_subtype !== 'RETAINAGE_RELEASE' && (await isFinalBilling(db, orgId, prior.job_id, p))) {
            const dep = await applySeamDepositsToFinalInvoice(db, { orgId, actor: 'system', invoiceId: prior.id, jobId: prior.job_id, customerId: prior.customer_id, locationId: prior.location_id });
            if (dep.applied.length) meta.applied_deposits = dep.applied;
            if (dep.errors.length) meta.deposit_errors = dep.errors;
          }
          await ack(ev, prior, meta);
          continue;
        }

        const plan = planBilling(p);
        const r = await issueBillingInvoice(db, ev, plan);
        if (r.kind === 'reject') { await reject(ev, r.rejection); continue; }
        if (r.kind === 'race') {
          // A concurrent drain is booking the same business key: leave it pending for
          // the next run, which acks from that invoice.
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Another drain is issuing this billing');
          continue;
        }
        await ack(ev, r.invoice, r.meta);
      } catch (e) {
        await reject(ev, e instanceof SeamRejection ? e : new SeamRejection('CONSUMER_ERROR', e instanceof Error ? e.message : 'consumer error'));
      }
    }
  } finally {
    // Anything still pending under this claim (an abort mid-run) is handed back.
    await releaseEventClaims(db, claim.token).catch(() => 0);
  }

  return out;
}

type IssueResult =
  | { kind: 'ok'; invoice: { id: string; invoice_number: string; gl_entry_id: string | null }; meta: Record<string, unknown> | null }
  | { kind: 'reject'; rejection: SeamRejection }
  | { kind: 'race' };

/** Validate the context and issue the invoice through the standard creator. */
async function issueBillingInvoice(db: DB, ev: ClaimedEvent<BillingPayload>, plan: BillingPlan): Promise<IssueResult> {
  const orgId = ev.org_id;
  const p = ev.payload;
  const rej = (code: ConstructorParameters<typeof SeamRejection>[0], msg: string): IssueResult => ({ kind: 'reject', rejection: new SeamRejection(code, msg) });

  const { data: loc } = await db.schema('core').from('locations').select('id').eq('id', p.location_id).eq('org_id', orgId).maybeSingle();
  if (!loc) return rej('COMPANY_NOT_FOUND', 'Company not found');

  const { data: jobRow } = await db.schema('core').from('jobs').select('id, customer_id, revenue_account_id, location_id')
    .eq('id', p.job_id).eq('org_id', orgId).maybeSingle();
  const job = jobRow as { id: string; customer_id: string | null; revenue_account_id: string | null } | null;
  if (!job || !job.customer_id) return rej('NO_CUSTOMER', 'Job has no customer to bill');
  const customerId = job.customer_id;

  const { data: period } = await db.from('fiscal_periods').select('id, status').eq('org_id', orgId).eq('location_id', p.location_id)
    .lte('start_date', p.occurred_on).gte('end_date', p.occurred_on).maybeSingle();
  if (!period) return rej('NO_FISCAL_PERIOD', `No fiscal period for ${p.occurred_on}`);
  if ((period as { status: string }).status === 'HARD_CLOSE') return rej('PERIOD_CLOSED', `The period for ${p.occurred_on} is closed`);

  // Customer terms (not a flat +30 days).
  const { data: cust } = await db.schema('core').from('customers').select('payment_terms_days').eq('org_id', orgId).eq('id', customerId).maybeSingle();
  // The job's customer must be this org's customer (core.jobs.customer_id has no
  // tenant-checked FK) — never invoice a customer from another tenant.
  if (!cust) return rej('NO_CUSTOMER', "The job's customer was not found in this organization");
  const terms = Number((cust as { payment_terms_days?: unknown } | null)?.payment_terms_days ?? 30);
  const dueDate = addDays(p.occurred_on, Number.isFinite(terms) && terms >= 0 ? terms : 30);

  // Lines: revenue lines carry their own revenue account; release lines credit
  // Retainage receivable (no revenue).
  let fallbackRev: Promise<string | null> | null = null;
  const fallback = () => (fallbackRev ??= defaultRevenueAccount(db, orgId));
  const lines: CreateInvoiceLineInput[] = [];
  for (const l of plan.revenueLines) {
    const acct = await lineRevenueAccount(db, orgId, l.item_id, job.revenue_account_id, fallback);
    if (!acct) return rej('ACCOUNT_UNRESOLVED', 'No revenue account in the chart of accounts');
    lines.push({ description: l.description, account_id: acct, unit_price_cents: l.amount_cents, kind: 'REVENUE' });
  }
  if (plan.releaseLines.length > 0) {
    let retAcct: string;
    try {
      retAcct = (await resolveRole(db, orgId, 'RETAINAGE_RECEIVABLE')).id;
    } catch (e) {
      return rej('ACCOUNT_UNRESOLVED', e instanceof Error ? e.message : 'Retainage receivable account missing');
    }
    for (const l of plan.releaseLines) {
      lines.push({ description: l.description, account_id: retAcct, unit_price_cents: l.amount_cents, kind: 'BALANCE_SHEET' });
    }
  }

  const subtypeLabel = plan.subtype ?? (['PROGRESS', 'MILESTONE', 'TIME_MATERIALS', 'DRAW'].includes(p.billing_type) ? p.billing_type : null);
  const outcome = await createInvoice(db, {
    orgId,
    actor: 'system',
    input: {
      location_id: p.location_id,
      customer_id: customerId,
      job_id: p.job_id,
      invoice_date: p.occurred_on,
      due_date: dueDate,
      memo: p.memo ?? `Billing (${p.billing_type}${plan.subtype ? ` · ${plan.subtype}` : ''})`,
      auto_tax: plan.revenueLines.length > 0,
      retainage_cents: plan.retainageCents,
      is_progress_bill: p.billing_type === 'PROGRESS' || p.billing_type === 'MILESTONE',
      application_number: p.application_no ?? null,
      source: { event_row_id: ev.id, source_ref: p.source_ref, billing_subtype: subtypeLabel },
      gl_source_ref: billingGlSourceRef(p.source_ref),
      post_to_gl: true,
      strict_gl: true,
      lines,
    },
  });

  if (!outcome.ok) {
    if (outcome.code === 'DUPLICATE_SOURCE') return { kind: 'race' };
    if (outcome.code === 'GL_POST_FAILED') {
      // 064: the ledger already holds this billing request's entry (a lost race on the
      // business key) — not an error, the winner's invoice acks it next run.
      if (/duplicate key|uq_gl_entries_org_source_type/i.test(outcome.error)) return { kind: 'race' };
      return rej('GL_POST_FAILED', outcome.error);
    }
    return rej('INVOICE_FAILED', outcome.error);
  }

  const inv = { id: outcome.result.invoice_id, invoice_number: outcome.result.invoice_number, gl_entry_id: outcome.result.gl_entry_id ?? null };
  const meta: Record<string, unknown> = {
    schema_version: plan.version,
    billing_subtype: plan.subtype,
    gross_earned_cents: plan.grossCents,
    retainage_cents: plan.retainageCents,
    retainage_released_cents: plan.releasedCents,
    tax_cents: outcome.result.tax_cents ?? 0,
    total_cents: outcome.result.total_cents,
  };

  // Final billing → apply the job's collected deposit requests (existing apply flow).
  if (plan.subtype !== 'RETAINAGE_RELEASE' && (await isFinalBilling(db, orgId, p.job_id, p))) {
    const dep = await applySeamDepositsToFinalInvoice(db, { orgId, actor: 'system', invoiceId: inv.id, jobId: p.job_id, customerId, locationId: p.location_id });
    if (dep.applied.length) meta.applied_deposits = dep.applied satisfies AppliedSeamDeposit[];
    if (dep.errors.length) meta.deposit_errors = dep.errors;
  }
  return { kind: 'ok', invoice: inv, meta };
}
