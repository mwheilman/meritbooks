/**
 * Consolidation engine (GATE 11a — the multi-entity moat).
 *
 * A PURE, deterministic function: given per-entity trial balances and the tenant's
 * ownership structure, it produces a CONSOLIDATED trial balance / financial
 * statement. No database, no clock, no randomness — the same inputs always yield
 * the same output, which is why it is unit-tested hard (elimination correctness,
 * NCI math, equity vs full method, single-entity degrade).
 *
 * What "consolidate" means here (canon §5; Master Doc II.4; migration 015/035):
 *
 *   1. FULL consolidation — sum every FULLY-consolidated entity LINE BY LINE at
 *      100% (a subsidiary's assets/liabilities/revenue/expense roll in whole,
 *      regardless of ownership %).
 *
 *   2. Eliminations — net every intercompany / interdepartmental position to zero
 *      so internal activity does not inflate the group. An account is eliminating
 *      when it is flagged `isEliminating` (the interdept Services Revenue/Cost
 *      accounts, migration 015) OR carries an eliminating role (Intercompany
 *      Receivable/Payable, migration 035). Each eliminating account is netted to
 *      zero and the removed amount is surfaced as the explicit "Eliminations"
 *      column an auditor can inspect. Because interco AR (asset) and AP (liability)
 *      eliminate together, and interdept revenue and cost eliminate together, the
 *      balance-sheet identity and the net-income identity both stay intact.
 *
 *   3. Non-controlling interest (NCI) — for a FULL entity the group owns < 100% of,
 *      the minority's share of that subsidiary's equity (balance sheet) and of its
 *      net income (P&L) is carved out and presented separately. The consolidated
 *      statement still shows 100% of the subsidiary; NCI reclassifies the minority
 *      slice within equity / splits net income into parent vs NCI.
 *
 *   4. Equity method — an entity with 20–50% influence is NOT rolled in line by
 *      line. It appears as ONE investment asset (ownership % × the affiliate's
 *      equity) plus one "equity in earnings" income line (ownership % × the
 *      affiliate's net income). NONE-method entities are excluded entirely.
 *
 * All money is bigint cents. Percent math rounds once, to the nearest cent.
 * Sign convention: every balance is its NATURAL balance (positive = the account's
 * normal side): ASSET/COGS/OPEX/OTHER are debit-normal, LIABILITY/EQUITY/REVENUE
 * are credit-normal. OTHER is treated as an expense-side account to match the
 * existing income-statement view (v_income_statement, migration 009).
 */

export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COGS'
  | 'OPEX'
  | 'OTHER';

export type ConsolidationMethod = 'FULL' | 'EQUITY' | 'NONE';

/** Account types booked on the debit side (positive natural balance = a debit). */
export const DEBIT_NORMAL_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'ASSET',
  'COGS',
  'OPEX',
  'OTHER',
]);
/** Account types booked on the credit side (positive natural balance = a credit). */
export const CREDIT_NORMAL_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'LIABILITY',
  'EQUITY',
  'REVENUE',
]);
/** Expense-side income-statement types (net income = REVENUE − these). */
const EXPENSE_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['COGS', 'OPEX', 'OTHER']);

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityMeta {
  entityId: string;
  name: string;
  /** How the group consolidates this entity. Defaults to FULL when absent. */
  method: ConsolidationMethod;
  /**
   * The group's effective ownership of this entity, 0..100. The consolidation
   * root (top parent) is 100. Any entity absent from the structure defaults to 100.
   */
  ownershipPercent: number;
}

export interface EntityAccountBalance {
  entityId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  /** Interdept Services Revenue/Cost accounts flagged for elimination (mig 015). */
  isEliminating: boolean;
  /** Optional account role (e.g. INTERCOMPANY_AR / INTERCOMPANY_AP) — eliminating. */
  role?: string | null;
  /** Net balance in cents, signed to the account's NATURAL (normal) side. */
  naturalBalanceCents: number;
}

