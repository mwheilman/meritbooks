export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  loadVendorPaymentProfiles,
  upsertVendorPaymentProfile,
} from '@/lib/ap/vendor-payment-details';

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
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const profiles = await loadVendorPaymentProfiles(supabase);
  return NextResponse.json({ profiles: Array.from(profiles.values()) });
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
    profile = await upsertVendorPaymentProfile(supabase, orgId, {
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
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save profile' }, { status: 500 });
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
