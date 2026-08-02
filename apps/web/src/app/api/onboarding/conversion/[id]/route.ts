export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import {
  applyMapping,
  tieOutBlockers,
  type MappingTable,
  type ConversionSessionData,
} from '@/lib/onboarding/conversion';
import { loadSession, saveSessionData, loadTargetAccounts } from '@/lib/onboarding/session';

/**
 * GET  /api/onboarding/conversion/:id — the full staged session.
 * PATCH /api/onboarding/conversion/:id — human edits: remap accounts, or tie out.
 *
 * Any mapping edit re-runs the deterministic assembly and clears the tie-out
 * (a changed TB must be re-reviewed). Tie-out is REFUSED unless the opening TB is
 * balanced, ≥2 lines, fully mapped, and every target exists — the blocking gate.
 */

interface PatchBody {
  /** sourceAccount -> target account number (null clears the mapping). */
  mappingUpdates?: Record<string, string | null>;
  /** true to tie out (go-live enabling), false to reopen. */
  tieOut?: boolean;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });

  return NextResponse.json({
    id: session.id,
    status: session.status,
    posted: !!session.postedGlEntryId,
    postedGlEntryId: session.postedGlEntryId,
    blockers: tieOutBlockers({
      openingBalances: session.data.openingBalances,
      balance: session.data.balance,
      unmapped: session.data.unmapped,
      unknownTargets: session.data.unknownTargets,
      sourceTotals: session.data.sourceTotals,
    }),
    ...session.data,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });
  if (session.postedGlEntryId) {
    return NextResponse.json({ error: 'This conversion has already been posted and is locked.' }, { status: 409 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const targets = await loadTargetAccounts(supabase, orgId);
  const targetNumbers = new Set(targets.map((t) => t.accountNumber));
  const data: ConversionSessionData = { ...session.data };

  // ── Human remap ────────────────────────────────────────────────────────────
  if (body.mappingUpdates && Object.keys(body.mappingUpdates).length > 0) {
    const mapping: MappingTable = { ...data.mapping };
    for (const [src, target] of Object.entries(body.mappingUpdates)) {
      if (!(src in mapping)) continue; // only accounts that exist in this file
      if (target && !targetNumbers.has(target)) {
        return NextResponse.json({ error: `Account ${target} is not in this chart of accounts` }, { status: 422 });
      }
      mapping[src] = target
        ? { targetAccountNumber: target, confidence: 1, source: 'human', reasoning: 'Mapped by a person.' }
        : { targetAccountNumber: null, confidence: null, source: 'unmapped' };
    }
    const assembled = applyMapping(data.sourceLines, mapping, targets);
    data.mapping = mapping;
    data.openingBalances = assembled.openingBalances;
    data.balance = assembled.balance;
    data.unmapped = assembled.unmapped;
    data.unknownTargets = assembled.unknownTargets;
    data.sourceTotals = assembled.sourceTotals;
    // A changed TB must be re-tied-out.
    data.tiedOut = false;
    data.tiedOutBy = null;
    data.tiedOutAt = null;
  }

  // ── Tie-out toggle (the blocking gate) ───────────────────────────────────────
  if (body.tieOut === true) {
    const blockers = tieOutBlockers({
      openingBalances: data.openingBalances,
      balance: data.balance,
      unmapped: data.unmapped,
      unknownTargets: data.unknownTargets,
      sourceTotals: data.sourceTotals,
    });
    if (blockers.length > 0) {
      return NextResponse.json({ error: 'Opening trial balance is not ready to tie out', blockers }, { status: 422 });
    }
    data.tiedOut = true;
    data.tiedOutBy = userId;
    data.tiedOutAt = new Date().toISOString();
  } else if (body.tieOut === false) {
    data.tiedOut = false;
    data.tiedOutBy = null;
    data.tiedOutAt = null;
  }

  await saveSessionData(supabase, orgId, params.id, data);

  return NextResponse.json({
    id: params.id,
    status: session.status,
    posted: false,
    blockers: tieOutBlockers({
      openingBalances: data.openingBalances,
      balance: data.balance,
      unmapped: data.unmapped,
      unknownTargets: data.unknownTargets,
      sourceTotals: data.sourceTotals,
    }),
    ...data,
  });
}
