/**
 * Which price-book operations reveal cost (security review, 1117 L): cost = price × (1 − GM), so
 * anyone who can set a margin target or a cost and then read the resulting price can derive cost.
 * Those operations need projects.financials:view, the same rule as the masked cost columns. Pure.
 */
export type PricebookOp =
  | { op: 'settings' }
  | { op: 'bulk'; mode: string }
  | { op: 'import'; rows: ReadonlyArray<{ cost_cents?: string; target_gm_pct?: string }> }
  | { op: string };

export function pricebookOpTouchesCost(b: PricebookOp): boolean {
  if (b.op === 'settings') return true;
  if (b.op === 'bulk' && 'mode' in b) return b.mode === 'TARGET_GM';
  if (b.op === 'import' && 'rows' in b) return b.rows.some((r) => r.cost_cents != null || r.target_gm_pct != null);
  return false;
}
