export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { generateChargebackInvoices } from '@/lib/services/chargeback';

const inputSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

export const POST = apiHandler(
  inputSchema,
  async (body, ctx) => {
    const invoices = await generateChargebackInvoices(
      ctx.supabase,
      ctx.orgId ?? '',
      body.year,
      body.month,
    );

    return NextResponse.json({
      period: `${body.year}-${String(body.month).padStart(2, '0')}`,
      invoice_count: invoices.length,
      total_cents: invoices.reduce((s, inv) => s + inv.totalCents, 0),
      invoices,
    }, { status: 201 });
  }
);
