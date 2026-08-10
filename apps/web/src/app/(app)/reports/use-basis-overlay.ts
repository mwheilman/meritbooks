'use client';

import { useMemo } from 'react';
import { useQuery } from '@/hooks';
import {
  basisPresentationLabel,
  type ReportingBasis,
} from '@/lib/reports/basis/apply-adjustments';

/**
 * Client hook: fetch the reporting-basis adjustments for a period and expose them as a
 * per-account natural-delta map the P&L / BS / TB renderers layer on top of the GAAP output
 * they already fetched. When `basis` is 'GAAP' nothing is fetched and the overlay is inert —
 * so the Accrual (GAAP) default renders exactly today's numbers, untouched.
 */

export type PresentationBasis = 'GAAP' | ReportingBasis;

export interface OverlayAdjItem {
  id: string;
  amountCents: number;
  description: string | null;
  adjustmentType: string | null;
  source: string;
}

export interface OverlayAccount {
  naturalCents: number;
  items: OverlayAdjItem[];
}

export interface BasisOverlay {
  enabled: boolean;
  loading: boolean;
  error: string | null;
  basis: PresentationBasis;
  basisLabel: string;
  byAccount: Map<string, OverlayAccount>;
  count: number;
  netDebitPositiveCents: number;
  balances: boolean;
  customLabel: string | null;
}

interface AdjApiRow {
  id: string;
  basis: string;
  customLabel: string | null;
  accountId: string;
  amountCents: number;
  description: string | null;
  adjustmentType: string | null;
  source: string;
}
interface AdjApiResponse {
  data: {
    adjustments: AdjApiRow[];
    summary: { count: number; netDebitPositiveCents: number; balances: boolean };
  };
}

export function useBasisOverlay(
  basis: PresentationBasis,
  year: string,
  month: string | undefined,
  locIds: string,
): BasisOverlay {
  const enabled = basis !== 'GAAP' && !!year;
  const params: Record<string, string> = {};
  if (enabled) {
    params.basis = basis;
    params.period_year = year;
    if (month) params.period_month = month;
    if (locIds) params.location_ids = locIds;
  }
  const { data: resp, isLoading, error } = useQuery<AdjApiResponse>(
    enabled ? '/api/basis-adjustments' : null,
    params,
    { scope: false },
  );
  const data = resp?.data;

  return useMemo<BasisOverlay>(() => {
    const byAccount = new Map<string, OverlayAccount>();
    let customLabel: string | null = null;
    if (data?.adjustments) {
      for (const a of data.adjustments) {
        if (!customLabel && a.customLabel) customLabel = a.customLabel;
        let acc = byAccount.get(a.accountId);
        if (!acc) { acc = { naturalCents: 0, items: [] }; byAccount.set(a.accountId, acc); }
        acc.naturalCents += a.amountCents;
        acc.items.push({ id: a.id, amountCents: a.amountCents, description: a.description, adjustmentType: a.adjustmentType, source: a.source });
      }
    }
    return {
      enabled,
      loading: enabled && isLoading,
      error: enabled ? error : null,
      basis,
      basisLabel: basis === 'GAAP' ? 'Accrual (GAAP)' : basisPresentationLabel(basis, customLabel),
      byAccount,
      count: data?.summary.count ?? 0,
      netDebitPositiveCents: data?.summary.netDebitPositiveCents ?? 0,
      balances: data?.summary.balances ?? true,
      customLabel,
    };
  }, [data, enabled, isLoading, error, basis]);
}
