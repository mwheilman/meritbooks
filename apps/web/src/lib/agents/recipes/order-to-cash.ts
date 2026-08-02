/**
 * ORDER-TO-CASH recipe (M9) — the supervised revenue loop.
 *
 * Chains the pieces that ALREADY exist, stopping at the human gate before anything
 * hits the ledger:
 *
 *   1. propose_invoice (PROPOSE)     Take the proposed invoice (customer + lines +
 *                                    dates, from a contract/SOW proposal or a hand
 *                                    keyed draft) and PREVIEW its AR posting through
 *                                    the SHARED rev-rec resolver (lib/invoices/
 *                                    rev-rec-credit) — showing which credit lands in
 *                                    Revenue vs Deferred Revenue (2410) for a
 *                                    rev-rec-managed job. NOTHING is persisted and NO
 *                                    GL is posted; this only records the proposal.
 *   2. approve_and_post (HUMAN_GATE) ALWAYS pauses. On the human's explicit APPROVE the
 *                                    EXISTING gated invoice-create/rev-rec engine
 *                                    (lib/invoices/create-invoice, post_to_gl:true)
 *                                    creates the invoice AND posts the rev-rec-aware AR
 *                                    journal entry (DR AR / CR Revenue-or-Deferred, +
 *                                    sales tax + retainage legs). The runner never posts
 *                                    on its own — the human at this gate is the sole
 *                                    authorization for the ledger effect (canon §3).
 *   3. send_invoice   (AUTO)         Email the posted invoice to the customer through the
 *                                    EXISTING send path (lib/invoices/send-invoice). If
 *                                    email is unconfigured or the provider rejects, the
 *                                    step PAUSES with a prompt to fix + retry — it never
 *                                    silently claims a send that did not happen.
 *
 * SAFETY (canon §3): no step posts money or hits the GL without the human gate. The only
 * ledger effect — the AR journal entry — is performed entirely by the pre-existing,
 * deterministic createInvoice engine, and only after a human APPROVES at step 2. Deferred
 * Revenue treatment for rev-rec-managed jobs is owned by the shared resolver, so this loop
 * can never disagree with the Projects-driven JOB_BILLING consumer.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import { createInvoice, type CreateInvoiceLineInput } from '@/lib/invoices/create-invoice';
import { resolveInvoiceCreditAccounts } from '@/lib/invoices/rev-rec-credit';
import { sendInvoiceById } from '@/lib/invoices/send-invoice';

const INVOICE_FEATURE = 'INVOICE';

interface O2CLine extends CreateInvoiceLineInput {
  amount_cents: number;
}

interface O2CInput {
  locationId: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  jobId: string | null;
  taxCents: number;
  retainagePct: number;
  isProgressBill: boolean;
  memo: string | null;
  send: boolean;
  lines: O2CLine[];
}

/** ISO yyyy-mm-dd for `today` (UTC), optionally offset by whole days. */
function isoDate(offsetDays = 0): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays));
  return t.toISOString().slice(0, 10);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Normalize the loose start input into a validated O2C input, or an error string. */
function parseInput(input: Record<string, unknown>): O2CInput | { error: string } {
  // Support a nested `invoice` object or flat fields.
  const src = (input.invoice && typeof input.invoice === 'object'
    ? (input.invoice as Record<string, unknown>)
    : input) as Record<string, unknown>;

  const locationId = asString(src.location_id) ?? asString(src.locationId);
  if (!locationId) return { error: 'A location_id is required to propose an invoice.' };
  const customerId = asString(src.customer_id) ?? asString(src.customerId);
  if (!customerId) return { error: 'A customer_id is required to propose an invoice.' };

  const rawLines = Array.isArray(src.lines) ? src.lines : [];
  const lines: O2CLine[] = [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as Record<string, unknown>;
    const description = asString(l.description);
    const accountId = asString(l.account_id) ?? asString(l.accountId);
    const unitPrice = asNumber(l.unit_price_cents ?? l.unitPriceCents, NaN);
    if (!description || !accountId || !Number.isFinite(unitPrice)) continue;
    const quantity = asNumber(l.quantity, 1) || 1;
    lines.push({
      description,
      account_id: accountId,
      quantity,
      unit_price_cents: Math.round(unitPrice),
      job_phase_id: asString(l.job_phase_id ?? l.jobPhaseId),
      cost_code_id: asString(l.cost_code_id ?? l.costCodeId),
      amount_cents: Math.round(quantity * unitPrice),
    });
  }
  if (lines.length === 0) {
    return { error: 'At least one valid line (description, account_id, unit_price_cents) is required.' };
  }

  const invoiceDate = isIsoDate(src.invoice_date) ? src.invoice_date : isIsoDate(src.invoiceDate) ? src.invoiceDate : isoDate(0);
  const dueDate = isIsoDate(src.due_date) ? src.due_date : isIsoDate(src.dueDate) ? src.dueDate : isoDate(30);

  return {
    locationId,
    customerId,
    invoiceDate,
    dueDate,
    jobId: asString(src.job_id) ?? asString(src.jobId),
    taxCents: Math.max(0, Math.round(asNumber(src.tax_cents ?? src.taxCents, 0))),
    retainagePct: Math.max(0, Math.min(100, asNumber(src.retainage_pct ?? src.retainagePct, 0))),
    isProgressBill: src.is_progress_bill === true || src.isProgressBill === true,
    memo: asString(src.memo),
    send: src.send !== false, // default: email after posting unless explicitly false
    lines,
  };
}

