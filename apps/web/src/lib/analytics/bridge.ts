/**
 * Bridges (waterfalls): start → driver steps → end, in integer cents, where the
 * steps ALWAYS sum exactly to end − start (FPB AC-C1). Every builder either ties by
 * construction or names its residual step explicitly — nothing is plugged silently.
 *
 *   - EBITDA bridge: volume (Δrevenue at the prior gross margin) → gross-margin rate
 *     → operating expenses (→ add-backs for the adjusted bridge).
 *   - Working-capital bridge: Δ receivables, inventory, other current assets, payables,
 *     other current liabilities.
 *   - Cash bridge: net income → D&A → working capital → capex → debt → equity /
 *     distributions → other balance-sheet movements (the named residual).
 */

import { roundCents, sum } from './numbers';

export interface BridgeStep {
  key: string;
  label: string;
  cents: number;
  /** True for a computed residual ("Other …") rather than a measured driver. */
  residual?: boolean;
}

export interface Bridge {
  start: { label: string; cents: number };
  steps: BridgeStep[];
  end: { label: string; cents: number };
  /** Σ steps === end − start (always true for bridges returned by this module). */
  ties: boolean;
}

export class BridgeTieError extends Error {
  constructor(public readonly gapCents: number) {
    super(`Bridge does not tie: steps miss end − start by ${gapCents} cents`);
    this.name = 'BridgeTieError';
  }
}

/**
 * Assemble a bridge. With `residualLabel`, any gap becomes a named residual step
 * (omitted when zero); without it, a gap throws BridgeTieError.
 */
export function buildBridge(
  start: { label: string; cents: number },
  end: { label: string; cents: number },
  steps: BridgeStep[],
  residualLabel?: string,
): Bridge {
  for (const v of [start.cents, end.cents, ...steps.map((s) => s.cents)]) {
    if (!Number.isInteger(v)) throw new Error('Bridge amounts must be integer cents');
  }
  const gap = end.cents - start.cents - sum(steps.map((s) => s.cents));
  const out = [...steps];
  if (gap !== 0) {
    if (!residualLabel) throw new BridgeTieError(gap);
    out.push({ key: 'other', label: residualLabel, cents: gap, residual: true });
  }
  return { start, steps: out, end, ties: true };
}

export interface EbitdaBridgeInput {
  revenueCents: number;
  grossProfitCents: number;
  /** Operating expenses EXCLUDING D&A (so EBITDA = gross profit − this + other operating items). */
  opexExDaCents: number;
  ebitdaCents: number;
  /** Documented add-backs (adjusted bridge only). */
  addBacksCents?: number;
}

/**
 * EBITDA bridge, prior → current (portal parity, steps sum exactly):
 *   Revenue (volume at prior margin) = Δrevenue × prior gross margin (rounded to cents)
 *   Gross margin (rate)              = Δgross profit − volume
 *   Operating expenses               = −Δopex(ex-D&A)
 *   Other operating items            = residual, if EBITDA ≠ GP − opex ex-D&A
 *   Add-backs                        = Δadd-backs (adjusted = true)
 * When prior revenue ≤ 0 the prior margin is undefined; the whole gross-profit change
 * is shown as one "Gross profit" step.
 */
export function ebitdaBridge(prior: EbitdaBridgeInput, current: EbitdaBridgeInput, opts: { adjusted?: boolean } = {}): Bridge {
  const adjusted = opts.adjusted ?? false;
  const steps: BridgeStep[] = [];
  const dGp = current.grossProfitCents - prior.grossProfitCents;
  if (prior.revenueCents > 0) {
    const priorMargin = prior.grossProfitCents / prior.revenueCents;
    const volume = roundCents((current.revenueCents - prior.revenueCents) * priorMargin);
    steps.push({ key: 'volume', label: 'Revenue (volume at prior margin)', cents: volume });
    steps.push({ key: 'rate', label: 'Gross margin (rate)', cents: dGp - volume });
  } else {
    steps.push({ key: 'gross_profit', label: 'Gross profit', cents: dGp });
  }
  steps.push({ key: 'opex', label: 'Operating expenses', cents: -(current.opexExDaCents - prior.opexExDaCents) });
  const priorEnd = prior.ebitdaCents + (adjusted ? prior.addBacksCents ?? 0 : 0);
  const currentEnd = current.ebitdaCents + (adjusted ? current.addBacksCents ?? 0 : 0);
  const derivedPrior = prior.grossProfitCents - prior.opexExDaCents;
  const derivedCurrent = current.grossProfitCents - current.opexExDaCents;
  const otherOperating = current.ebitdaCents - derivedCurrent - (prior.ebitdaCents - derivedPrior);
  if (otherOperating !== 0) steps.push({ key: 'other_operating', label: 'Other operating items', cents: otherOperating });
  if (adjusted) {
    const dAdd = (current.addBacksCents ?? 0) - (prior.addBacksCents ?? 0);
    if (dAdd !== 0) steps.push({ key: 'addbacks', label: 'Add-backs', cents: dAdd });
  }
  const label = adjusted ? 'Adjusted EBITDA' : 'EBITDA';
  return buildBridge({ label: `Prior ${label}`, cents: priorEnd }, { label: `Current ${label}`, cents: currentEnd }, steps);
}

