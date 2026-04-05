export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

const querySchema = z.object({
  search: z.string().optional(),
  is_active: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));

  const page = parseInt(params.page ?? '1', 10);
  const perPage = parseInt(params.per_page ?? '50', 10);
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = supabase
    .from('customers')
    .select('*', { count: 'exact' })
    .order('name')
    .range(from, to);

  if (params.search) query = query.ilike('name', `%${params.search}%`);
  if (params.is_active === 'true') query = query.eq('is_active', true);
  if (params.is_active === 'false') query = query.eq('is_active', false);

  const { data: customers, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Get AR summary per customer
  const customerIds = (customers ?? []).map((c) => c.id);
  let arSummary: Record<string, { totalInvoicedCents: number; totalPaidCents: number; openBalanceCents: number; invoiceCount: number }> = {};

  if (customerIds.length > 0) {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('customer_id, total_cents, amount_paid_cents, balance_cents, status')
      .in('customer_id', customerIds)
      .neq('status', 'VOIDED');

    arSummary = {};
    for (const inv of invoices ?? []) {
      if (!arSummary[inv.customer_id]) {
        arSummary[inv.customer_id] = { totalInvoicedCents: 0, totalPaidCents: 0, openBalanceCents: 0, invoiceCount: 0 };
      }
      arSummary[inv.customer_id].totalInvoicedCents += Number(inv.total_cents);
      arSummary[inv.customer_id].totalPaidCents += Number(inv.amount_paid_cents);
      if (inv.status !== 'PAID') {
        arSummary[inv.customer_id].openBalanceCents += Number(inv.balance_cents);
      }
      arSummary[inv.customer_id].invoiceCount++;
    }
  }

  const result = (customers ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: [c.address_line1, c.address_line2, c.city, c.state, c.zip].filter(Boolean).join(', '),
    paymentTermsDays: c.payment_terms_days,
    creditLimitCents: c.credit_limit_cents ? Number(c.credit_limit_cents) : null,
    isActive: c.is_active,
    arSummary: arSummary[c.id] ?? { totalInvoicedCents: 0, totalPaidCents: 0, openBalanceCents: 0, invoiceCount: 0 },
  }));

  return NextResponse.json({
    data: result,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
  });
}

// ─── POST: Create customer ────────────────────────────────────────────
const createCustomerSchema = z.object({
  name: z.string().min(1, 'Name required').max(200),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  address_line1: z.string().max(200).optional().nullable(),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(50).optional().nullable(),
  zip: z.string().max(20).optional().nullable(),
  payment_terms_days: z.number().int().min(0).max(365).default(30),
  credit_limit_cents: z.number().int().min(0).optional().nullable(),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ orgId: null as string | null }));
  const orgId = authResult.orgId ?? '';
  const supabase = createAdminSupabase();

  try {
    const raw = await request.json();
    const result = createCustomerSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }

    const body = result.data;
    const { data: customer, error } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        name: body.name,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address_line1: body.address_line1 ?? null,
        address_line2: body.address_line2 ?? null,
        city: body.city ?? null,
        state: body.state ?? null,
        zip: body.zip ?? null,
        payment_terms_days: body.payment_terms_days,
        credit_limit_cents: body.credit_limit_cents ?? null,
      })
      .select('id, name')
      .single();

    if (error || !customer) {
      return NextResponse.json({ error: error?.message ?? 'Failed to create customer' }, { status: 500 });
    }

    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
