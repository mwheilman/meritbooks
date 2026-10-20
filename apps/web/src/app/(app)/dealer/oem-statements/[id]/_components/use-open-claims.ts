'use client';

/**
 * The open warranty + incentive claims of one manufacturer — the candidates a
 * statement credit can settle — indexed by id, via the D1 list routes
 * (warranty: oem_vendor_id + status filters; incentives: status filter, then kept
 * to this manufacturer's programs).
 */

import { useCallback, useMemo } from 'react';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { incentiveOpenCents, warrantyOpenCents, type IncentiveClaimRow, type OemProgramRecord, type WarrantyClaimRow } from '@/lib/dealer/ui/claims';
import type { ClaimKind } from '@/lib/dealer/types';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { useDealerQuery, type ListPage } from '../../../_lib/use-dealer';

export interface ClaimCandidate {
  kind: ClaimKind;
  id: string;
  label: string;
  reference: string | null;
  serial: string | null;
  openCents: number;
  href: string;
  status: string;
}

export function useOpenClaims(oemVendorId: string | null): {
  byId: Map<string, ClaimCandidate>;
  list: ClaimCandidate[];
  isLoading: boolean;
  error: DealerApiError | null;
  refetch: () => Promise<void>;
} {
  const w = useDealerQuery<ListPage<WarrantyClaimRow>>(oemVendorId ? '/api/dealer/warranty' : null, {
    oem_vendor_id: oemVendorId,
    status: 'SUBMITTED,PARTIAL,RESUBMITTED',
    per_page: 100,
    sort: 'submitted_date',
    dir: 'asc',
  });
  const p = useDealerQuery<ListPage<OemProgramRecord>>(oemVendorId ? '/api/dealer/oem-programs' : null, { oem_vendor_id: oemVendorId, per_page: 100 });
  const i = useDealerQuery<ListPage<IncentiveClaimRow>>(oemVendorId ? '/api/dealer/incentives' : null, { status: 'ACCRUED,SUBMITTED,PARTIAL', per_page: 100, sort: 'earned_date', dir: 'asc' });

  const list = useMemo(() => {
    const programs = new Map((p.data?.rows ?? []).map((x) => [x.id, x]));
    const out: ClaimCandidate[] = [];
    for (const c of w.data?.rows ?? []) {
      out.push({
        kind: 'WARRANTY',
        id: c.id,
        label: c.oem_claim_number ? `Warranty claim ${c.oem_claim_number}` : c.dealer_claim_ref ? `Warranty claim ${c.dealer_claim_ref}` : `Warranty claim (RO ${c.repair_order_ref ?? '—'})`,
        reference: c.oem_claim_number,
        serial: c.serial_number,
        openCents: warrantyOpenCents(c),
        href: dealerLinks.warranty({ claim: c.id }),
        status: c.status,
      });
    }
    for (const c of i.data?.rows ?? []) {
      const prog = programs.get(c.program_id);
      if (!prog) continue; // another manufacturer's program
      out.push({
        kind: 'INCENTIVE',
        id: c.id,
        label: `${prog.name}${c.claim_reference ? ` · ${c.claim_reference}` : ''}`,
        reference: c.claim_reference,
        serial: null,
        openCents: incentiveOpenCents(c),
        href: dealerLinks.incentives({ claim: c.id }),
        status: c.status,
      });
    }
    return out.filter((c) => c.openCents > 0);
  }, [w.data, i.data, p.data]);

  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list]);
  const { refetch: rw } = w;
  const { refetch: ri } = i;
  const refetch = useCallback(async () => {
    await Promise.all([rw(), ri()]);
  }, [rw, ri]);

  return {
    byId,
    list,
    isLoading: w.isLoading || i.isLoading || p.isLoading,
    error: w.error ?? i.error ?? p.error,
    refetch,
  };
}
