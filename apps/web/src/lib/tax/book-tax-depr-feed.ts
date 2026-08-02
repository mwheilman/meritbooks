/**
 * Book-vs-tax depreciation → Schedule M-1 feed (temporary difference).
 *
 * The financial GL carries BOOK depreciation (posted monthly); the parallel tax track
 * (lib/posting/tax-depreciation.ts) carries MACRS / §179 / bonus. For a tax year the two
 * diverge — that divergence is a TEMPORARY book-tax difference (ASC 740 deferred tax) that
 * belongs on Schedule M-1: line 5a `BOOK_DEPR_EXCESS` when book > tax, line 8a
 * `TAX_DEPR_EXCESS` when tax > book (the §179/bonus/MACRS acceleration).
 *
 * Canon §3 posture: this NEVER writes the M-1 number as fact. The delta is deterministic
 * arithmetic (posted book depreciation − the pure MACRS schedule), but it only ENTERS the
 * M-1 once a human confirms a PROPOSED `ai_decisions` row (feature 'BOOK_TAX_DEPR'), whose
 * confirmation writes a `book_tax_line_overrides` row (an explicit pinned amount on a book
 * depreciation-expense line) that the existing deterministic M-1 engine (`m1-report.ts`)
 * then picks up. We do NOT touch book-tax.ts / m1-report.ts — we propose INTO their tables.
 *
 * All math is integer cents. The pure `classifyDepreciationDifference` is unit-testable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeTaxDepreciationSchedule,
  taxDepreciationForYear,
  type TaxConvention,
  type TaxRegularMethod,
} from '@/lib/posting/tax-depreciation';

export const BOOK_TAX_DEPR_FEATURE = 'BOOK_TAX_DEPR';

/** M-1 lines the depreciation timing difference maps onto (must exist in STANDARD_M_LINES). */
export const BOOK_DEPR_EXCESS_CODE = 'BOOK_DEPR_EXCESS';
export const TAX_DEPR_EXCESS_CODE = 'TAX_DEPR_EXCESS';

export interface DepreciationDifference {
  /** M-1 code — BOOK_DEPR_EXCESS (book>tax) or TAX_DEPR_EXCESS (tax>book). */
  code: typeof BOOK_DEPR_EXCESS_CODE | typeof TAX_DEPR_EXCESS_CODE;
  taxableEffect: 'ADD' | 'SUBTRACT';
  differenceType: 'TEMPORARY';
  /** positive magnitude in cents. */
  amountCents: number;
}

/**
 * Classify the net book-vs-tax depreciation delta for a period into an M-1 temporary
 * difference. `null` when the two are equal (no adjustment). Book > tax adds to taxable
 * income (book took more expense than tax allowed this year); tax > book subtracts.
 */
