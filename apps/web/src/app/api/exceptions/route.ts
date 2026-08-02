export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * Unified exception / "Needs Attention" queue.
 *
 * Folds the six fragmented "a human must look at this" sources into ONE
 * normalized, newest-first list:
 *   - bank_transactions   status = 'FLAGGED'            → /bank-feed
 *   - receipts            status = 'FLAGGED'            → /receipts
 *   - bills               status = 'ON_HOLD'           → /bills
 *   - ai_decisions        status = 'PROPOSED'          → /ai-decisions
 *   - approvals           status = 'PENDING_APPROVAL'  → /bills
 *   - job_cost_attributions lifecycle = 'PENDING'      → /bills
 *
 * READ-ONLY aggregation. Every query runs through the RLS-scoped client, so the
 * database enforces org isolation — this route never filters org_id by hand.
 */

type ExceptionSource =
  | 'bank'
  | 'receipt'
  | 'bill'
  | 'ai_proposal'
  | 'approval'
  | 'cost';

/**
 * The Autonomy Control Plane disposition an AI proposal recorded at detection —
 * what the tenant's per-feature dial + global kill switch say the machine WOULD do
 * (advisory; auto-post stays OFF, so every proposal still routes through a human
 * approve step). Only ai_proposal rows carry one.
 */
type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';

const DISPOSITIONS: readonly Disposition[] = ['AUTO', 'REVIEW', 'ESCALATE', 'BLOCKED'];

function toDisposition(raw: unknown): Disposition | null {
  return typeof raw === 'string' && (DISPOSITIONS as readonly string[]).includes(raw)
    ? (raw as Disposition)
    : null;
}

interface ExceptionItem {
  id: string;
  source: ExceptionSource;
  title: string;
  subtitle: string | null;
  amountCents: number | null;
  confidence: number | null; // ai_proposal only (0..1)
  disposition: Disposition | null; // ai_proposal only — advisory autonomy disposition
  companyId: string | null;
  createdAt: string;
  href: string;
}

const SOURCE_CAP = 100;

const HREF: Record<ExceptionSource, string> = {
  bank: '/bank-feed',
  receipt: '/receipts',
  bill: '/bills',
  ai_proposal: '/ai-decisions',
  approval: '/bills',
  // No standalone cost-approvals page exists yet; resolve alongside bills.
  cost: '/bills',
};

// ── Raw row shapes (only the columns we select) ────────────────────────────────

interface BankRow {
  id: string;
  description: string | null;
  amount_cents: number | string | null;
  ai_reasoning: string | null;
  created_at: string;
  location_id: string | null;
}
interface ReceiptRow {
  id: string;
  vendor_name: string | null;
  amount_cents: number | string | null;
  submitted_at: string | null;
  location_id: string | null;
}
interface BillRow {
  id: string;
  bill_number: string | null;
  total_cents: number | string | null;
  payment_hold_reason: string | null;
  created_at: string;
  location_id: string | null;
  vendor_id: string | null;
}
interface AiRow {
  id: string;
  feature: string | null;
  input_summary: string | null;
  confidence: number | string | null;
  proposed_output: { disposition?: unknown } | null;
  created_at: string;
  location_id: string | null;
}
interface ApprovalRow {
  id: string;
  kind: string | null;
  subject_table: string | null;
  amount_cents: number | string | null;
  created_at: string;
}
interface CostRow {
  id: string;
  cost_type: string | null;
  memo: string | null;
  amount_cents: number | string | null;
  created_at: string;
  location_id: string | null;
}

