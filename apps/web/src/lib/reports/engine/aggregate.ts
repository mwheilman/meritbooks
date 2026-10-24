/**
 * Aggregation core (pure): turns the store rows the adapter loaded into per-account
 * DEBIT-POSITIVE maps for any (range × companies × dimension × entry kinds) cell, plus
 * budget / forecast / basis / consolidation maps. No I/O, no clock.
 */
import { consolidate, type EntityAccountBalance, type EntityMeta } from '@/lib/consolidation/consolidate';
import { addDays, fiscalYearStart, isMonthAligned, monthStart, monthsIn, rangeKey } from './periods';
import { SYNTH_NI_CURRENT, SYNTH_RE_PRIOR, isPnlAccount, inRange } from './layout';
import type {
  AccountMeta,
  BalanceRow,
  BasisDelta,
  DateRange,
  DimensionKey,
  EngineData,
  EntryKind,
  GroupWindow,
  ReportFilters,
} from './types';

export type AccountMap = Map<string, number>;

export const ALL_KINDS: EntryKind[] = ['STANDARD', 'ADJUSTING', 'CLOSING'];
/** P&L activity excludes year-end CLOSING entries (they zero the P&L into retained earnings). */
export const PNL_KINDS: EntryKind[] = ['STANDARD', 'ADJUSTING'];

export interface CellSpec {
  range: DateRange;
  companyIds: string[];
  /** dimension split value: null = Unassigned */
  dim?: { key: DimensionKey; value: string | null } | null;
  kinds: EntryKind[];
  /** read every company regardless of its in-group window (boundary balances) */
  ignoreWindows?: boolean;
}

export class MissingBalancesError extends Error {}

/** Key for range-specific inputs the adapter computes per cell (live CASH basis deltas). */
export function basisKey(range: DateRange, companyIds: string[]): string {
  return `${rangeKey(range)}|${[...companyIds].sort().join(',')}`;
}

export class Ledger {
  readonly accounts: Map<string, AccountMeta>;
  private readonly byPeriod = new Map<string | null, BalanceRow[]>();
  private readonly periods: string[];
  private readonly exact = new Map<string, BalanceRow[]>();
  private readonly allowedAccounts: Set<string> | null;
  private readonly filters: ReportFilters;
  private readonly cache = new Map<string, { net: AccountMap; dr: AccountMap; cr: AccountMap }>();
  private readonly windows: Record<string, GroupWindow> | null;

  /**
   * `windows` = in-group windows to apply (pre-acquisition exclusion). Flow cells keep a
   * company's rows only for months inside its window; point-in-time cells keep a company
   * (its whole history) only when the as-of month is inside its window.
   */
  constructor(private readonly data: EngineData, filters: ReportFilters = {}, windows?: Record<string, GroupWindow> | null) {
    const w = windows ?? null;
    this.windows = w && Object.keys(w).length > 0 ? w : null;
    this.accounts = new Map(data.accounts.map((a) => [a.id, a]));
    for (const r of data.balances) {
      const list = this.byPeriod.get(r.period) ?? [];
      list.push(r);
      this.byPeriod.set(r.period, list);
    }
    this.periods = [...this.byPeriod.keys()].filter((p): p is string => p !== null).sort();
    for (const [k, rows] of Object.entries(data.exactBalances ?? {})) this.exact.set(k, rows);
    this.filters = filters;
    const hasAcctFilter = (filters.accountIds?.length ?? 0) > 0 || (filters.accountRanges?.length ?? 0) > 0;
    this.allowedAccounts = hasAcctFilter
      ? new Set(
          data.accounts
            .filter(
              (a) =>
                (filters.accountIds?.includes(a.id) ?? false) ||
                (filters.accountRanges ?? []).some((rg) => inRange(a.number, rg.from, rg.to)),
            )
            .map((a) => a.id),
        )
      : null;
  }

  get hasWindows(): boolean {
    return this.windows !== null;
  }

  windowOf(companyId: string): GroupWindow | null {
    return this.windows?.[companyId] ?? null;
  }