export interface ConsolidationInput {
  entities: EntityMeta[];
  balances: EntityAccountBalance[];
  /** Account roles treated as eliminating positions (default: interco AR/AP). */
  eliminatingRoles?: readonly string[];
  /** When false, produce a pre-elimination pass-through (eliminations = 0). */
  eliminate?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsolAccountLine {
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  isEliminating: boolean;
  /** Group total before eliminations (sum across FULL entities, natural sign). */
  grossCents: number;
  /** Removed at consolidation (0 for non-eliminating accounts; ≤0 otherwise). */
  eliminationCents: number;
  /** Net after eliminations (0 for an eliminating account when netting applies). */
  consolidatedCents: number;
  /** Per-entity contribution (entityId → natural cents). */
  byEntity: Record<string, number>;
}

export interface EquityMethodLine {
  entityId: string;
  name: string;
  ownershipPercent: number;
  /** One-line investment carrying value (asset, debit-normal positive). */
  investmentCents: number;
  /** Equity in the affiliate's earnings for the period (positive = income). */
  equityInEarningsCents: number;
}

export interface NciEntityShare {
  entityId: string;
  name: string;
  ownershipPercent: number;
  minorityPercent: number;
  /** Minority share of this subsidiary's period-end equity (credit-normal +). */
  equityCents: number;
  /** Minority share of this subsidiary's net income (positive = income to NCI). */
  netIncomeCents: number;
}

export interface NciResult {
  /** Non-controlling interest presented in equity (credit-normal positive). */
  equityCents: number;
  /** NCI share of consolidated earnings (positive = income attributable to NCI). */
  netIncomeCents: number;
  byEntity: NciEntityShare[];
}

export interface ConsolidationTotals {
  /** Total of the eliminations column (≤ 0). */
  eliminationsCents: number;
  /** Post-elimination sum of every eliminating account — must be exactly 0. */
  eliminatingResidualCents: number;
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  otherCents: number;
  /** Net income of the FULL group (post-elim, 100% of every full entity). */
  netIncomeFullCents: number;
  /** Total consolidated net income (FULL group + equity-method pickups). */
  netIncomeCents: number;
  netIncomeParentCents: number;
  netIncomeNciCents: number;
  /** Consolidated balance-sheet subtotals (FULL entities, post-elim). */
  assetsCents: number;
  liabilitiesCents: number;
  /** Booked equity accounts (excludes current-period earnings). */
  equityBookedCents: number;
  /** Equity section total = booked equity + FULL net income (ties the BS). */
  equitySectionCents: number;
  /** assets − (liabilities + equity section); 0 when every entity TB balances. */
  balanceCheckCents: number;
}

export interface ConsolidationResult {
  accounts: ConsolAccountLine[];
  equityMethod: EquityMethodLine[];
  nci: NciResult;
  totals: ConsolidationTotals;
  entitiesFull: string[];
  entitiesEquityMethod: string[];
  entitiesExcluded: string[];
  eliminationsApplied: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for direct unit testing)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ELIMINATING_ROLES: readonly string[] = ['INTERCOMPANY_AR', 'INTERCOMPANY_AP'];

/** An account is eliminating if flagged OR it carries an eliminating role. */
export function isEliminatingAccount(
  b: Pick<EntityAccountBalance, 'isEliminating' | 'role'>,
  eliminatingRoles: ReadonlySet<string>,
): boolean {
  return Boolean(b.isEliminating) || (b.role != null && eliminatingRoles.has(b.role));
}

/** A single entity's standalone net income (REVENUE − COGS/OPEX/OTHER), cents. */
export function entityNetIncomeCents(balances: EntityAccountBalance[], entityId: string): number {
  let revenue = 0;
  let expense = 0;
  for (const b of balances) {
    if (b.entityId !== entityId) continue;
    if (b.accountType === 'REVENUE') revenue += b.naturalBalanceCents;
    else if (EXPENSE_TYPES.has(b.accountType)) expense += b.naturalBalanceCents;
  }
  return revenue - expense;
}

/** A single entity's booked equity (EQUITY accounts, credit-normal), cents. */
export function entityBookedEquityCents(balances: EntityAccountBalance[], entityId: string): number {
  let equity = 0;
  for (const b of balances) {
    if (b.entityId === entityId && b.accountType === 'EQUITY') equity += b.naturalBalanceCents;
  }
  return equity;
}

/**
 * A subsidiary's ECONOMIC period-end equity for NCI / equity-method purposes:
 * booked equity + current-period net income (the earnings not yet closed to
 * retained earnings on a pre-close trial balance).
 */
export function entityPeriodEndEquityCents(
  balances: EntityAccountBalance[],
  entityId: string,
): number {
  return entityBookedEquityCents(balances, entityId) + entityNetIncomeCents(balances, entityId);
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consolidate per-entity trial balances into a group statement. Deterministic and
 * side-effect free. Any entity that appears in `balances` but not in `entities`
 * (or with no ownership row) is treated as FULL at 100% — the single-entity /
 * pre-structure degrade path, so a lone company consolidates to itself.
 */
export function consolidate(input: ConsolidationInput): ConsolidationResult {
  const eliminate = input.eliminate !== false; // default true
  const eliminatingRoles = new Set<string>(input.eliminatingRoles ?? DEFAULT_ELIMINATING_ROLES);

  // --- Resolve method + ownership per entity (default FULL / 100%). ------------
  const metaById = new Map<string, EntityMeta>();
  for (const e of input.entities) metaById.set(e.entityId, e);
  const resolveMeta = (entityId: string, name?: string): EntityMeta =>
    metaById.get(entityId) ?? {
      entityId,
      name: name ?? entityId,
      method: 'FULL',
      ownershipPercent: 100,
    };

  // Every entity that actually has balances (so a listed-but-empty NONE entity
  // still classifies, but the roll-up only touches entities with data).
  const entityIds = new Set<string>();
  for (const b of input.balances) entityIds.add(b.entityId);
  for (const e of input.entities) entityIds.add(e.entityId);

  const entitiesFull: string[] = [];
  const entitiesEquityMethod: string[] = [];
  const entitiesExcluded: string[] = [];
  for (const id of entityIds) {
    const m = resolveMeta(id);
    if (m.method === 'EQUITY') entitiesEquityMethod.push(id);
    else if (m.method === 'NONE') entitiesExcluded.push(id);
    else entitiesFull.push(id);
  }
  const fullSet = new Set(entitiesFull);

  // --- 1 + 2: FULL consolidation, line by line, with eliminations. ------------
  const lineByAccount = new Map<string, ConsolAccountLine>();
  for (const b of input.balances) {
    if (!fullSet.has(b.entityId)) continue;
    const key = b.accountNumber;
    const elim = isEliminatingAccount(b, eliminatingRoles);
    let line = lineByAccount.get(key);
    if (!line) {
      line = {
        accountNumber: b.accountNumber,
        accountName: b.accountName,
        accountType: b.accountType,
        isEliminating: elim,
        grossCents: 0,
        eliminationCents: 0,
        consolidatedCents: 0,
        byEntity: {},
      };
      lineByAccount.set(key, line);
    }
    // If ANY contributing line is eliminating, the account eliminates.
    line.isEliminating = line.isEliminating || elim;
    line.grossCents += b.naturalBalanceCents;
    line.byEntity[b.entityId] = (line.byEntity[b.entityId] ?? 0) + b.naturalBalanceCents;
  }

  let eliminationsCents = 0;
  const accounts: ConsolAccountLine[] = [];
  for (const line of lineByAccount.values()) {
    line.eliminationCents = eliminate && line.isEliminating ? -line.grossCents : 0;
    line.consolidatedCents = line.grossCents + line.eliminationCents;
    eliminationsCents += line.eliminationCents;
    accounts.push(line);
  }
  accounts.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  const eliminatingResidualCents = accounts
    .filter((a) => a.isEliminating)
    .reduce((s, a) => s + a.consolidatedCents, 0);

  // --- Post-elimination statement subtotals (FULL group). ---------------------
  let revenueCents = 0;
  let cogsCents = 0;
  let opexCents = 0;
  let otherCents = 0;
  let assetsCents = 0;
  let liabilitiesCents = 0;
  let equityBookedCents = 0;
  for (const a of accounts) {
    switch (a.accountType) {
      case 'REVENUE':
        revenueCents += a.consolidatedCents;
        break;
      case 'COGS':
        cogsCents += a.consolidatedCents;
        break;
      case 'OPEX':
        opexCents += a.consolidatedCents;
        break;
      case 'OTHER':
        otherCents += a.consolidatedCents;
        break;
      case 'ASSET':
        assetsCents += a.consolidatedCents;
        break;
      case 'LIABILITY':
        liabilitiesCents += a.consolidatedCents;
        break;
      case 'EQUITY':
        equityBookedCents += a.consolidatedCents;
        break;
    }
  }
  const netIncomeFullCents = revenueCents - (cogsCents + opexCents + otherCents);
  const equitySectionCents = equityBookedCents + netIncomeFullCents;
  const balanceCheckCents = assetsCents - (liabilitiesCents + equitySectionCents);

  // --- 3: Non-controlling interest (minority share of FULL subsidiaries). -----
  const nciByEntity: NciEntityShare[] = [];
  let nciEquityCents = 0;
  let nciNetIncomeCents = 0;
  for (const id of entitiesFull) {
    const m = resolveMeta(id);
    const own = clampPercent(m.ownershipPercent);
    if (own >= 100) continue; // wholly owned → no minority
    const minority = (100 - own) / 100;
    const subNi = entityNetIncomeCents(input.balances, id);
    const subEquity = entityPeriodEndEquityCents(input.balances, id);
    const equityShare = Math.round(minority * subEquity);
    const niShare = Math.round(minority * subNi);
    nciEquityCents += equityShare;
    nciNetIncomeCents += niShare;
    nciByEntity.push({
      entityId: id,
      name: m.name,
      ownershipPercent: own,
      minorityPercent: Math.round(minority * 1000000) / 10000, // percent, 4dp
      equityCents: equityShare,
      netIncomeCents: niShare,
    });
  }

  // --- 4: Equity-method one-line investment + equity in earnings. -------------
  const equityMethod: EquityMethodLine[] = [];
  let equityInEarningsTotalCents = 0;
  for (const id of entitiesEquityMethod) {
    const m = resolveMeta(id);
    const own = clampPercent(m.ownershipPercent) / 100;
    const affiliateNi = entityNetIncomeCents(input.balances, id);
    const affiliateEquity = entityPeriodEndEquityCents(input.balances, id);
    const investmentCents = Math.round(own * affiliateEquity);
    const equityInEarningsCents = Math.round(own * affiliateNi);
    equityInEarningsTotalCents += equityInEarningsCents;
    equityMethod.push({
      entityId: id,
      name: m.name,
      ownershipPercent: clampPercent(m.ownershipPercent),
      investmentCents,
      equityInEarningsCents,
    });
  }
  equityMethod.sort((a, b) => a.name.localeCompare(b.name));

  // --- Net income split. Total = FULL group + equity pickups; NCI is a carve. -
  const netIncomeCents = netIncomeFullCents + equityInEarningsTotalCents;
  const netIncomeNciCents = nciNetIncomeCents;
  const netIncomeParentCents = netIncomeCents - netIncomeNciCents;

  return {
    accounts,
    equityMethod,
    nci: {
      equityCents: nciEquityCents,
      netIncomeCents: nciNetIncomeCents,
      byEntity: nciByEntity.sort((a, b) => a.name.localeCompare(b.name)),
    },
    totals: {
      eliminationsCents,
      eliminatingResidualCents,
      revenueCents,
      cogsCents,
      opexCents,
      otherCents,
      netIncomeFullCents,
      netIncomeCents,
      netIncomeParentCents,
      netIncomeNciCents,
      assetsCents,
      liabilitiesCents,
      equityBookedCents,
      equitySectionCents,
      balanceCheckCents,
    },
    entitiesFull,
    entitiesEquityMethod,
    entitiesExcluded,
    eliminationsApplied: eliminate,
  };
}

/** Clamp a percent into [0, 100]; non-finite → 100 (safe default = wholly owned). */
function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 100;
  return Math.max(0, Math.min(100, pct));
}
