/**
 * Board Package assembler (M7 / FP&A) — PURE, framework-free, deterministic.
 *
 * Given the report payloads already produced by the existing RLS-scoped report
 * endpoints (income statement, balance sheet, cash flow, AR/AP aging, debt
 * schedule), this module assembles a board-ready financial package:
 *   1. a cover,
 *   2. a deterministically-computed KPI summary (revenue, margins, cash,
 *      AR/AP, leverage/liquidity ratios),
 *   3. the core statements (passed through verbatim — the numbers are the exact
 *      figures the on-screen statements show, so the package ties out),
 *   4. an executive summary (the ONLY AI surface — the gateway phrases the
 *      computed KPI figures; it never computes or invents a number), and
 *   5. financial-statement notes (deterministic disclosures + a human-filled
 *      subsequent-events placeholder).
 *
 * CANON invariants honored here:
 *   • Every dollar is bigint CENTS; ratios/percents are derived from cents.
 *   • NO Supabase / react-pdf / Next imports — this file is a pure transform so
 *     the KPI math and section assembly are unit-testable against fixtures.
 *   • The AI "gateway" only receives already-computed facts (see
 *     buildExecutiveSummaryFacts); the deterministic fallback is always truthful.
 */

import { z } from 'zod';
import { formatMoney, pct } from '@meritbooks/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Input payload schemas (subsets of the existing report-route responses).
// Kept permissive (extra keys are stripped) so a route can pass the raw payload.
// ─────────────────────────────────────────────────────────────────────────────

export const isAccountSchema = z.object({
  accountNumber: z.string().default(''),
  accountName: z.string().default(''),
  amountCents: z.number().default(0),
  accountId: z.string().optional(),
  groupName: z.string().optional(),
});
export const isGroupSchema = z.object({
  name: z.string().default(''),
  accounts: z.array(isAccountSchema).default([]),
  totalCents: z.number().default(0),
});
export const isSectionSchema = z.object({
  type: z.string(),
  label: z.string().default(''),
  groups: z.array(isGroupSchema).default([]),
  totalCents: z.number().default(0),
});
export const incomeStatementPayloadSchema = z.object({
  sections: z.array(isSectionSchema).default([]),
  summary: z.object({
    revenueCents: z.number().default(0),
    cogsCents: z.number().default(0),
    grossProfitCents: z.number().default(0),
    opexCents: z.number().default(0),
    ebitdaCents: z.number().default(0),
    otherCents: z.number().default(0),
    netIncomeCents: z.number().default(0),
    grossMarginPct: z.number().default(0),
    netMarginPct: z.number().default(0),
  }),
  filters: z
    .object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      basis: z.string().optional(),
    })
    .optional(),
});

export const bsAccountSchema = z.object({
  accountNumber: z.string().default(''),
  accountName: z.string().default(''),
  balanceCents: z.number().default(0),
  accountId: z.string().optional(),
});
export const bsGroupSchema = z.object({
  name: z.string().default(''),
  accounts: z.array(bsAccountSchema).default([]),
  totalCents: z.number().default(0),
});
export const bsSubTypeSchema = z.object({
  name: z.string().default(''),
  groups: z.array(bsGroupSchema).default([]),
  totalCents: z.number().default(0),
});
export const bsSectionSchema = z.object({
  type: z.string(),
  label: z.string().default(''),
  subTypes: z.array(bsSubTypeSchema).default([]),
  totalCents: z.number().default(0),
});
export const balanceSheetPayloadSchema = z.object({
  sections: z.array(bsSectionSchema).default([]),
  summary: z.object({
    totalAssetsCents: z.number().default(0),
    totalLiabilitiesCents: z.number().default(0),
    totalEquityCents: z.number().default(0),
    liabilitiesPlusEquityCents: z.number().default(0),
    isBalanced: z.boolean().default(false),
    varianceCents: z.number().default(0),
  }),
  filters: z.object({ asOfDate: z.string().optional() }).optional(),
});