  /** Is the company in the group in this month ('YYYY-MM-01')? */
  inGroup(companyId: string, month: string): boolean {
    const w = this.windows?.[companyId];
    if (!w) return true;
    if (w.from && month < w.from) return false;
    if (w.until && month > w.until) return false;
    return true;
  }

  /** Window test for one store row inside a cell's range. */
  admits(row: BalanceRow, range: DateRange): boolean {
    if (!this.windows) return true;
    if (range.start === null) return this.inGroup(row.companyId, monthStart(range.end));
    return this.inGroup(row.companyId, row.period ?? monthStart(range.start));
  }

  get hasAccountFilter(): boolean {
    return this.allowedAccounts !== null;
  }

  get hasDimensionFilter(): boolean {
    const f = this.filters;
    return !!(f.departmentIds?.length || f.classIds?.length || f.jobIds?.length || f.itemIds?.length);
  }

  /** The store rows a range needs (exact set when the range cuts a month). */
  rowsFor(r: DateRange): BalanceRow[] {
    const ex = this.exact.get(rangeKey(r));
    if (ex) return ex;
    if (!isMonthAligned(r)) throw new MissingBalancesError(`engine: no exact balances loaded for ${rangeKey(r)}`);
    const out: BalanceRow[] = [];
    if (r.start === null) {
      for (const row of this.byPeriod.get(null) ?? []) out.push(row);
    }
    for (const p of this.periods) {
      if (p > r.end) break;
      if (r.start !== null && p < r.start) continue;
      for (const row of this.byPeriod.get(p) ?? []) out.push(row);
    }
    return out;
  }

  private passes(row: BalanceRow, spec: CellSpec): boolean {
    if (!spec.kinds.includes(row.kind)) return false;
    if (spec.companyIds.length > 0 && !spec.companyIds.includes(row.companyId)) return false;
    if (!spec.ignoreWindows && !this.admits(row, spec.range)) return false;
    if (this.allowedAccounts && !this.allowedAccounts.has(row.accountId)) return false;
    const f = this.filters;
    if (f.departmentIds?.length && !f.departmentIds.includes(row.departmentId ?? '')) return false;
    if (f.classIds?.length && !f.classIds.includes(row.classId ?? '')) return false;
    if (f.jobIds?.length && !f.jobIds.includes(row.jobId ?? '')) return false;
    if (f.itemIds?.length && !f.itemIds.includes(row.itemId ?? '')) return false;
    if (spec.dim) {
      const v = dimValue(row, spec.dim.key);
      if ((spec.dim.value ?? null) !== (v ?? null)) return false;
    }
    return true;
  }

  private specKey(spec: CellSpec): string {
    return `${rangeKey(spec.range)}|${[...spec.companyIds].sort().join(',')}|${spec.dim ? `${spec.dim.key}=${spec.dim.value ?? 'null'}` : ''}|${spec.kinds.join(',')}|${spec.ignoreWindows ? 'all' : ''}`;
  }

  /** Σ debit / credit / net per account for one cell. */
  sums(spec: CellSpec): { net: AccountMap; dr: AccountMap; cr: AccountMap } {
    const key = this.specKey(spec);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const net: AccountMap = new Map();
    const dr: AccountMap = new Map();
    const cr: AccountMap = new Map();
    for (const row of this.rowsFor(spec.range)) {
      if (!this.passes(row, spec)) continue;
      net.set(row.accountId, (net.get(row.accountId) ?? 0) + row.debit - row.credit);
      dr.set(row.accountId, (dr.get(row.accountId) ?? 0) + row.debit);
      cr.set(row.accountId, (cr.get(row.accountId) ?? 0) + row.credit);
    }
    const out = { net, dr, cr };
    this.cache.set(key, out);
    return out;
  }

  net(spec: CellSpec): AccountMap {
    return this.sums(spec).net;
  }

