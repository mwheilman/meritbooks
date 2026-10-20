export const dynamic = 'force-dynamic';

import { DealsList } from './deals-list';

/**
 * Deals & trade-ins (FPB §3.4–3.5, DL-11; D2 slice A). Query: tab=deals|trades,
 * status. Guard + client scope: ../layout.tsx.
 */
function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

export default function DealsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const tab = one(searchParams.tab) === 'trades' ? 'trades' : 'deals';
  return <DealsList initialTab={tab} initialStatus={one(searchParams.status)} />;
}
