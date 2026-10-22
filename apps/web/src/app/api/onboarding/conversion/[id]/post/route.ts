export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import {
  buildOpeningEntryLines,
  hardClosedPeriodMessage,
  isIsoDate,
  formatLongDate,
  type ConversionSessionData,
} from '@/lib/onboarding/conversion';
import {
  loadSession,
  loadAccountIdByNumber,
  openingSourceRef,
  computeGateBlockers,
  ensureCutoverPeriod,
  loadCompanyName,
} from '@/lib/onboarding/session';
import { setDomainDetectedHint, type OnboardingDomainKey } from '@/lib/onboarding/import/domain-detection';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { createAdminSupabase } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePermission } from '@/lib/rbac/require-permission';
import { writerFor } from '@/lib/db/scoped-writer';
import { sampleSessionPostBlock } from '@/lib/onboarding/sample-guard';

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

  // Authorize — go-live posts the opening-balance journal entry to the GL.
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  const session = await loadSession(supabase, orgId, params.id);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });

  // Already posted → surface the existing entry (idempotent, no double-post).
  if (session.postedGlEntryId) {
    return NextResponse.json({ ok: true, alreadyPosted: true, glEntryId: session.postedGlEntryId });
  }

  const data = session.data;

  // GATE 0 — never post SAMPLE (fixture) data to a real company's books (FPB B3).
  const sample = sampleSessionPostBlock(data, { orgId });
  if (sample) return NextResponse.json(sample, { status: 409 });

  // GATE 1 — a person confirmed the numbers match (tie-out).
  if (!data.tiedOut) {
    return NextResponse.json({ error: 'Before going live, a person needs to confirm the numbers match (the “Check the numbers match” step).' }, { status: 409 });
  }

  // GATE 2 — still balanced / mapped AND every imported subledger foots to its control
  // account (extended tie-out, spec §4). Re-checked at post time, never trusted stale.
  // This is the SAME predicate (computeGateBlockers) the review screen shows (FPB B8).
  const { blockers } = await computeGateBlockers(supabase, orgId, data);
  if (blockers.length > 0) {
    return NextResponse.json({ error: 'Something changed — these need fixing before your opening balances can post.', blockers }, { status: 409 });
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

  // GATE 4 — the cutover month must exist and be postable (FPB B1). A company created
  // without that year's periods gets them generated now with PRE-GO-LIVE statuses
  // (earlier months SOFT_CLOSE, never HARD_CLOSE). A locked (HARD_CLOSE) month is
  // never silently reopened — the user gets the exact steps to reopen it.
  if (!isIsoDate(data.asOfDate)) {
    return NextResponse.json({ error: `The opening-balance date “${data.asOfDate}” isn't a valid date. Start a new conversion with a valid date.` }, { status: 422 });
  }
  let periodsCreated = 0;
  try {
    const cut = await ensureCutoverPeriod(supabase, orgId, data.companyId, data.asOfDate);
    if (!cut.ok && cut.reason === 'HARD_CLOSE') {
      const companyName = (await loadCompanyName(supabase, orgId, data.companyId)) ?? data.companyShortCode;
      return NextResponse.json({
        error: hardClosedPeriodMessage({ asOfDate: data.asOfDate, companyName }),
        code: 'PERIOD_LOCKED',
      }, { status: 409 });
    }
    if (!cut.ok) {
      return NextResponse.json({
        error: `We couldn't set up the accounting month for ${formatLongDate(data.asOfDate)}. Open Accounting → Fiscal Periods, add ${data.asOfDate.slice(0, 4)} for this company, then press Post again.`,
        code: 'PERIOD_MISSING',
      }, { status: 422 });
    }
    periodsCreated = cut.created;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not prepare the accounting month' }, { status: 500 });
  }

  // Resolve target account numbers → account ids.
  const idByNumber = await loadAccountIdByNumber(supabase, orgId);
  const { lines: openingLines, missing } = buildOpeningEntryLines(data.openingBalances, idByNumber);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Can't post yet — these accounts are no longer in your chart of accounts: ${missing.join(', ')}. Choose different accounts for them.` }, { status: 422 });
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

  // Best-effort: an opening TB that carries a balance on a long-tail control account
  // (a term loan, a lease liability/ROU asset) means that DOMAIN exists but its
  // instrument/schedule isn't set up yet — flip the Setup Home card to "Detected ·
  // review" so the user is nudged to complete it. Never blocks go-live (fully guarded).
  await flagDetectedDomainsFromOpening(supabase, orgId, data).catch(() => { /* non-blocking */ });

  return NextResponse.json({
    ok: true,
    glEntryId: result.entry_id,
    entryNumber: result.entry_number,
    lineCount: lines.length,
    totalDebitCents: data.balance.totalDebitCents,
    periodsCreated,
  });
}

/**
 * Detect long-tail domains from the just-posted opening trial balance and set their
 * "Detected · review" board hint. A domain lights up when its control account (resolved
 * BY ROLE — no hard-coded numbers) carries a non-zero opening balance:
 *   • debt   ⇐ NOTES_PAYABLE (term loans)
 *   • leases ⇐ LEASE_LIABILITY or ROU_ASSET (ASC 842)
 * Fully degrade-safe: unresolved roles / write failures are swallowed. Uses the admin
 * client to write onboarding_state (service-role-write, mirroring persistOnboardingProgress).
 *
 * NOTE (fixed_assets): there is no single fixed-asset ACCOUNT ROLE to key off yet, so
 * fixed-asset detection from a TB is not wired here — see the integrator report for the
 * exact seam needed (a FIXED_ASSET_COST role, or a category heuristic on the 15xx range).
 */
async function flagDetectedDomainsFromOpening(
  supabase: SupabaseClient,
  orgId: string,
  data: ConversionSessionData,
): Promise<void> {
  const netByNumber = new Map<string, number>();
  for (const b of data.openingBalances) {
    netByNumber.set(b.targetAccountNumber, (b.debitCents || 0) - (b.creditCents || 0));
  }
  const roleHasBalance = async (role: AccountRoleKey): Promise<boolean> => {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      return Math.abs(netByNumber.get(ref.account_number) ?? 0) > 0;
    } catch (e) {
      if (e instanceof PostingError) return false;
      throw e;
    }
  };

  const admin = createAdminSupabase();
  const detect = async (key: OnboardingDomainKey, roles: AccountRoleKey[]) => {
    let hit = false;
    for (const r of roles) { if (await roleHasBalance(r)) { hit = true; break; } }
    if (hit) await setDomainDetectedHint(admin, orgId, key, { detected: true });
  };

  await detect('debt', ['NOTES_PAYABLE']);
  await detect('leases', ['LEASE_LIABILITY', 'ROU_ASSET']);
}

async function markPosted(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  orgId: string,
  id: string,
  glEntryId: string,
  userId: string | null,
): Promise<void> {
  // ai_decisions is SELECT-only for members (migration 172): the session row was read through
  // the member client in this request (loadSession — RLS proved org + client scope) after
  // journal_entries:post; lifecycle update via the service role, org pinned.
  await writerFor(supabase)
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
