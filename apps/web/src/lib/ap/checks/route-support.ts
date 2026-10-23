/**
 * Shared plumbing for the /api/ap/checks/* routes (server-only): permission gates, the SoD
 * settings, error → response mapping, PDF rendering and display names.
 */

import React from 'react';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToBuffer } from '@react-pdf/renderer';
import { requirePermission, type PermissionResult } from '@/lib/rbac/require-permission';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { loadTenantSodSettings } from '@/lib/rbac/sod-store';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { AlignmentPdf, CheckRunPdf } from '@/lib/ap/check-print/check-pdf';
import type { CheckStockSetup, RenderedCheck } from '@/lib/ap/check-print/check-doc';
import type { CheckLayout } from '@/lib/ap/check-print/layout';
import { loadMicrFont } from '@/lib/ap/check-print/micr-font';
import { CheckAmountError } from './amount-words';
import { MicrError } from './micr';
import { PositivePayError } from './positive-pay';
import { isCheckError } from './db';
import type { PrintSod } from './print-service';

/** Print / spoil / void / mark sent / positive pay / check-stock changes: release authority. */
export function requireCheckMoney(userId: string): Promise<PermissionResult> {
  return requireMoneyMovement(userId, PAYMENTS_EXECUTE, { feature: 'checks', action: 'create' }, AP_DISBURSEMENT_RELEASE_FEATURE);
}

export function requireCheckView(userId: string): Promise<PermissionResult> {
  return requirePermission(userId, 'checks', 'view');
}

export async function loadPrintSod(orgId: string): Promise<PrintSod> {
  const sod = await loadTenantSodSettings(createAdminSupabase(), orgId);
  return { soleApproverMode: sod.soleApproverMode, soleApproverMaxCents: sod.soleApproverMaxCents };
}

/** Map a thrown error to a JSON response with the right status (never a stack). */
export function checkErrorResponse(e: unknown, fallback = 'Something went wrong.'): NextResponse {
  if (isCheckError(e)) return NextResponse.json({ error: e.message }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
  if (e instanceof MicrError || e instanceof CheckAmountError || e instanceof PositivePayError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  console.error('[checks]', e);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export function pdfResponse(buf: Uint8Array, fileName: string, headers: Record<string, string> = {}): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function renderCheckRun(checks: RenderedCheck[], setup: CheckStockSetup): Promise<Uint8Array> {
  const el = React.createElement(CheckRunPdf, { checks, setup, micrFont: loadMicrFont(), title: `Checks ${checks[0]?.checkNumber ?? ''}` });
  return renderToBuffer(el as Parameters<typeof renderToBuffer>[0]);
}

export async function renderAlignment(layout: CheckLayout, offsetXPt: number, offsetYPt: number, accountLabel: string): Promise<Uint8Array> {
  const el = React.createElement(AlignmentPdf, { layout, offsetXPt, offsetYPt, accountLabel });
  return renderToBuffer(el as Parameters<typeof renderToBuffer>[0]);
}

/** Clerk user id → display name (presentation only; unknown ids are omitted). */
export async function userNames(db: SupabaseClient, clerkIds: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ids = Array.from(new Set(clerkIds.filter((x) => typeof x === 'string' && x.length > 0)));
  if (ids.length === 0) return out;
  try {
    const { data } = await db.schema('core').from('users').select('clerk_user_id, first_name, last_name, email').in('clerk_user_id', ids);
    for (const u of (data ?? []) as Array<{ clerk_user_id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '';
      if (name) out[u.clerk_user_id] = name;
    }
  } catch {
    /* names are presentation only */
  }
  return out;
}

/** Plain-ASCII account label for PDFs (Helvetica has no bullet glyph). */
export function pdfAccountLabel(name: string, mask: string | null): string {
  const last4 = (mask ?? '').replace(/\D/g, '').slice(-4);
  return last4 ? `${name} ****${last4}` : name;
}
