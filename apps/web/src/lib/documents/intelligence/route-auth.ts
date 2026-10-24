/**
 * Who may do what with document intelligence (FPB §5, AC8):
 *   read / analyze / change type / set company / dismiss  → the Documents center gate
 *                                                            (audit_trail:view — the same
 *                                                            gate as the /documents page)
 *   accept / dismiss a module proposal                     → that module's own create gate
 *   link to an existing record                             → the record's module gate
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { FeatureAction } from '@/lib/rbac/permissions';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { IntelligenceError, type DraftAuthorizer } from './service';
import { TARGETS, type IntelligenceDto, type TargetKind } from './types';

type Guard = Awaited<ReturnType<typeof requirePermission>>;

export function guardCenter(userId: string, route: string): Promise<Guard> {
  return requirePermission(userId, 'audit_trail', 'view', { route });
}

export function guardTarget(userId: string, kind: TargetKind, route: string): Promise<Guard> {
  const p = TARGETS[kind].permission;
  return requirePermission(userId, p.feature, p.action, { route });
}

/** The module gate for linking a document to a record of this type. */
export const RECORD_PERMISSION: Record<string, { feature: string; action: FeatureAction }> = {
  lease: { feature: 'journal_entries', action: 'create' },
  debt_instrument: { feature: 'journal_entries', action: 'post' },
  covenant: { feature: 'journal_entries', action: 'post' },
  policy: { feature: 'journal_entries', action: 'create' },
  prepaid: { feature: 'journal_entries', action: 'create' },
  subscription: { feature: 'bills', action: 'create' },
  fixed_asset: { feature: 'fixed_assets', action: 'create' },
  bill: { feature: 'bills', action: 'create' },
  invoice: { feature: 'invoices', action: 'create' },
  customer_contract: { feature: 'invoices', action: 'create' },
  vendor: { feature: 'vendors', action: 'edit' },
  customer: { feature: 'customers', action: 'edit' },
  payroll_run: { feature: 'payroll', action: 'create' },
  bank_account: { feature: 'bank_feed', action: 'edit' },
  location: { feature: 'settings_acct', action: 'edit' },
};

export function guardRecord(userId: string, recordType: string, route: string): Promise<Guard> | null {
  const p = RECORD_PERMISSION[recordType];
  return p ? requirePermission(userId, p.feature, p.action, { route }) : null;
}

/**
 * The draft gate for a read the caller runs (security review M): a module draft (staged
 * extract, AP intake draft, vendor submission) is only made when the caller holds that
 * module's own gate AND the document's company is inside their client scope. Cached per
 * kind / company for the request. Fails closed.
 */
export function draftAuthorizer(opts: { userId: string; orgId: string; supabase: SupabaseClient; route: string }): DraftAuthorizer {
  const perm = new Map<TargetKind, Promise<boolean>>();
  const scope = new Map<string, Promise<boolean>>();
  return async (kind, locationId) => {
    let p = perm.get(kind);
    if (!p) {
      p = guardTarget(opts.userId, kind, opts.route).then((g) => g.ok, () => false);
      perm.set(kind, p);
    }
    if (!(await p)) return false;
    if (!locationId) return true;
    let s = scope.get(locationId);
    if (!s) {
      s = assertWriteScope(opts.supabase, opts.orgId, [locationId]).then(() => true, () => false);
      scope.set(locationId, s);
    }
    return s;
  };
}

/**
 * Never reveal a document the caller can't see (M): `duplicate_of` is kept only when the
 * twin is visible through the caller's RLS client (org + client scope), else null.
 */
export async function maskForeignDuplicates<T extends Pick<IntelligenceDto, 'duplicate_of'>>(supabase: SupabaseClient, rows: T[]): Promise<T[]> {
  const ids = Array.from(new Set(rows.map((r) => r.duplicate_of).filter((x): x is string => typeof x === 'string' && x.length > 0)));
  if (ids.length === 0) return rows;
  let visible = new Set<string>();
  try {
    const { data } = await supabase.from('documents').select('id').in('id', ids);
    visible = new Set(((data ?? []) as Array<{ id: string }>).map((d) => d.id));
  } catch {
    visible = new Set();
  }
  return rows.map((r) => (r.duplicate_of && !visible.has(r.duplicate_of) ? { ...r, duplicate_of: null } : r));
}

/** Map a service / scope error to the API's error shape. */
export function errorResponse(e: unknown, fallback: string): NextResponse {
  if (e instanceof IntelligenceError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'OUT_OF_SCOPE' }, { status: 403 });
  console.error(`[document-intelligence] ${fallback}:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: fallback, code: 'INTERNAL_ERROR' }, { status: 500 });
}

export const noOrg = (): NextResponse => NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