/** Rehydrate the O2C input persisted in run state (JSON round-trips as plain objects). */
function inputFromState(state: AgentState): O2CInput {
  return (state.o2c as O2CInput) ?? parseInputOrThrow(state);
}
function parseInputOrThrow(state: AgentState): O2CInput {
  const parsed = parseInput(state as Record<string, unknown>);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

interface CustomerRow {
  name: string;
  email: string | null;
}

async function loadCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<CustomerRow | null> {
  const { data } = await supabase
    .schema('core')
    .from('customers')
    .select('name, email')
    .eq('id', customerId)
    .maybeSingle();
  return (data as CustomerRow | null) ?? null;
}

export const orderToCashRecipe: AgentRecipe = {
  key: 'ORDER_TO_CASH',
  label: 'Order-to-Cash',
  description:
    'Turns a proposed invoice (from a customer contract/SOW or a draft) into revenue the safe way: previews the rev-rec-aware AR posting, pauses for a human to approve, posts the invoice through the existing gated engine (Deferred Revenue for rev-rec-managed jobs), then emails it. No ledger effect without the human gate.',
  feature: INVOICE_FEATURE,

  async init(ctx, input) {
    const parsed = parseInput(input);
    if ('error' in parsed) return { error: parsed.error };

    const customer = await loadCustomer(ctx.supabase, parsed.customerId);
    if (!customer) return { error: 'Customer not found (or not in your organization).' };

    const subtotalCents = parsed.lines.reduce((s, l) => s + l.amount_cents, 0);
    const previewTotal = subtotalCents + parsed.taxCents;

    const state: AgentState = {
      o2c: parsed,
      customerName: customer.name,
      customerEmail: customer.email,
      subtotalCents,
      previewTotalCents: previewTotal,
    };

    return {
      title: `Order-to-cash · ${customer.name} · ${formatMoney(previewTotal)}`,
      state,
      // No subject yet — the invoice does not exist until the human approves the post.
    };
  },

  steps: [
    // ── 1. Propose the invoice + preview its rev-rec posting (PROPOSE) ─────────
    {
      name: 'propose_invoice',
      label: 'Propose invoice & preview rev-rec',
      kind: 'PROPOSE',
      feature: INVOICE_FEATURE,
      async execute(ctx, state): Promise<StepExecuteResult> {
        const o2c = inputFromState(state);
        const customerName = (state.customerName as string | null) ?? 'the customer';
        const subtotalCents = o2c.lines.reduce((s, l) => s + l.amount_cents, 0);

        // Preview the AR credit split through the SHARED rev-rec resolver — the same
        // one createInvoice will use when it posts, so the preview never lies.
        let deferredCents = 0;
        let revenueCents = 0;
        let revRecNote = 'Credits Revenue (no rev-rec-managed job).';
        try {
          const creditLines = await resolveInvoiceCreditAccounts(ctx.supabase, {
            orgId: ctx.orgId,
            locationId: o2c.locationId,
            jobId: o2c.jobId,
            lines: o2c.lines.map((l) => ({ account_id: l.account_id, amount_cents: l.amount_cents })),
          });
          for (const cl of creditLines) {
            if (cl.deferred) deferredCents += cl.amount_cents;
            else revenueCents += cl.amount_cents;
          }
          revRecNote =
            deferredCents > 0
              ? `Rev-rec-managed job: ${formatMoney(deferredCents)} credits Deferred Revenue (2410); ${formatMoney(revenueCents)} credits Revenue.`
              : 'Credits Revenue on issue (billing is the recognition event).';
        } catch {
          // Resolver degrade (COA/role gap) — the post step surfaces it; the preview
          // falls back to "credits Revenue" without blocking the proposal.
          revenueCents = subtotalCents;
        }

        const totalCents = subtotalCents + o2c.taxCents;
        return {
          status: 'DONE',
          summary: `Proposed invoice for ${customerName}: ${o2c.lines.length} line${o2c.lines.length === 1 ? '' : 's'}, ${formatMoney(totalCents)}. ${revRecNote}`,
          statePatch: { subtotalCents, previewTotalCents: totalCents, deferredCents, revenueCents },
          output: {
            customer: customerName,
            lineCount: o2c.lines.length,
            subtotalCents,
            taxCents: o2c.taxCents,
            totalCents,
            deferredCents,
            revenueCents,
            revRecNote,
            invoiceDate: o2c.invoiceDate,
            dueDate: o2c.dueDate,
          },
        };
      },
    },

    // ── 2. Approve & post — the ONLY step that hits the GL (HUMAN_GATE) ────────
    {
      name: 'approve_and_post',
      label: 'Approve & post invoice',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const customerName = (state.customerName as string | null) ?? 'the customer';
        const totalCents = Number(state.previewTotalCents ?? 0);
        const deferredCents = Number(state.deferredCents ?? 0);
        const email = (state.customerEmail as string | null) ?? null;
        const o2c = inputFromState(state);

        const creditWhere =
          deferredCents > 0 ? 'Deferred Revenue (2410) + Revenue' : 'Revenue';
        const sendClause = o2c.send
          ? email
            ? ` It will then be emailed to ${email}.`
            : ' (No customer email on file — the send step will pause for you to send manually.)'
          : ' (Email will be skipped per the run request.)';

        return {
          status: 'WAITING',
          summary: `Awaiting approval to create & post the invoice for ${customerName} (${formatMoney(totalCents)}).`,
          gatePrompt: `Approve to create and post this invoice for ${customerName} — ${formatMoney(totalCents)}, posting DR Accounts Receivable / CR ${creditWhere} through the deterministic engine.${sendClause} Reject to stop; the agent never posts on your behalf.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        const o2c = inputFromState(state);
        const customerName = (state.customerName as string | null) ?? 'the customer';

        const outcome = await createInvoice(ctx.supabase, {
          orgId: ctx.orgId,
          actor: ctx.userId,
          input: {
            location_id: o2c.locationId,
            customer_id: o2c.customerId,
            job_id: o2c.jobId,
            invoice_date: o2c.invoiceDate,
            due_date: o2c.dueDate,
            memo: o2c.memo,
            tax_cents: o2c.taxCents,
            retainage_pct: o2c.retainagePct,
            is_progress_bill: o2c.isProgressBill,
            post_to_gl: true, // the human just approved the ledger effect
            lines: o2c.lines.map((l) => ({
              description: l.description,
              account_id: l.account_id,
              quantity: l.quantity,
              unit_price_cents: l.unit_price_cents,
              job_phase_id: l.job_phase_id ?? null,
              cost_code_id: l.cost_code_id ?? null,
            })),
          },
        });

        if (!outcome.ok) {
          return { status: 'FAILED', summary: `Invoice post failed: ${outcome.error}` };
        }

        const { invoice_id, invoice_number, total_cents, posted } = outcome.result;
        const summary = posted
          ? `Reviewer approved — posted invoice ${invoice_number} for ${customerName} (${formatMoney(total_cents)}) via the deterministic AR engine.`
          : `Reviewer approved — created invoice ${invoice_number} (${formatMoney(total_cents)}), but the GL post was skipped (COA/role gap); it is DRAFT. Post it manually from Invoices.`;

        return {
          status: 'DONE',
          summary,
          statePatch: { invoiceId: invoice_id, invoiceNumber: invoice_number, posted },
          subject: { table: 'invoices', id: invoice_id },
          output: { invoiceId: invoice_id, invoiceNumber: invoice_number, totalCents: total_cents, posted },
        };
      },
    },

    // ── 3. Send the invoice to the customer (AUTO, degrade-safe) ───────────────
    {
      name: 'send_invoice',
      label: 'Email invoice to customer',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const o2c = inputFromState(state);
        const invoiceId = state.invoiceId as string | undefined;
        if (!invoiceId) {
          return { status: 'FAILED', summary: 'No invoice id in state — nothing to send.' };
        }
        if (!o2c.send) {
          return { status: 'DONE', summary: 'Send skipped per the run request. The invoice is posted and available in Invoices.' };
        }
        return sendInvoiceStep(ctx, invoiceId);
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // Human fixed the email issue and asked to retry the send.
        const invoiceId = state.invoiceId as string | undefined;
        if (!invoiceId) return { status: 'DONE', summary: 'No invoice to send.' };
        return sendInvoiceStep(ctx, invoiceId);
      },
    },
  ],
};

/** Send the invoice; map the send result to a step outcome (DONE / WAITING to retry). */
async function sendInvoiceStep(ctx: AgentRunContext, invoiceId: string): Promise<StepExecuteResult> {
  const res = await sendInvoiceById(ctx.supabase, ctx.orgId, invoiceId, ctx.userId);
  if (res.ok) {
    return {
      status: 'DONE',
      summary: `Emailed the invoice to ${res.to} via ${res.provider}.`,
      output: { to: res.to, messageId: res.message_id, provider: res.provider, payUrl: res.pay_url },
    };
  }
  return {
    status: 'WAITING',
    summary: `Could not email the invoice: ${res.error}${res.detail ? ` (${res.detail})` : ''}`,
    gatePrompt: `The invoice is posted, but the email did not send: ${res.error}${res.detail ? ` — ${res.detail}` : ''}. Fix the issue (or send it manually from Invoices) and approve to retry, or reject to finish without emailing.`,
    output: { sendError: res.code ?? res.error, detail: res.detail ?? null },
  };
}
