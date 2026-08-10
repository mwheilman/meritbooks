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
 *
 * CASH is AUTOMATIC and ONE-CLICK: it hits `/api/basis-adjustments/cash`, which reuses the
 * proven full cash conversion (`fetchCashIncomeStatement` — the SAME engine the report
 * compiler uses) and returns the accrual→cash deltas live. No manual basis-adjustment rows
 * are needed to flip Accrual⇆Cash. TAX (M-1 derived) and CUSTOM (manual) read the stored
 * `reporting_basis_adjustments` rows via `/api/basis-adjustments`.
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
  /** Exact statement window — required so CASH derives on the SAME period the report shows. */
  startDate?: string,
  endDate?: string,
): BasisOverlay {
  const isCash = basis === 'CASH';
  // CASH needs a concrete window; TAX/CUSTOM key off period_year/month.
  const enabled = basis !== 'GAAP' && (isCash ? !!(startDate && endDate) : !!year);
  const params: Record<string, string> = {};
  if (enabled) {
    if (isCash) {
      // Live, automatic cash derivation — no stored rows, always ties to the ledger.
      params.start_date = startDate as string;
      params.end_date = endDate as string;
      if (locIds) params.location_ids = locIds;
    } else {
      params.basis = basis;
      params.period_year = year;
      if (month) params.period_month = month;
      if (locIds) params.location_ids = locIds;
    }
  }
  const { data: resp, isLoading, error } = useQuery<AdjApiResponse>(
    enabled ? (isCash ? '/api/basis-adjustments/cash' : '/api/basis-adjustments') : null,
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
