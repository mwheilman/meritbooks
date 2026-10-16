export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { applyMappingChanges, withMapping, STRONG_MATCH_THRESHOLD } from '@/lib/onboarding/conversion';
import { loadSession, saveSessionData, loadTargetAccounts, buildSessionView } from '@/lib/onboarding/session';

/**
 * POST /api/onboarding/conversion/:id/mapping — save MANY mapping decisions in ONE
 * request (FPB W1 "faster mapping").
 *
 * Body:
 *   changes                  — person-chosen targets: [{ sourceAccount, target|null }]
 *   acceptSuggestedAtOrAbove — optional; accept every AI/auto suggestion at or above
 *                              this confidence (the "Accept all strong matches" action;
 *                              the screen sends 0.9)
 *
 * The whole batch is validated first (every target must exist in the chart of
 * accounts) and persisted in a single write — nothing is half-applied. When any
 * target changes, the opening TB is re-assembled in code and "the numbers match" is
 * cleared. Returns the same session view as GET.
 */

const BodySchema = z.object({
  changes: z
    .array(z.object({ sourceAccount: z.string().min(1).max(200), target: z.string().max(50).nullable() }))
    .max(5000)
    .default([]),
  acceptSuggestedAtOrAbove: z.number().min(0.5).max(1).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid mapping changes', details: parsed.error.flatten() }, { status: 400 });
  }
  const { changes, acceptSuggestedAtOrAbove } = parsed.data;
  if (changes.length === 0 && acceptSuggestedAtOrAbove == null) {
    return NextResponse.json({ error: 'Nothing to save' }, { status: 400 });
  }

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });
  if (session.postedGlEntryId) {
    return NextResponse.json({ error: 'These opening balances are already posted and locked.' }, { status: 409 });
  }

  try {
    const targets = await loadTargetAccounts(supabase, orgId);
    const res = applyMappingChanges(
      session.data.mapping,
      changes,
      new Set(targets.map((t) => t.accountNumber)),
      { acceptSuggestedAtOrAbove: acceptSuggestedAtOrAbove ?? undefined },
    );
    if (res.error) return NextResponse.json({ error: res.error }, { status: 422 });

    const data = withMapping(session.data, res.mapping, targets, { resetTieOut: res.targetsChanged > 0 });
    await saveSessionData(supabase, orgId, params.id, data);
    const view = await buildSessionView(supabase, orgId, session, data);
    return NextResponse.json({
      ...view,
      saved: { targetsChanged: res.targetsChanged, accepted: res.accepted, threshold: acceptSuggestedAtOrAbove ?? STRONG_MATCH_THRESHOLD },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save the mapping' }, { status: 500 });
  }
}
