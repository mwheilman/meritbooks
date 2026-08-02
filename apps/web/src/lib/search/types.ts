/**
 * SEARCH / KNOWLEDGE lane (matrix modality M13) — shared types.
 *
 * A plain-English "find anything" across the owned ledger. The deterministic
 * core parses a query into structure (amounts, dates, entity/text terms, type
 * hints) and runs structured + text search across the searchable objects; the
 * ranker scores every hit by field-weighted match + recency. The optional Core
 * AI gateway is used ONLY to extract structured intent when the deterministic
 * parse is ambiguous — never to write SQL and never to fabricate results.
 */

/** The object classes a query can retrieve. */
export type SearchType =
  | 'journal_entry'
  | 'bank_transaction'
  | 'invoice'
  | 'bill'
  | 'vendor'
  | 'customer'
  | 'account';

export const ALL_SEARCH_TYPES: readonly SearchType[] = [
  'journal_entry',
  'bank_transaction',
  'invoice',
  'bill',
  'vendor',
  'customer',
  'account',
] as const;

export const TYPE_LABELS: Record<SearchType, string> = {
  journal_entry: 'Journal entries',
  bank_transaction: 'Bank transactions',
  invoice: 'Invoices',
  bill: 'Bills',
  vendor: 'Vendors',
  customer: 'Customers',
  account: 'GL accounts',
};

/** ISO yyyy-mm-dd inclusive range. `from`/`to` may each be null (open-ended). */
export interface DateRange {
  from: string | null;
  to: string | null;
}

/** Amount intent, in bigint cents. */
export interface AmountConstraint {
  /** Exact cent values to match (absolute value; sign-agnostic). */
  exact: number[];
  /** Inclusive lower bound in cents, or null. */
  min: number | null;
  /** Inclusive upper bound in cents, or null. */
  max: number | null;
}

/** Deterministic parse of a raw query string. */
export interface ParsedQuery {
  raw: string;
  /** Free-text terms for ILIKE matching (names, memos, descriptions). */
  terms: string[];
  /** Reference-number-like tokens (e.g. INV-1001, JE-000123, 1500). */
  numberTokens: string[];
  amounts: AmountConstraint;
  /** Null when the query implies no specific date window. */
  dateRange: DateRange | null;
  /** Explicit type filter parsed from the query; null = search all types. */
  types: SearchType[] | null;
}

export type FieldKind = 'exact' | 'partial';
export type MatchField =
  | 'number'
  | 'name'
  | 'memo'
  | 'description'
  | 'category'
  | 'other';

export interface FieldMatch {
  field: MatchField;
  kind: FieldKind;
}

/**
 * A span of a grounded result "headline" — the ts_headline-equivalent snippet
 * that shows the user *why* a record matched. `hit: true` marks a matched span
 * (rendered highlighted). Built deterministically from the record's own text, so
 * nothing here is fabricated — it always quotes real field content.
 */
export interface HeadlineSegment {
  text: string;
  hit: boolean;
}

/** A single ranked search hit returned to the client. */
export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  amountCents: number | null;
  /** ISO yyyy-mm-dd, or null for undated masters. */
  date: string | null;
  href: string;
  snippet: string;
  /** Highlighted "why it matched" snippet, or null when no field span matched. */
  headline: HeadlineSegment[] | null;
  score: number;
}

export interface SearchGroup {
  type: SearchType;
  label: string;
  results: SearchResult[];
}

export interface SearchResponse {
  query: string;
  parsed: {
    terms: string[];
    numberTokens: string[];
    amounts: AmountConstraint;
    dateRange: DateRange | null;
    types: SearchType[] | null;
  };
  groups: SearchGroup[];
  total: number;
  /** True when the Core AI gateway contributed intent to this parse. */
  aiAssisted: boolean;
}