  /**
   * Balance-sheet cell as of range.end: every account cumulative (all entry kinds) plus the two
   * synthetic equity rows — P&L before the fiscal-year start (prior earnings not yet closed)
   * and P&L from the fiscal-year start (current-year net income). Closing entries are
   * included, so a closed year nets to zero here and sits in retained earnings instead.
   * A company that joined the group during the fiscal year carries its pre-joining P&L in
   * the prior bucket (equity it brought in), so current-year net income = the group's P&L.
   */
  balanceSheet(spec: Omit<CellSpec, 'kinds'>, fyStartMonth: number): AccountMap {
    const asOf: DateRange = { start: null, end: spec.range.end };
    const fyStart = fiscalYearStart(spec.range.end, fyStartMonth);
    const out: AccountMap = new Map();
    let prior = 0;
    let current = 0;
    for (const row of this.rowsFor(asOf)) {
      if (!this.passes(row, { ...spec, range: asOf, kinds: ALL_KINDS })) continue;
      const a = this.accounts.get(row.accountId);
      const v = row.debit - row.credit;
      if (a && isPnlAccount(a)) {
        const joined = this.windows?.[row.companyId]?.from ?? null;
        if (row.period !== null && row.period >= fyStart && !(joined && row.period < joined)) current += v;
        else prior += v;
      }
      out.set(row.accountId, (out.get(row.accountId) ?? 0) + v);
    }
    out.set(SYNTH_RE_PRIOR, prior);
    out.set(SYNTH_NI_CURRENT, current);
    return out;
  }

  /**
   * Balances companies bring into (+) or take out of (−) the group inside a flow range: for
   * every month m of the range where a company's membership changes, its full point-in-time
   * balance at the end of the month before m (debit-positive, per account). Statements add
   * this so beginning + activity + joining/leaving = ending.
   */
  groupBoundary(spec: CellSpec): AccountMap {
    const out: AccountMap = new Map();
    if (!this.windows || spec.range.start === null) return out;
    const ids = spec.companyIds.length ? spec.companyIds : this.data.companyIds;
    const months = monthsIn({ start: spec.range.start, end: spec.range.end });
    for (const id of ids) {
      if (!this.windows[id]) continue;
      for (const m of months) {
        const prevEnd = addDays(m, -1);
        const before = this.inGroup(id, monthStart(prevEnd));
        const now = this.inGroup(id, m);
        if (before === now) continue;
        const bal = this.net({ ...spec, range: { start: null, end: prevEnd }, companyIds: [id], kinds: ALL_KINDS, ignoreWindows: true });
        addInto(out, bal, now ? 1 : -1);
      }
    }
    return out;
  }
}

export function dimValue(row: BalanceRow, key: DimensionKey): string | null {
  switch (key) {
    case 'department': return row.departmentId;
    case 'class': return row.classId;
    case 'job': return row.jobId;
    case 'item': return row.itemId;
  }
}

/** natural (normal-balance-positive) → debit-positive */
export function naturalToDebit(a: Pick<AccountMeta, 'normalBalance'> | undefined, naturalCents: number): number {
  return a?.normalBalance === 'CREDIT' ? -naturalCents : naturalCents;
}

export function addInto(target: AccountMap, src: AccountMap, sign = 1): AccountMap {
  for (const [k, v] of src) target.set(k, (target.get(k) ?? 0) + sign * v);
  return target;
}

export function sumMaps(maps: AccountMap[]): AccountMap {
  const out: AccountMap = new Map();
  for (const m of maps) addInto(out, m);
  return out;
}

