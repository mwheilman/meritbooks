import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: '1099 readiness' };

export const dynamic = 'force-dynamic';

/**
 * /compliance-1099 — kept so old links, help and the command bar keep working: 1099
 * readiness now renders as a tab INSIDE Vendor compliance (so the rail stays on Vendor
 * compliance). Redirects to /vendor-compliance?tab=1099, preserving any other query.
 *
 * PAGE-LEVEL RBAC (identity gate #9): 1099 readiness exposes vendor tax facts — the guard
 * runs before the redirect (the destination's layout guards compliance:view too).
 */
export default async function Compliance1099Page({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  await requirePagePermission('compliance', 'view');
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams ?? {})) {
    if (k === 'tab' || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) sp.append(k, one);
  }
  sp.set('tab', '1099');
  redirect(`/vendor-compliance?${sp.toString()}`);
}
