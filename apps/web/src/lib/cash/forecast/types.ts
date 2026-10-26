/**
 * Direct 13-week cash forecast (Wave 4C, docs/FPB-reports-fpna.md §4.12) — shared types.
 *
 * Every source (open AR, recurring billing, AP, payroll, debt, leases, subscriptions, taxes,
 * budgeted opex run-rate, manual items, scenario line draws) becomes a dated `ForecastItem`; the
 * engine (./engine.ts) buckets items into Monday-anchored weeks and days, per company and combined.
 *
 * Money is integer cents (JS number, integer arithmetic only). Inflows and outflows are both
 * stored as POSITIVE magnitudes; `direction` says which way the cash moves.
 */

export type Direction = 'IN' | 'OUT';

export const INFLOW_CATEGORIES = ['AR', 'RECURRING_AR', 'DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW'] as const;
export const OUTFLOW_CATEGORIES = [
  'AP',
  'PAYROLL',
  'PAYROLL_TAX',
  'DEBT_SERVICE',
  'LEASE',
  'SUBSCRIPTION',
  'TAX',
  'OPEX_RUNRATE',
  'OPEX',
  'CAPEX',
  'DISTRIBUTION',
  'TRANSFER_OUT',
  'LINE_PAYDOWN',
  'OTHER_OUT',
] as const;

export type InflowCategory = (typeof INFLOW_CATEGORIES)[number];
export type OutflowCategory = (typeof OUTFLOW_CATEGORIES)[number];
export type Category = InflowCategory | OutflowCategory;

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  AR: 'Customer collections',
  RECURRING_AR: 'Recurring billing',
  DEPOSIT: 'Deposits',
  OTHER_IN: 'Other receipts',
  TRANSFER_IN: 'Transfers in',
  LINE_DRAW: 'Line draws',
  AP: 'Vendor bills',
  PAYROLL: 'Payroll (net pay)',
  PAYROLL_TAX: 'Payroll taxes',
  DEBT_SERVICE: 'Debt service',
  LEASE: 'Leases',
  SUBSCRIPTION: 'Subscriptions',
  TAX: 'Taxes',
  OPEX_RUNRATE: 'Budgeted opex (run-rate)',
  OPEX: 'Other operating spend',
  CAPEX: 'Capital spending',
  DISTRIBUTION: 'Distributions',
  TRANSFER_OUT: 'Transfers out',
  LINE_PAYDOWN: 'Line paydowns',
  OTHER_OUT: 'Other disbursements',
};

export function directionOf(c: Category): Direction {
  return (INFLOW_CATEGORIES as readonly string[]).includes(c) ? 'IN' : 'OUT';
}

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && ((INFLOW_CATEGORIES as readonly string[]).includes(v) || (OUTFLOW_CATEGORIES as readonly string[]).includes(v));
}

/** How firm the item is — drives the confidence band and the UI badge. */
export type Certainty = 'COMMITTED' | 'EXPECTED' | 'ESTIMATED';

export type SourceKind =
  | 'INVOICE'
  | 'RECURRING_INVOICE'
  | 'BILL'
  | 'PAYROLL_RUN'
  | 'PAY_SCHEDULE'
  | 'DEBT'
  | 'LEASE'
  | 'SUBSCRIPTION'
  | 'SALES_TAX'
  | 'ESTIMATED_TAX'
  | 'BUDGET'
  | 'MANUAL'
  | 'SCENARIO';

export type ItemFlag = 'OVERDUE' | 'DISPUTED' | 'ON_HOLD' | 'UNAPPROVED' | 'PAY_RUN' | 'SCHEDULED' | 'DELAYED' | 'HAIRCUT' | 'GROWTH' | 'UNCONFIRMED';

export interface ForecastItem {
  /** Stable, unique key (`ar:<invoice id>`, `payroll:<schedule>:<date>` …) — REMOVE_ITEM targets it. */
  key: string;
  /** Owning company (core.locations.id); null = org-level (shown in the combined view only). */
  companyId: string | null;
  direction: Direction;
  category: Category;
  /** Expected cash date (ISO yyyy-mm-dd), never before today. */
  date: string;
  /** Expected cents (probability-weighted), positive. This is what the forecast counts. */
  amountCents: number;
  /** Document / schedule amount before probability, positive. */
  grossCents: number;
  /** 0..1 — the share of `grossCents` expected to arrive / leave. */
  probability: number;
  certainty: Certainty;
  label: string;
  party: string | null;
  /** customer / vendor id (scenario targeting). */
  partyId: string | null;
  source: { kind: SourceKind; id: string | null };
  /** The document's due date when it has one (drill / overdue badge). */
  dueDate?: string | null;
  /** Counterparty is another company in the forecast scope → excluded from the combined view. */
  counterpartyCompanyId?: string | null;
  /** A projection (not a document on file) — payroll growth applies only to these. */
  projected?: boolean;
  /** GL account the spend codes to (run-rate dedupe). */
  accountId?: string | null;
  flags?: ItemFlag[];
  note?: string | null;
  /** The amount split by GL account (bills with several lines) — run-rate dedupe. */
  accountSplit?: Array<{ accountId: string; cents: number }>;
  /** Top components (run-rate by account …) for the drill panel. */
  breakdown?: Array<{ label: string; cents: number }>;
}

export interface CompanyRef {
  id: string;
  name: string;
}