/** Budget map (debit-positive) for the months a range covers. Department split only. */
export function budgetMap(
  data: EngineData,
  spec: CellSpec,
  accounts: Map<string, AccountMeta>,
  filters: ReportFilters,
  inGroup?: (companyId: string, month: string) => boolean,
): AccountMap | null {
  if (spec.dim && spec.dim.key !== 'department') return null;
  if (filters.classIds?.length || filters.jobIds?.length || filters.itemIds?.length) return null;
  if (spec.range.start === null) return null;
  const months = new Set(monthsIn({ start: spec.range.start, end: spec.range.end }));
  const out: AccountMap = new Map();
  for (const b of data.budgets) {
    if (!months.has(b.period)) continue;
    if (spec.companyIds.length && !spec.companyIds.includes(b.companyId)) continue;
    if (inGroup && !inGroup(b.companyId, b.period)) continue;
    if (spec.dim?.key === 'department' && (spec.dim.value ?? null) !== (b.departmentId ?? null)) continue;
    if (filters.departmentIds?.length && !filters.departmentIds.includes(b.departmentId ?? '')) continue;
    if (filters.accountIds?.length && !filters.accountIds.includes(b.accountId)) continue;
    const a = accounts.get(b.accountId);
    out.set(b.accountId, (out.get(b.accountId) ?? 0) + naturalToDebit(a, b.naturalCents));
  }
  return out;
}

/** Is every month of the range closed (soft or hard) for every company? */
export function monthClosed(data: EngineData, month: string, companyIds: string[]): boolean {
  const ids = companyIds.length ? companyIds : data.companyIds;
  if (ids.length === 0) return false;
  return ids.every((c) =>
    data.periodStatus.some((p) => p.companyId === c && p.period === month && (p.status === 'HARD_CLOSE' || p.status === 'SOFT_CLOSE')),
  );
}

/** The month sub-ranges of a range (clipped at both ends). */
export function monthSlices(r: { start: string; end: string }): DateRange[] {
  return monthsIn(r).map((m) => {
    const end = addDays(monthStart(addMonthsSafe(m, 1)), -1);
    return { start: m < r.start ? r.start : m, end: end > r.end ? r.end : end };
  });
}