function toNum(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/** Human-friendly label for an approval kind, e.g. AP_DISBURSEMENT → "AP disbursement". */
function humanizeKind(kind: string | null): string {
  if (!kind) return 'Approval required';
  const spaced = kind.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const bankQ = supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, ai_reasoning, created_at, location_id')
    .eq('status', 'FLAGGED')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);

  const receiptQ = supabase
    .from('receipts')
    .select('id, vendor_name, amount_cents, submitted_at, location_id')
    .eq('status', 'FLAGGED')
    .order('submitted_at', { ascending: false })
    .limit(SOURCE_CAP);

  const billQ = supabase
    .from('bills')
    .select('id, bill_number, total_cents, payment_hold_reason, created_at, location_id, vendor_id')
    .eq('status', 'ON_HOLD')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);

  const aiQ = supabase
    .from('ai_decisions')
    .select('id, feature, input_summary, confidence, proposed_output, created_at, location_id')
    .eq('status', 'PROPOSED')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);

  const approvalQ = supabase
    .from('approvals')
    .select('id, kind, subject_table, amount_cents, created_at')
    .eq('status', 'PENDING_APPROVAL')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);

  const costQ = supabase
    .from('job_cost_attributions')
    .select('id, cost_type, memo, amount_cents, created_at, location_id')
    .eq('lifecycle', 'PENDING')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);

  const [bankRes, receiptRes, billRes, aiRes, approvalRes, costRes] = await Promise.all([
    bankQ,
    receiptQ,
    billQ,
    aiQ,
    approvalQ,
    costQ,
  ]);

  // Surface the first hard failure rather than silently returning a partial list.
  const firstError =
    bankRes.error ||
    receiptRes.error ||
    billRes.error ||
    aiRes.error ||
    approvalRes.error ||
    costRes.error;
  if (firstError) {
    console.error('[exceptions] query failed:', firstError.message);
    return NextResponse.json(
      { error: 'Failed to load exceptions', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }

  const bankRows = (bankRes.data ?? []) as BankRow[];
  const receiptRows = (receiptRes.data ?? []) as ReceiptRow[];
  const billRows = (billRes.data ?? []) as BillRow[];
  const aiRows = (aiRes.data ?? []) as AiRow[];
  const approvalRows = (approvalRes.data ?? []) as ApprovalRow[];
  const costRows = (costRes.data ?? []) as CostRow[];

  // Stitch vendor names for bills (cross-schema embed doesn't work — see stitch-core).
  const venMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase,
    'vendors',
    'id, name',
    billRows.map((b) => b.vendor_id)
  );

  const items: ExceptionItem[] = [];

  for (const t of bankRows) {
    const amt = toNum(t.amount_cents);
    items.push({
      id: t.id,
      source: 'bank',
      title: t.description ?? 'Bank transaction',
      subtitle: t.ai_reasoning ?? 'Flagged for review',
      amountCents: amt === null ? null : Math.abs(amt),
      confidence: null,
      disposition: null,
      companyId: t.location_id,
      createdAt: t.created_at,
      href: HREF.bank,
    });
  }

  for (const r of receiptRows) {
    const amt = toNum(r.amount_cents);
    items.push({
      id: r.id,
      source: 'receipt',
      title: r.vendor_name ?? 'Unknown receipt',
      subtitle: 'Flagged receipt — requires manual review',
      amountCents: amt === null ? null : Math.abs(amt),
      confidence: null,
      disposition: null,
      companyId: r.location_id,
      createdAt: r.submitted_at ?? '',
      href: HREF.receipt,
    });
  }

  for (const b of billRows) {
    const vendor = b.vendor_id ? venMap.get(b.vendor_id) ?? null : null;
    const amt = toNum(b.total_cents);
    items.push({
      id: b.id,
      source: 'bill',
      title: `${vendor?.name ?? 'Unknown vendor'} — ${b.bill_number ?? 'No #'}`,
      subtitle: b.payment_hold_reason ?? 'Payment hold — compliance issue',
      amountCents: amt === null ? null : Math.abs(amt),
      confidence: null,
      disposition: null,
      companyId: b.location_id,
      createdAt: b.created_at,
      href: HREF.bill,
    });
  }

  for (const a of aiRows) {
    items.push({
      id: a.id,
      source: 'ai_proposal',
      title: a.input_summary ?? 'AI proposal',
      subtitle: a.feature ?? 'Awaiting human review',
      amountCents: null,
      confidence: toNum(a.confidence),
      disposition: toDisposition(a.proposed_output?.disposition),
      companyId: a.location_id,
      createdAt: a.created_at,
      href: HREF.ai_proposal,
    });
  }

  for (const ap of approvalRows) {
    const amt = toNum(ap.amount_cents);
    items.push({
      id: ap.id,
      source: 'approval',
      title: humanizeKind(ap.kind),
      subtitle: ap.subject_table ? `Pending approval — ${ap.subject_table}` : 'Pending approval',
      amountCents: amt === null ? null : Math.abs(amt),
      confidence: null,
      disposition: null,
      companyId: null,
      createdAt: ap.created_at,
      href: HREF.approval,
    });
  }

  for (const c of costRows) {
    const amt = toNum(c.amount_cents);
    const typeLabel = c.cost_type ? c.cost_type.toLowerCase() : 'cost';
    items.push({
      id: c.id,
      source: 'cost',
      title: c.memo ?? `Job cost — ${typeLabel}`,
      subtitle: `Job cost approval — ${typeLabel}`,
      amountCents: amt === null ? null : Math.abs(amt),
      confidence: null,
      disposition: null,
      companyId: c.location_id,
      createdAt: c.created_at,
      href: HREF.cost,
    });
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const bySource: Record<string, number> = {
    bank: bankRows.length,
    receipt: receiptRows.length,
    bill: billRows.length,
    ai_proposal: aiRows.length,
    approval: approvalRows.length,
    cost: costRows.length,
  };

  // Advisory autonomy dispositions across the AI proposals in the queue — lets the
  // page show a manager, at a glance, what the AI WOULD do vs what it MUST route.
  const byDisposition: Record<Disposition, number> = { AUTO: 0, REVIEW: 0, ESCALATE: 0, BLOCKED: 0 };
  for (const it of items) {
    if (it.disposition) byDisposition[it.disposition] += 1;
  }

  return NextResponse.json({
    data: items,
    counts: { total: items.length, bySource, byDisposition },
  });
}
