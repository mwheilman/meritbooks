export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { createInvoice } from '@/lib/invoices/create-invoice';

// ─── GET: List invoices ───────────────────────────────────────────────
const querySchema = z.object({
  location_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export async function GET(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const supabase = createAdminSupabase();

  const { searchParams } = new URL(request.url);
  const raw = Object.fromEntries(searchParams.entries());
  const params = querySchema.parse(raw);

  const page = parseInt(params.page ?? '1', 10);
  const perPage = parseInt(params.per_page ?? '50', 10);
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  // Base query.
  // NOTE: no PostgREST embeds on customers/locations/jobs here — those tables
  // now live in the `core` schema while invoices is in `public`, and PostgREST
  // cannot embed across schemas (it 500s with a schema-cache error). We fetch
  // each relation separately from `core` (below) and stitch them in JS.
  let query = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, due_date, subtotal_cents, tax_cents,
      retainage_cents, total_cents, amount_paid_cents, balance_cents,
      status, is_progress_bill, application_number, memo, sent_at, created_at,
      customer_id, location_id, job_id
    `, { count: 'exact' })
    .order('invoice_date', { ascending: false })
    .range(from, to);

  if (params.location_id) query = query.eq('location_id', params.location_id);
  if (params.customer_id) query = query.eq('customer_id', params.customer_id);
  if (params.status && params.status !== 'ALL') query = query.eq('status', params.status);
  if (params.search) query = query.or(`invoice_number.ilike.%${params.search}%,memo.ilike.%${params.search}%`);

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Status counts
  const { data: allInvoices } = await supabase
    .from('invoices')
    .select('status, total_cents, balance_cents');

  const counts: Record<string, { count: number; totalCents: number; balanceCents: number }> = {
    ALL: { count: 0, totalCents: 0, balanceCents: 0 },
    DRAFT: { count: 0, totalCents: 0, balanceCents: 0 },
    SENT: { count: 0, totalCents: 0, balanceCents: 0 },
    PARTIALLY_PAID: { count: 0, totalCents: 0, balanceCents: 0 },
    PAID: { count: 0, totalCents: 0, balanceCents: 0 },
    OVERDUE: { count: 0, totalCents: 0, balanceCents: 0 },
  };

  const now = new Date();
  for (const inv of allInvoices ?? []) {
    const total = Number(inv.total_cents ?? 0);
    const balance = Number(inv.balance_cents ?? 0);
    counts.ALL.count++;
    counts.ALL.totalCents += total;
    counts.ALL.balanceCents += balance;

    const status = inv.status as string;
    if (counts[status]) {
      counts[status].count++;
      counts[status].totalCents += total;
      counts[status].balanceCents += balance;
    }
  }

  // Fetch the related core records for the invoices on this page and build
  // lookup maps (replaces the cross-schema PostgREST embeds removed above).
  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const locationIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))] as string[];

  const [custRes, locRes, jobRes] = await Promise.all([
    customerIds.length
      ? supabase.schema('core').from('customers').select('id, name, email, payment_terms_days').in('id', customerIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    locationIds.length
      ? supabase.schema('core').from('locations').select('id, name, short_code').in('id', locationIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    jobIds.length
      ? supabase.schema('core').from('jobs').select('id, job_number, name').in('id', jobIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const customerById = new Map((custRes.data ?? []).map((c: Record<string, unknown>) => [c.id as string, c]));
  const locationById = new Map((locRes.data ?? []).map((l: Record<string, unknown>) => [l.id as string, l]));
  const jobById = new Map((jobRes.data ?? []).map((j: Record<string, unknown>) => [j.id as string, j]));

  // Map data with aging calculation
  const invoices = rows.map((inv) => {
    const customer = inv.customer_id ? customerById.get(inv.customer_id as string) ?? null : null;
    const location = inv.location_id ? locationById.get(inv.location_id as string) ?? null : null;
    const job = inv.job_id ? jobById.get(inv.job_id as string) ?? null : null;
    const dueDate = new Date(inv.due_date);
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / 86400000));

    return {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      subtotalCents: Number(inv.subtotal_cents),
      taxCents: Number(inv.tax_cents),
      retainageCents: Number(inv.retainage_cents),
      totalCents: Number(inv.total_cents),
      amountPaidCents: Number(inv.amount_paid_cents),
      balanceCents: Number(inv.balance_cents),
      status: inv.status,
      isProgressBill: inv.is_progress_bill,
      applicationNumber: inv.application_number,
      memo: inv.memo,
      sentAt: inv.sent_at,
      daysOverdue,
      customer: customer ? { id: customer.id, name: customer.name, email: customer.email, paymentTermsDays: customer.payment_terms_days } : null,
      location: location ? { id: location.id, name: location.name, shortCode: location.short_code } : null,
      job: job ? { id: job.id, jobNumber: job.job_number, name: job.name } : null,
    };
  });

  return NextResponse.json({
    data: invoices,
    counts,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
  });
}

// ─── POST: Create invoice ─────────────────────────────────────────────
const createInvoiceSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().optional().nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(1000).optional(),
  tax_cents: z.number().int().min(0).default(0),
  retainage_pct: z.number().min(0).max(100).default(0),
  is_progress_bill: z.boolean().default(false),
  post_to_gl: z.boolean().default(false),
  lines: z.array(z.object({
    description: z.string().min(1, 'Description required').max(500),
    account_id: z.string().uuid(),
    quantity: z.number().min(0).default(1),
    unit_price_cents: z.number().int(),
    job_phase_id: z.string().uuid().optional().nullable(),
    cost_code_id: z.string().uuid().optional().nullable(),
  })).min(1, 'At least one line item required'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';

  // Authorize — creating an invoice (optionally posting AR to the GL) requires
  // invoices:create (defense-in-depth on top of RLS).
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  try {
    const raw = await request.json();
    const result = createInvoiceSchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Delegate to the shared invoice-create core — the same path the recurring
    // generator uses, so numbering, rev-rec treatment, and GL posting never fork.
    const outcome = await createInvoice(supabase, {
      orgId,
      actor: userId,
      input: {
        location_id: body.location_id,
        customer_id: body.customer_id,
        job_id: body.job_id ?? null,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        memo: body.memo,
        tax_cents: body.tax_cents,
        retainage_pct: body.retainage_pct,
        is_progress_bill: body.is_progress_bill,
        post_to_gl: body.post_to_gl,
        lines: body.lines,
      },
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    return NextResponse.json({
      invoice_id: outcome.result.invoice_id,
      invoice_number: outcome.result.invoice_number,
      total_cents: outcome.result.total_cents,
    }, { status: 201 });
  } catch (error) {
    console.error('[Invoice Create Error]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
