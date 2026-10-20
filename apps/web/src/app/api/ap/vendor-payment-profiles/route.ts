export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { applyFieldMasksAll, maskMeta, resolveFieldAccess } from '@/lib/rbac/field-masks';
import {
  loadVendorPaymentProfiles,
  upsertVendorPaymentProfile,
} from '@/lib/ap/vendor-payment-details';
import { isWriteScopeError } from '@/lib/db/scoped-writer';

/**
 * Vendor payment profiles — the MASKED bank details + preferred method captured
 * in the pay-run flow. GET lists the org's profiles (masked, RLS-scoped). POST
 * upserts one; the raw account/routing numbers are masked to last-4 server-side
 * and the full values are NEVER persisted or returned.
 *
 * SAFETY: nothing here moves money, posts to the GL, or contacts a bank. Capture
 * is a preparer-level action, gated on checks:create (fails closed).
 */

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const profiles = await loadVendorPaymentProfiles(supabase);
  // Bank details are the `bank` field class (05 R-6). Only last-4 masks are ever
  // stored; a role whose bank level is `hidden` gets no mask at all.
  const fieldAccess = await resolveFieldAccess(createAdminSupabase(), orgId, userId);
  const masked = applyFieldMasksAll(
    Array.from(profiles.values()) as unknown as Array<Record<string, unknown>>,
    { accountMask: 'bank', routingMask: 'bank' },
    fieldAccess,
  );
  return NextResponse.json({ profiles: masked.rows, fieldMasks: maskMeta(fieldAccess, masked.masked) });
}

interface ProfileBody {
  vendorId?: string;
  paymentMethod?: string;
  accountType?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  bankName?: string | null;
  notes?: string | null;
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Capturing vendor banking detail is a preparer step in the money-out flow —
  // gate it (fails closed for any role lacking checks:create).
  const guard = await requirePermission(userId, 'checks', 'create');
  if (!guard.ok) return guard.response;

  // R-7: changing vendor bank details is the classic payment-fraud vector — it needs a
  // fresh re-verification when the tenant turned step-up on (05 §3.8).
  const sessionPolicy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'bank_details_edit' });
  if (!sessionPolicy.ok) return sessionPolicy.response;

  let body: ProfileBody = {};
  try {
    body = (await request.json()) as ProfileBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.vendorId) {
    return NextResponse.json({ error: 'vendorId is required' }, { status: 400 });
  }

  let profile;
  try {
    profile = await upsertVendorPaymentProfile(orgId, {
      vendorId: body.vendorId,
      paymentMethod: body.paymentMethod ?? 'ACH',
      accountType: body.accountType ?? null,
      accountNumber: body.accountNumber ?? null,
      routingNumber: body.routingNumber ?? null,
      bankName: body.bankName ?? null,
      notes: body.notes ?? null,
      capturedBy: userId,
    });
  } catch (e) {
    const status = isWriteScopeError(e) ? 403 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save profile' }, { status });
  }

  // Audit — record only the MASKED detail (never the raw numbers the client sent).
  await logHumanAction(supabase, userId, orgId, {
    action: 'ap.vendor_payment_profile.upsert',
    subjectTable: 'vendor_payment_profiles',
    subjectId: body.vendorId,
    summary: `Captured payment details for vendor (${profile.paymentMethod}${profile.accountMask ? ` acct ${profile.accountMask}` : ''})`,
    metadata: {
      vendorId: profile.vendorId,
      paymentMethod: profile.paymentMethod,
      accountMask: profile.accountMask,
      routingMask: profile.routingMask,
      accountType: profile.accountType,
    },
  }).catch(() => {});

  return NextResponse.json({ profile });
}
