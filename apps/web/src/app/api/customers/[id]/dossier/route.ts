export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { runAiGateway } from '@meritbooks/core-ai';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  buildDossier,
  type DossierInvoice,
  type DossierPayment,
} from '@/lib/customers/dossier';
import {
  pairsForCustomer,
  type CustomerDupInput,
} from '@/lib/customers/dedupe';

/**
 * GET /api/customers/[id]/dossier — the deterministic customer dossier:
 * payment-behavior profile, credit-limit + utilization, a computed risk flag,
 * and the live "possible duplicates" surface. Every figure is computed in code
 * (lib/customers/dossier); the AI gateway is used ONLY to phrase a one-line risk
 * summary from those numbers — it never computes them, and it degrades to the
 * deterministic sentence when the model is unavailable or over budget.
 */

const DOSSIER_FEATURE = 'CUSTOMER_RISK_SUMMARY';
const DOSSIER_MODEL = 'claude-sonnet-4-20250514';

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const asOf = new Date().toISOString().slice(0, 10);

  // ── Customer master (fields we read for the profile) ────────────────────────
  const { data: cust, error: custErr } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name, credit_limit_cents, payment_terms_days')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .is('deleted_at', null)
    .single();
  if (custErr || !cust) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  const c = cust as {
    id: string;
    name: string;
    display_name: string | null;
    credit_limit_cents: number | string | null;
    payment_terms_days: number | null;
  };
  const customerName = c.display_name || c.name;
  const creditLimitCents = c.credit_limit_cents != null ? Number(c.credit_limit_cents) : null;
  const termsDays = c.payment_terms_days ?? 30;

  // ── Invoices for this customer ──────────────────────────────────────────────
  const { data: invRows } = await supabase
    .from('invoices')
    .select('id, invoice_date, due_date, total_cents, balance_cents, status')
    .eq('org_id', orgId)
    .eq('customer_id', params.id)
    .limit(2000);
  const invoiceRows = (invRows ?? []) as Array<{
    id: string;
    invoice_date: string;
    due_date: string;
    total_cents: number | string;
    balance_cents: number | string;
    status: string;
  }>;
  const invoiceDates = new Map<string, { invoiceDate: string; dueDate: string }>();
  const invoices: DossierInvoice[] = invoiceRows.map((r) => {
    invoiceDates.set(r.id, { invoiceDate: r.invoice_date, dueDate: r.due_date });
    return {
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      totalCents: Number(r.total_cents) || 0,
      balanceCents: Number(r.balance_cents) || 0,
      status: r.status,
    };
  });

  // ── Payment applications → days-to-pay history ──────────────────────────────
  const { data: payRows } = await supabase
    .from('customer_payments')
    .select('id, payment_date')
    .eq('org_id', orgId)
    .eq('customer_id', params.id)
    .limit(2000);
  const paymentDateById = new Map<string, string>();
  for (const p of (payRows ?? []) as Array<{ id: string; payment_date: string }>) {
    paymentDateById.set(p.id, p.payment_date);
  }
  const payments: DossierPayment[] = [];
  const paymentIds = [...paymentDateById.keys()];
  for (let i = 0; i < paymentIds.length; i += 500) {
    const slice = paymentIds.slice(i, i + 500);
    if (slice.length === 0) break;
    const { data: apps } = await supabase
      .from('payment_applications')
      .select('payment_id, invoice_id, amount_cents')
      .eq('org_id', orgId)
      .in('payment_id', slice);
    for (const a of (apps ?? []) as Array<{ payment_id: string; invoice_id: string; amount_cents: number | string }>) {
      const paymentDate = paymentDateById.get(a.payment_id);
      const inv = invoiceDates.get(a.invoice_id);
      if (!paymentDate || !inv) continue; // only applications against THIS customer's invoices
      payments.push({
        paymentDate,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        amountCents: Number(a.amount_cents) || 0,
      });
    }
  }

  // ── Org TTM revenue (for concentration) ─────────────────────────────────────
  const ttmStart = new Date(new Date(asOf).getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const { data: orgInv } = await supabase
    .from('invoices')
    .select('total_cents, status')
    .eq('org_id', orgId)
    .gte('invoice_date', ttmStart)
    .not('status', 'in', '(VOIDED,DRAFT)')
    .limit(20000);
  let orgTtmRevenueCents = 0;
  for (const r of (orgInv ?? []) as Array<{ total_cents: number | string }>) {
    orgTtmRevenueCents += Number(r.total_cents) || 0;
  }

  const dossier = buildDossier({
    customerName,
    creditLimitCents,
    termsDays,
    invoices,
    payments,
    orgTtmRevenueCents,
    asOf,
  });

  // ── Live possible-duplicates surface for this customer (read-only) ──────────
  const possibleDuplicates = await computePossibleDuplicates(supabase, orgId, params.id);

  // ── AI one-liner: phrase ONLY, from the deterministic figures ───────────────
  const aiSummary = await phraseRiskSummary(orgId, userId, dossier, customerName);

  return NextResponse.json({
    id: c.id,
    name: customerName,
    asOf,
    creditLimitCents,
    termsDays,
    behavior: dossier.behavior,
    credit: dossier.credit,
    risk: {
      flags: dossier.risk.flags,
      level: dossier.risk.level,
      // deterministic figures are authoritative; aiSummary is a phrasing of them.
      summary: dossier.risk.summary,
      aiSummary,
    },
    concentrationPct: dossier.concentrationPct,
    possibleDuplicates,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function computePossibleDuplicates(
  supabase: SupabaseClient,
  orgId: string,
  targetId: string,
): Promise<Array<{
  id: string;
  name: string;
  confidence: number;
  matchedFields: string[];
  reason: string;
  amountAtRiskCents: number;
}>> {
  const { data: rows } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name, email, phone, tax_id, address_line1, zip')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .limit(5000);
  const custRows = (rows ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
    email: string | null;
    phone: string | null;
    tax_id: string | null;
    address_line1: string | null;
    zip: string | null;
  }>;
  if (custRows.length < 2) return [];

  // open AR per customer (best-effort) to quantify the at-risk figure
  const openArByCustomer = new Map<string, number>();
  const ids = custRows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: invs } = await supabase
      .from('invoices')
      .select('customer_id, balance_cents, status')
      .eq('org_id', orgId)
      .in('customer_id', slice)
      .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE']);
    for (const inv of (invs ?? []) as Array<{ customer_id: string; balance_cents: number | string }>) {
      const cur = openArByCustomer.get(inv.customer_id) ?? 0;
      openArByCustomer.set(inv.customer_id, cur + (Number(inv.balance_cents) || 0));
    }
  }

  const toInput = (r: (typeof custRows)[number]): CustomerDupInput => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    email: r.email,
    phone: r.phone,
    taxId: r.tax_id,
    addressLine1: r.address_line1,
    zip: r.zip,
    openArCents: openArByCustomer.get(r.id) ?? 0,
  });

  const target = custRows.find((r) => r.id === targetId);
  if (!target) return [];
  const others = custRows.filter((r) => r.id !== targetId).map(toInput);
  const pairs = pairsForCustomer(toInput(target), others);
  return pairs.slice(0, 5).map((p) => ({
    id: p.b.id,
    name: p.b.displayName || p.b.name,
    confidence: p.signal.confidence,
    matchedFields: p.signal.matchedFields,
    reason: p.signal.reason,
    amountAtRiskCents: p.amountAtRiskCents,
  }));
}

