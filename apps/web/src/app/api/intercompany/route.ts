export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import {
  postIntercompany,
  voidIntercompany,
  getIntercompanyOverview,
} from '@/lib/services/intercompany';

// ─── GET: overview (entities, transactions, pair balances, group tie) ─────────
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ entities: [], transactions: [], pairBalances: [], groupTie: { totalReceivableCents: 0, totalPayableCents: 0, differenceCents: 0, balanced: true } });
  }
  const overview = await getIntercompanyOverview(supabase, orgId);
  return NextResponse.json(overview);
}

// ─── POST: create an intercompany transaction ─────────────────────────────────
const createSchema = z
  .object({
    nature: z.enum(['FUNDING', 'EXPENSE_ON_BEHALF', 'REPAYMENT']),
    from_location_id: z.string().uuid(),
    to_location_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().max(1000).optional(),
    expense_account_id: z.string().uuid().optional(),
  })
  .refine((v) => v.from_location_id !== v.to_location_id, {
    message: 'The two entities must be different.',
    path: ['to_location_id'],
  })
  .refine((v) => v.nature !== 'EXPENSE_ON_BEHALF' || !!v.expense_account_id, {
    message: 'An expense account is required for "expense paid on behalf".',
    path: ['expense_account_id'],
  });

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', details }, { status: 422 });
  }

  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const result = await postIntercompany(supabase, {
    orgId,
    nature: parsed.data.nature,
    transactionDate: parsed.data.transaction_date,
    fromLocationId: parsed.data.from_location_id,
    toLocationId: parsed.data.to_location_id,
    amountCents: parsed.data.amount_cents,
    memo: parsed.data.memo,
    expenseAccountId: parsed.data.expense_account_id,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(
    {
      ic_id: result.icId,
      ic_number: result.icNumber,
      from_entry_number: result.fromEntryNumber,
      to_entry_number: result.toEntryNumber,
    },
    { status: 201 },
  );
}

// ─── DELETE: void an intercompany transaction (?id=...&reason=...) ─────────────
export async function DELETE(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const reason = (searchParams.get('reason') ?? '').trim();

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  if (reason.length < 3) return NextResponse.json({ error: 'A void reason is required' }, { status: 400 });

  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const res = await voidIntercompany(supabase, orgId, id, reason);
  if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
