import 'server-only';
/**
 * The page gate for the residential screens. lib/nav has no rule for /proposals, /homes or
 * /communities yet (the lead adds them), so canReach would let anyone in: this checks the
 * capability itself for the company in view and sends people without it home. RLS stays the
 * boundary underneath.
 */
import { redirect } from 'next/navigation';
import { can } from '@/lib/access/can';
import type { AccessAction, ProjectCapability } from '@/lib/access/types';
import { opsScope, type OpsScope } from '@/lib/pm/ops/scope';
import { guardPage, type PageAccess } from '@/components/shell/page-guard';

export async function resPage(href: string, cap: ProjectCapability, action: AccessAction): Promise<(PageAccess & { o: OpsScope }) | null> {
  const o = await opsScope();
  if (!o) return null;
  const g = await guardPage(href);
  const companyId = o.scope.company?.id ?? null;
  const ok = companyId ? can(g.access, cap, action, companyId) : o.companyIds.some((id) => can(g.access, cap, action, id));
  if (!ok) redirect('/');
  return { ...g, o };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
