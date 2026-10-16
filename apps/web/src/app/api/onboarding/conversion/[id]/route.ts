export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  applyMappingChanges,
  withMapping,
  type ConversionSessionData,
  type MappingChange,
} from '@/lib/onboarding/conversion';
import {
  loadSession,
  saveSessionData,
  loadTargetAccounts,
  buildSessionView,
  computeGateBlockers,
} from '@/lib/onboarding/session';

/**
 * GET  /api/onboarding/conversion/:id — the full staged session, as the review screen
 *      shows it: EVERY go-live blocker (base TB + subledger→control ties — the exact
 *      predicate the post route enforces, FPB B8), in dollars, plus the cutover-month
 *      state.
 * PATCH /api/onboarding/conversion/:id — person edits: remap accounts (legacy
 *      per-row path; the screen now uses …/:id/mapping for batched saves), the
 *      mid-year acknowledgment, or "the numbers match" (tie-out).
 *
 * Any target change re-runs the deterministic assembly and clears the tie-out (a
 * changed TB must be re-checked). Tie-out is REFUSED while any gate blocker remains.
 */

interface PatchBody {
  /** sourceAccount -> target account number (null clears the mapping). */
  mappingUpdates?: Record<string, string | null>;
  /** true to confirm the numbers match (enables go-live), false to reopen. */
  tieOut?: boolean;
  /** Acknowledge a mid-year go-live (open income-statement balances are intended). */
  acknowledgePl?: boolean;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });

  try {
    const view = await buildSessionView(supabase, orgId, session, session.data);
    return NextResponse.json(view);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load the conversion' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Editing / attesting the opening entry is journal-entry preparation work.
  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });
  if (session.postedGlEntryId) {
    return NextResponse.json({ error: 'These opening balances are already posted and locked.' }, { status: 409 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let data: ConversionSessionData = { ...session.data };

  try {
    // ── Person remap (legacy per-row) ────────────────────────────────────────
    if (body.mappingUpdates && Object.keys(body.mappingUpdates).length > 0) {
      const targets = await loadTargetAccounts(supabase, orgId);
      const changes: MappingChange[] = Object.entries(body.mappingUpdates).map(([sourceAccount, target]) => ({ sourceAccount, target }));
      const res = applyMappingChanges(data.mapping, changes, new Set(targets.map((t) => t.accountNumber)));
      if (res.error) return NextResponse.json({ error: res.error }, { status: 422 });
      data = withMapping(data, res.mapping, targets, { resetTieOut: res.targetsChanged > 0 });
    }

    // ── Mid-year go-live acknowledgment (unblocks the balance-sheet identity gate) ──
    if (typeof body.acknowledgePl === 'boolean') {
      data.plAcknowledged = body.acknowledgePl;
      if (!body.acknowledgePl) { data.tiedOut = false; data.tiedOutBy = null; data.tiedOutAt = null; }
    }

    // ── "The numbers match" (tie-out) — the SAME predicate the post route enforces ──
    if (body.tieOut === true) {
      const { blockers } = await computeGateBlockers(supabase, orgId, data);
      if (blockers.length > 0) {
        return NextResponse.json({ error: 'The numbers are not ready to confirm yet.', blockers }, { status: 422 });
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
    const view = await buildSessionView(supabase, orgId, session, data);
    return NextResponse.json(view);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not update the conversion' }, { status: 500 });
  }
}
