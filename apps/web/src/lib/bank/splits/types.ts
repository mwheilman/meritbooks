/**
 * Client-safe split types (no server imports) — shared by the split service, the
 * /api/bank-feed/splits route and the split grid UI.
 */
import type { AppliedSplitLine } from './rules';

export interface SplitSummary {
  lines: number;
  companies: number;
  status: 'DRAFT' | 'POSTED';
}

export interface SplitRow {
  id: string;
  line_no: number;
  status: 'DRAFT' | 'POSTED';
  amount_cents: number;
  percent_bp: number | null;
  account_id: string;
  allocation_location_id: string;
  department_id: string | null;
  class_id: string | null;
  job_id: string | null;
  cost_code_id: string | null;
  memo: string | null;
  posting_version: number;
  gl_entry_id: string | null;
  split_rule_id: string | null;
}

export interface SplitSuggestion {
  source: 'RULE' | 'HISTORY';
  rule_id: string | null;
  name: string;
  lines: AppliedSplitLine[];
}

/** GET /api/bank-feed/splits response. */
export interface SplitStateResponse {
  transaction: { id: string; amount_cents: number; status: string; location_id: string; splittable: boolean };
  status: 'NONE' | 'DRAFT' | 'POSTED';
  lines: SplitRow[];
  suggestion: SplitSuggestion | null;
  /** Labels for every account referenced by `lines` / `suggestion`. */
  accounts: Record<string, { id: string; account_number: string; name: string; account_type: string }>;
}
