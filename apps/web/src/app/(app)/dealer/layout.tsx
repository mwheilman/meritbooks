export const dynamic = 'force-dynamic';

import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { DealerShell } from './_components/dealer-shell';

/**
 * Dealer Pack (FPB-dealer-pack, slice D2) — every /dealer/** screen.
 *
 * Page-level RBAC uses the same cell the D1 read routes use (DEALER_PERMS.view =
 * journal_entries:view) until the lead registers the dedicated `books.dealer.*`
 * capabilities; every write is re-authorized server-side by the D1 routes.
 */
export default async function DealerLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('journal_entries', 'view');
  return <DealerShell>{children}</DealerShell>;
}
