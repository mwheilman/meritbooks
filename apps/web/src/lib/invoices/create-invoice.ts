/**
 * Shared invoice-create core.
 *
 * The single source of truth for turning a customer + lines + dates into a real
 * `public.invoices` row: it mints the Books-owned invoice number, computes the
 * subtotal, resolves conditional retainage (job → customer cascade), inserts the
 * header + lines, records the CREATED event, and — when asked — posts the
 * rev-rec-aware AR journal entry (DR AR / CR Revenue-or-Deferred, + sales tax and
 * retainage legs) and stamps POSTED.
 *
 * Both the interactive `POST /api/invoices` route AND the recurring-invoice
 * generator call this, so a scheduled invoice is created by EXACTLY the same code
 * as a hand-keyed one — numbering, rev-rec treatment, and GL posting never fork.
 * The Projects seam consumers (JOB_BILLING, JOB_DEPOSIT_REQUEST — migration 173) are
 * thin adapters over it too: they add the event provenance (source_event_id +
 * business-key source_ref, both unique), an explicit retainage amount, balance-sheet
 * lines (retainage release / deposit) and strict_gl (no invoice without its entry).
 *
 * GL posting is best-effort: a COA/role gap (no Deferred Revenue / Sales Tax /
 * Retainage account) leaves the invoice DRAFT rather than failing creation — the
 * invoice header already exists and must not be orphaned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveInvoiceCreditAccounts } from '@/lib/invoices/rev-rec-credit';
import { resolveRole } from '@/lib/posting/account-roles';
import { resolveInvoiceTax } from '@/lib/tax/resolve-invoice-tax';

export interface CreateInvoiceLineInput {
  description: string;
  account_id: string;
  quantity?: number;
  unit_price_cents: number;
  job_phase_id?: string | null;
  cost_code_id?: string | null;
  /**
   * REVENUE (default): a sale — credited through the rev-rec resolver (revenue or
   * Deferred Revenue) and part of the sales-tax base.
   * BALANCE_SHEET: credits `account_id` directly, never revenue, never taxed — e.g. a
   * retainage release (CR Retainage receivable) or a deposit invoice (CR Customer
   * deposits).
   */
  kind?: 'REVENUE' | 'BALANCE_SHEET';
}

/** Where an event-issued invoice came from (the seam consumers). */
export interface CreateInvoiceSource {
  /** core.events.id (170 unique: one invoice per event). */
  event_row_id?: string | null;
  /** Emitter business key (173 unique per org: one invoice per billing request). */
  source_ref?: string | null;
  billing_subtype?: string | null;
}

export interface CreateInvoiceInput {
  location_id: string;
  customer_id: string;
  job_id?: string | null;
  invoice_date: string;
  due_date: string;
  memo?: string | null;
  tax_cents?: number;
  /**
   * When true, compute sales tax deterministically from the tenant's configured
   * rate rows + the customer's jurisdiction (GATE 11d), overriding `tax_cents`.
   * Degrade-safe: no rate configured / exempt customer → tax = 0 (behaves as before).
   */
  auto_tax?: boolean;
  /** optional ship-to snapshot ({ state, city }) — wins over customer HQ for tax. */
  ship_to?: Record<string, unknown> | null;
  retainage_pct?: number;
  /**
   * Explicit retainage withheld on this invoice, in cents. When given (>= 0) it is used
   * verbatim — the emitter (Projects) is authoritative — and the pct cascade is skipped.
   */
  retainage_cents?: number;
  is_progress_bill?: boolean;
  /** AIA pay application # (invoices.application_number). */
  application_number?: number | null;
  /** Free-text invoice kind (invoices.invoice_type), e.g. 'Deposit'. */
  invoice_type?: string | null;
  /** Event provenance (seam consumers only). */
  source?: CreateInvoiceSource | null;
  /** GL source_ref for the AR entry (064 unique per org + entry_type → never double-posts). */
  gl_source_ref?: string | null;
  /**
   * When true, a GL posting failure is a creation failure: the invoice is removed and
   * the outcome is { ok: false, code: 'GL_POST_FAILED' } (an event-issued invoice must
   * never exist without its entry). Default false: leave it DRAFT (interactive path).
   */
  strict_gl?: boolean;
  /** When true, immediately post the AR journal entry and flip status → SENT. */
  post_to_gl?: boolean;
  lines: CreateInvoiceLineInput[];
}

