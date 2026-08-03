/**
 * Client-safe discoverability chips for the ANALYTICAL lane.
 *
 * This module is DEPENDENCY-FREE (no zod/supabase/server imports) so it can be
 * bundled into the client command bar without dragging server-only code. It is
 * NOT the safety boundary — `lib/nl/metric-catalog.ts` is the allowlist the model
 * is constrained to. These are only example prompts a user can click to run; each
 * maps in spirit to a catalog metric, but the router + resolveMetric still decide.
 *
 * Keep roughly in sync with METRIC_CATALOG when metrics are added/removed.
 */

export interface AnalyticalExample {
  /** The catalog metric id this example is expected to route to (documentation only). */
  metric: string;
  /** The chip label + the prompt sent to the router. */
  prompt: string;
}

export const ANALYTICAL_EXAMPLES: AnalyticalExample[] = [
  { metric: 'pnl_summary', prompt: 'Show me the P&L for this month' },
  { metric: 'cash_position', prompt: 'What is cash on hand right now?' },
  { metric: 'gross_margin', prompt: 'What was our gross margin last quarter?' },
  { metric: 'net_margin', prompt: 'What is our net profit margin?' },
  { metric: 'current_ratio', prompt: 'What is our current ratio and working capital?' },
  { metric: 'cash_runway', prompt: 'How many months of cash runway do we have?' },
  { metric: 'days_sales_outstanding', prompt: 'What is our DSO?' },
  { metric: 'days_payable_outstanding', prompt: 'What is our DPO?' },
  { metric: 'revenue_by_department', prompt: 'Show revenue by department' },
  { metric: 'expense_by_department', prompt: 'Show expenses by department' },
  { metric: 'top_customers_by_receivable', prompt: 'Which customers owe us the most?' },
  { metric: 'top_vendors_by_payable', prompt: 'Which vendors do we owe the most?' },
  { metric: 'revenue_trend', prompt: 'Show the revenue trend by month' },
  { metric: 'expense_trend', prompt: 'Show the expense trend by month' },
  { metric: 'overdue_receivables', prompt: 'How much of our AR is overdue?' },
  { metric: 'overdue_payables', prompt: 'How much of our AP is past due?' },
  { metric: 'ar_aging', prompt: 'Show accounts receivable aging' },
  { metric: 'ap_aging', prompt: 'Show accounts payable aging' },
  { metric: 'trial_balance', prompt: 'Show the trial balance' },
  { metric: 'balance_sheet_summary', prompt: 'Show the balance sheet summary' },
];