async function phraseRiskSummary(
  orgId: string,
  userId: string,
  dossier: ReturnType<typeof buildDossier>,
  customerName: string,
): Promise<string> {
  const deterministic = dossier.risk.summary;
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return deterministic;

  // The model receives ONLY the already-computed facts and must not invent
  // numbers — it rephrases the deterministic figures into one plain sentence.
  const facts = {
    customer: customerName,
    riskLevel: dossier.risk.level,
    flags: dossier.risk.flags,
    avgDaysToPay: dossier.behavior.avgDaysToPay,
    avgDaysBeyondTerms: dossier.behavior.avgDaysBeyondTerms,
    onTimeRate: dossier.behavior.onTimeRate,
    openBalanceCents: dossier.behavior.openBalanceCents,
    overdueBalanceCents: dossier.behavior.overdueBalanceCents,
    creditUtilizationPct: dossier.credit.utilizationPct,
    concentrationPct: dossier.concentrationPct,
    deterministicSummary: deterministic,
  };
  const system =
    'You are a credit analyst. Rephrase the provided, ALREADY-COMPUTED figures into ONE concise ' +
    'plain-English sentence about this customer\'s payment risk. Do NOT invent, estimate, or change ' +
    'any number — use only the figures given. If no risk flags are present, say the account looks healthy. ' +
    'Return the sentence only, no preamble.';
  try {
    const admin = createAdminSupabase();
    const gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: orgId,
        user_id: userId,
        module: 'BOOKS',
        feature: DOSSIER_FEATURE,
        model: DOSSIER_MODEL,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(facts) }] }],
        max_tokens: 160,
      },
    );
    if (gw.status === 'blocked' || gw.result == null) return deterministic;
    const text = extractText(gw.result);
    return (text ?? '').trim() || deterministic;
  } catch {
    return deterministic;
  }
}