function addMonthsSafe(m: string, n: number): string {
  const [y, mo] = m.split('-').map(Number);
  const idx = y * 12 + (mo - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

/** Latest estimate: closed months = actual, open months = budget (budget_remaining method). */
export function forecastMap(
  data: EngineData,
  ledger: Ledger,
  spec: CellSpec,
  filters: ReportFilters,
): AccountMap | null {
  if (spec.range.start === null) return null;
  const out: AccountMap = new Map();
  let any = false;
  for (const slice of monthSlices({ start: spec.range.start, end: spec.range.end })) {
    const month = monthStart(slice.end);
    if (monthClosed(data, month, spec.companyIds)) {
      addInto(out, ledger.net({ ...spec, range: slice }));
      any = true;
    } else {
      const b = budgetMap(data, { ...spec, range: { start: month, end: slice.end } }, ledger.accounts, filters, (id, mo) => ledger.inGroup(id, mo));
      if (b) {
        addInto(out, b);
        any = true;
      }
    }
  }
  return any ? out : null;
}

/** TAX / CUSTOM basis overlay for one cell (stored month-tagged natural deltas). */
export function storedBasisOverlay(
  deltas: BasisDelta[],
  spec: CellSpec,
  allCompanies: string[],
  accounts: Map<string, AccountMeta>,
  pointInTime: boolean,
): AccountMap {
  const out: AccountMap = new Map();
  const coversAll = spec.companyIds.length === 0 || allCompanies.every((c) => spec.companyIds.includes(c));
  for (const d of deltas) {
    if (d.companyId === null ? !coversAll : spec.companyIds.length > 0 && !spec.companyIds.includes(d.companyId)) continue;
    if (d.period > spec.range.end) continue;
    if (!pointInTime && spec.range.start !== null && d.period < monthStart(spec.range.start)) continue;
    out.set(d.accountId, (out.get(d.accountId) ?? 0) + naturalToDebit(accounts.get(d.accountId), d.naturalCents));
  }
  return out;
}

// ─── consolidation bridge ───────────────────────────────────────────────────

const CREDIT_NATURAL = new Set(['LIABILITY', 'EQUITY', 'REVENUE']);
const IC_ROLES = ['INTERCOMPANY_AR', 'INTERCOMPANY_AP'];

/** consolidate.ts sign convention (OTHER is debit-natural there). */
function toConsolNatural(type: string, debitPositive: number): number {
  return CREDIT_NATURAL.has(type) ? -debitPositive : debitPositive;
}

export interface EliminationResult {
  /** debit-positive elimination per account (sums with Combined to Consolidated) */
  eliminations: AccountMap;
  fullEntityIds: string[];
  nonFullEntityIds: string[];
  residualCents: number;
  nciEquityCents: number;
  nciNetIncomeCents: number;
}

/**
 * Run the GATE 11a pure engine over per-company, per-counterparty balances for one cell and
 * return the eliminations as an explicit account map. `perCompany` must already be split by
 * counterparty for intercompany-role accounts (rows carry counterpartyId).
 */
export function eliminationsFor(
  rows: Array<{ companyId: string; accountId: string; counterpartyId: string | null; debitPositive: number }>,
  accounts: Map<string, AccountMeta>,
  entities: Array<{ id: string; name: string }>,
  ownership: EngineData['ownership'],
): EliminationResult {
  const meta: EntityMeta[] = entities.map((e) => {
    const o = ownership.find((x) => x.entityId === e.id);
    return { entityId: e.id, name: e.name, method: o?.method ?? 'FULL', ownershipPercent: o?.ownershipPercent ?? 100 };
  });
  const balances: EntityAccountBalance[] = [];
  const idByNumber = new Map<string, string>();
  for (const r of rows) {
    const a = accounts.get(r.accountId);
    if (!a || a.id.startsWith('__')) continue;
    idByNumber.set(a.number, a.id);
    balances.push({
      entityId: r.companyId,
      accountNumber: a.number,
      accountName: a.name,
      accountType: a.type,
      isEliminating: a.isEliminating,
      role: a.roles.find((x) => IC_ROLES.includes(x)) ?? null,
      naturalBalanceCents: toConsolNatural(a.type, r.debitPositive),
      counterpartyEntityId: r.counterpartyId,
    });
  }
  const res = consolidate({ entities: meta, balances });
  const eliminations: AccountMap = new Map();
  for (const line of res.accounts) {
    if (line.eliminationCents === 0) continue;
    const id = idByNumber.get(line.accountNumber);
    if (!id) continue;
    const a = accounts.get(id)!;
    eliminations.set(id, CREDIT_NATURAL.has(a.type) ? -line.eliminationCents : line.eliminationCents);
  }
  return {
    eliminations,
    fullEntityIds: res.entitiesFull,
    nonFullEntityIds: [...res.entitiesEquityMethod, ...res.entitiesExcluded],
    residualCents: res.totals.eliminatingResidualCents,
    nciEquityCents: res.nci.equityCents,
    nciNetIncomeCents: res.nci.netIncomeCents,
  };
}

/** Per company × account × counterparty debit-positive rows for one cell (consolidation input). */
export function counterpartyRows(
  ledger: Ledger,
  spec: CellSpec,
  pointInTime: boolean,
): Array<{ companyId: string; accountId: string; counterpartyId: string | null; debitPositive: number }> {
  const range: DateRange = pointInTime ? { start: null, end: spec.range.end } : spec.range;
  const kinds = pointInTime ? ALL_KINDS : spec.kinds;
  const acc = new Map<string, { companyId: string; accountId: string; counterpartyId: string | null; debitPositive: number }>();
  for (const row of ledger.rowsFor(range)) {
    if (!kinds.includes(row.kind)) continue;
    if (spec.companyIds.length && !spec.companyIds.includes(row.companyId)) continue;
    if (!ledger.admits(row, range)) continue;
    const key = `${row.companyId}|${row.accountId}|${row.counterpartyId ?? ''}`;
    const cur = acc.get(key) ?? { companyId: row.companyId, accountId: row.accountId, counterpartyId: row.counterpartyId, debitPositive: 0 };
    cur.debitPositive += row.debit - row.credit;
    acc.set(key, cur);
  }
  return [...acc.values()];
}
