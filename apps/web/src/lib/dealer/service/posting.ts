/**
 * Post a role-level JournalPlan for one client.
 *
 *  1. The plan must balance on canonical types (engine guarantee, re-checked).
 *  2. Each role resolves through public.dealer_role_map (mig 169 — the SAME resolver the
 *     enable gate and the tie-out view use). A leg may carry an explicit override (a
 *     floor-plan line's own liability account).
 *  3. Each resolved account must be active, in the org, of an allowed type for the role,
 *     and share the role's normal balance — so a mis-mapping can never invert a leg.
 *  4. Debit/credit is DERIVED from the resolved account's type (canon §3).
 *  5. Every leg carries the client's department for its department role (AC14);
 *     unmapped department role → refuse.
 *  6. postJournalEntry with source_ref `dealer:<key>` — migration 064's unique index on
 *     (org_id, source_ref, entry_type) makes the DB the double-post guarantor; a retry
 *     that collides returns the existing entry instead of posting twice.
 */

import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { debitCreditFor, normalBalanceFor, type AccountSubType, type AccountType } from '@/lib/posting/account-direction';
import { assertBalanced, type JournalPlan } from '../journal';
import { ROLE_SPEC, unmappedRoleMessage, type DealerRole } from '../roles';
import type { DeptRole } from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';

export interface RoleMapRow {
  role_key: string;
  account_id: string | null;
  mapped_directly: boolean;
}

export async function loadRoleMap(d: Pick<DealerCtx, 'admin' | 'orgId' | 'locationId'>): Promise<Map<string, RoleMapRow>> {
  const { data, error } = await d.admin.rpc('dealer_role_map', { p_org: d.orgId, p_location: d.locationId });
  if (error) dbFail('Role map lookup failed', error);
  return new Map(((data ?? []) as RoleMapRow[]).map((r) => [r.role_key, r]));
}

export async function loadDepartmentMap(d: Pick<DealerCtx, 'admin' | 'orgId' | 'locationId'>): Promise<Map<DeptRole, string>> {
  const { data, error } = await d.admin
    .from('dealer_department_map')
    .select('dept_role, department_id')
    .eq('org_id', d.orgId)
    .eq('location_id', d.locationId);
  if (error) dbFail('Department map lookup failed', error);
  return new Map(((data ?? []) as { dept_role: DeptRole; department_id: string }[]).map((r) => [r.dept_role, r.department_id]));
}

interface AccountRow {
  id: string;
  account_type: AccountType;
  account_sub_type: AccountSubType;
  account_number: string;
  is_active: boolean;
}

export interface PostPlanOptions {
  entryDate: string;
  /** Stable idempotency key; becomes source_ref `dealer:<key>`. */
  key: string;
  sourceId?: string | null;
  /** Pre-loaded maps (batch posting). */
  roleMap?: Map<string, RoleMapRow>;
  deptMap?: Map<DeptRole, string>;
}

export interface PostPlanResult {
  glEntryId: string;
  entryNumber: string | null;
  reused: boolean;
}

