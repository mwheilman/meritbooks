import 'server-only';
import { redirect } from 'next/navigation';
import { getAccess } from '@/lib/access';
import { can } from '@/lib/access/can';
import type { Access, AccessAction, ProjectCapability } from '@/lib/access/types';
import { moneyVisFor, type MoneyVis } from '@/components/money/visibility';
import { opsScope, type OpsScope } from '@/lib/pm/ops/scope';

export interface FsPage {
  o: OpsScope;
  access: Access;
  /** The company in view (field-service screens work one company at a time), or null in a workspace view. */
  companyId: string | null;
  money: MoneyVis;
  /** cap:action at the company in view (or at any company in a workspace view). */
  can: (cap: ProjectCapability, action: AccessAction) => boolean;
}

/**
 * Page guard for the field-service screens (spec §5: a page the persona can't use sends them home).
 * These routes are not in lib/nav's rule table yet (A5 owns it), so the rule is checked here.
 * `any`: at least one grant must be held at the company in view.
 */
export async function fsPage(any: ReadonlyArray<readonly [ProjectCapability, AccessAction]>): Promise<FsPage | null> {
  const o = await opsScope();
  if (!o) return null;
  const access = await getAccess();
  const companyId = o.scope.company?.id ?? (o.companyIds.length === 1 ? o.companyIds[0]! : null);
  const holds = (cap: ProjectCapability, action: AccessAction) => can(access, cap, action, companyId);
  if (!any.some(([c, a]) => holds(c, a))) redirect('/');
  return { o, access, companyId, money: moneyVisFor(access, companyId), can: holds };
}
