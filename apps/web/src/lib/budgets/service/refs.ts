/**
 * Reference guards for budget writes (security review, MEDIUM). Every budget write goes through
 * the service role, and a foreign key never checks the tenant — so an id from another org (or
 * another company of the same org) could ride a service-role insert in. Before a write, every id
 * it references is checked:
 *
 *   1. org pin     — lib/db/scoped-writer.ts `assertOrgRefs` (service read, org_id = the session org)
 *   2. same company — the version / comment belongs to the company being written, and a
 *                     department is either org-wide (location_id NULL) or that company's.
 *
 * Failures throw WriteScopeError (→ 403 through route-support `budgetError`).
 */
import { assertOrgRefs, WriteScopeError, type OrgRef } from '@/lib/db/scoped-writer';
import type { BudgetCtx } from './data';

export interface BudgetRefs {
  /** The company the write lands on. */
  locationId: string;
  versionIds?: ReadonlyArray<string | null | undefined>;
  accountIds?: ReadonlyArray<string | null | undefined>;
  departmentIds?: ReadonlyArray<string | null | undefined>;
  commentIds?: ReadonlyArray<string | null | undefined>;
}

const uniq = (ids: ReadonlyArray<string | null | undefined> | undefined): string[] =>
  Array.from(new Set((ids ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)));

type Row = Record<string, unknown>;

export async function assertBudgetRefs(ctx: Pick<BudgetCtx, 'orgId' | 'writer'>, r: BudgetRefs): Promise<void> {
  const versions = uniq(r.versionIds);
  const accounts = uniq(r.accountIds);
  const departments = uniq(r.departmentIds);
  const comments = uniq(r.commentIds);
  const refs: OrgRef[] = [
    { table: 'budget_plan_versions', ids: versions, label: 'budget version' },
    { table: 'accounts', ids: accounts, label: 'account' },
    { schema: 'core', table: 'departments', ids: departments, label: 'department' },
    { table: 'budget_comments', ids: comments, label: 'comment' },
  ];
  await assertOrgRefs(ctx.orgId, refs, { writer: ctx.writer });

  // Same company.
  const sameCompany = async (table: string, ids: string[], label: string, allowOrgWide: boolean, schema?: 'core') => {
    if (ids.length === 0) return;
    const base = schema === 'core' ? ctx.writer.schema('core').from(table) : ctx.writer.from(table);
    const { data, error } = await base.select('id, location_id').eq('org_id', ctx.orgId).in('id', ids);
    if (error) throw new WriteScopeError(`Could not verify the ${label}: ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const loc = row.location_id == null ? null : String(row.location_id);
      if (loc === null && allowOrgWide) continue;
      if (loc !== r.locationId) throw new WriteScopeError(`That ${label} belongs to a different company.`);
    }
  };
  await sameCompany('budget_plan_versions', versions, 'budget version', false);
  await sameCompany('departments', departments, 'department', true, 'core');
  await sameCompany('budget_comments', comments, 'comment', false);
}
