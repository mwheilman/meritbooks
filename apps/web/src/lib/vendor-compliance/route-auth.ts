/**
 * Vendor compliance route guards (FPB §19 A9) — until dedicated keys exist (lead: a
 * `ctl.vendor_compliance:K` configure key and a payments-side key for VN-10):
 *   view                       compliance:view
 *   request / review / verify  compliance:manage
 *   requirement sets           compliance:manage
 *   automatic-chase switch     compliance:manage AND settings_system:edit
 */

import { NextResponse } from 'next/server';
import { requirePermission, type PermissionResult } from '@/lib/rbac/require-permission';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { AdminError } from './admin';
import { BankChangeError } from './bank-change';
import { ReviewError } from './review';
import { RequestError } from '@/lib/requests/service';

export function vcView(userId: string, route: string): Promise<PermissionResult> {
  return requirePermission(userId, 'compliance', 'view', { route });
}

export function vcManage(userId: string, route: string): Promise<PermissionResult> {
  return requirePermission(userId, 'compliance', 'manage', { route });
}

export async function vcSettings(userId: string, route: string): Promise<PermissionResult> {
  const m = await vcManage(userId, route);
  if (!m.ok) return m;
  return requirePermission(userId, 'settings_system', 'edit', { route });
}

/** Typed domain errors → a calm JSON error; anything else rethrows (apiHandler → 500). */
export function vcError(e: unknown): NextResponse {
  if (e instanceof ReviewError || e instanceof BankChangeError || e instanceof AdminError || e instanceof RequestError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
  throw e;
}

export function noOrg(): NextResponse {
  return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
}
