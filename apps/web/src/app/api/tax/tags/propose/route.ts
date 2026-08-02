export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { proposeAccountTags, persistTagProposals, type CandidateAccount } from '@/lib/tax/book-tax-tag-ai';

/**
 * POST /api/tax/tags/propose — AI proposes book-tax TAGS for untagged P&L accounts.
 *
 * Canon §3: the model proposes only WHICH standard M-1/M-3 line an account belongs to; it
 * never proposes a number. Each proposal is written PROPOSED to public.ai_decisions
 * (feature 'BOOK_TAX_TAG') for a human to confirm on the tagging surface. A deterministic
 * keyword heuristic runs first (free, explainable); the ambiguous remainder routes through
 * the metered Core AI gateway only when a key is configured. Idempotent per account.
 *
 * Gated on journal_entries:create (control-family guard); RLS-scoped throughout.
 */
export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  // Candidate = active P&L account with NO existing tag.
  const [{ data: accounts, error: acctErr }, { data: tags }] = await Promise.all([
    supabase
      .from('accounts')
      .select('id, account_number, name, account_type')
      .in('account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER'])
      .eq('is_active', true),
    supabase.from('book_tax_account_tags').select('account_id'),
  ]);
  if (acctErr) return NextResponse.json({ error: acctErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const tagged = new Set(((tags ?? []) as Array<{ account_id: string }>).map((t) => t.account_id));
  const candidates: CandidateAccount[] = ((accounts ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string }>)
    .filter((a) => !tagged.has(a.id))
    .map((a) => ({ id: a.id, accountNumber: a.account_number, name: a.name, accountType: a.account_type }));

  if (candidates.length === 0) {
    return NextResponse.json({ data: { proposed: 0, inserted: 0, refreshed: 0, candidates: 0 } });
  }

  const proposals = await proposeAccountTags(
    { supabase, anthropicApiKey: getAnthropicApiKey() },
    { orgId, userId, accounts: candidates },
  );
  const { inserted, refreshed } = await persistTagProposals(supabase, { orgId, userId, proposals });

  return NextResponse.json({
    data: { proposed: proposals.length, inserted, refreshed, candidates: candidates.length },
  });
}