export function classifyDepreciationDifference(
  bookDepreciationCents: number,
  taxDepreciationCents: number,
): DepreciationDifference | null {
  const net = Math.round(bookDepreciationCents) - Math.round(taxDepreciationCents);
  if (net === 0) return null;
  if (net > 0) {
    return { code: BOOK_DEPR_EXCESS_CODE, taxableEffect: 'ADD', differenceType: 'TEMPORARY', amountCents: net };
  }
  return { code: TAX_DEPR_EXCESS_CODE, taxableEffect: 'SUBTRACT', differenceType: 'TEMPORARY', amountCents: -net };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed computation (RLS-scoped; the caller's client enforces org isolation)
// ─────────────────────────────────────────────────────────────────────────────

interface AssetRow {
  id: string;
  name: string;
  category: string | null;
  acquisition_date: string;
  acquisition_cost_cents: number;
  salvage_value_cents: number;
  depreciation_method: string;
  tax_method: string;
  tax_recovery_years: number | null;
  tax_convention: string;
  tax_life_months: number | null;
  section_179_cents: number;
  bonus_pct: number | null;
  accumulated_depreciation_cents: number;
  tax_accumulated_depreciation_cents: number;
  depreciation_expense_account_id: string;
  status: string;
}

export interface AssetDepreciationLine {
  assetId: string;
  name: string;
  category: string | null;
  acquisitionDate: string;
  costCents: number;
  taxMethod: string; // NONE | SL | MACRS | SECTION_179 | BONUS
  recoveryYears: number | null;
  convention: string;
  section179Cents: number;
  bonusPct: number;
  /** the pure MACRS/SL schedule for this asset (empty when tax_method NONE). */
  schedule: { ordinal: number; year: number; section179Cents: number; bonusCents: number; regularCents: number; totalCents: number; accumulatedCents: number }[];
  bookYearCents: number;
  taxYearCents: number;
  differenceCents: number; // book − tax for the year
}

export interface BookVsTaxDepreciation {
  taxYear: number;
  assets: AssetDepreciationLine[];
  totalBookCents: number;
  totalTaxCents: number;
  netDifferenceCents: number; // book − tax
  difference: DepreciationDifference | null;
}

function regularMethodFor(taxMethod: string): TaxRegularMethod {
  return taxMethod === 'SL' ? 'SL' : 'MACRS';
}

/**
 * Compute the per-asset (and total) book-vs-tax depreciation for a tax year. BOOK is the
 * posted book depreciation for the calendar year (`depreciation_runs`, the GL truth); TAX
 * is the pure MACRS/SL schedule projected from the asset's tax fields (deterministic,
 * independent of whether the tax runner has executed). Assets with tax_method NONE have
 * tax = book by definition (no difference).
 */
export async function computeBookVsTaxDepreciation(
  supabase: SupabaseClient,
  taxYear: number,
): Promise<BookVsTaxDepreciation> {
  const { data: assetData, error } = await supabase
    .from('fixed_assets')
    .select('id, name, category, acquisition_date, acquisition_cost_cents, salvage_value_cents, depreciation_method, tax_method, tax_recovery_years, tax_convention, tax_life_months, section_179_cents, bonus_pct, accumulated_depreciation_cents, tax_accumulated_depreciation_cents, depreciation_expense_account_id, status')
    .in('status', ['ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED']);
  if (error) throw new Error(error.message);
  const assets = (assetData ?? []) as AssetRow[];

  // Posted BOOK depreciation for the calendar year, grouped per asset.
  const { data: bookRuns } = await supabase
    .from('depreciation_runs')
    .select('fixed_asset_id, amount_cents')
    .eq('period_year', taxYear);
  const bookByAsset = new Map<string, number>();
  for (const r of (bookRuns ?? []) as Array<{ fixed_asset_id: string; amount_cents: number }>) {
    bookByAsset.set(r.fixed_asset_id, (bookByAsset.get(r.fixed_asset_id) ?? 0) + Number(r.amount_cents ?? 0));
  }

  const lines: AssetDepreciationLine[] = [];
  let totalBook = 0;
  let totalTax = 0;

  for (const a of assets) {
    const bookYear = bookByAsset.get(a.id) ?? 0;
    let taxYearCents = bookYear; // tax_method NONE ⇒ tax follows book
    let schedule: AssetDepreciationLine['schedule'] = [];
    let recoveryYears: number | null = null;

    if (a.tax_method !== 'NONE' && a.tax_convention !== 'MID_MONTH') {
      const bonusPct = a.bonus_pct ?? 0;
      try {
        const s = computeTaxDepreciationSchedule({
          costCents: a.acquisition_cost_cents,
          inServiceDate: a.acquisition_date,
          method: regularMethodFor(a.tax_method),
          recoveryYears: a.tax_recovery_years,
          convention: a.tax_convention as TaxConvention,
          taxLifeMonths: a.tax_life_months,
          salvageCents: a.salvage_value_cents,
          section179Cents: a.section_179_cents,
          bonusPct,
        });
        taxYearCents = taxDepreciationForYear(s, taxYear);
        recoveryYears = s.recoveryYears;
        schedule = s.years.map((y) => ({
          ordinal: y.ordinal,
          year: y.year,
          section179Cents: y.section179Cents,
          bonusCents: y.bonusCents,
          regularCents: y.regularCents,
          totalCents: y.totalCents,
          accumulatedCents: y.accumulatedCents,
        }));
      } catch {
        // A malformed tax election never breaks the reconciliation — fall back to tax = book.
        taxYearCents = bookYear;
      }
    }

    totalBook += bookYear;
    totalTax += taxYearCents;
    lines.push({
      assetId: a.id,
      name: a.name,
      category: a.category,
      acquisitionDate: a.acquisition_date,
      costCents: a.acquisition_cost_cents,
      taxMethod: a.tax_method,
      recoveryYears,
      convention: a.tax_convention,
      section179Cents: a.section_179_cents,
      bonusPct: a.bonus_pct ?? 0,
      schedule,
      bookYearCents: bookYear,
      taxYearCents,
      differenceCents: bookYear - taxYearCents,
    });
  }

  lines.sort((x, y) => Math.abs(y.differenceCents) - Math.abs(x.differenceCents));

  return {
    taxYear,
    assets: lines,
    totalBookCents: totalBook,
    totalTaxCents: totalTax,
    netDifferenceCents: totalBook - totalTax,
    difference: classifyDepreciationDifference(totalBook, totalTax),
  };
}

/**
 * Find a POSTED book depreciation-expense gl_entry_line in the tax year to anchor the M-1
 * override on. The override amount is EXPLICIT (pinned), so the anchor line only needs to be
 * a P&L (OPEX) line inside the period so `m1-report.ts` includes it. Returns null when no
 * book depreciation was posted that year (nothing for the M-1 to attach to yet).
 */
export async function findDepreciationAnchorLine(
  supabase: SupabaseClient,
  taxYear: number,
): Promise<string | null> {
  const { data: assets } = await supabase
    .from('fixed_assets')
    .select('depreciation_expense_account_id');
  const acctIds = Array.from(
    new Set(
      ((assets ?? []) as Array<{ depreciation_expense_account_id: string | null }>)
        .map((a) => a.depreciation_expense_account_id)
        .filter((x): x is string => Boolean(x)),
    ),
  );
  if (acctIds.length === 0) return null;

  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select('id, gl_entries!inner(entry_date, status)')
    .in('account_id', acctIds)
    .eq('gl_entries.status', 'POSTED')
    .gte('gl_entries.entry_date', `${taxYear}-01-01`)
    .lte('gl_entries.entry_date', `${taxYear}-12-31`)
    .order('id', { ascending: false })
    .limit(1);
  const row = (lines ?? [])[0] as { id: string } | undefined;
  return row?.id ?? null;
}

export interface DeprProposalSummary {
  proposed: boolean;
  decisionId: string | null;
  code: string | null;
  amountCents: number;
  netDifferenceCents: number;
  targetLineFound: boolean;
}

/**
 * Write (or refresh) a PROPOSED ai_decisions row carrying the year's book-vs-tax
 * depreciation temporary difference for a human to confirm. Idempotent per tax year via
 * a stable dedup_key. Does NOT write to the M-1 — confirmation does. RLS-scoped.
 */
export async function proposeDepreciationDifference(
  supabase: SupabaseClient,
  args: { orgId: string; userId: string | null; taxYear: number },
): Promise<DeprProposalSummary> {
  const { orgId, userId, taxYear } = args;
  const recon = await computeBookVsTaxDepreciation(supabase, taxYear);
  const diff = recon.difference;

  if (!diff || diff.amountCents === 0) {
    return { proposed: false, decisionId: null, code: null, amountCents: 0, netDifferenceCents: recon.netDifferenceCents, targetLineFound: false };
  }

  const anchorLineId = await findDepreciationAnchorLine(supabase, taxYear);
  const dedupKey = `booktaxdepr:${taxYear}`;

  const perAsset = recon.assets
    .filter((a) => a.differenceCents !== 0)
    .map((a) => ({ asset_id: a.assetId, name: a.name, book_year_cents: a.bookYearCents, tax_year_cents: a.taxYearCents, difference_cents: a.differenceCents }));

  const proposedOutput = {
    dedup_key: dedupKey,
    kind: 'depr_difference',
    tax_year: taxYear,
    code: diff.code,
    label: diff.code === BOOK_DEPR_EXCESS_CODE ? 'Book depreciation over tax' : 'Tax depreciation over book (§179/bonus)',
    difference_type: 'TEMPORARY',
    taxable_effect: diff.taxableEffect,
    amount_cents: diff.amountCents,
    book_total_cents: recon.totalBookCents,
    tax_total_cents: recon.totalTaxCents,
    net_difference_cents: recon.netDifferenceCents,
    target_gl_entry_line_id: anchorLineId,
    assets: perAsset,
  };

  const reasoning =
    diff.code === BOOK_DEPR_EXCESS_CODE
      ? `Book depreciation ($${(recon.totalBookCents / 100).toLocaleString()}) exceeded tax depreciation ($${(recon.totalTaxCents / 100).toLocaleString()}) in ${taxYear} — an M-1 line 5a temporary addition that reverses in later years.`
      : `Tax depreciation ($${(recon.totalTaxCents / 100).toLocaleString()}) exceeded book depreciation ($${(recon.totalBookCents / 100).toLocaleString()}) in ${taxYear} — MACRS/§179/bonus acceleration; an M-1 line 8a temporary subtraction.`;

  // Idempotent: refresh an open proposal for this year, else insert.
  const { data: existing } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output')
    .eq('feature', BOOK_TAX_DEPR_FEATURE)
    .eq('status', 'PROPOSED');
  const openId = ((existing ?? []) as Array<{ id: string; proposed_output?: { dedup_key?: string } }>).find(
    (r) => r.proposed_output?.dedup_key === dedupKey,
  )?.id;

  if (openId) {
    await supabase
      .from('ai_decisions')
      .update({ proposed_output: proposedOutput, confidence: 1, reasoning })
      .eq('id', openId);
    return { proposed: true, decisionId: openId, code: diff.code, amountCents: diff.amountCents, netDifferenceCents: recon.netDifferenceCents, targetLineFound: Boolean(anchorLineId) };
  }

  const { data: inserted, error } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      feature: BOOK_TAX_DEPR_FEATURE,
      input_summary: `Book-vs-tax depreciation difference for tax year ${taxYear}`,
      proposed_output: proposedOutput,
      confidence: 1,
      reasoning,
      status: 'PROPOSED',
      created_by_user: userId,
    })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);

  return {
    proposed: true,
    decisionId: (inserted as { id: string } | null)?.id ?? null,
    code: diff.code,
    amountCents: diff.amountCents,
    netDifferenceCents: recon.netDifferenceCents,
    targetLineFound: Boolean(anchorLineId),
  };
}