export interface CreateInvoiceResult {
  invoice_id: string;
  invoice_number: string;
  total_cents: number;
  /** True when the AR journal entry posted (status SENT); false when left DRAFT. */
  posted: boolean;
  /** The AR journal entry, when posted. */
  gl_entry_id?: string | null;
  subtotal_cents?: number;
  tax_cents?: number;
  retainage_cents?: number;
}

/**
 * DUPLICATE_SOURCE: an invoice for this event / business key already exists (a
 * concurrent drain won) — the caller acks from that invoice. GL_POST_FAILED: strict_gl
 * and the entry did not post (the invoice was removed).
 */
export type CreateInvoiceFailureCode = 'DUPLICATE_SOURCE' | 'GL_POST_FAILED' | 'INSERT_FAILED';

export type CreateInvoiceOutcome =
  | { ok: true; result: CreateInvoiceResult }
  | { ok: false; status: number; error: string; code?: CreateInvoiceFailureCode };

/** Postgres unique_violation on a named index/constraint. */
function uniqueViolationOn(err: { code?: string; message?: string; details?: string } | null, needle: RegExp): boolean {
  if (!err) return false;
  const dup = err.code === '23505' || /duplicate key value/i.test(err.message ?? '');
  return dup && needle.test(`${err.message ?? ''} ${err.details ?? ''}`);
}

/**
 * Create one invoice for `orgId`. `actor` is the Clerk user id (or 'system' for
 * scheduled generation) — it attributes the invoice_events rows, never the GL
 * author columns (those stay null; Clerk ids are text, the columns are uuid).
 */
