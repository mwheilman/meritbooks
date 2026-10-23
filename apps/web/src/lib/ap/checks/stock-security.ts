/**
 * Check-stock SECURITY changes (security review M9, mig 182 §3b).
 *
 * Changing what makes a paper check negotiable — a signature image, the MICR bank numbers,
 * or LOOSENING the second-signature threshold / max-check amount — is exactly what an
 * insider (or a hijacked session) would do right before printing a fraudulent check. So
 * such a change:
 *   1. opens a public.check_stock_security_changes row (BEFORE the change is applied, so a
 *      failed write can only ever leave a spurious hold, never an unrecorded change);
 *   2. notifies every tenant admin in-app (lib/notify, severity critical);
 *   3. blocks THAT user from printing on THAT bank account for 24 h — enforced here for the
 *      UI and again inside public.issue_check_print_run — unless a DIFFERENT tenant admin
 *      confirms the change.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { membershipIdFor, notifyMembers, tenantAdminMemberships } from '@/lib/notify/in-app';
import { CheckError, type DB } from './db';

export const SECURITY_HOLD_HOURS = 24;

export const SECURITY_CHANGE_KINDS = ['SIGNATURE', 'SIGNATURE_REMOVED', 'BANK_NUMBERS', 'SECOND_SIGNATURE_THRESHOLD', 'MAX_CHECK_AMOUNT'] as const;
export type SecurityChangeKind = (typeof SECURITY_CHANGE_KINDS)[number];

export interface SecurityChangeRow {
  id: string;
  org_id: string;
  location_id: string;
  bank_account_id: string;
  change_kind: SecurityChangeKind;
  summary: string;
  changed_by: string;
  changed_at: string;
  hold_until: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

const COLUMNS = 'id, org_id, location_id, bank_account_id, change_kind, summary, changed_by, changed_at, hold_until, confirmed_by, confirmed_at';

function isMissingTable(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === '42P01' || e.code === 'PGRST205' || /relation "?[\w.]+"? does not exist|could not find the table/i.test(e.message ?? '');
}

const dollars = (c: number | null) => (c == null ? 'none' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

/**
 * Which threshold changes are security-relevant. ANY change to an existing value — raised,
 * lowered or removed — counts; only setting a limit where there was none (null → value,
 * a pure tightening) does not. No previous profile row = first-time setup = no change.
 */
export function thresholdChanges(
  prev: { secondSignatureOverCents: number | null; maxCheckCents: number | null } | null,
  next: { secondSignatureOverCents: number | null; maxCheckCents: number | null },
): Array<{ kind: SecurityChangeKind; summary: string }> {
  if (!prev) return [];
  const out: Array<{ kind: SecurityChangeKind; summary: string }> = [];
  const changed = (a: number | null, b: number | null) => a !== b && !(a == null && b != null);
  if (changed(prev.secondSignatureOverCents, next.secondSignatureOverCents)) {
    out.push({
      kind: 'SECOND_SIGNATURE_THRESHOLD',
      summary: next.secondSignatureOverCents == null
        ? `Second-signature requirement removed (was over ${dollars(prev.secondSignatureOverCents)})`
        : `Second-signature threshold changed from ${dollars(prev.secondSignatureOverCents)} to ${dollars(next.secondSignatureOverCents)}`,
    });
  }
  if (changed(prev.maxCheckCents, next.maxCheckCents)) {
    out.push({
      kind: 'MAX_CHECK_AMOUNT',
      summary: next.maxCheckCents == null
        ? `Maximum check amount removed (was ${dollars(prev.maxCheckCents)})`
        : `Maximum check amount changed from ${dollars(prev.maxCheckCents)} to ${dollars(next.maxCheckCents)}`,
    });
  }
  return out;
}

/** Pure: is `actor` held from printing by these open changes as of `now`? */
export function holdFor(rows: ReadonlyArray<Pick<SecurityChangeRow, 'changed_by' | 'confirmed_at' | 'hold_until' | 'summary'>>, actor: string, now: Date): { reason: string; holdUntil: string } | null {
  const open = rows.filter((r) => r.changed_by === actor && !r.confirmed_at && new Date(r.hold_until).getTime() > now.getTime());
  if (open.length === 0) return null;
  const until = open.map((r) => r.hold_until).sort().at(-1) as string;
  const when = new Date(until).toISOString().replace('T', ' ').slice(0, 16);
  return {
    holdUntil: until,
    reason: `You changed this account's check security settings (${open.map((r) => r.summary).join('; ')}). Another admin has to confirm the change on the Check stock tab before you can print — or wait until ${when} UTC.`,
  };
}

