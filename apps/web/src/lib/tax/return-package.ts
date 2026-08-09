/**
 * Tax Return Package (1120-style) — read-only AGGREGATOR over the existing tax engines.
 *
 * This module recomputes NOTHING. It assembles, for one entity + period, the figures the
 * accountant needs to prepare a Form 1120 corporate return, by calling the SAME RLS-scoped
 * services the individual tax screens already use:
 *
 *   • Book net income + Schedule M-1/M-3 reconciliation → taxable income
 *       — `computeProvisionForPeriod` (provision-service) internally runs `buildM1Report`
 *         (m1-report.ts / book-tax.ts) and returns the finished M-1 plus the ASC 740 result.
 *   • ASC 740 income-tax provision (current + deferred) + effective-rate reconciliation
 *       — `computeProvision` result + `effectiveRateReconciliation` (provision.ts).
 *   • Book-vs-tax (MACRS/§179/bonus) depreciation delta
 *       — `computeBookVsTaxDepreciation` (book-tax-depr-feed.ts) for the tax year.
 *   • DTA/DTL rollforward
 *       — beginning cumulative balances read from persisted `deferred_tax_items` on prior
 *         provisions, plus this period's DTA/DTL change from the live computation.
 *
 * Every number here is produced by an engine that owns it; this file only arranges them into
 * a single hand-off package and derives presentation-only cross-references (e.g. the waterfall
 * ladder). All money is bigint cents. No posting, no money movement — a report.
 *
 * The exported `taxReturnPackageSchema` lets the PDF route re-accept the exact package the
 * client previewed (mirrors the board-package export pattern) without re-querying the GL.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeProvisionForPeriod } from './provision-service';
import { effectiveRateReconciliation } from './provision';
import { computeBookVsTaxDepreciation } from './book-tax-depr-feed';

// ─────────────────────────────────────────────────────────────────────────────
// Options / types
// ─────────────────────────────────────────────────────────────────────────────

export interface TaxReturnPackageOptions {
  startDate: string;
  endDate: string;
  statutoryRatePct: number;
  /** Entity/company (location) the return is scoped to; null = consolidated preview. */
  locationId?: string | null;
  /** Human label for the filing entity (rendered on the cover). */
  entityLabel?: string;
}

/** A single Schedule M-1 adjustment line (permanent or temporary). */
export interface TaxReturnMLine {
  code: string;
  label: string;
  m1Line: string;
  differenceType: 'PERMANENT' | 'TEMPORARY';
  taxableEffect: 'ADD' | 'SUBTRACT';
  codeSection: string;
  amountCents: number;
}

/** One rung of the book-income → taxable-income → provision waterfall. */
export interface WaterfallStep {
  key: string;
  label: string;
  amountCents: number;
  /** 'input' (a running figure), 'add', 'subtract', or 'subtotal' (bold total). */
  kind: 'input' | 'add' | 'subtract' | 'subtotal';
}

export interface DeferredRollLine {
  code: string;
  label: string;
  temporaryDiffCents: number;
  deferredTaxCents: number;
  category: 'DTA' | 'DTL';
}

export interface DtaDtlRollforward {
  beginningDtaCents: number;
  beginningDtlCents: number;
  /** This period's change (increase) in each balance — the live computation. */
  dtaChangeCents: number;
  dtlChangeCents: number;
  endingDtaCents: number;
  endingDtlCents: number;
  /** Net deferred tax asset position at period end (ending DTA − ending DTL). */
  endingNetDtaCents: number;
  /** Whether beginning balances were found in prior persisted provisions. */
  hasPriorHistory: boolean;
}

export interface DepreciationAssetLine {
  assetId: string;
  name: string;
  category: string | null;
  taxMethod: string;
  recoveryYears: number | null;
  costCents: number;
  bookYearCents: number;
  taxYearCents: number;
  differenceCents: number;
}

