export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { fetchCoreMap } from '@/lib/stitch-core';
import { CASHAPP_FEATURE } from '@/lib/controls/cash-application';

/**
 * GET /api/cash-application/proposals
 *
 * The cash-application REVIEW surface: the open (PROPOSED) cash-application
 * proposals, enriched for a human to approve or adjust. Read-only. Every query
 * runs through the RLS-scoped client — org isolation is the database's job.
 *
 * For each proposal we return the deposit, the AI's proposed invoice picks, and
 * the FULL set of that customer's open invoices so the human can re-pick before
 * applying (the "if the match is wrong, pick the correct invoice(s)" path).
 *
 * Authorization: invoices:view — the same read surface as the AR ledger.
 */

interface ProposedOutput {
  bank_transaction_id?: string;
  customer_id?: string;
  invoice_ids?: string[];
  kind?: 'single' | 'sum_to_total';
  deposit_amount_cents?: number;
}

interface AiRow {
  id: string;
  confidence: number | string | null;
  reasoning: string | null;
  input_summary: string | null;
  proposed_output: ProposedOutput | null;
  created_at: string;
}

interface InvoiceCandidate {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  balanceCents: number;
}

function toNum(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId } = ctx;

  const guard = await requirePermission(userId, 'invoices', 'view');
  if (!guard.ok) return guard.response;

  const { data: aiData, error: aiErr } = await supabase
    .from('ai_decisions')
    .select('id, confidence, reasoning, input_summary, proposed_output, created_at')
    .eq('feature', CASHAPP_FEATURE)
    .eq('status', 'PROPOSED')
    .order('created_at', { ascending: false })
    .limit(100);
  if (aiErr) {
    console.error('[cash-application/proposals] load failed:', aiErr.message);
    return NextResponse.json({ error: 'Failed to load proposals', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const rows = (aiData ?? []) as AiRow[];
  if (rows.length === 0) {
    return NextResponse.json({ data: [], counts: { total: 0 } });
  }

  const bankTxnIds = rows.map((r) => r.proposed_output?.bank_transaction_id).filter(Boolean) as string[];
  const customerIds = Array.from(
    new Set(rows.map((r) => r.proposed_output?.customer_id).filter(Boolean) as string[]),
  );

  // Deposits.
  const { data: txnData } = await supabase
    .from('bank_transactions')
    .select('id, transaction_date, amount_cents, description, gl_entry_id')
    .in('id', bankTxnIds.length ? bankTxnIds : ['00000000-0000-0000-0000-000000000000']);
  const txnById = new Map<string, { date: string; amountCents: number; description: string | null; posted: boolean }>();
  for (const t of (txnData ?? []) as Array<{
    id: string;
    transaction_date: string;
    amount_cents: number | string;
    description: string | null;
    gl_entry_id: string | null;
  }>) {
    txnById.set(t.id, {
      date: t.transaction_date,
      amountCents: toNum(t.amount_cents),
      description: t.description,
      posted: Boolean(t.gl_entry_id),
    });
  }

  // All open invoices for the involved customers (the re-pick candidate set).
  const { data: invData } = await supabase
    .from('invoices')
    .select('id, customer_id, invoice_number, invoice_date, due_date, balance_cents, status')
    .in('customer_id', customerIds.length ? customerIds : ['00000000-0000-0000-0000-000000000000'])
    .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .gt('balance_cents', 0);
  const openByCustomer = new Map<string, InvoiceCandidate[]>();
  const invById = new Map<string, InvoiceCandidate>();
  for (const i of (invData ?? []) as Array<{
    id: string;
    customer_id: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string;
    balance_cents: number | string;
  }>) {
    const cand: InvoiceCandidate = {
      id: i.id,
      invoiceNumber: i.invoice_number,
      invoiceDate: i.invoice_date,
      dueDate: i.due_date,
      balanceCents: toNum(i.balance_cents),
    };
    invById.set(i.id, cand);
    const arr = openByCustomer.get(i.customer_id) ?? [];
    arr.push(cand);
    openByCustomer.set(i.customer_id, arr);
  }

  // Customer names (core schema — can't embed from public).
  const custMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'customers', 'id, name', customerIds);

  const data = rows.map((r) => {
    const po = r.proposed_output ?? {};
    const txn = po.bank_transaction_id ? txnById.get(po.bank_transaction_id) : undefined;
    const customerId = po.customer_id ?? null;
    const proposedIds = po.invoice_ids ?? [];
    const candidates = customerId ? openByCustomer.get(customerId) ?? [] : [];
    // Ensure the proposed invoices are always present as candidates even if paid
    // down since the scan (so the UI can still render the proposed picks).
    const candidateIds = new Set(candidates.map((c) => c.id));
    const proposedInvoices = proposedIds
      .map((id) => invById.get(id))
      .filter((c): c is InvoiceCandidate => Boolean(c) && !candidateIds.has(c!.id));
    return {
      id: r.id,
      confidence: r.confidence === null ? null : toNum(r.confidence),
      reasoning: r.reasoning,
      title: r.input_summary,
      kind: po.kind ?? 'single',
      customerId,
      customerName: customerId ? custMap.get(customerId)?.name ?? 'Unknown customer' : 'Unknown customer',
      deposit: txn
        ? { id: po.bank_transaction_id!, date: txn.date, amountCents: txn.amountCents, description: txn.description, posted: txn.posted }
        : null,
      proposedInvoiceIds: proposedIds,
      candidateInvoices: [...proposedInvoices, ...candidates],
      createdAt: r.created_at,
    };
  });

  // A proposal whose deposit already posted (matched elsewhere) is stale — hide it.
  const fresh = data.filter((d) => !d.deposit || !d.deposit.posted);

  return NextResponse.json({ data: fresh, counts: { total: fresh.length } });
}