/** Pure confirmation rules (exported for tests). Returns an error sentence or null. */
export function confirmProblem(row: Pick<SecurityChangeRow, 'changed_by' | 'confirmed_at'>, actor: string, actorIsAdmin: boolean): string | null {
  if (row.confirmed_at) return 'This change was already confirmed.';
  if (row.changed_by === actor) return 'You made this change, so a different admin has to confirm it.';
  if (!actorIsAdmin) return 'Only a tenant admin can confirm a check security change.';
  return null;
}

/** Open (unconfirmed, unexpired) changes on one account. Fails closed except on a missing table. */
export async function loadOpenSecurityChanges(db: DB, orgId: string, bankAccountId: string, now: Date = new Date()): Promise<SecurityChangeRow[]> {
  const { data, error } = await db
    .from('check_stock_security_changes')
    .select(COLUMNS)
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .is('confirmed_at', null)
    .gt('hold_until', now.toISOString())
    .order('changed_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new CheckError(`Could not check for recent check security changes: ${error.message}`, 500);
  }
  return (data ?? []) as SecurityChangeRow[];
}

/** The print hold for `actor` on this account, or null. */
export async function printSecurityHold(db: DB, orgId: string, bankAccountId: string, actor: string, now: Date = new Date()): Promise<{ reason: string; holdUntil: string } | null> {
  return holdFor(await loadOpenSecurityChanges(db, orgId, bankAccountId, now), actor, now);
}

/** Record a change (service writer, BEFORE the change is applied). Throws on failure. */
export async function recordSecurityChange(
  writer: DB,
  input: { orgId: string; locationId: string; bankAccountId: string; kind: SecurityChangeKind; summary: string; actor: string },
  now: Date = new Date(),
): Promise<SecurityChangeRow> {
  const { data, error } = await writer
    .from('check_stock_security_changes')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      bank_account_id: input.bankAccountId,
      change_kind: input.kind,
      summary: input.summary.slice(0, 500),
      changed_by: input.actor,
      changed_at: now.toISOString(),
      hold_until: new Date(now.getTime() + SECURITY_HOLD_HOURS * 3600_000).toISOString(),
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new CheckError(`The change was not saved: its security hold could not be recorded (${error?.message ?? 'no row'}).`, 500);
  return data as SecurityChangeRow;
}

/** Tell every tenant admin (in-app, critical). Never throws — the row is the record. */
export async function notifySecurityChange(writer: SupabaseClient, row: SecurityChangeRow, accountLabel: string): Promise<number> {
  try {
    const targets = await tenantAdminMemberships(writer, row.org_id);
    if (targets.length === 0) return 0;
    return await notifyMembers(writer, targets, {
      orgId: row.org_id,
      locationId: row.location_id,
      kind: 'checks.stock_security_change',
      severity: 'critical',
      title: `Check security settings changed on ${accountLabel}`.slice(0, 200),
      body: `${row.summary}. The person who made the change can't print checks on this account for ${SECURITY_HOLD_HOURS} hours unless another admin confirms it. If you don't recognise this change, review it now.`,
      deepLink: `/checks?tab=stock&account=${row.bank_account_id}`,
      dedupeKey: `check-stock-security:${row.id}`,
    });
  } catch (e) {
    console.warn('[checks] security-change notification failed (non-fatal):', e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Is this Clerk user an active tenant admin (the lib/notify admin roles)? */
export async function isTenantAdmin(admin: SupabaseClient, orgId: string, clerkUserId: string): Promise<boolean> {
  const mid = await membershipIdFor(admin, orgId, clerkUserId);
  if (!mid) return false;
  return (await tenantAdminMemberships(admin, orgId)).includes(mid);
}

/** A different tenant admin confirms a change, lifting the changer's print hold. */
export async function confirmSecurityChange(
  db: DB,
  writer: DB,
  orgId: string,
  actor: string,
  changeId: string,
  actorIsAdmin: boolean,
  now: Date = new Date(),
): Promise<SecurityChangeRow> {
  const { data: row, error } = await db.from('check_stock_security_changes').select(COLUMNS).eq('org_id', orgId).eq('id', changeId).maybeSingle();
  if (error) throw new CheckError(`Could not load the change: ${error.message}`, 500);
  if (!row) throw new CheckError('That change was not found.', 404);
  const problem = confirmProblem(row as SecurityChangeRow, actor, actorIsAdmin);
  if (problem) throw new CheckError(problem, (row as SecurityChangeRow).confirmed_at ? 409 : 403);
  const { data: upd, error: updErr } = await writer
    .from('check_stock_security_changes')
    .update({ confirmed_by: actor, confirmed_at: now.toISOString() })
    .eq('org_id', orgId)
    .eq('id', changeId)
    .is('confirmed_at', null)
    .select(COLUMNS);
  if (updErr) throw new CheckError(`Could not confirm the change: ${updErr.message}`, 500);
  const out = ((upd ?? []) as SecurityChangeRow[])[0];
  if (!out) throw new CheckError('This change was already confirmed.', 409);
  return out;
}
