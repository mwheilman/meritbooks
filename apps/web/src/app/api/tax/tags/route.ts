export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { STANDARD_M_LINES, findMLine } from '@/lib/tax/book-tax';

/**
 * Book-to-tax ACCOUNT tagging surface.
 *
 * GET  /api/tax/tags — the standard M-1/M-3 line catalog, every P&L account with its
 *      current tag (if any) and period activity, plus any open AI tag proposals. This is
 *      what the tagging UI renders so a human can review and set each account's book-tax
 *      character.
 * POST /api/tax/tags — upsert an account's tag (human confirms). If it confirms an AI
 *      proposal, the matching PROPOSED ai_decisions row is dispositioned APPROVED.
 * DELETE /api/tax/tags?account_id=… — clear an account's tag.
 *
 * Reads run through the RLS-scoped client (org isolation by the DB). Writes are gated on
 * journal_entries:create — the same guard the control family uses (a dedicated `tax`
 * permission is the follow-up, mirroring the `payments` permission task). Nothing here
 * posts to the ledger or moves money; a tag is a reporting dimension.
 */

const CODES = STANDARD_M_LINES.map((l) => l.code) as [string, ...string[]];

const upsertSchema = z.object({
  account_id: z.string().uuid(),
  m_line_code: z.enum(CODES),
  disallowance_pct: z.number().min(0).max(100).nullable().optional(),
  note: z.string().max(500).optional(),
  ai_decision_id: z.string().uuid().optional(),
});

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  // P&L accounts (the tag candidates) — REVENUE/COGS/OPEX/OTHER only.
  const { data: accounts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, account_number, name, account_type, is_active')
    .in('account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER'])
    .eq('is_active', true)
    .order('account_number');
  if (acctErr) {
    return NextResponse.json({ error: acctErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const [{ data: tags }, { data: proposals }] = await Promise.all([
    supabase
      .from('book_tax_account_tags')
      .select('account_id, m_line_code, difference_type, taxable_effect, disallowance_pct, note, source'),
    supabase
      .from('ai_decisions')
      .select('id, confidence, reasoning, proposed_output')
      .eq('feature', 'BOOK_TAX_TAG')
      .eq('status', 'PROPOSED'),
  ]);

  const tagByAccount = new Map(
    ((tags ?? []) as Array<{ account_id: string }>).map((t) => [t.account_id, t]),
  );
  const proposalByAccount = new Map<string, { id: string; confidence: number | null; reasoning: string | null; code: string; label: string; method: string }>();
  for (const p of (proposals ?? []) as Array<{ id: string; confidence: number | null; reasoning: string | null; proposed_output: Record<string, unknown> }>) {
    const out = p.proposed_output ?? {};
    const acctId = out.account_id as string | undefined;
    const code = out.code as string | undefined;
    if (acctId && code) {
      proposalByAccount.set(acctId, {
        id: p.id,
        confidence: p.confidence,
        reasoning: p.reasoning,
        code,
        label: (out.label as string) ?? findMLine(code)?.label ?? code,
        method: (out.method as string) ?? 'ai',
      });
    }
  }

  const rows = ((accounts ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string }>).map((a) => ({
    accountId: a.id,
    accountNumber: a.account_number,
    accountName: a.name,
    accountType: a.account_type,
    tag: tagByAccount.get(a.id) ?? null,
    proposal: proposalByAccount.get(a.id) ?? null,
  }));

  return NextResponse.json({
    data: {
      catalog: STANDARD_M_LINES,
      accounts: rows,
      taggedCount: rows.filter((r) => r.tag).length,
      proposalCount: proposalByAccount.size,
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  const { account_id, m_line_code, disallowance_pct, note, ai_decision_id } = parsed.data;
  const def = findMLine(m_line_code);
  if (!def) {
    return NextResponse.json({ error: 'Unknown M-line code', code: 'BAD_CODE' }, { status: 422 });
  }

  const { error: upsertErr } = await supabase
    .from('book_tax_account_tags')
    .upsert(
      {
        org_id: orgId,
        account_id,
        m_line_code,
        difference_type: def.differenceType,
        taxable_effect: def.taxableEffect,
        disallowance_pct: disallowance_pct ?? null,
        note: note ?? null,
        source: ai_decision_id ? 'AI_CONFIRMED' : 'MANUAL',
        ai_decision_id: ai_decision_id ?? null,
      },
      { onConflict: 'org_id,account_id' },
    );
  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message, code: 'UPSERT_ERROR' }, { status: 500 });
  }

  // Confirming an AI proposal dispositions its decision row APPROVED (audit trail).
  if (ai_decision_id) {
    await supabase
      .from('ai_decisions')
      .update({ status: 'APPROVED', disposition_by_user: userId, disposition_at: new Date().toISOString() })
      .eq('id', ai_decision_id)
      .eq('feature', 'BOOK_TAX_TAG');
  }

  return NextResponse.json({ data: { ok: true } });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const accountId = new URL(request.url).searchParams.get('account_id');
  if (!accountId) {
    return NextResponse.json({ error: 'account_id is required', code: 'MISSING_PARAM' }, { status: 400 });
  }
  const { error } = await supabase.from('book_tax_account_tags').delete().eq('account_id', accountId);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_ERROR' }, { status: 500 });
  return NextResponse.json({ data: { ok: true } });
}
