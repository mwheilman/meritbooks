export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { postJournalEntry } from '@/lib/services/gl-posting';

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

  // Base query
  let query = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, due_date, subtotal_cents, tax_cents,
      retainage_cents, total_cents, amount_paid_cents, balance_cents,
      status, is_progress_bill, application_number, memo, sent_at, created_at,
      customer:customers!invoices_customer_id_fkey(id, name, email, payment_terms_days),
      location:locations!invoices_location_id_fkey(id, name, short_code),
      job:jobs!invoices_job_id_fkey(id, job_number, name)
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

  // Map data with aging calculation
  const invoices = (data ?? []).map((inv) => {
    const customer = Array.isArray(inv.customer) ? inv.customer[0] : inv.customer;
    const location = Array.isArray(inv.location) ? inv.location[0] : inv.location;
    const job = Array.isArray(inv.job) ? inv.job[0] : inv.job;
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
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const orgId = authResult.orgId ?? '';

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

    // Generate invoice number: INV-{YYYYMMDD}-{seq}
    const dateStr = body.invoice_date.replace(/-/g, '');
    const { count } = await supabase
      .from('invoices')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId);
    const seq = String((count ?? 0) + 1).padStart(4, '0');
    const invoiceNumber = `INV-${dateStr}-${seq}`;

    // Calculate totals
    const lines = body.lines.map((l, i) => ({
      ...l,
      line_number: i + 1,
      amount_cents: Math.round(l.quantity * l.unit_price_cents),
    }));
    const subtotalCents = lines.reduce((s, l) => s + l.amount_cents, 0);
    const retainageCents = body.retainage_pct > 0 ? Math.round(subtotalCents * body.retainage_pct / 100) : 0;
    const totalCents = subtotalCents + body.tax_cents - retainageCents;

    // Insert invoice header
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .insert({
        org_id: orgId,
        location_id: body.location_id,
        customer_id: body.customer_id,
        job_id: body.job_id ?? null,
        invoice_number: invoiceNumber,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        subtotal_cents: subtotalCents,
        tax_cents: body.tax_cents,
        retainage_cents: retainageCents,
        total_cents: totalCents,
        status: 'DRAFT',
        is_progress_bill: body.is_progress_bill,
        memo: body.memo,
      })
      .select('id, invoice_number')
      .single();

    if (invErr || !invoice) {
      return NextResponse.json({ error: invErr?.message ?? 'Failed to create invoice' }, { status: 500 });
    }

    // Insert lines
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

    const { error: linesErr } = await supabase
      .from('invoice_lines')
      .insert(lineInserts);

    if (linesErr) {
      await supabase.from('invoices').delete().eq('id', invoice.id);
      return NextResponse.json({ error: linesErr.message }, { status: 500 });
    }

    // Optionally post to GL (Debit AR, Credit Revenue per line)
    if (body.post_to_gl && totalCents > 0) {
      // Find the AR control account (12xxx range)
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
        const jeLines = [
          // Debit AR
          {
            account_id: arAccount.id,
            debit_cents: totalCents,
            credit_cents: 0,
            location_id: body.location_id,
          },
          // Credit each revenue line's account
          ...lines.map((l) => ({
            account_id: l.account_id,
            debit_cents: 0,
            credit_cents: l.amount_cents,
            location_id: body.location_id,
          })),
        ];

        const jeResult = await postJournalEntry(supabase, {
          org_id: orgId,
          location_id: body.location_id,
          entry_date: body.invoice_date,
          entry_type: 'STANDARD',
          memo: `Invoice ${invoiceNumber} — ${body.memo ?? ''}`,
          source_module: 'AR',
          source_id: invoice.id,
          created_by: userId,
          lines: jeLines,
        });

        if (jeResult.success) {
          await supabase.from('invoices')
            .update({ gl_entry_id: jeResult.entry_id, status: 'SENT' })
            .eq('id', invoice.id);
        }
      }
    }

    return NextResponse.json({
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      total_cents: totalCents,
    }, { status: 201 });
  } catch (error) {
    console.error('[Invoice Create Error]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
