'use client';

/**
 * Live floor-plan notes (OPEN / SOLD_UNPAID / IN_DEFAULT) for the units on the
 * visible register page, via GET /api/dealer/notes?unit_id=a,b,…  The D1 list
 * query caps each filter value at 500 characters, so ids go in chunks of 12.
 */

import { useEffect, useMemo, useState } from 'react';
import type { NoteView } from '@/lib/dealer/ui/unit-deal-types';
import { dealerGet, type ListPage } from '../../_lib/use-dealer';

const CHUNK = 12;

export function useLiveNotes(locationId: string | null, unitIds: string[]): { byUnit: Map<string, NoteView>; loading: boolean; failed: boolean } {
  const key = useMemo(() => [...new Set(unitIds)].sort().join(','), [unitIds]);
  const [byUnit, setByUnit] = useState<Map<string, NoteView>>(new Map());
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!locationId || !key) {
      setByUnit(new Map());
      return;
    }
    const ids = key.split(',');
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    void Promise.all(
      chunks.map((c) =>
        dealerGet<ListPage<NoteView>>('/api/dealer/notes', locationId, {
          unit_id: c.join(','),
          status: 'OPEN,SOLD_UNPAID,IN_DEFAULT',
          per_page: 100,
        }),
      ),
    ).then((results) => {
      if (cancelled) return;
      const m = new Map<string, NoteView>();
      let bad = false;
      for (const r of results) {
        if (r.error) bad = true;
        for (const n of r.data?.rows ?? []) if (n.unit_id) m.set(n.unit_id, n);
      }
      setByUnit(m);
      setFailed(bad);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, key]);

  return { byUnit, loading, failed };
}
