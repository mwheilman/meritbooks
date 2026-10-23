export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { removeSignature, setSignature } from '@/lib/ap/checks/stock-service';
import { MAX_SIGNATURE_BYTES, supabaseCheckSecrets } from '@/lib/ap/checks/secrets';
import { checkErrorResponse, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/stock/signature (multipart: bankAccountId, slot 1|2, file) — upload a
 * signature image to the private check-signatures bucket. DELETE ?bank_account_id=&slot=
 * removes it. The image is never served back; it is only drawn on a printed check.
 * Release authority + the bank-details session policy.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function gate() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return { res: ctx } as const;
  if (!ctx.orgId) return { res: NextResponse.json({ error: 'No organization' }, { status: 400 }) } as const;
  const guard = await requireCheckMoney(ctx.userId);
  if (!guard.ok) return { res: guard.response } as const;
  const policy = await assertSessionMeetsPolicy({ orgId: ctx.orgId, userId: ctx.userId }, { action: 'bank_details_edit' });
  if (!policy.ok) return { res: policy.response } as const;
  return { ctx: { supabase: ctx.supabase, userId: ctx.userId, orgId: ctx.orgId } } as const;
}

export async function POST(request: Request) {
  const g = await gate();
  if ('res' in g) return g.res;
  const { supabase, orgId, userId } = g.ctx;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send the signature as a file upload.' }, { status: 400 });
  }
  const bankAccountId = String(form.get('bankAccountId') ?? '');
  const slot = Number(form.get('slot') ?? 1) === 2 ? 2 : 1;
  const file = form.get('file');
  if (!UUID.test(bankAccountId)) return NextResponse.json({ error: 'Choose a bank account.' }, { status: 400 });
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'Choose a signature image.' }, { status: 400 });
  if (file.size > MAX_SIGNATURE_BYTES) return NextResponse.json({ error: 'The signature image must be 512 KB or smaller.' }, { status: 413 });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await setSignature(supabase, orgId, userId, bankAccountId, slot, bytes, supabaseCheckSecrets(createAdminSupabase()));
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.stock.signature',
      subjectTable: 'check_stock_profiles',
      summary: `Uploaded check signature ${slot}`,
      metadata: { bankAccountId, slot, bytes: bytes.length },
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return checkErrorResponse(e, 'Could not save the signature.');
  }
}

export async function DELETE(request: Request) {
  const g = await gate();
  if ('res' in g) return g.res;
  const { supabase, orgId, userId } = g.ctx;
  const url = new URL(request.url);
  const bankAccountId = url.searchParams.get('bank_account_id') ?? '';
  const slot = url.searchParams.get('slot') === '2' ? 2 : 1;
  if (!UUID.test(bankAccountId)) return NextResponse.json({ error: 'Choose a bank account.' }, { status: 400 });
  try {
    await removeSignature(supabase, orgId, userId, bankAccountId, slot, supabaseCheckSecrets(createAdminSupabase()));
    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.checks.stock.signature_removed',
      subjectTable: 'check_stock_profiles',
      summary: `Removed check signature ${slot}`,
      metadata: { bankAccountId, slot },
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return checkErrorResponse(e, 'Could not remove the signature.');
  }
}
