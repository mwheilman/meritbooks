export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { updateBankAccount } from '@/lib/money/plaid-feed';

/**
 * PATCH /api/bank-accounts/:id
 *   { label?, gl_account_id? }
 *   Rename a bank account and/or reselect its GL cash account (in-feed edit).
 *   Entity is intentionally not editable here.
 */
const schema = z.object({
  label: z.string().min(1).max(120).optional(),
  gl_account_id: z.string().uuid().optional(),
}).refine((v) => v.label !== undefined || v.gl_account_id !== undefined, {
  message: 'Provide a label or a GL account to update.',
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const db = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(db, claimOrgId);
    await updateBankAccount(db, orgId, {
      bankAccountId: params.id,
      label: parsed.data.label,
      glAccountId: parsed.data.gl_account_id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
