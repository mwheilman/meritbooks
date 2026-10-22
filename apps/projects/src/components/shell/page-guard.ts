import 'server-only';
import { redirect } from 'next/navigation';
import { getAccess } from '@/lib/access';
import type { Access } from '@/lib/access/types';
import { getScope } from '@/lib/scope';
import { canReach } from '@/lib/nav';
import { moneyVisFor, type MoneyVis } from '@/components/money/visibility';

export interface PageAccess {
  access: Access;
  /** Money this page may draw, for the company in view (the union in a workspace view). */
  money: MoneyVis;
}

/**
 * Page-level guard (spec §5): a page the caller's persona can't use sends them to their home.
 * Same rule as the rail (lib/nav canReach), read for the company in view. Server-side; RLS is
 * still the boundary underneath.
 */
export async function guardPage(href: string): Promise<PageAccess> {
  const [access, r] = await Promise.all([getAccess(), getScope()]);
  const companyId = r.kind === 'ready' ? r.scope.company?.id ?? null : null;
  if (!canReach(access, href, companyId)) redirect('/');
  return { access, money: moneyVisFor(access, companyId) };
}
