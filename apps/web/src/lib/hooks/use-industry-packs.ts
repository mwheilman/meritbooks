'use client';

/**
 * Which industry packs are switched on for the active client.
 *
 * Used by the sidebar to show pack-gated nav groups (NavGroup.requiresPack) only
 * for clients that enabled the pack. This is a usability lens, not a security
 * boundary — every pack page and API guards itself server-side.
 *
 * Fails quiet: while loading, on error, or in consolidated ('all') view the pack
 * reads as OFF, so the group simply stays hidden. Results are cached per client
 * for the session (a toggle in Dealer Settings calls `invalidateIndustryPacks`).
 */

import { useEffect, useState } from 'react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';

export interface IndustryPacks {
  dealer: boolean;
}

const OFF: IndustryPacks = { dealer: false };
const cache = new Map<string, IndustryPacks>();

export function invalidateIndustryPacks(locationId?: string): void {
  if (locationId) cache.delete(locationId);
  else cache.clear();
}

async function loadPacks(locationId: string): Promise<IndustryPacks> {
  const hit = cache.get(locationId);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/dealer/settings?locationId=${encodeURIComponent(locationId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return OFF; // 403 (no dealer view), 404, 409 … → hidden
    const body = (await res.json()) as { settings?: { enabled?: unknown } } | null;
    const packs: IndustryPacks = { dealer: body?.settings?.enabled === true };
    cache.set(locationId, packs);
    return packs;
  } catch {
    return OFF;
  }
}

export function useIndustryPacks(): IndustryPacks {
  const { activeCompanyId, isAll, ready } = useActiveCompany();
  const [packs, setPacks] = useState<IndustryPacks>(OFF);

  useEffect(() => {
    if (!ready || isAll || !activeCompanyId) {
      setPacks(OFF);
      return;
    }
    let cancelled = false;
    void loadPacks(activeCompanyId).then((p) => {
      if (!cancelled) setPacks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, isAll, ready]);

  return packs;
}
