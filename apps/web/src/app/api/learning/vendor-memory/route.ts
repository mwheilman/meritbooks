export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { suggestAccountForVendor } from '@/lib/learning/vendor-memory';

/**
 * GET /api/learning/vendor-memory
 *   ?vendor_id=<uuid>            — the vendor to recall
 *   [&vendor_name=<text>]        — resolve by name when no id is on hand
 *   [&amount_cents=<int>]        — bias toward similar-sized past charges
 *
 * The read side of the M14 categorization-memory layer. Returns the accounts a
 * human has historically coded this vendor to (derived live from approved
 * bank-feed history — no cache table), ranked with a confidence per account and
 * a last-used date. Powers the "you usually code {vendor} to {account}" inline
 * hint in the bank-feed edit panel. Proposes only; a human still approves.
 *
 * RLS/org-scoped via the authed client + explicit org filter in the module.
 */
const schema = z.object({
  vendor_id: z.string().uuid().optional(),
  vendor_name: z.string().max(200).optional(),
  amount_cents: z.coerce.number().int().optional(),
});

export const GET = apiQueryHandler(schema, async (params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (!params.vendor_id && !params.vendor_name) {
    return NextResponse.json({ vendorId: null, vendorName: null, total: 0, suggestions: [], top: null });
  }

  const memory = await suggestAccountForVendor(ctx.supabase, {
    orgId: ctx.orgId,
    vendorId: params.vendor_id ?? null,
    vendorName: params.vendor_name ?? null,
    amountCents: params.amount_cents,
  });

  return NextResponse.json(memory);
});
