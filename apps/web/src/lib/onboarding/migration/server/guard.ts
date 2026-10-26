/**
 * Who may do what in a client migration. Until the lead adds the spec's `onb.*` capability
 * keys (08-ONBOARDING-V2-SPEC §3 "Permissions used"), each action rides an existing
 * feature/action so the gate is real today:
 *
 *   view         journal_entries:view      the Tower, a client's migration, the certificate
 *   manage       settings_acct:edit        add clients to the migration, waves, plan, people
 *   work         journal_entries:create    sources, files, data-quality and match decisions, load
 *   settle       chart_of_accounts:approve settle a shared mapping rule for every client
 *   sign_proof   journal_entries:create    the preparer signs the balance proof
 *   sign_off     journal_entries:post      the reviewer signs off (issues) the certificate
 *   void         close_mgmt:manage         void a certificate (reason required)
 *   go_live      journal_entries:post      mark the client live
 *
 * Plus, on every write, the client must be inside the caller's client scope (enforce mode
 * refuses; shadow mode logs) — `assertWriteScope`. Reads use the caller's RLS client, so
 * a bookkeeper only ever sees their own clients' rows.
 */

import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { FeatureAction } from '@/lib/rbac/permissions';
import { isWriteScopeError } from '@/lib/db/scoped-writer';

export type MigrationAction = 'view' | 'manage' | 'work' | 'settle' | 'sign_proof' | 'sign_off' | 'void' | 'go_live';

export const MIGRATION_PERMISSIONS: Record<MigrationAction, { feature: string; action: FeatureAction }> = {
  view: { feature: 'journal_entries', action: 'view' },
  manage: { feature: 'settings_acct', action: 'edit' },
  work: { feature: 'journal_entries', action: 'create' },
  settle: { feature: 'chart_of_accounts', action: 'approve' },
  sign_proof: { feature: 'journal_entries', action: 'create' },
  sign_off: { feature: 'journal_entries', action: 'post' },
  void: { feature: 'close_mgmt', action: 'manage' },
  go_live: { feature: 'journal_entries', action: 'post' },
};

type Guard = Awaited<ReturnType<typeof requirePermission>>;

export function guardMigration(userId: string, action: MigrationAction, route: string): Promise<Guard> {
  const p = MIGRATION_PERMISSIONS[action];
  return requirePermission(userId, p.feature, p.action, { route });
}

/** A refused migration step, with a plain-English message and an HTTP status. */
export class MigrationError extends Error {
  constructor(message: string, readonly status: number = 400, readonly code: string = 'MIGRATION_ERROR') {
    super(message);
    this.name = 'MigrationError';
  }
}

export function migrationErrorResponse(e: unknown, fallback: string): NextResponse {
  if (e instanceof MigrationError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'OUT_OF_SCOPE' }, { status: 403 });
  console.error(`[onboarding-migration] ${fallback}:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: fallback, code: 'INTERNAL_ERROR' }, { status: 500 });
}

export const noOrg = (): NextResponse => NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
