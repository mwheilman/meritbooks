/**
 * Inventory valuation engine (GATE 11c) — pure, deterministic, unit-tested.
 *
 * The single place inventory cost is computed. Two methods:
 *
 *   WEIGHTED_AVG  — one blended unit cost. A RECEIPT adds qty + value and the
 *                   average re-blends; an ISSUE removes at the *current* average.
 *                   The integer source of truth is `total_value_cents`; the unit
 *                   average is only ever derived for display (round(value/qty)).
 *
 *   FIFO          — value is carried as ordered cost layers (oldest first). A
 *                   RECEIPT pushes a layer; an ISSUE consumes from the front, so
 *                   COGS is the actual cost of the oldest units on hand.
 *
 * MONEY IS BIGINT CENTS. No floating-point is ever used for a money amount — the
 * only divisions are proportional splits of an integer value by a unit *count*,
 * and every result is rounded to whole cents so totals reconcile exactly (the
 * remaining value is always the prior value minus the amount removed, never an
 * independently-rounded product). Quantities may be fractional (e.g. 12.5 lbs);
 * costs never are.
 *
 * This module has NO database or framework imports so it stays trivially testable
 * and reusable by the service layer, the API, and the tests alike.
 */

export type ValuationMethod = 'WEIGHTED_AVG' | 'FIFO';

export type MovementType = 'RECEIPT' | 'ISSUE' | 'ADJUST';

/** A FIFO cost layer: a batch of units received together, valued as a whole. */
export interface FifoLayer {
  qty: number;
  value_cents: number;
}

/**
 * The full valuation state of one item. `qty_on_hand`, `avg_cost_cents` and
 * `total_value_cents` are the display/rollup fields (maintained for both methods);
 * `fifo_layers` is authoritative only under FIFO.
 */
export interface ValuationState {
  qty_on_hand: number;
  avg_cost_cents: number;
  total_value_cents: number;
  fifo_layers: FifoLayer[];
}

/** The outcome of applying a movement: the next state + the COGS it realized. */
export interface MovementResult {
  state: ValuationState;
  /** COGS realized by this movement (ISSUE, or a negative ADJUST). RECEIPT = 0. */
  cogs_cents: number;
  /** Effective unit cost used for the moved quantity, in cents (for the audit row). */
  unit_cost_cents: number;
}

export class ValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValuationError';
  }
}

const QTY_EPSILON = 1e-9;

/** The starting state for a brand-new item (nothing on hand). */
export function emptyState(): ValuationState {
  return { qty_on_hand: 0, avg_cost_cents: 0, total_value_cents: 0, fifo_layers: [] };
}

function assertMoney(value: number, label: string): void {
  if (!Number.isInteger(value)) throw new ValuationError(`${label} must be integer cents, got ${value}`);
  if (value < 0) throw new ValuationError(`${label} must be non-negative, got ${value}`);
}

function assertQty(qty: number, label: string): void {
  if (!Number.isFinite(qty)) throw new ValuationError(`${label} must be a finite number, got ${qty}`);
  if (qty <= 0) throw new ValuationError(`${label} must be greater than zero, got ${qty}`);
}

/** Derived blended unit cost (display only). Zero when nothing is on hand. */
export function unitAverageCents(state: ValuationState): number {
  if (state.qty_on_hand <= QTY_EPSILON) return 0;
  return Math.round(state.total_value_cents / state.qty_on_hand);
}

/**
 * RECEIPT — add `qty` units carrying `totalCostCents` of cost. Under FIFO this is
 * a new layer; the rollup fields advance for both methods.
 */
export function applyReceipt(
  state: ValuationState,
  qty: number,
  totalCostCents: number,
): MovementResult {
  assertQty(qty, 'receipt quantity');
  assertMoney(totalCostCents, 'receipt cost');

  const layers = [...state.fifo_layers, { qty, value_cents: totalCostCents }];
  const total_value_cents = state.total_value_cents + totalCostCents;
  const qty_on_hand = state.qty_on_hand + qty;
  const next: ValuationState = {
    qty_on_hand,
    total_value_cents,
    avg_cost_cents: qty_on_hand > QTY_EPSILON ? Math.round(total_value_cents / qty_on_hand) : 0,
    fifo_layers: layers,
  };
  return { state: next, cogs_cents: 0, unit_cost_cents: Math.round(totalCostCents / qty) };
}

