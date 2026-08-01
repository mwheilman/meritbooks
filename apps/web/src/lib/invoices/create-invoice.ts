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

export interface CreateInvoiceLineInput {
  description: string;
  account_id: string;
  quantity?: number;
  unit_price_cents: number;
  job_phase_id?: string | null;
  cost_code_id?: string | null;
}

export interface CreateInvoiceInput {
  location_id: string;
  customer_id: string;
  job_id?: string | null;
  invoice_date: string;
  due_date: string;
  memo?: string | null;
  tax_cents?: number;
  retainage_pct?: number;
  is_progress_bill?: boolean;
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
}

export type CreateInvoiceOutcome =
  | { ok: true; result: CreateInvoiceResult }
  | { ok: false; status: number; error: string };

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
  const taxCents = input.tax_cents ?? 0;

  // Mint the Books-owned invoice number: INV-{YYYYMMDD}-{seq} (per-org sequence).
  const dateStr = input.invoice_date.replace(/-/g, '');
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);
  const seq = String((count ?? 0) + 1).padStart(4, '0');
  const invoiceNumber = `INV-${dateStr}-${seq}`;

  // Line extended amounts + subtotal.
  const lines = input.lines.map((l, i) => ({
    ...l,
    quantity: l.quantity ?? 1,
    line_number: i + 1,
    amount_cents: Math.round((l.quantity ?? 1) * l.unit_price_cents),
  }));
  const subtotalCents = lines.reduce((s, l) => s + l.amount_cents, 0);

  // Retainage is conditional: only customers/jobs that opted in withhold it.
  // Resolve job → customer; if neither enabled, no retainage regardless of pct.
  const [{ data: custR }, { data: jobR }] = await Promise.all([
    supabase.schema('core').from('customers').select('retainage_enabled, default_retainage_pct').eq('id', input.customer_id).maybeSingle(),
    input.job_id
      ? supabase.schema('core').from('jobs').select('retainage_enabled, default_retainage_pct').eq('id', input.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const j = jobR as { retainage_enabled: boolean | null; default_retainage_pct: number | null } | null;
  const c = custR as { retainage_enabled: boolean | null; default_retainage_pct: number | null } | null;
  const retainageEnabled = j?.retainage_enabled ?? c?.retainage_enabled ?? false;
  const passedPct = input.retainage_pct ?? 0;
  const resolvedPct = passedPct > 0 ? passedPct : Number(j?.default_retainage_pct ?? c?.default_retainage_pct ?? 0);
  const retainageCents = retainageEnabled && resolvedPct > 0 ? Math.round(subtotalCents * resolvedPct / 100) : 0;
  const totalCents = subtotalCents + taxCents - retainageCents;

  // Insert invoice header.
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .insert({
      org_id: orgId,
      location_id: input.location_id,
      customer_id: input.customer_id,
      job_id: input.job_id ?? null,
      invoice_number: invoiceNumber,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      retainage_cents: retainageCents,
      total_cents: totalCents,
      status: 'DRAFT',
      is_progress_bill: input.is_progress_bill ?? false,
      memo: input.memo ?? null,
    })
    .select('id, invoice_number')
    .single();

  if (invErr || !invoice) {
    return { ok: false, status: 500, error: invErr?.message ?? 'Failed to create invoice' };
  }

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
    return { ok: false, status: 500, error: linesErr.message };
  }

  await recordInvoiceEvent(supabase, {
    orgId, invoiceId: invoice.id, type: 'CREATED', actor,
    meta: { invoice_number: invoiceNumber, total_cents: totalCents },
  });

  let posted = false;

  // Optionally post to GL. Rev-rec-aware: a line tied to a rev-rec-managed job
  // credits Deferred Revenue (2410) via the SHARED resolver, the same one the
  // Projects-driven JOB_BILLING consumer uses, so the two never disagree.
  if (input.post_to_gl && totalCents > 0) {
    try {
      // Find the AR control account (12xxx range).
      const { data: arAccount } = await supabase
        .from('accounts')
        .select('id')
        .eq('org_id', orgId)
        .gte('account_number', '12000')
        .lt('account_number', '13000')
        .eq('is_active', true)
        .limit(1)
        .single();

      if (arAccount) {
        const creditLines = await resolveInvoiceCreditAccounts(supabase, {
          orgId,
          locationId: input.location_id,
          jobId: input.job_id,
          lines: lines.map((l) => ({ account_id: l.account_id, amount_cents: l.amount_cents })),
        });

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
            memo: cl.deferred ? 'Deferred revenue' : 'Revenue',
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
          created_by: null,
          lines: jeLines,
        });

        if (jeResult.success) {
          await supabase.from('invoices')
            .update({ gl_entry_id: jeResult.entry_id, status: 'SENT' })
            .eq('id', invoice.id);
          await recordInvoiceEvent(supabase, {
            orgId, invoiceId: invoice.id, type: 'POSTED', actor,
            meta: { gl_entry_id: jeResult.entry_id, total_cents: totalCents },
          });
          posted = true;
        } else {
          console.error('[createInvoice] GL post failed, invoice left DRAFT:', jeResult.error);
        }
      }
    } catch (glErr) {
      console.error('[createInvoice] GL posting skipped:', glErr instanceof Error ? glErr.message : glErr);
    }
  }

  return { ok: true, result: { invoice_id: invoice.id, invoice_number: invoiceNumber, total_cents: totalCents, posted } };
}