export interface TaxReturnPackage {
  meta: {
    entityLabel: string;
    locationId: string | null;
    startDate: string;
    endDate: string;
    asOfDate: string;
    periodLabel: string;
    taxYear: number;
    statutoryRatePct: number;
    basisLabel: string;
    generatedAt: string;
    accent: string;
    /** True when scoped to a single entity (a real return); false = consolidated preview. */
    isSingleEntity: boolean;
  };
  /** The headline provision figures (ASC 740). */
  summary: {
    pretaxBookIncomeCents: number;
    permanentNetCents: number;
    temporaryNetCents: number;
    taxableIncomeCents: number;
    currentTaxCents: number;
    deferredTaxCents: number;
    totalProvisionCents: number;
    effectiveRatePct: number;
  };
  /** Book-income → taxable-income → provision ladder for the on-screen/PDF waterfall. */
  waterfall: WaterfallStep[];
  /** Schedule M-1 detail. */
  m1: {
    bookNetIncomeCents: number;
    additions: TaxReturnMLine[];
    subtractions: TaxReturnMLine[];
    totalAdditionsCents: number;
    totalSubtractionsCents: number;
    permanentAdditionsCents: number;
    permanentSubtractionsCents: number;
    temporaryAdditionsCents: number;
    temporarySubtractionsCents: number;
    taxableIncomeCents: number;
    adjustmentCount: number;
  };
  /** Tax-vs-book depreciation for the tax year (the largest single timing item). */
  depreciation: {
    taxYear: number;
    totalBookCents: number;
    totalTaxCents: number;
    netDifferenceCents: number;
    /** M-1 line the net delta maps onto (5a book>tax, 8a tax>book), or null when equal. */
    m1Code: 'BOOK_DEPR_EXCESS' | 'TAX_DEPR_EXCESS' | null;
    assets: DepreciationAssetLine[];
  };
  /** Effective-rate reconciliation ladder (statutory → permanent effect → effective). */
  effectiveRate: { label: string; amountCents: number; ratePct: number }[];
  /** Deferred-tax detail + the DTA/DTL rollforward. */
  deferred: {
    items: DeferredRollLine[];
    rollforward: DtaDtlRollforward;
  };
  /** Non-blocking notes for the preparer (e.g. missing provision accounts, consolidated preview). */
  preparerNotes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────────

function periodLabel(startDate: string, endDate: string): string {
  const sy = startDate.slice(0, 4);
  const ey = endDate.slice(0, 4);
  if (startDate.endsWith('-01-01') && endDate.endsWith('-12-31') && sy === ey) return `FY ${sy}`;
  return `${startDate} — ${endDate}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregator
// ─────────────────────────────────────────────────────────────────────────────

export async function buildTaxReturnPackage(
  supabase: SupabaseClient,
  orgId: string,
  opts: TaxReturnPackageOptions,
): Promise<TaxReturnPackage> {
  const { startDate, endDate, statutoryRatePct } = opts;
  const locationId = opts.locationId ?? null;
  const taxYear = Number(endDate.slice(0, 4));

  // 1. ASC 740 provision + M-1 (the provision service already runs buildM1Report).
  const computation = await computeProvisionForPeriod(supabase, orgId, {
    startDate,
    endDate,
    statutoryRatePct,
    locationId,
  });
  const r = computation.result;
  const m1 = computation.m1;

  // 2. Book-vs-tax depreciation for the tax year (MACRS/§179/bonus).
  const depr = await computeBookVsTaxDepreciation(supabase, taxYear);

  // 3. DTA/DTL rollforward — computed by the provision service (beginning from persisted
  //    deferred_tax_items on prior provisions), so the return package and the ASC 740 provision
  //    screen share one rollforward and can never disagree.
  const rollforward: DtaDtlRollforward = computation.rollforward;

  // 4. Waterfall ladder (presentation-only; derived from already-computed figures).
  const waterfall: WaterfallStep[] = [
    { key: 'book', label: 'Net income per books (pretax)', amountCents: r.pretaxBookIncomeCents, kind: 'input' },
    { key: 'perm', label: 'Permanent differences (net)', amountCents: r.permanentNetCents, kind: r.permanentNetCents >= 0 ? 'add' : 'subtract' },
    { key: 'temp', label: 'Temporary differences (net)', amountCents: r.temporaryNetCents, kind: r.temporaryNetCents >= 0 ? 'add' : 'subtract' },
    { key: 'taxable', label: 'Taxable income', amountCents: r.taxableIncomeCents, kind: 'subtotal' },
    { key: 'current', label: `Current tax @ ${r.statutoryRatePct}%`, amountCents: r.currentTaxCents, kind: 'input' },
    { key: 'deferred', label: 'Deferred tax (Δ DTL − Δ DTA)', amountCents: r.deferredTaxCents, kind: 'input' },
    { key: 'total', label: 'Total income tax provision', amountCents: r.totalProvisionCents, kind: 'subtotal' },
  ];

  // 5. Preparer notes (non-blocking).
  const preparerNotes: string[] = [];
  if (!locationId) {
    preparerNotes.push(
      'Consolidated preview across all entities. Select a single company to prepare an entity-level Form 1120.',
    );
  }
  if (m1.adjustmentCount === 0) {
    preparerNotes.push(
      'No book-tax differences are tagged for this period — taxable income equals book income. Tag accounts on the Book-to-Tax screen to build Schedule M-1.',
    );
  }
  if (computation.missingAccounts.length > 0) {
    preparerNotes.push(
      `Provision accounts not yet mapped in the chart of accounts: ${computation.missingAccounts.join('; ')}. The provision computes, but posting its journal entry is blocked until these exist.`,
    );
  }
  if (depr.difference && !m1.additions.concat(m1.subtractions).some((l) => l.code === depr.difference!.code)) {
    preparerNotes.push(
      'The book-vs-tax depreciation timing difference is shown below but is not yet feeding Schedule M-1. Confirm it on the Tax Depreciation screen to include it in taxable income.',
    );
  }

  return {
    meta: {
      entityLabel: opts.entityLabel?.trim() || (locationId ? 'Company' : 'All Companies (Consolidated)'),
      locationId,
      startDate,
      endDate,
      asOfDate: endDate,
      periodLabel: periodLabel(startDate, endDate),
      taxYear,
      statutoryRatePct: r.statutoryRatePct,
      basisLabel: 'Prepared on the accrual basis · U.S. Form 1120 presentation',
      generatedAt: new Date().toISOString(),
      accent: '#10b981',
      isSingleEntity: !!locationId,
    },
    summary: {
      pretaxBookIncomeCents: r.pretaxBookIncomeCents,
      permanentNetCents: r.permanentNetCents,
      temporaryNetCents: r.temporaryNetCents,
      taxableIncomeCents: r.taxableIncomeCents,
      currentTaxCents: r.currentTaxCents,
      deferredTaxCents: r.deferredTaxCents,
      totalProvisionCents: r.totalProvisionCents,
      effectiveRatePct: r.effectiveRatePct,
    },
    waterfall,
    m1: {
      bookNetIncomeCents: m1.bookNetIncomeCents,
      additions: m1.additions,
      subtractions: m1.subtractions,
      totalAdditionsCents: m1.totalAdditionsCents,
      totalSubtractionsCents: m1.totalSubtractionsCents,
      permanentAdditionsCents: m1.permanentAdditionsCents,
      permanentSubtractionsCents: m1.permanentSubtractionsCents,
      temporaryAdditionsCents: m1.temporaryAdditionsCents,
      temporarySubtractionsCents: m1.temporarySubtractionsCents,
      taxableIncomeCents: m1.taxableIncomeCents,
      adjustmentCount: m1.adjustmentCount,
    },
    depreciation: {
      taxYear: depr.taxYear,
      totalBookCents: depr.totalBookCents,
      totalTaxCents: depr.totalTaxCents,
      netDifferenceCents: depr.netDifferenceCents,
      m1Code: depr.difference?.code ?? null,
      assets: depr.assets.map((a) => ({
        assetId: a.assetId,
        name: a.name,
        category: a.category,
        taxMethod: a.taxMethod,
        recoveryYears: a.recoveryYears,
        costCents: a.costCents,
        bookYearCents: a.bookYearCents,
        taxYearCents: a.taxYearCents,
        differenceCents: a.differenceCents,
      })),
    },
    effectiveRate: effectiveRateReconciliation(r),
    deferred: {
      items: computation.deferredItems.map((it) => ({
        code: it.code,
        label: it.label,
        temporaryDiffCents: it.temporaryDiffCents,
        deferredTaxCents: it.deferredTaxCents,
        category: it.category,
      })),
      rollforward,
    },
    preparerNotes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema — lets the PDF route re-accept the previewed package (no GL re-query)
// ─────────────────────────────────────────────────────────────────────────────

const mLineSchema = z.object({
  code: z.string(),
  label: z.string(),
  m1Line: z.string().default(''),
  differenceType: z.enum(['PERMANENT', 'TEMPORARY']),
  taxableEffect: z.enum(['ADD', 'SUBTRACT']),
  codeSection: z.string().default(''),
  amountCents: z.number(),
});

export const taxReturnPackageSchema = z.object({
  meta: z.object({
    entityLabel: z.string(),
    locationId: z.string().nullable(),
    startDate: z.string(),
    endDate: z.string(),
    asOfDate: z.string(),
    periodLabel: z.string(),
    taxYear: z.number(),
    statutoryRatePct: z.number(),
    basisLabel: z.string(),
    generatedAt: z.string(),
    accent: z.string().default('#10b981'),
    isSingleEntity: z.boolean(),
  }),
  summary: z.object({
    pretaxBookIncomeCents: z.number(),
    permanentNetCents: z.number(),
    temporaryNetCents: z.number(),
    taxableIncomeCents: z.number(),
    currentTaxCents: z.number(),
    deferredTaxCents: z.number(),
    totalProvisionCents: z.number(),
    effectiveRatePct: z.number(),
  }),
  waterfall: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      amountCents: z.number(),
      kind: z.enum(['input', 'add', 'subtract', 'subtotal']),
    }),
  ),
  m1: z.object({
    bookNetIncomeCents: z.number(),
    additions: z.array(mLineSchema),
    subtractions: z.array(mLineSchema),
    totalAdditionsCents: z.number(),
    totalSubtractionsCents: z.number(),
    permanentAdditionsCents: z.number(),
    permanentSubtractionsCents: z.number(),
    temporaryAdditionsCents: z.number(),
    temporarySubtractionsCents: z.number(),
    taxableIncomeCents: z.number(),
    adjustmentCount: z.number(),
  }),
  depreciation: z.object({
    taxYear: z.number(),
    totalBookCents: z.number(),
    totalTaxCents: z.number(),
    netDifferenceCents: z.number(),
    m1Code: z.enum(['BOOK_DEPR_EXCESS', 'TAX_DEPR_EXCESS']).nullable(),
    assets: z.array(
      z.object({
        assetId: z.string(),
        name: z.string(),
        category: z.string().nullable(),
        taxMethod: z.string(),
        recoveryYears: z.number().nullable(),
        costCents: z.number(),
        bookYearCents: z.number(),
        taxYearCents: z.number(),
        differenceCents: z.number(),
      }),
    ),
  }),
  effectiveRate: z.array(
    z.object({ label: z.string(), amountCents: z.number(), ratePct: z.number() }),
  ),
  deferred: z.object({
    items: z.array(
      z.object({
        code: z.string(),
        label: z.string(),
        temporaryDiffCents: z.number(),
        deferredTaxCents: z.number(),
        category: z.enum(['DTA', 'DTL']),
      }),
    ),
    rollforward: z.object({
      beginningDtaCents: z.number(),
      beginningDtlCents: z.number(),
      dtaChangeCents: z.number(),
      dtlChangeCents: z.number(),
      endingDtaCents: z.number(),
      endingDtlCents: z.number(),
      endingNetDtaCents: z.number(),
      hasPriorHistory: z.boolean(),
    }),
  }),
  preparerNotes: z.array(z.string()),
});