/** Remove `qty` units under weighted-average, at the current blended cost. */
function issueWeightedAvg(state: ValuationState, qty: number): MovementResult {
  if (qty > state.qty_on_hand + QTY_EPSILON) {
    throw new ValuationError(
      `Cannot issue ${qty}; only ${state.qty_on_hand} on hand (negative inventory is not allowed).`,
    );
  }
  const isFull = qty >= state.qty_on_hand - QTY_EPSILON;
  // Full issue clears the value exactly; partial issue removes the proportional share.
  const cogs = isFull
    ? state.total_value_cents
    : Math.round(state.total_value_cents * (qty / state.qty_on_hand));

  const qty_on_hand = isFull ? 0 : state.qty_on_hand - qty;
  const total_value_cents = isFull ? 0 : state.total_value_cents - cogs;
  const next: ValuationState = {
    qty_on_hand,
    total_value_cents,
    avg_cost_cents: qty_on_hand > QTY_EPSILON ? Math.round(total_value_cents / qty_on_hand) : 0,
    // Keep a single synthetic layer so a mixed-history item stays FIFO-switchable.
    fifo_layers: qty_on_hand > QTY_EPSILON ? [{ qty: qty_on_hand, value_cents: total_value_cents }] : [],
  };
  return { state: next, cogs_cents: cogs, unit_cost_cents: qty > 0 ? Math.round(cogs / qty) : 0 };
}

/** Remove `qty` units under FIFO, consuming the oldest layers first. */
function issueFifo(state: ValuationState, qty: number): MovementResult {
  const onHand = state.fifo_layers.reduce((s, l) => s + l.qty, 0);
  const available = Math.max(onHand, state.qty_on_hand);
  if (qty > available + QTY_EPSILON) {
    throw new ValuationError(
      `Cannot issue ${qty}; only ${available} on hand (negative inventory is not allowed).`,
    );
  }

  const layers = state.fifo_layers.map((l) => ({ ...l }));
  let remaining = qty;
  let cogs = 0;
  let i = 0;
  while (remaining > QTY_EPSILON && i < layers.length) {
    const layer = layers[i];
    const take = Math.min(remaining, layer.qty);
    const takesWholeLayer = take >= layer.qty - QTY_EPSILON;
    const layerCogs = takesWholeLayer
      ? layer.value_cents
      : Math.round(layer.value_cents * (take / layer.qty));
    cogs += layerCogs;
    layer.qty -= take;
    layer.value_cents -= layerCogs;
    remaining -= take;
    if (layer.qty <= QTY_EPSILON) i += 1;
  }

  const remainingLayers = layers.filter((l) => l.qty > QTY_EPSILON);
  const qty_on_hand = remainingLayers.reduce((s, l) => s + l.qty, 0);
  const total_value_cents = remainingLayers.reduce((s, l) => s + l.value_cents, 0);
  const next: ValuationState = {
    qty_on_hand,
    total_value_cents,
    avg_cost_cents: qty_on_hand > QTY_EPSILON ? Math.round(total_value_cents / qty_on_hand) : 0,
    fifo_layers: remainingLayers,
  };
  return { state: next, cogs_cents: cogs, unit_cost_cents: qty > 0 ? Math.round(cogs / qty) : 0 };
}

/** ISSUE — remove `qty` units, computing COGS per the item's valuation method. */
export function applyIssue(
  method: ValuationMethod,
  state: ValuationState,
  qty: number,
): MovementResult {
  assertQty(qty, 'issue quantity');
  return method === 'FIFO' ? issueFifo(state, qty) : issueWeightedAvg(state, qty);
}

/**
 * ADJUST — reconcile a physical count / correction. A positive delta behaves like
 * a costed receipt (a `unitCostCents` is required); a negative delta behaves like
 * an issue and realizes COGS (shrinkage). `deltaQty` is the signed change in units.
 */
export function applyAdjust(
  method: ValuationMethod,
  state: ValuationState,
  deltaQty: number,
  unitCostCents?: number,
): MovementResult {
  if (!Number.isFinite(deltaQty) || Math.abs(deltaQty) < QTY_EPSILON) {
    throw new ValuationError(`Adjustment quantity must be a non-zero finite number, got ${deltaQty}`);
  }
  if (deltaQty > 0) {
    if (unitCostCents === undefined) {
      throw new ValuationError('A positive adjustment (write-up) requires unitCostCents.');
    }
    assertMoney(unitCostCents, 'adjustment unit cost');
    return applyReceipt(state, deltaQty, Math.round(unitCostCents * deltaQty));
  }
  // Negative adjustment: remove |deltaQty| like an issue (shrinkage → COGS/expense).
  return applyIssue(method, state, -deltaQty);
}

/** Dispatch a movement to the right primitive. Central entry point for the service. */
export function applyMovement(
  method: ValuationMethod,
  state: ValuationState,
  movement: { type: MovementType; qty: number; totalCostCents?: number; unitCostCents?: number },
): MovementResult {
  switch (movement.type) {
    case 'RECEIPT': {
      if (movement.totalCostCents === undefined) {
        throw new ValuationError('A RECEIPT requires totalCostCents.');
      }
      return applyReceipt(state, movement.qty, movement.totalCostCents);
    }
    case 'ISSUE':
      return applyIssue(method, state, movement.qty);
    case 'ADJUST':
      return applyAdjust(method, state, movement.qty, movement.unitCostCents);
    default: {
      const _never: never = movement.type;
      return _never;
    }
  }
}