export async function createInvoice(
  supabase: SupabaseClient,
  args: { orgId: string; actor: string | null; input: CreateInvoiceInput },
): Promise<CreateInvoiceOutcome> {
  const { orgId, actor, input } = args;

  // Mint the Books-owned invoice number: INV-{YYYYMMDD}-{seq} (per-org sequence).
  // The (org_id, invoice_number) unique index is the guarantor; a concurrent creator
  // that took the same number makes the insert below retry with the next one.
  const dateStr = input.invoice_date.replace(/-/g, '');
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);
  let seqN = (count ?? 0) + 1;
  let invoiceNumber = `INV-${dateStr}-${String(seqN).padStart(4, '0')}`;

  // Line extended amounts + subtotal.
  const lines = input.lines.map((l, i) => ({
    ...l,
    quantity: l.quantity ?? 1,
    line_number: i + 1,
    amount_cents: Math.round((l.quantity ?? 1) * l.unit_price_cents),
  }));
  const subtotalCents = lines.reduce((s, l) => s + l.amount_cents, 0);
  const isRevenue = (l: { kind?: 'REVENUE' | 'BALANCE_SHEET' }) => (l.kind ?? 'REVENUE') === 'REVENUE';

  // Sales tax (GATE 11d). When `auto_tax`, compute the accrual deterministically from
  // the tenant's configured rate rows + the customer's jurisdiction; the resolved rate
  // is authoritative and overrides any passed `tax_cents`. Degrade-safe: no configured
  // rate or an exempt customer yields tax = 0, so the invoice behaves exactly as before.
  // Balance-sheet lines (retainage release, deposit) are never part of the tax base.
  let taxCents = input.tax_cents ?? 0;
  let resolvedTaxRatePct: number | null = null;
  let resolvedTaxJurisdiction: string | null = null;
  let resolvedTaxSource: string | null = null;
  if (input.auto_tax) {
    const taxable = lines.filter(isRevenue).map((l) => l.amount_cents);
    const resolved = taxable.length === 0
      ? null
      : await resolveInvoiceTax(supabase, {
        orgId,
        customerId: input.customer_id,
        onDate: input.invoice_date,
        lineAmountsCents: taxable,
        shipTo: input.ship_to ?? null,
      });
    taxCents = resolved?.taxCents ?? 0;
    if (resolved?.rateResolved) {
      resolvedTaxRatePct = resolved.ratePct;
      resolvedTaxJurisdiction = resolved.jurisdictionLabel;
      resolvedTaxSource = resolved.source; // rate provenance (INTERNAL_TABLE | AVALARA | …)
    } else if (resolved?.exempt) {
      resolvedTaxJurisdiction = 'EXEMPT';
    }
  }

  // Retainage. An explicit amount (the emitter is authoritative) is used verbatim.
  // Otherwise it is conditional: only customers/jobs that opted in withhold it —
  // resolve job → customer; if neither enabled, no retainage regardless of pct.
  let retainageCents = 0;
  if (input.retainage_cents != null && input.retainage_cents >= 0) {
    retainageCents = Math.round(input.retainage_cents);
  } else {
    const [{ data: custR }, { data: jobR }] = await Promise.all([
      supabase.schema('core').from('customers').select('retainage_enabled, default_retainage_pct').eq('id', input.customer_id).eq('org_id', orgId).maybeSingle(),
      input.job_id
        ? supabase.schema('core').from('jobs').select('retainage_enabled, default_retainage_pct').eq('id', input.job_id).eq('org_id', orgId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const j = jobR as { retainage_enabled: boolean | null; default_retainage_pct: number | null } | null;
    const c = custR as { retainage_enabled: boolean | null; default_retainage_pct: number | null } | null;
    const retainageEnabled = j?.retainage_enabled ?? c?.retainage_enabled ?? false;
    const passedPct = input.retainage_pct ?? 0;
    const resolvedPct = passedPct > 0 ? passedPct : Number(j?.default_retainage_pct ?? c?.default_retainage_pct ?? 0);
    retainageCents = retainageEnabled && resolvedPct > 0 ? Math.round(subtotalCents * resolvedPct / 100) : 0;
  }
  const totalCents = subtotalCents + taxCents - retainageCents;

  // Insert invoice header (retrying the number on a concurrent collision).
  const header: Record<string, unknown> = {
    org_id: orgId,
    location_id: input.location_id,
    customer_id: input.customer_id,
    job_id: input.job_id ?? null,
    invoice_date: input.invoice_date,
    due_date: input.due_date,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    retainage_cents: retainageCents,
    total_cents: totalCents,
    status: 'DRAFT',
    is_progress_bill: input.is_progress_bill ?? false,
    memo: input.memo ?? null,
  };
  if (input.application_number != null) header.application_number = input.application_number;
  if (input.invoice_type != null) header.invoice_type = input.invoice_type;
  if (input.source?.event_row_id) header.source_event_id = input.source.event_row_id;
  if (input.source?.source_ref) header.source_ref = input.source.source_ref;
  if (input.source?.billing_subtype) header.billing_subtype = input.source.billing_subtype;

  let created: { id: string; invoice_number: string } | null = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const { data, error: invErr } = await supabase
      .from('invoices')
      .insert({ ...header, invoice_number: invoiceNumber })
      .select('id, invoice_number')
      .single();
    if (!invErr && data) { created = data as { id: string; invoice_number: string }; break; }
    if (uniqueViolationOn(invErr, /source_ref|source_event/i)) {
      return { ok: false, status: 409, code: 'DUPLICATE_SOURCE', error: 'An invoice for this source already exists' };
    }
    if (uniqueViolationOn(invErr, /invoice_number/i)) {
      seqN++;
      invoiceNumber = `INV-${dateStr}-${String(seqN).padStart(4, '0')}`;
      continue;
    }
    return { ok: false, status: 500, code: 'INSERT_FAILED', error: invErr?.message ?? 'Failed to create invoice' };
  }
  if (!created) {
    return { ok: false, status: 500, code: 'INSERT_FAILED', error: 'Could not allocate an invoice number' };
  }
  const invoice = created;

  // Insert lines.
  const lineInserts = lines.map((l) => ({
    org_id: orgId,
    invoice_id: invoice.id,
    line_number: l.line_number,
    description: l.description,
    account_id: l.account_id,
    quantity: l.quantity,
    unit_price_cents: l.unit_price_cents,
    amount_cents: l.amount_cents,
    job_phase_id: l.job_phase_id ?? null,
    cost_code_id: l.cost_code_id ?? null,
  }));
  const { error: linesErr } = await supabase.from('invoice_lines').insert(lineInserts);
  if (linesErr) {
    await supabase.from('invoices').delete().eq('id', invoice.id);
    return { ok: false, status: 500, code: 'INSERT_FAILED', error: linesErr.message };
  }

  // Persist the resolved rate/jurisdiction for the return-prep rate reconciliation
  // and the invoice UI. Best-effort: the columns are a RESERVED-migration addition,
  // so if they aren't present yet this no-ops and creation is unaffected.
  if (resolvedTaxRatePct != null || resolvedTaxJurisdiction != null) {
    try {
      await supabase
        .from('invoices')
        .update({ tax_rate_pct: resolvedTaxRatePct, tax_jurisdiction: resolvedTaxJurisdiction })
        .eq('id', invoice.id);
    } catch {
      /* columns not present yet — the collected tax still flows via tax_cents. */
    }
  }

  await recordInvoiceEvent(supabase, {
    orgId, invoiceId: invoice.id, type: 'CREATED', actor,
    meta: {
      invoice_number: invoiceNumber,
      total_cents: totalCents,
      tax_cents: taxCents,
      ...(resolvedTaxRatePct != null ? { tax_rate_pct: resolvedTaxRatePct } : {}),
      ...(resolvedTaxJurisdiction != null ? { tax_jurisdiction: resolvedTaxJurisdiction } : {}),
      ...(resolvedTaxSource != null ? { tax_rate_source: resolvedTaxSource } : {}),
      ...(input.source?.source_ref ? { source_ref: input.source.source_ref } : {}),
    },
  });

  let posted = false;
  let glEntryId: string | null = null;
  let glError: string | null = null;

  // Optionally post to GL. Rev-rec-aware: a line tied to a rev-rec-managed job
  // credits Deferred Revenue (2410) via the SHARED resolver, the same one the
  // Projects-driven JOB_BILLING consumer uses, so the two never disagree.
  if (input.post_to_gl && totalCents > 0) {
    try {
      // Resolve the AR control account BY ROLE (AR_CONTROL → '1100'), the same
      // resolver the AR credit side / cash-application / reports use. This replaces
      // a broken string-range lookup (`account_number >= '12000' AND < '13000'`)
      // that lexicographically EXCLUDED the 4-digit '1100' AR account, so the DR
      // landed on the wrong asset (e.g. 1210 Job WIP / 1300 Prepaid) — breaking the
      // AR subledger ↔ GL 1100 tie. resolveRole throws PostingError on a COA/role
      // gap, which the surrounding catch turns into "leave the invoice DRAFT".
      const arAccount = await resolveRole(supabase, orgId, 'AR_CONTROL', input.location_id);

      if (arAccount) {
        // Revenue lines go through the rev-rec resolver; balance-sheet lines credit
        // their own account (never revenue).
        const revenueLines = lines.filter(isRevenue);
        const creditLines = [
          ...(await resolveInvoiceCreditAccounts(supabase, {
            orgId,
            locationId: input.location_id,
            jobId: input.job_id,
            lines: revenueLines.map((l) => ({ account_id: l.account_id, amount_cents: l.amount_cents })),
          })).map((cl) => ({ ...cl, memo: cl.deferred ? 'Deferred revenue' : 'Revenue' })),
          ...lines.filter((l) => !isRevenue(l)).map((l) => ({
            account_id: l.account_id, amount_cents: l.amount_cents, deferred: false, memo: l.description,
          })),
        ];

        const jobDim = input.job_id ?? undefined;
        const jeLines: Parameters<typeof postJournalEntry>[1]['lines'] = [
          {
            account_id: arAccount.id,
            debit_cents: totalCents,
            credit_cents: 0,
            location_id: input.location_id,
            job_id: jobDim,
            memo: 'Accounts receivable',
          },
          ...creditLines.map((cl) => ({
            account_id: cl.account_id,
            debit_cents: 0,
            credit_cents: cl.amount_cents,
            location_id: input.location_id,
            job_id: jobDim,
            memo: cl.memo,
          })),
        ];

        if (taxCents > 0) {
          const taxAcct = await resolveRole(supabase, orgId, 'SALES_TAX_PAYABLE');
          jeLines.push({
            account_id: taxAcct.id,
            debit_cents: 0,
            credit_cents: taxCents,
            location_id: input.location_id,
            job_id: jobDim,
            memo: 'Sales tax payable',
          });
        }

        if (retainageCents > 0) {
          const retAcct = await resolveRole(supabase, orgId, 'RETAINAGE_RECEIVABLE');
          jeLines.push({
            account_id: retAcct.id,
            debit_cents: retainageCents,
            credit_cents: 0,
            location_id: input.location_id,
            job_id: jobDim,
            memo: 'Retainage receivable',
          });
        }

        const jeResult = await postJournalEntry(supabase, {
          org_id: orgId,
          location_id: input.location_id,
          entry_date: input.invoice_date,
          entry_type: 'STANDARD',
          memo: `Invoice ${invoiceNumber} — ${input.memo ?? ''}`,
          source_module: 'AR',
          source_id: invoice.id,
          ...(input.gl_source_ref ? { source_ref: input.gl_source_ref } : {}),
          created_by: null,
          lines: jeLines,
        });

        if (jeResult.success && jeResult.entry_id) {
          glEntryId = jeResult.entry_id;
          await supabase.from('invoices')
            .update({ gl_entry_id: jeResult.entry_id, status: 'SENT' })
            .eq('id', invoice.id);
          await recordInvoiceEvent(supabase, {
            orgId, invoiceId: invoice.id, type: 'POSTED', actor,
            meta: { gl_entry_id: jeResult.entry_id, total_cents: totalCents },
          });
          posted = true;
        } else {
          glError = jeResult.error ?? 'GL post failed';
          console.error('[createInvoice] GL post failed, invoice left DRAFT:', jeResult.error);
        }
      }
    } catch (glErr) {
      glError = glErr instanceof Error ? glErr.message : String(glErr);
      console.error('[createInvoice] GL posting skipped:', glError);
    }
  }

  if (input.strict_gl && !posted) {
    // An event-issued invoice must never exist without its entry: remove it (lines and
    // invoice_events cascade) so a retry starts clean.
    await supabase.from('invoices').delete().eq('id', invoice.id).eq('org_id', orgId);
    return {
      ok: false,
      status: 422,
      code: 'GL_POST_FAILED',
      error: glError ?? (totalCents > 0 ? 'GL post failed' : 'Invoice total must be greater than zero'),
    };
  }

  return {
    ok: true,
    result: {
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      total_cents: totalCents,
      posted,
      gl_entry_id: glEntryId,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      retainage_cents: retainageCents,
    },
  };
}
