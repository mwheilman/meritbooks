export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { learnVendorPattern } from '@/lib/services/categorization';

const schema = z.object({
  description: z.string().min(3).max(2000),
  account_id: z.string().uuid(),
  vendor_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const res = await learnVendorPattern(supabase, {
    orgId,
    description: parsed.data.description,
    accountId: parsed.data.account_id,
    vendorId: parsed.data.vendor_id ?? null,
    departmentId: parsed.data.department_id ?? null,
    locationId: parsed.data.location_id ?? null,
  });
  return NextResponse.json(res);
}
