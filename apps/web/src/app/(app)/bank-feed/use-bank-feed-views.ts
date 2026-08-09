'use client';

/**
 * useBankFeedViews — a purely LOCAL, view-only store of saved bank-feed filter
 * lenses (see `bank-feed-views.ts` for the shape + pure logic).
 *
 * Writes NOTHING to the server. The store is namespaced per active company so
 * switching companies in the same browser never leaks one entity's saved views
 * into another's list. Guards against SSR (no `window`) and corrupt payloads.
 */

import { useCallback, useEffect, useState } from 'react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import {
  type SavedView,
  type ViewLens,
  parseViews,
  serializeViews,
  upsertView,
  removeView,
  newViewId,
} from './bank-feed-views';

const KEY_PREFIX = 'mb.bankfeed.views';

function storageKey(companyId: string | null | undefined): string {
  return `${KEY_PREFIX}.${companyId ?? 'all'}`;
}

export interface UseBankFeedViews {
  views: SavedView[];
  saveView: (name: string, lens: ViewLens) => SavedView | null;
  deleteView: (id: string) => void;
}

export function useBankFeedViews(): UseBankFeedViews {
  const { activeCompanyId } = useActiveCompany();
  const key = storageKey(activeCompanyId);
  const [views, setViews] = useState<SavedView[]>([]);

  // Load (and reload when the company namespace changes).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setViews(parseViews(window.localStorage.getItem(key)));
    } catch {
      setViews([]);
    }
  }, [key]);

  const persist = useCallback(
    (next: SavedView[]) => {
      setViews(next);
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, serializeViews(next));
      } catch {
        /* storage full / disabled — keep the in-memory copy, fail quiet */
      }
    },
    [key],
  );

  const saveView = useCallback(
    (name: string, lens: ViewLens): SavedView | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const view: SavedView = { id: newViewId(), name: trimmed, ...lens };
      persist(upsertView(views, view));
      return view;
    },
    [views, persist],
  );

  const deleteView = useCallback(
    (id: string) => {
      persist(removeView(views, id));
    },
    [views, persist],
  );

  return { views, saveView, deleteView };
}