/** Resolve a plan into GL lines (exported for preview endpoints and tests). */
export async function resolvePlanLines(
  d: DealerCtx,
  plan: JournalPlan,
  maps: { roleMap: Map<string, RoleMapRow>; deptMap: Map<DeptRole, string> },
): Promise<JournalEntryLineInput[]> {
  const canonical = assertBalanced(plan);
  const legs = plan.legs.filter((l) => l.amountCents > 0);

  const accountIdFor = (role: DealerRole, override?: string | null): string => {
    if (override) return override;
    const id = maps.roleMap.get(role)?.account_id ?? null;
    if (!id) throw new DealerError('UNMAPPED_ROLE', unmappedRoleMessage(role), { role });
    return id;
  };
  const ids = [...new Set(legs.map((l) => accountIdFor(l.role, l.accountOverrideId)))];
  const { data, error } = await d.admin
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number, is_active')
    .eq('org_id', d.orgId)
    .in('id', ids);
  if (error) dbFail('Account lookup failed', error);
  const byId = new Map(((data ?? []) as AccountRow[]).map((a) => [a.id, a]));

  return legs.map((leg, i) => {
    const accountId = accountIdFor(leg.role, leg.accountOverrideId);
    const acct = byId.get(accountId);
    const spec = ROLE_SPEC[leg.role];
    if (!acct) throw new DealerError('UNMAPPED_ROLE', `The account mapped to '${spec.label}' is not in this organization.`, { role: leg.role });
    if (!acct.is_active) throw new DealerError('UNMAPPED_ROLE', `The account mapped to '${spec.label}' (${acct.account_number}) is inactive.`, { role: leg.role });
    const sameNormal =
      normalBalanceFor(acct.account_type, acct.account_sub_type) === normalBalanceFor(spec.canonicalType);
    if (!spec.allowedTypes.includes(acct.account_type) || !sameNormal) {
      throw new DealerError(
        'UNMAPPED_ROLE',
        `'${spec.label}' is mapped to ${acct.account_number} (${acct.account_type}); it must be ${spec.allowedTypes.join(' or ')}.`,
        { role: leg.role },
      );
    }
    const dc = debitCreditFor(acct.account_type, leg.effect, leg.amountCents, acct.account_sub_type);
    // Cross-check against the engine's canonical side (defense in depth).
    if (dc.debit_cents !== canonical[i].debitCents || dc.credit_cents !== canonical[i].creditCents) {
      throw new DealerError('POSTING_FAILED', `Direction mismatch on ${leg.role}`);
    }
    const deptRole = leg.deptRole ?? plan.primaryDept;
    const departmentId = maps.deptMap.get(deptRole);
    if (!departmentId) {
      throw new DealerError('UNMAPPED_DEPARTMENT', `Map the '${deptRole}' department role for this client before posting.`, { deptRole });
    }
    return {
      account_id: accountId,
      debit_cents: dc.debit_cents,
      credit_cents: dc.credit_cents,
      location_id: d.locationId,
      department_id: departmentId,
      memo: leg.memo,
    };
  });
}

export async function postPlan(d: DealerCtx, plan: JournalPlan, opts: PostPlanOptions): Promise<PostPlanResult> {
  const sourceRef = `dealer:${opts.key}`;
  const existing = await findPosted(d, sourceRef, plan.entryType);
  if (existing) return { ...existing, reused: true };

  const roleMap = opts.roleMap ?? (await loadRoleMap(d));
  const deptMap = opts.deptMap ?? (await loadDepartmentMap(d));
  const lines = await resolvePlanLines(d, plan, { roleMap, deptMap });

  const res = await postJournalEntry(d.admin, {
    org_id: d.orgId,
    location_id: d.locationId,
    entry_date: opts.entryDate,
    entry_type: plan.entryType,
    memo: plan.memo,
    source_module: 'DEALER',
    source_id: opts.sourceId ?? undefined,
    source_ref: sourceRef,
    // GL author columns are uuid; Clerk ids are text → null (canon §2). The actor is
    // recorded on the dealer subledger row and in core.action_log.
    created_by: null,
    lines,
  });
  if (!res.success || !res.entry_id) {
    if (/duplicate key|uq_gl_entries_org_source_type/i.test(res.error ?? '')) {
      const again = await findPosted(d, sourceRef, plan.entryType);
      if (again) return { ...again, reused: true };
    }
    throw new DealerError('POSTING_FAILED', res.error ?? 'Posting failed');
  }
  return { glEntryId: res.entry_id, entryNumber: res.entry_number ?? null, reused: false };
}

async function findPosted(d: DealerCtx, sourceRef: string, entryType: string): Promise<{ glEntryId: string; entryNumber: string | null } | null> {
  const { data, error } = await d.admin
    .from('gl_entries')
    .select('id, entry_number')
    .eq('org_id', d.orgId)
    .eq('source_ref', sourceRef)
    .eq('entry_type', entryType)
    .eq('status', 'POSTED')
    .maybeSingle();
  if (error) dbFail('GL lookup failed', error);
  return data ? { glEntryId: (data as { id: string }).id, entryNumber: (data as { entry_number: string | null }).entry_number } : null;
}

/** Deterministic short hash for batch idempotency keys (not security-relevant). */
export function stableHash(parts: string[]): string {
  let h = 5381;
  for (const ch of [...parts].sort().join('|')) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}
