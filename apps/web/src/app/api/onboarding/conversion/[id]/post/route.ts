export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { buildOpeningEntryLines, extendedTieOutBlockers } from '@/lib/onboarding/conversion';
import { loadSession, loadAccountIdByNumber, openingSourceRef } from '@/lib/onboarding/session';
import { buildGateSubledgerTies } from '@/lib/onboarding/reconciliation/build';

/**
 * POST /api/onboarding/conversion/:id/post — GO-LIVE: post the opening entry.
 *
 * This is the gated step. It refuses unless the session is TIED OUT (a human
 * marked the opening TB reconciled) and still balanced. It posts a single balanced
 * opening journal entry through the deterministic engine (postJournalEntry), which
 * re-checks debits == credits at the DB. A deterministic source_ref
 * (CONVERSION-:id) guards against a double-post; the ai_decisions row then flips to
 * APPROVED and links to the GL entry.
 */

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });

  // Already posted → surface the existing entry (idempotent, no double-post).
  if (session.postedGlEntryId) {
    return NextResponse.json({ ok: true, alreadyPosted: true, glEntryId: session.postedGlEntryId });
  }

  const data = session.data;

  // GATE 1 — human tie-out.
  if (!data.tiedOut) {
    return NextResponse.json({ error: 'Blocked: a person must tie out the opening trial balance before go-live.' }, { status: 409 });
  }

  // GATE 2 — still balanced / mapped AND every imported subledger foots to its control
  // account (extended tie-out, spec §4). Re-checked at post time, never trusted stale.
  // The subledger→control ties resolve each control account BY ROLE; absent imported
  // subledger detail the tie list is empty and this is exactly the base balance gate.
  const subledgerTies = await buildGateSubledgerTies(supabase, orgId, data);
  const blockers = extendedTieOutBlockers({
    openingBalances: data.openingBalances,
    balance: data.balance,
    balanceSheet: data.balanceSheet,
    unmapped: data.unmapped,
    unknownTargets: data.unknownTargets,
    sourceTotals: data.sourceTotals,
  }, subledgerTies, { plAcknowledged: data.plAcknowledged });
  if (blockers.length > 0) {
    return NextResponse.json({ error: 'Blocked: the opening trial balance is no longer ready to post.', blockers }, { status: 409 });
  }

  // GATE 3 — double-post guard via a deterministic source_ref.
  const sourceRef = openingSourceRef(params.id);
  const { data: existing } = await supabase
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .eq('status', 'POSTED')
    .maybeSingle();
  if (existing) {
    const glId = (existing as { id: string }).id;
    await markPosted(supabase, orgId, params.id, glId, userId);
    return NextResponse.json({ ok: true, alreadyPosted: true, glEntryId: glId });
  }

  // Resolve target account numbers → account ids.
  const idByNumber = await loadAccountIdByNumber(supabase, orgId);
  const { lines: openingLines, missing } = buildOpeningEntryLines(data.openingBalances, idByNumber);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Cannot post — these accounts are missing from the chart of accounts: ${missing.join(', ')}` }, { status: 422 });
  }

  const lines: JournalEntryLineInput[] = openingLines.map((l) => ({
    account_id: l.account_id,
    debit_cents: l.debit_cents,
    credit_cents: l.credit_cents,
    location_id: data.companyId,
    memo: l.memo,
  }));

  // Post through the deterministic engine (re-checks balance at the DB).
  const result = await postJournalEntry(supabase, {
    org_id: orgId,
    location_id: data.companyId,
    entry_date: data.asOfDate,
    entry_type: 'STANDARD',
    memo: `Opening balance (historical conversion) — ${data.companyShortCode} as of ${data.asOfDate}`,
    source_module: 'OPENING_BALANCE',
    source_ref: sourceRef,
    created_by: null, // gl_entries.created_by is uuid + nullable → write null (Clerk ids are text)
    lines,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Failed to post the opening entry' }, { status: 422 });
  }

  await markPosted(supabase, orgId, params.id, result.entry_id!, userId);

  return NextResponse.json({
    ok: true,
    glEntryId: result.entry_id,
    entryNumber: result.entry_number,
    lineCount: lines.length,
    totalDebitCents: data.balance.totalDebitCents,
  });
}

async function markPosted(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  orgId: string,
  id: string,
  glEntryId: string,
  userId: string | null,
): Promise<void> {
  await supabase
    .from('ai_decisions')
    .update({
      status: 'APPROVED',
      posted_gl_entry_id: glEntryId,
      disposition_by_user: userId,
      disposition_at: new Date().toISOString(),
      disposition_note: 'Opening balance posted at go-live after human tie-out.',
    })
    .eq('org_id', orgId)
    .eq('id', id);
}
