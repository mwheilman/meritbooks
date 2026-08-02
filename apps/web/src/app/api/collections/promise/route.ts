export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { logHumanAction } from '@/lib/trust/action-log';
import { fetchCoreMap } from '@/lib/stitch-core';
import { classifyPromise, PROMISE_ACTION, type PromiseToPay } from '@/lib/collections/promises';

/**
 * Promise-to-pay tracking. NO new table this wave — a promise is persisted as a
 * HUMAN row on the immutable audit rail (core.action_log, action
 * `collections.promise.logged`, the amount/date/target in `metadata`). The
 * worklist reads these back and flags broken ones; this endpoint logs a new
 * promise (POST) and lists them with a live kept/pending/broken verdict (GET).
 */

const num = (v: unknown): number => Number(v ?? 0);

// ── POST: log a promise ────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { customerId?: string; invoiceId?: string | null; amountCents?: number; promiseDate?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const customerId = body.customerId;
  const amountCents = Math.round(num(body.amountCents));
  const promiseDate = typeof body.promiseDate === 'string' ? body.promiseDate.slice(0, 10) : '';
  const invoiceId = body.invoiceId ?? null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  if (!customerId) return NextResponse.json({ error: 'customerId is required.' }, { status: 422 });
  if (!(amountCents > 0)) return NextResponse.json({ error: 'A positive promised amount is required.' }, { status: 422 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(promiseDate)) return NextResponse.json({ error: 'A valid promiseDate (YYYY-MM-DD) is required.' }, { status: 422 });

  // Validate the customer belongs to this tenant (RLS-scoped read).
  const { data: cust } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name')
    .eq('org_id', orgId)
    .eq('id', customerId)
    .maybeSingle();
  if (!cust) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  const customerName = (cust as { name: string; display_name: string | null }).display_name || (cust as { name: string }).name;

  await logHumanAction(supabase, userId, orgId, {
    action: PROMISE_ACTION,
    subjectTable: invoiceId ? 'invoices' : 'customers',
    subjectId: invoiceId ?? customerId,
    summary: `Promise to pay $${(amountCents / 100).toFixed(2)} by ${promiseDate} — ${customerName}`,
    metadata: { customerId, invoiceId, amountCents, promiseDate, note },
  });

  return NextResponse.json({ ok: true, customerId, invoiceId, amountCents, promiseDate });
}

// ── GET: list promises with a live verdict ─────────────────────────────────────
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const asOf = searchParams.get('as_of') ?? new Date().toISOString().slice(0, 10);
  const customerFilter = searchParams.get('customer_id');

  const { data, error } = await supabase
    .schema('core')
    .from('action_log')
    .select('id, subject_id, metadata, created_at')
    .eq('org_id', orgId)
    .eq('action', PROMISE_ACTION)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const promises: PromiseToPay[] = [];
  for (const r of (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null; created_at: string }>) {
    const m = r.metadata ?? {};
    const customerId = (m.customerId as string) ?? '';
    if (!customerId) continue;
    if (customerFilter && customerId !== customerFilter) continue;
    promises.push({
      id: r.id,
      customerId,
      invoiceId: (m.invoiceId as string) ?? null,
      amountCents: num(m.amountCents),
      promiseDate: (m.promiseDate as string) ?? '',
      note: (m.note as string) ?? null,
      createdAt: r.created_at,
    });
  }

  // Live verdict needs current balances of the referenced invoices + customers.
  const invoiceIds = [...new Set(promises.map((p) => p.invoiceId).filter(Boolean))] as string[];
  const balByInvoice = new Map<string, { balance: number; status: string; number: string }>();
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const slice = invoiceIds.slice(i, i + 200);
    if (slice.length === 0) break;
    const { data: invs } = await supabase
      .from('invoices')
      .select('id, invoice_number, balance_cents, status')
      .eq('org_id', orgId)
      .in('id', slice);
    for (const inv of (invs ?? []) as Array<{ id: string; invoice_number: string; balance_cents: number | string; status: string }>) {
      balByInvoice.set(inv.id, { balance: num(inv.balance_cents), status: inv.status, number: inv.invoice_number });
    }
  }

  // Customer-level open overdue balance (for customer-scoped promises).
  const custIds = [...new Set(promises.map((p) => p.customerId))];
  const openByCustomer = new Map<string, number>();
  for (let i = 0; i < custIds.length; i += 200) {
    const slice = custIds.slice(i, i + 200);
    if (slice.length === 0) break;
    const { data: invs } = await supabase
      .from('invoices')
      .select('customer_id, balance_cents')
      .eq('org_id', orgId)
      .in('customer_id', slice)
      .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE']);
    for (const inv of (invs ?? []) as Array<{ customer_id: string; balance_cents: number | string }>) {
      openByCustomer.set(inv.customer_id, (openByCustomer.get(inv.customer_id) ?? 0) + num(inv.balance_cents));
    }
  }

  const custNameMap = await fetchCoreMap<{ id: string; name: string; display_name: string | null }>(
    supabase, 'customers', 'id, name, display_name', custIds,
  );

  const out = promises.map((p) => {
    const inv = p.invoiceId ? balByInvoice.get(p.invoiceId) : undefined;
    const openBalanceCents = inv ? inv.balance : openByCustomer.get(p.customerId) ?? 0;
    const settled = inv ? (inv.status === 'PAID' || inv.balance <= 0) : openBalanceCents <= 0;
    const status = classifyPromise(p, { paidSinceCents: 0, openBalanceCents, settled }, asOf);
    const c = custNameMap.get(p.customerId);
    return {
      ...p,
      customerName: c ? (c.display_name || c.name) : 'Unknown customer',
      invoiceNumber: inv?.number ?? null,
      openBalanceCents,
      status,
    };
  });

  return NextResponse.json({ asOf, promises: out });
}