export interface WorkingCapitalPosition {
  receivablesCents: number;
  inventoryCents: number;
  otherCurrentAssetsCents: number;
  payablesCents: number;
  otherCurrentLiabilitiesCents: number;
}

/** Operating working capital = receivables + inventory + other CA − payables − other CL (all ex cash / ex debt). */
export function operatingWorkingCapital(p: WorkingCapitalPosition): number {
  return p.receivablesCents + p.inventoryCents + p.otherCurrentAssetsCents - p.payablesCents - p.otherCurrentLiabilitiesCents;
}

/** Working-capital bridge: ties by construction (each step is one component's change, liabilities negated). */
export function workingCapitalBridge(start: WorkingCapitalPosition, end: WorkingCapitalPosition): Bridge {
  const steps: BridgeStep[] = [
    { key: 'receivables', label: 'Receivables', cents: end.receivablesCents - start.receivablesCents },
    { key: 'inventory', label: 'Inventory', cents: end.inventoryCents - start.inventoryCents },
    { key: 'other_current_assets', label: 'Other current assets', cents: end.otherCurrentAssetsCents - start.otherCurrentAssetsCents },
    { key: 'payables', label: 'Payables', cents: -(end.payablesCents - start.payablesCents) },
    { key: 'other_current_liabilities', label: 'Other current liabilities', cents: -(end.otherCurrentLiabilitiesCents - start.otherCurrentLiabilitiesCents) },
  ];
  return buildBridge(
    { label: 'Opening working capital', cents: operatingWorkingCapital(start) },
    { label: 'Closing working capital', cents: operatingWorkingCapital(end) },
    steps,
  );
}

export interface CashDrivers {
  netIncomeCents: number;
  depreciationAmortizationCents: number;
  /** Increase in operating working capital (an increase USES cash). */
  workingCapitalIncreaseCents: number;
  /** Capital expenditure (positive = spent). */
  capexCents: number;
  /** Net borrowing (+ drawn, − repaid). */
  netBorrowingCents: number;
  /** Owner contributions (+) net of distributions / draws (−). */
  equityNetCents: number;
}

/**
 * Cash bridge from opening to closing cash. Measured drivers first; anything they
 * don't explain (other balance-sheet movements, FX, reclasses) is the named residual.
 */
export function cashBridge(openingCashCents: number, closingCashCents: number, d: CashDrivers): Bridge {
  const steps: BridgeStep[] = [
    { key: 'net_income', label: 'Net income', cents: d.netIncomeCents },
    { key: 'da', label: 'Depreciation & amortization', cents: d.depreciationAmortizationCents },
    { key: 'working_capital', label: 'Working capital', cents: -d.workingCapitalIncreaseCents },
    { key: 'capex', label: 'Capital expenditure', cents: -d.capexCents },
    { key: 'debt', label: 'Net borrowing', cents: d.netBorrowingCents },
    { key: 'equity', label: 'Contributions less distributions', cents: d.equityNetCents },
  ];
  return buildBridge(
    { label: 'Opening cash', cents: openingCashCents },
    { label: 'Closing cash', cents: closingCashCents },
    steps,
    'Other balance-sheet movements',
  );
}

/**
 * Elimination bridge for a consolidation: Σ companies → eliminations → consolidated.
 * Steps are one per company (the sum) plus the eliminations step; ties by construction.
 */
export function eliminationBridge(companies: { id: string; label: string; cents: number }[], eliminationsCents: number): Bridge {
  const combined = sum(companies.map((c) => c.cents));
  return buildBridge(
    { label: 'Start', cents: 0 },
    { label: 'Consolidated', cents: combined + eliminationsCents },
    [
      ...companies.map((c) => ({ key: `company:${c.id}`, label: c.label, cents: c.cents })),
      { key: 'eliminations', label: 'Intercompany eliminations', cents: eliminationsCents },
    ],
  );
}