const cfItemSchema = z.object({ label: z.string().default(''), amountCents: z.number().default(0) });
export const cashFlowPayloadSchema = z.object({
  period: z.object({ startDate: z.string(), endDate: z.string() }).optional(),
  operating: z.object({
    netIncome: z.number().default(0),
    adjustments: z.array(cfItemSchema).default([]),
    changesInWorkingCapital: z.array(cfItemSchema).default([]),
    totalCents: z.number().default(0),
  }),
  investing: z.object({ items: z.array(cfItemSchema).default([]), totalCents: z.number().default(0) }),
  financing: z.object({ items: z.array(cfItemSchema).default([]), totalCents: z.number().default(0) }),
  netChangeCents: z.number().default(0),
  beginningCashCents: z.number().default(0),
  endingCashCents: z.number().default(0),
});

export const agingPayloadSchema = z.object({
  buckets: z.record(z.object({ count: z.number().default(0), totalCents: z.number().default(0) })).default({}),
  totalOutstanding: z.number().default(0),
});

const debtInstrumentSchema = z.object({
  name: z.string().default(''),
  lender: z.string().default(''),
  type: z.string().default(''),
  balanceCents: z.number().default(0),
  interestRate: z.number().default(0),
  maturityDate: z.string().nullable().optional(),
  monthlyPaymentCents: z.number().default(0),
  annualPaymentCents: z.number().default(0),
  locationName: z.string().optional(),
});
export const debtPayloadSchema = z.object({
  data: z.array(debtInstrumentSchema).default([]),
  summary: z.object({
    totalBalanceCents: z.number().default(0),
    totalMonthlyPaymentCents: z.number().default(0),
    instrumentCount: z.number().default(0),
    weightedAvgRate: z.number().default(0),
  }),
});

export type IncomeStatementPayload = z.infer<typeof incomeStatementPayloadSchema>;
export type BalanceSheetPayload = z.infer<typeof balanceSheetPayloadSchema>;
export type CashFlowPayload = z.infer<typeof cashFlowPayloadSchema>;
export type AgingPayload = z.infer<typeof agingPayloadSchema>;
export type DebtPayload = z.infer<typeof debtPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// KPI summary
// ─────────────────────────────────────────────────────────────────────────────

export type KpiKind = 'money' | 'pct' | 'ratio' | 'count';

export const boardKpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['money', 'pct', 'ratio', 'count']),
  /** Present when kind === 'money'. */
  valueCents: z.number().nullable().optional(),
  /** Rendered value for pct / ratio / count / money. */
  valueText: z.string(),
  /** Period-over-period movement (money delta), when a prior period was given. */
  deltaCents: z.number().nullable().optional(),
  deltaPct: z.number().nullable().optional(),
  favorable: z.boolean().nullable().optional(),
  hint: z.string().optional(),
});
export type BoardKpi = z.infer<typeof boardKpiSchema>;

export const kpiSummarySchema = z.object({
  revenueCents: z.number(),
  grossProfitCents: z.number(),
  grossMarginPct: z.number(),
  operatingIncomeCents: z.number(),
  netIncomeCents: z.number(),
  netMarginPct: z.number(),
  cashCents: z.number(),
  netChangeInCashCents: z.number(),
  arCents: z.number(),
  apCents: z.number(),
  currentAssetsCents: z.number().nullable(),
  currentLiabilitiesCents: z.number().nullable(),
  workingCapitalCents: z.number().nullable(),
  currentRatio: z.number().nullable(),
  totalAssetsCents: z.number(),
  totalLiabilitiesCents: z.number(),
  totalEquityCents: z.number(),
  debtToEquity: z.number().nullable(),
  returnOnEquityPct: z.number().nullable(),
  totalDebtCents: z.number(),
  weightedAvgRatePct: z.number(),
  annualDebtServiceCents: z.number(),
  deltas: z.object({
    revenuePct: z.number().nullable(),
    grossProfitPct: z.number().nullable(),
    netIncomePct: z.number().nullable(),
  }),
  cards: z.array(boardKpiSchema),
});
export type KpiSummary = z.infer<typeof kpiSummarySchema>;

/** Sum balance-sheet sub-type totals whose name marks them "current" (but not
 *  "non-current" / "long-term"). Returns null when no such sub-type exists, so a
 *  ratio is only reported when it is actually derivable from the COA structure. */
