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

export interface IndustryPacksState {
  packs: IndustryPacks;
  /**
   * The client the packs were resolved for, or null while loading / in consolidated
   * view. Lets a page that already knows the answer from the server (a server-read
   * seed) keep showing it until the client read for the SAME client lands.
   */
  resolvedFor: string | null;
}

export function useIndustryPacksState(): IndustryPacksState {
  const { activeCompanyId, isAll, ready } = useActiveCompany();
  const [state, setState] = useState<IndustryPacksState>({ packs: OFF, resolvedFor: null });

  useEffect(() => {
    if (!ready || isAll || !activeCompanyId) {
      setState({ packs: OFF, resolvedFor: null });
      return;
    }
    let cancelled = false;
    void loadPacks(activeCompanyId).then((p) => {
      if (!cancelled) setState({ packs: p, resolvedFor: activeCompanyId });
    });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, isAll, ready]);

  return state;
}

export function useIndustryPacks(): IndustryPacks {
  return useIndustryPacksState().packs;
}
