'use client';

/**
 * Match the serials / customer names / makes an import mentions to records already in
 * Books (POST /api/dealer/imports/parse/resolve). Debounced; results accumulate so edits
 * only look up what's new.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportFileKind } from '@/lib/dealer/types';
import type { Cells, Resolution } from '@/lib/dealer/imports/targets';
import { normKey } from '@/lib/dealer/imports/values';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import { dealerSend } from '../../_lib/use-dealer';

const EMPTY: Resolution = { unitsBySerial: {}, customersByName: {}, vendorsByName: {} };

function wanted(kind: ImportFileKind, rows: Cells[]): { serials: string[]; customers: string[]; vendors: string[] } {
  const serials = new Set<string>();
  const customers = new Set<string>();
  const vendors = new Set<string>();
  for (const c of rows) {
    if ((kind === 'DEALS' || kind === 'WARRANTY') && c.serialNumber) serials.add(c.serialNumber.trim());
    if (kind === 'DEALS' && c.customer) customers.add(c.customer.trim());
    if ((kind === 'UNITS' || kind === 'OPENING') && c.make) vendors.add(c.make.trim());
  }
  return { serials: [...serials], customers: [...customers], vendors: [...vendors] };
}

export function needsResolution(kind: ImportFileKind): boolean {
  return kind === 'DEALS' || kind === 'WARRANTY' || kind === 'UNITS' || kind === 'OPENING';
}

export function useResolution(kind: ImportFileKind, locationId: string | null, rows: Cells[], enabled: boolean) {
  const [resolve, setResolve] = useState<Resolution | null>(needsResolution(kind) ? null : EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<{ serials: Set<string>; customers: Set<string>; vendors: Set<string> }>({ serials: new Set(), customers: new Set(), vendors: new Set() });
  const [round, setRound] = useState(0);
  const want = useMemo(() => wanted(kind, rows), [kind, rows]);
  const key = JSON.stringify(want);

  useEffect(() => {
    if (!enabled || !locationId || !needsResolution(kind)) return;
    const a = asked.current;
    const fresh = {
      serials: want.serials.filter((s) => !a.serials.has(normKey(s))).slice(0, 5000),
      customers: want.customers.filter((s) => !a.customers.has(normKey(s))).slice(0, 5000),
      vendors: want.vendors.filter((s) => !a.vendors.has(normKey(s))).slice(0, 500),
    };
    if (!fresh.serials.length && !fresh.customers.length && !fresh.vendors.length) {
      setResolve((r) => r ?? EMPTY);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      void dealerSend<Resolution>('post', '/api/dealer/imports/parse/resolve', locationId, fresh).then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (res.error || !res.data) {
          setError(explainDealerError(res.error).message);
          return;
        }
        setError(null);
        fresh.serials.forEach((s) => a.serials.add(normKey(s)));
        fresh.customers.forEach((s) => a.customers.add(normKey(s)));
        fresh.vendors.forEach((s) => a.vendors.add(normKey(s)));
        const got = res.data;
        setResolve((r) => ({
          unitsBySerial: { ...(r?.unitsBySerial ?? {}), ...got.unitsBySerial },
          customersByName: { ...(r?.customersByName ?? {}), ...got.customersByName },
          vendorsByName: { ...(r?.vendorsByName ?? {}), ...got.vendorsByName },
        }));
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, locationId, kind, round]);

  /** Look everything up again (e.g. after adding a missing customer in another tab). */
  const recheck = () => {
    asked.current = { serials: new Set(), customers: new Set(), vendors: new Set() };
    setResolve(needsResolution(kind) ? null : EMPTY);
    setRound((n) => n + 1);
  };

  return { resolve, loading, error, recheck };
}