function sumCurrentSubTypes(section: BalanceSheetPayload['sections'][number] | undefined): number | null {
  if (!section) return null;
  let sum = 0;
  let matched = false;
  for (const st of section.subTypes) {
    const n = st.name.toLowerCase();
    const isCurrent = n.includes('current') && !n.includes('non-current') && !n.includes('non current') && !n.includes('long');
    if (isCurrent) {
      matched = true;
      sum += st.totalCents;
    }
  }
  return matched ? sum : null;
}

function deltaPct(current: number, prior: number | null | undefined): number | null {
  if (prior == null || prior === 0) return null;
  return Number((((current - prior) / Math.abs(prior)) * 100).toFixed(1));
}

export interface KpiInputs {
  currentIS: IncomeStatementPayload;
  priorIS?: IncomeStatementPayload | null;
  balanceSheet: BalanceSheetPayload;
  cashFlow: CashFlowPayload;
  arAging: AgingPayload;
  apAging: AgingPayload;
  debt: DebtPayload;
}

export function computeKpis(input: KpiInputs): KpiSummary {
  const s = input.currentIS.summary;
  const bs = input.balanceSheet.summary;
  const assetSection = input.balanceSheet.sections.find((x) => x.type === 'ASSET');
  const liabSection = input.balanceSheet.sections.find((x) => x.type === 'LIABILITY');

  const currentAssets = sumCurrentSubTypes(assetSection);
  const currentLiabilities = sumCurrentSubTypes(liabSection);
  const workingCapital =
    currentAssets != null && currentLiabilities != null ? currentAssets - currentLiabilities : null;
  const currentRatio =
    currentAssets != null && currentLiabilities != null && currentLiabilities !== 0
      ? Number((currentAssets / currentLiabilities).toFixed(2))
      : null;

  const debtToEquity =
    bs.totalEquityCents !== 0 ? Number((bs.totalLiabilitiesCents / bs.totalEquityCents).toFixed(2)) : null;
  const returnOnEquityPct =
    bs.totalEquityCents !== 0 ? pct(s.netIncomeCents, bs.totalEquityCents) : null;

  const cashCents = input.cashFlow.endingCashCents;
  const arCents = input.arAging.totalOutstanding;
  const apCents = input.apAging.totalOutstanding;

  const revenuePct = deltaPct(s.revenueCents, input.priorIS?.summary.revenueCents ?? null);
  const grossProfitPct = deltaPct(s.grossProfitCents, input.priorIS?.summary.grossProfitCents ?? null);
  const netIncomePct = deltaPct(s.netIncomeCents, input.priorIS?.summary.netIncomeCents ?? null);

  const priorRev = input.priorIS?.summary.revenueCents ?? null;
  const priorGP = input.priorIS?.summary.grossProfitCents ?? null;
  const priorNI = input.priorIS?.summary.netIncomeCents ?? null;

  const cards: BoardKpi[] = [
    {
      key: 'revenue',
      label: 'Revenue',
      kind: 'money',
      valueCents: s.revenueCents,
      valueText: formatMoney(s.revenueCents),
      deltaCents: priorRev != null ? s.revenueCents - priorRev : null,
      deltaPct: revenuePct,
      favorable: priorRev != null ? s.revenueCents >= priorRev : null,
    },
    {
      key: 'gross_profit',
      label: 'Gross Profit',
      kind: 'money',
      valueCents: s.grossProfitCents,
      valueText: formatMoney(s.grossProfitCents),
      deltaCents: priorGP != null ? s.grossProfitCents - priorGP : null,
      deltaPct: grossProfitPct,
      favorable: priorGP != null ? s.grossProfitCents >= priorGP : null,
      hint: `${s.grossMarginPct}% margin`,
    },
    {
      key: 'net_income',
      label: 'Net Income',
      kind: 'money',
      valueCents: s.netIncomeCents,
      valueText: formatMoney(s.netIncomeCents),
      deltaCents: priorNI != null ? s.netIncomeCents - priorNI : null,
      deltaPct: netIncomePct,
      favorable: priorNI != null ? s.netIncomeCents >= priorNI : null,
      hint: `${s.netMarginPct}% margin`,
    },
    {
      key: 'cash',
      label: 'Cash & Equivalents',
      kind: 'money',
      valueCents: cashCents,
      valueText: formatMoney(cashCents),
      deltaCents: input.cashFlow.netChangeCents,
      deltaPct: null,
      favorable: input.cashFlow.netChangeCents >= 0,
      hint: `${formatMoney(input.cashFlow.netChangeCents, { showSign: true })} this period`,
    },
    {
      key: 'ar',
      label: 'Accounts Receivable',
      kind: 'money',
      valueCents: arCents,
      valueText: formatMoney(arCents),
      favorable: null,
    },
    {
      key: 'ap',
      label: 'Accounts Payable',
      kind: 'money',
      valueCents: apCents,
      valueText: formatMoney(apCents),
      favorable: null,
    },
    {
      key: 'current_ratio',
      label: 'Current Ratio',
      kind: 'ratio',
      valueText: currentRatio != null ? `${currentRatio.toFixed(2)}x` : 'n/a',
      favorable: currentRatio != null ? currentRatio >= 1 : null,
      hint: workingCapital != null ? `${formatMoney(workingCapital)} working capital` : undefined,
    },
    {
      key: 'debt_to_equity',
      label: 'Debt / Equity',
      kind: 'ratio',
      valueText: debtToEquity != null ? `${debtToEquity.toFixed(2)}x` : 'n/a',
      favorable: debtToEquity != null ? debtToEquity <= 2 : null,
    },
    {
      key: 'total_debt',
      label: 'Total Debt',
      kind: 'money',
      valueCents: input.debt.summary.totalBalanceCents,
      valueText: formatMoney(input.debt.summary.totalBalanceCents),
      favorable: null,
      hint: input.debt.summary.weightedAvgRate ? `${input.debt.summary.weightedAvgRate}% wtd avg rate` : undefined,
    },
  ];

  return {
    revenueCents: s.revenueCents,
    grossProfitCents: s.grossProfitCents,
    grossMarginPct: s.grossMarginPct,
    operatingIncomeCents: s.ebitdaCents,
    netIncomeCents: s.netIncomeCents,
    netMarginPct: s.netMarginPct,
    cashCents,
    netChangeInCashCents: input.cashFlow.netChangeCents,
    arCents,
    apCents,
    currentAssetsCents: currentAssets,
    currentLiabilitiesCents: currentLiabilities,
    workingCapitalCents: workingCapital,
    currentRatio,
    totalAssetsCents: bs.totalAssetsCents,
    totalLiabilitiesCents: bs.totalLiabilitiesCents,
    totalEquityCents: bs.totalEquityCents,
    debtToEquity,
    returnOnEquityPct,
    totalDebtCents: input.debt.summary.totalBalanceCents,
    weightedAvgRatePct: input.debt.summary.weightedAvgRate,
    annualDebtServiceCents: input.debt.summary.totalMonthlyPaymentCents * 12,
    deltas: { revenuePct, grossProfitPct, netIncomePct },
    cards,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial-statement notes (deterministic disclosures)
// ─────────────────────────────────────────────────────────────────────────────

export const noteSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.array(z.string()).default([]),
  table: z
    .object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.union([z.string(), z.number()]))),
    })
    .nullable()
    .optional(),
  /** True → this note is a placeholder a human must complete (e.g. subsequent events). */
  editable: z.boolean().optional(),
});
export type NoteSection = z.infer<typeof noteSectionSchema>;