export interface DeprConfirmResult {
  ok: boolean;
  error?: string;
}

/**
 * Confirm a PROPOSED depreciation-difference decision: write the pinned book_tax_line_override
 * on the anchor depreciation line (which the M-1 engine then reads) and disposition the
 * decision APPROVED. Never posts to the GL or moves money — a book-tax override is a
 * reporting dimension. RLS-scoped.
 */
export async function confirmDepreciationDifference(
  supabase: SupabaseClient,
  args: { orgId: string; userId: string | null; decisionId: string },
): Promise<DeprConfirmResult> {
  const { orgId, userId, decisionId } = args;

  const { data: decision } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output')
    .eq('id', decisionId)
    .eq('feature', BOOK_TAX_DEPR_FEATURE)
    .maybeSingle();
  if (!decision) return { ok: false, error: 'Proposal not found' };
  const d = decision as { id: string; status: string; proposed_output: Record<string, unknown> };
  if (d.status !== 'PROPOSED') return { ok: false, error: `Proposal already ${d.status.toLowerCase()}` };

  const out = d.proposed_output ?? {};
  const anchorLineId = out.target_gl_entry_line_id as string | null;
  const code = out.code as string | undefined;
  const effect = out.taxable_effect as 'ADD' | 'SUBTRACT' | undefined;
  const amountCents = Number(out.amount_cents ?? 0);
  if (!code || !effect || amountCents <= 0) return { ok: false, error: 'Proposal is malformed' };
  if (!anchorLineId) {
    return { ok: false, error: 'No posted book depreciation line in this year to anchor the M-1 override — post book depreciation first.' };
  }

  const { error: upErr } = await supabase.from('book_tax_line_overrides').upsert(
    {
      org_id: orgId,
      gl_entry_line_id: anchorLineId,
      m_line_code: code,
      difference_type: 'TEMPORARY',
      taxable_effect: effect,
      disallowance_pct: null,
      override_amount_cents: amountCents,
      note: `Book-vs-tax depreciation timing difference, tax year ${String(out.tax_year ?? '')} (confirmed from AI proposal).`,
      source: 'AI_CONFIRMED',
      ai_decision_id: decisionId,
    },
    { onConflict: 'org_id,gl_entry_line_id' },
  );
  if (upErr) return { ok: false, error: upErr.message };

  await supabase
    .from('ai_decisions')
    .update({ status: 'APPROVED', disposition_by_user: userId, disposition_at: new Date().toISOString() })
    .eq('id', decisionId)
    .eq('feature', BOOK_TAX_DEPR_FEATURE);

  return { ok: true };
}