export const boardNotesSchema = z.object({ notes: z.array(noteSectionSchema) });
export type BoardNotes = z.infer<typeof boardNotesSchema>;

function pastDueCents(aging: AgingPayload): number {
  let sum = 0;
  for (const [bucket, v] of Object.entries(aging.buckets)) {
    if (bucket !== 'CURRENT') sum += v.totalCents;
  }
  return sum;
}

export function buildBoardNotes(input: {
  entityLabel: string;
  periodLabel: string;
  generatedAt: string;
  balanceSheet: BalanceSheetPayload;
  cashFlow: CashFlowPayload;
  arAging: AgingPayload;
  apAging: AgingPayload;
  debt: DebtPayload;
  basisLabel: string;
}): BoardNotes {
  const notes: NoteSection[] = [];

  // Note 1 — Basis of Presentation
  notes.push({
    id: 'basis',
    title: 'Note 1 — Basis of Presentation',
    body: [
      `The accompanying financial statements of ${input.entityLabel} have been prepared on the ${input.basisLabel.toLowerCase()} in accordance with accounting principles generally accepted in the United States of America (GAAP).`,
      'These statements are internally prepared from the general ledger and have not been audited or reviewed by an independent accountant. They are intended for management and board use.',
    ],
  });

  // Note 2 — Significant Accounting Policies (stub)
  notes.push({
    id: 'policies',
    title: 'Note 2 — Summary of Significant Accounting Policies',
    body: [
      'Revenue recognition — Revenue is recognized under ASC 606 as performance obligations are satisfied. For contract-based work, revenue is recognized under the recognition method elected per engagement (e.g., percentage-of-completion, completed-contract, or point-in-time), with amounts billed in advance of recognition deferred.',
      'Cash and cash equivalents — Cash includes demand deposits and highly liquid instruments with original maturities of three months or less.',
      'Accounts receivable — Receivables are stated at the amount management expects to collect; an allowance for doubtful accounts is recorded where collection is uncertain.',
      'Use of estimates — The preparation of financial statements in conformity with GAAP requires management to make estimates and assumptions that affect the reported amounts of assets, liabilities, revenues, and expenses.',
    ],
  });

  // Note 3 — Debt & Financing Arrangements (deterministic table)
  const debtRows = input.debt.data.map((d) => [
    d.name || d.lender || 'Instrument',
    d.lender,
    d.type,
    formatMoney(d.balanceCents),
    `${d.interestRate}%`,
    d.maturityDate ?? '—',
    formatMoney(d.monthlyPaymentCents),
  ]);
  notes.push({
    id: 'debt',
    title: 'Note 3 — Debt and Financing Arrangements',
    body: [
      input.debt.summary.instrumentCount === 0
        ? 'The Company had no outstanding debt instruments recorded as of the reporting date.'
        : `As of the reporting date the Company had ${input.debt.summary.instrumentCount} outstanding debt instrument(s) with an aggregate balance of ${formatMoney(input.debt.summary.totalBalanceCents)}, a weighted-average interest rate of ${input.debt.summary.weightedAvgRate}%, and aggregate scheduled monthly debt service of ${formatMoney(input.debt.summary.totalMonthlyPaymentCents)} (${formatMoney(input.debt.summary.totalMonthlyPaymentCents * 12)} annualized).`,
    ],
    table:
      input.debt.summary.instrumentCount === 0
        ? null
        : {
            columns: ['Instrument', 'Lender', 'Type', 'Balance', 'Rate', 'Maturity', 'Monthly'],
            rows: debtRows,
          },
  });

  // Note 4 — Accounts Receivable & Concentrations (deterministic)
  const arPastDue = pastDueCents(input.arAging);
  const arTotal = input.arAging.totalOutstanding;
  notes.push({
    id: 'receivables',
    title: 'Note 4 — Accounts Receivable',
    body: [
      `Gross trade receivables outstanding totaled ${formatMoney(arTotal)} as of the reporting date, of which ${formatMoney(arPastDue)} (${pct(arPastDue, arTotal)}%) was past due.`,
      `Trade payables outstanding totaled ${formatMoney(input.apAging.totalOutstanding)}.`,
    ],
    table: {
      columns: ['Aging bucket', 'Count', 'Amount'],
      rows: ['CURRENT', '1-30', '31-60', '61-90', '90+'].map((b) => [
        b,
        input.arAging.buckets[b]?.count ?? 0,
        formatMoney(input.arAging.buckets[b]?.totalCents ?? 0),
      ]),
    },
  });

  // Note 5 — Subsequent Events (human-filled placeholder)
  const throughDate = new Date(input.generatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  notes.push({
    id: 'subsequent_events',
    title: 'Note 5 — Subsequent Events',
    body: [
      `Management has evaluated subsequent events through ${throughDate}, the date these financial statements were available to be issued.`,
      '[PLACEHOLDER — to be completed by management: describe any material events occurring after the reporting date, or state that no material subsequent events were identified.]',
    ],
    editable: true,
  });

  return { notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Executive summary (AI phrases; deterministic fallback always truthful)
// ─────────────────────────────────────────────────────────────────────────────

export const EXEC_SUMMARY_FEATURE = 'BOARD_NARRATIVE';

const withDelta = (label: string, cents: number, deltaPctVal: number | null): string =>
  deltaPctVal == null
    ? `${label} ${formatMoney(cents)}`
    : `${label} ${formatMoney(cents)} (${deltaPctVal > 0 ? '+' : ''}${deltaPctVal}% vs prior period)`;

/** The ONLY facts the model is allowed to see. Every figure is pre-computed. */
export function buildExecutiveSummaryFacts(k: KpiSummary, entityLabel: string, periodLabel: string): string {
  const lines: string[] = [
    `Entity: ${entityLabel}`,
    `Period: ${periodLabel}`,
    withDelta('Revenue:', k.revenueCents, k.deltas.revenuePct),
    withDelta('Gross profit:', k.grossProfitCents, k.deltas.grossProfitPct) + ` at ${k.grossMarginPct}% gross margin`,
    `Operating income: ${formatMoney(k.operatingIncomeCents)}`,
    withDelta('Net income:', k.netIncomeCents, k.deltas.netIncomePct) + ` at ${k.netMarginPct}% net margin`,
    `Cash & equivalents: ${formatMoney(k.cashCents)} (net change ${formatMoney(k.netChangeInCashCents, { showSign: true })})`,
    `Accounts receivable: ${formatMoney(k.arCents)}; accounts payable: ${formatMoney(k.apCents)}`,
    `Total assets ${formatMoney(k.totalAssetsCents)}; total liabilities ${formatMoney(k.totalLiabilitiesCents)}; total equity ${formatMoney(k.totalEquityCents)}`,
    k.currentRatio != null ? `Current ratio: ${k.currentRatio.toFixed(2)}x` : 'Current ratio: not determinable from the COA',
    k.debtToEquity != null ? `Debt-to-equity: ${k.debtToEquity.toFixed(2)}x` : 'Debt-to-equity: not determinable',
    `Total debt: ${formatMoney(k.totalDebtCents)} at ${k.weightedAvgRatePct}% weighted-average rate; annual debt service ${formatMoney(k.annualDebtServiceCents)}`,
  ];
  return lines.join('\n');
}

export const EXEC_SUMMARY_SYSTEM =
  'You are a CFO writing the executive summary at the front of a board financial package. ' +
  'You are given financial metrics that have ALREADY been computed from the general ledger. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures, percentages, and ratios provided — never invent, recompute, round differently, or introduce any number not in the facts. ' +
  '(2) Do not speculate about business causes the data does not contain. ' +
  '(3) Write 4-7 tight, board-ready sentences: lead with revenue and profitability, then liquidity/cash, then leverage. No markdown, no headings, no bullet lists — just the paragraph.';

/** Deterministic, no-speculation summary used when AI is unavailable/blocked. */
export function deterministicExecutiveSummary(k: KpiSummary, entityLabel: string, periodLabel: string): string {
  const parts: string[] = [];
  const revMove =
    k.deltas.revenuePct == null ? '' : ` (${k.deltas.revenuePct > 0 ? 'up' : k.deltas.revenuePct < 0 ? 'down' : 'flat'} ${Math.abs(k.deltas.revenuePct)}% vs the prior period)`;
  parts.push(
    `For ${periodLabel}, ${entityLabel} generated revenue of ${formatMoney(k.revenueCents)}${revMove}, producing gross profit of ${formatMoney(k.grossProfitCents)} (${k.grossMarginPct}% margin) and net income of ${formatMoney(k.netIncomeCents)} (${k.netMarginPct}% margin).`,
  );
  parts.push(
    `Cash and equivalents ended the period at ${formatMoney(k.cashCents)}, a net ${k.netChangeInCashCents >= 0 ? 'increase' : 'decrease'} of ${formatMoney(Math.abs(k.netChangeInCashCents))}; receivables stood at ${formatMoney(k.arCents)} and payables at ${formatMoney(k.apCents)}.`,
  );
  const liq = k.currentRatio != null ? `a current ratio of ${k.currentRatio.toFixed(2)}x` : 'liquidity ratios not derivable from the chart of accounts';
  const lev = k.debtToEquity != null ? `debt-to-equity of ${k.debtToEquity.toFixed(2)}x` : 'debt-to-equity not derivable';
  parts.push(
    `The balance sheet shows total assets of ${formatMoney(k.totalAssetsCents)} against total equity of ${formatMoney(k.totalEquityCents)}, with ${liq} and ${lev}. Total debt of ${formatMoney(k.totalDebtCents)} carries a ${k.weightedAvgRatePct}% weighted-average rate.`,
  );
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Package assembly
// ─────────────────────────────────────────────────────────────────────────────

export const BOARD_SECTION_LIST = [
  'Executive Summary',
  'Key Performance Indicators',
  'Statement of Operations (P&L)',
  'Balance Sheet',
  'Statement of Cash Flows',
  'Notes to Financial Statements',
] as const;

export const boardPackageMetaSchema = z.object({
  entityLabel: z.string(),
  periodLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  asOfDate: z.string(),
  generatedAt: z.string(),
  basisLabel: z.string(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#10b981'),
});

export const executiveSummarySchema = z.object({
  text: z.string(),
  source: z.enum(['ai', 'deterministic']),
  model: z.string().nullable().optional(),
});

export const boardPackageSchema = z.object({
  meta: boardPackageMetaSchema,
  cover: z.object({
    title: z.string(),
    entityLabel: z.string(),
    periodLabel: z.string(),
    asOfDate: z.string(),
    generatedAt: z.string(),
    sectionList: z.array(z.string()),
  }),
  executiveSummary: executiveSummarySchema,
  kpis: kpiSummarySchema,
  statements: z.object({
    incomeStatement: incomeStatementPayloadSchema,
    balanceSheet: balanceSheetPayloadSchema,
    cashFlow: cashFlowPayloadSchema,
    arAging: agingPayloadSchema,
    apAging: agingPayloadSchema,
    debt: debtPayloadSchema,
  }),
  notes: boardNotesSchema,
});
export type BoardPackage = z.infer<typeof boardPackageSchema>;

export interface AssembleInput {
  meta: z.infer<typeof boardPackageMetaSchema>;
  currentIS: IncomeStatementPayload;
  priorIS?: IncomeStatementPayload | null;
  balanceSheet: BalanceSheetPayload;
  cashFlow: CashFlowPayload;
  arAging: AgingPayload;
  apAging: AgingPayload;
  debt: DebtPayload;
  /** Optional pre-generated (AI) executive summary; deterministic if omitted. */
  executiveSummary?: z.infer<typeof executiveSummarySchema> | null;
}

export function assembleBoardPackage(input: AssembleInput): BoardPackage {
  const kpis = computeKpis({
    currentIS: input.currentIS,
    priorIS: input.priorIS ?? null,
    balanceSheet: input.balanceSheet,
    cashFlow: input.cashFlow,
    arAging: input.arAging,
    apAging: input.apAging,
    debt: input.debt,
  });

  const executiveSummary =
    input.executiveSummary ??
    {
      text: deterministicExecutiveSummary(kpis, input.meta.entityLabel, input.meta.periodLabel),
      source: 'deterministic' as const,
      model: null,
    };

  const notes = buildBoardNotes({
    entityLabel: input.meta.entityLabel,
    periodLabel: input.meta.periodLabel,
    generatedAt: input.meta.generatedAt,
    balanceSheet: input.balanceSheet,
    cashFlow: input.cashFlow,
    arAging: input.arAging,
    apAging: input.apAging,
    debt: input.debt,
    basisLabel: input.meta.basisLabel,
  });

  return {
    meta: input.meta,
    cover: {
      title: 'Board Financial Package',
      entityLabel: input.meta.entityLabel,
      periodLabel: input.meta.periodLabel,
      asOfDate: input.meta.asOfDate,
      generatedAt: input.meta.generatedAt,
      sectionList: [...BOARD_SECTION_LIST],
    },
    executiveSummary,
    kpis,
    statements: {
      incomeStatement: input.currentIS,
      balanceSheet: input.balanceSheet,
      cashFlow: input.cashFlow,
      arAging: input.arAging,
      apAging: input.apAging,
      debt: input.debt,
    },
    notes,
  };
}
