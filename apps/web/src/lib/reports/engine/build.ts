/**
 * Statement builder (pure): fills a Plan's columns from the Ledger and renders the rows
 * of every core statement — layout statements (income statement, balance sheet, any
 * custom layout), cash flow (indirect, any set of companies), statement of changes in
 * equity, trial balance worksheet and GL summary. Deterministic: same inputs → same output.
 */
import {
  ALL_KINDS,
  Ledger,
  PNL_KINDS,
  addInto,
  basisKey,
  budgetMap,
  counterpartyRows,
  eliminationsFor,
  forecastMap,
  naturalToDebit,
  storedBasisOverlay,
  sumMaps,
  type AccountMap,
  type CellSpec,
} from './aggregate';
import {
  SYNTH_NI_CURRENT,
  SYNTH_RE_PRIOR,
  builtinLayout,
  evaluationOrder,
  evalFormula,
  fromCustom,
  isPnlAccount,
  matchesSelector,
  parseFormula,
  type Layout,
  type LayoutRow,
} from './layout';
import { addDays, fiscalYearStart, monthStart, monthsIn, rangeLabel, shortDate } from './periods';
import type { Plan, PlannedColumn } from './plan';
import type {
  AccountMeta,
  DateRange,
  DrillScope,
  EngineData,
  ReportColumn,
  ReportRequest,
  ReportResult,
  ReportRow,
  ReportWarning,
  CashFlowCategory,
} from './types';

const TITLES: Record<ReportRequest['statement'], string> = {
  income_statement: 'Income statement',
  balance_sheet: 'Balance sheet',
  cash_flow: 'Statement of cash flows',
  equity_changes: 'Statement of changes in equity',
  trial_balance: 'Trial balance',
  gl_summary: 'General ledger summary',
};

export const PRIOR_RE_LABEL = 'Retained earnings — prior years (not yet closed)';
export const CY_NI_LABEL = 'Net income (current year)';

function syntheticAccounts(): AccountMeta[] {
  const base = {
    type: 'EQUITY' as const,
    subType: 'EQUITY',
    subTypeName: 'Equity',
    subTypeOrder: 999,
    groupId: '__earnings',
    groupName: 'Earnings not yet closed',
    groupOrder: 999,
    normalBalance: 'CREDIT' as const,
    isBank: false,
    isEliminating: false,
    isActive: true,
    roles: [],
    cashFlowCategory: null,
  };
  return [
    { ...base, id: SYNTH_RE_PRIOR, number: '', name: PRIOR_RE_LABEL, order: 100000 },
    { ...base, id: SYNTH_NI_CURRENT, number: '', name: CY_NI_LABEL, order: 100001 },
  ];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function basisLabel(req: Pick<ReportRequest, 'basis' | 'customBasisLabel'>): string {
  switch (req.basis) {
    case 'CASH': return 'Cash basis';
    case 'TAX': return 'Tax basis';
    case 'CUSTOM': return req.customBasisLabel ? `${req.customBasisLabel} basis` : 'Custom basis';
    default: return 'Accrual basis';
  }
}

function accountSort(a: AccountMeta, b: AccountMeta): number {
  return (
    a.subTypeOrder - b.subTypeOrder ||
    a.groupOrder - b.groupOrder ||
    a.order - b.order ||
    a.number.localeCompare(b.number, undefined, { numeric: true }) ||
    a.name.localeCompare(b.name)
  );
}

interface Ctx {
  req: ReportRequest;
  plan: Plan;
  data: EngineData;
  ledger: Ledger;
  warnings: ReportWarning[];
  notes: string[];
  accounts: Map<string, AccountMeta>;
}

// ─── amount maps per column ──────────────────────────────────────────────────

function columnMaps(c: Ctx): Map<string, AccountMap | null> {
  const { plan, data, ledger, req } = c;
  const maps = new Map<string, AccountMap | null>();
  const amountCols = plan.columns.filter((col) => col.cell);
  const actual = (cell: CellSpec): AccountMap => {
    const m = plan.pointInTime ? ledger.balanceSheet(cell, plan.fyStartMonth) : ledger.net(cell);
    return applyBasis(c, cell, new Map(m));
  };
  let basisWarned = false;
  for (const col of amountCols) {
    if (col.role === 'elimination' || col.role === 'consolidated' || col.role === 'combined') continue;
    const cell = col.cell!;
    if (col.source === 'budget') {
      const m = budgetMap(data, cell, c.accounts, req.filters ?? {}, (id, mo) => ledger.inGroup(id, mo));
      if (m && m.size === 0 && !c.warnings.some((w) => w.code === 'NO_BUDGET')) {
        c.warnings.push({ code: 'NO_BUDGET', message: 'No budget is loaded for this period — the budget column is empty.' });
      }
      maps.set(col.id, m);
    } else if (col.source === 'forecast') {
      maps.set(col.id, forecastMap(data, ledger, cell, req.filters ?? {}));
    } else {
      maps.set(col.id, actual(cell));
    }
    if (cell.dim && req.basis !== 'ACCRUAL' && !basisWarned) {
      basisWarned = true;
      c.warnings.push({ code: 'BASIS_LIMITED', message: `${basisLabel(req)} adjustments carry no dimensions, so dimension columns show accrual figures; the Total column is on ${basisLabel(req).toLowerCase()}.` });
    }
  }
  // consolidation: combined (FULL entities) → eliminations → consolidated
  const elimCol = amountCols.find((x) => x.role === 'elimination');
  if (elimCol) {
    const cell = elimCol.cell!;
    const rows = counterpartyRows(ledger, cell, plan.pointInTime);
    const entities = data.companies.filter((x) => cell.companyIds.includes(x.id)).map((x) => ({ id: x.id, name: x.name }));
    const res = eliminationsFor(rows, c.accounts, entities, data.ownership);
    const full = res.fullEntityIds.length ? res.fullEntityIds : cell.companyIds;
    const combined = sumMaps(amountCols.filter((x) => x.role === 'base' && x.cell && full.includes(x.cell.companyIds[0])).map((x) => maps.get(x.id) ?? new Map()));
    const elim = new Map(res.eliminations);
    const consol = addInto(new Map(combined), elim);
    for (const col of amountCols) {
      if (col.role === 'combined') maps.set(col.id, combined);
      if (col.role === 'elimination') maps.set(col.id, elim);
      if (col.role === 'consolidated') maps.set(col.id, consol);
    }
    if (res.nonFullEntityIds.length) {
      const names = data.companies.filter((x) => res.nonFullEntityIds.includes(x.id)).map((x) => x.name);
      c.warnings.push({ code: 'NON_FULL_ENTITIES', message: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not fully consolidated (equity method / excluded) and ${names.length === 1 ? 'is' : 'are'} left out of Combined and Consolidated.` });
    }
    if (res.residualCents !== 0) {
      c.warnings.push({ code: 'ELIMINATION_RESIDUAL', message: 'Intercompany balances do not offset — reconcile the intercompany pair before relying on the consolidated figures.', amountCents: res.residualCents });
    }
    if (res.nciEquityCents !== 0 || res.nciNetIncomeCents !== 0) {
      c.notes.push(`Non-controlling interest: equity ${res.nciEquityCents} cents, share of net income ${res.nciNetIncomeCents} cents (included in the consolidated figures; attributable to minority holders).`);
    }
    c.notes.push('Consolidated = Combined + Eliminations. Eliminations net intercompany receivables/payables (counterparty inside the group) and interdepartment revenue/cost to zero.');
  } else if (plan.consolidated) {
    // consolidated figures in a non-company column layout: eliminate inside every actual cell
    for (const col of amountCols) {
      if (col.source !== 'actual' || !col.cell) continue;
      const rows = counterpartyRows(ledger, col.cell, plan.pointInTime);
      const entities = data.companies.filter((x) => col.cell!.companyIds.includes(x.id)).map((x) => ({ id: x.id, name: x.name }));
      const res = eliminationsFor(rows, c.accounts, entities, data.ownership);
      maps.set(col.id, addInto(new Map(maps.get(col.id) ?? new Map()), res.eliminations));
    }
    c.notes.push('Figures are consolidated: intercompany and interdepartment balances are eliminated.');
  }
  return maps;
}

function applyBasis(c: Ctx, cell: CellSpec, m: AccountMap): AccountMap {
  const { req, data, plan } = c;
  if (req.basis === 'ACCRUAL' || cell.dim) return m;
  if (req.basis === 'CASH') {
    if (plan.pointInTime) {
      if (!c.warnings.some((w) => w.code === 'BASIS_LIMITED')) {
        c.warnings.push({ code: 'BASIS_LIMITED', message: 'A cash-basis balance sheet is not derived automatically; this statement is shown on the accrual basis.' });
      }
      return m;
    }
    const deltas = data.basisDeltasByCell?.[basisKey(cell.range, cell.companyIds)] ?? [];
    for (const d of deltas) m.set(d.accountId, (m.get(d.accountId) ?? 0) + naturalToDebit(c.accounts.get(d.accountId), d.naturalCents));
    return m;
  }
  return addInto(m, storedBasisOverlay(data.basisDeltas, cell, data.companyIds, c.accounts, plan.pointInTime));
}

// ─── layout statements ───────────────────────────────────────────────────────

interface Built {
  rows: ReportRow[];
}

function layoutFor(c: Ctx): Layout {
  const { req, data } = c;
  if (req.layout?.kind === 'custom' && data.customLayout) {
    const l = fromCustom(data.customLayout);
    return l;
  }
  return builtinLayout(req.statement, req.layout?.kind === 'ebitda' ? 'ebitda' : 'standard');
}

function buildLayoutStatement(c: Ctx, layout: Layout, maps: Map<string, AccountMap | null>): Built {
  const { plan, req } = c;
  const cols = plan.columns;
  const isPnl = layout.statement === 'PNL';
  const accountList = [...c.accounts.values()].filter((a) => (isPnl ? isPnlAccount(a) : !isPnlAccount(a))).sort(accountSort);
  // first-match assignment: an account appears in the first layout row that selects it
  const owner = new Map<string, string>();
  for (const lr of layout.rows) {
    if (lr.kind !== 'accounts') continue;
    for (const a of accountList) if (!owner.has(a.id) && matchesSelector(a, lr.select)) owner.set(a.id, lr.id);
  }
  const amountIdx = cols.map((col, i) => (col.cell ? i : -1)).filter((i) => i >= 0);
  const val = (accountIds: string[], sign: number): Array<number | null> =>
    cols.map((col) => {
      if (!col.cell) return null;
      const m = maps.get(col.id);
      if (!m) return null;
      let s = 0;
      for (const id of accountIds) s += m.get(id) ?? 0;
      return s === 0 ? 0 : sign * s;
    });
  const nonzero = (v: Array<number | null>) => amountIdx.some((i) => (v[i] ?? 0) !== 0);
  const showZero = !!req.showZeroRows;

  // unmapped accounts with activity (custom layouts) → warning, never silently dropped
  const unmapped = accountList.filter((a) => !owner.has(a.id) && !a.id.startsWith('__') && nonzero(val([a.id], 1)));
  if (unmapped.length) {
    c.warnings.push({
      code: 'UNMAPPED_ACCOUNTS',
      message: `${unmapped.length} account${unmapped.length === 1 ? '' : 's'} with activity ${unmapped.length === 1 ? 'is' : 'are'} not in this layout: ${unmapped.slice(0, 5).map((a) => `${a.number} ${a.name}`.trim()).join(', ')}${unmapped.length > 5 ? '…' : ''}.`,
    });
  }

  const rowVals = new Map<string, Array<number | null>>();
  const rowPercent = new Set<string>();
  const sections = new Map<string, ReportRow[]>();
  const accountsOf = new Map<string, string[]>();

  // 1. accounts rows (independent)
  for (const lr of layout.rows) {
    if (lr.kind !== 'accounts') continue;
    const mine = accountList.filter((a) => owner.get(a.id) === lr.id);
    const goodWhen = isPnl ? (lr.goodWhen ?? (lr.sign === -1 ? 'up' : 'down')) : undefined;
    const visible = mine.filter((a) => showZero ? !a.id.startsWith('__') || nonzero(val([a.id], lr.sign)) : nonzero(val([a.id], lr.sign)));
    accountsOf.set(lr.id, mine.map((a) => a.id));
    rowVals.set(lr.id, val(mine.map((a) => a.id), lr.sign));
    const children: ReportRow[] = [];
    const acctRow = (a: AccountMeta, depth: number, parentId: string): ReportRow => ({
      id: `${lr.id}:a:${a.id}`,
      kind: 'account',
      label: a.number ? `${a.number} · ${a.name}` : a.name,
      depth,
      parentId,
      accountId: a.id.startsWith('__') ? null : a.id,
      accountNumber: a.number || null,
      accountIds: a.id.startsWith('__') ? pnlAccountIds(c) : [a.id],
      values: val([a.id], lr.sign),
      goodWhen,
      drillSign: lr.sign,
      synthetic: a.id.startsWith('__') || undefined,
      cellDrill: a.id === SYNTH_RE_PRIOR || a.id === SYNTH_NI_CURRENT ? syntheticDrill(c, a.id) : undefined,
    });
    const groups = new Map<string, AccountMeta[]>();
    for (const a of visible) {
      const g = groups.get(a.groupId) ?? [];
      g.push(a);
      groups.set(a.groupId, g);
    }
    // one group in the section → no group row (it would just repeat the section)
    if ((lr.expand ?? 'groups') === 'groups' && groups.size > 1) {
      for (const [gid, accts] of groups) {
        const gRowId = `${lr.id}:g:${gid}`;
        const kids = accts.map((a) => acctRow(a, 2, gRowId));
        children.push({
          id: gRowId,
          kind: 'group',
          label: accts[0].groupName,
          depth: 1,
          parentId: lr.id,
          accountIds: accts.map((a) => a.id).filter((id) => !id.startsWith('__')),
          values: val(accts.map((a) => a.id), lr.sign),
          goodWhen,
          drillSign: lr.sign,
          collapsible: true,
          sumOf: kids.map((k) => ({ id: k.id, sign: 1 as const })),
        });
        children.push(...kids);
      }
    } else if (lr.expand !== 'none') {
      for (const a of visible) children.push(acctRow(a, 1, lr.id));
    }
    sections.set(lr.id, children);
  }

  // 2. subtotals + formulas in dependency order
  const formulas = new Map<string, ReturnType<typeof parseFormula>>();
  for (const id of evaluationOrder(layout.rows)) {
    const lr = layout.rows.find((r) => r.id === id);
    if (!lr) continue;
    if (lr.kind === 'subtotal') {
      rowVals.set(
        lr.id,
        cols.map((col, i) => {
          if (!col.cell || !maps.get(col.id)) return null;
          let s = 0;
          for (const o of lr.of) s += o.sign * ((rowVals.get(o.id)?.[i] ?? 0) as number);
          return s === 0 ? 0 : s;
        }),
      );
    } else if (lr.kind === 'formula') {
      const node = parseFormula(lr.expr);
      formulas.set(lr.id, node);
      if (lr.format === 'percent') rowPercent.add(lr.id);
      rowVals.set(
        lr.id,
        cols.map((col, i) => {
          if (!col.cell || !maps.get(col.id) || col.kind === 'elimination') return null;
          const v = evalFormula(node, (ref) => (rowPercent.has(ref) ? null : (rowVals.get(ref)?.[i] ?? null)));
          if (v == null || !Number.isFinite(v)) return null;
          return lr.format === 'percent' ? round1(v) : Math.round(v);
        }),
      );
    }
  }

  // Drill for subtotal rows (gross profit, net income, total assets …): drillable when every
  // term contributes with the same debit-sign, e.g. GP = −Σ(revenue ∪ cost of sales) — then
  // the subtotal is drillSign × Σ(debit − credit) over the union of its accounts.
  const drillOf = new Map<string, { ids: string[]; sign: 1 | -1 } | null>();
  for (const lr of layout.rows as LayoutRow[]) {
    if (lr.kind === 'accounts') {
      const all = accountsOf.get(lr.id) ?? [];
      drillOf.set(lr.id, all.some((x) => x.startsWith('__')) ? null : { ids: all, sign: lr.sign === -1 ? -1 : 1 });
    } else if (lr.kind === 'subtotal') {
      let sign: 1 | -1 | null = null;
      const ids: string[] = [];
      let ok = true;
      for (const o of lr.of) {
        const d = drillOf.get(o.id);
        if (d && d.ids.length === 0) continue; // an empty section adds nothing
        const s = d ? ((o.sign * d.sign) as 1 | -1) : null;
        if (!d || !s || (sign !== null && s !== sign)) { ok = false; break; }
        sign = s;
        ids.push(...d.ids);
      }
      drillOf.set(lr.id, ok && new Set(ids).size === ids.length ? { ids, sign: sign ?? 1 } : null);
    }
  }
  const subtotalDrill = (id: string): Partial<ReportRow> => {
    const d = drillOf.get(id);
    return d && d.ids.length ? { accountIds: d.ids, drillSign: d.sign } : {};
  };

  // 3. emit rows in display order
  const out: ReportRow[] = [];
  for (const lr of layout.rows as LayoutRow[]) {
    if (lr.kind === 'header') out.push({ id: lr.id, kind: 'header', label: lr.label, depth: 0, values: cols.map(() => null) });
    else if (lr.kind === 'spacer') out.push({ id: lr.id, kind: 'spacer', label: '', depth: 0, values: cols.map(() => null) });
    else if (lr.kind === 'accounts') {
      const children = sections.get(lr.id) ?? [];
      const ids = (accountsOf.get(lr.id) ?? []).filter((x) => !x.startsWith('__'));
      const synth = (accountsOf.get(lr.id) ?? []).some((x) => x.startsWith('__'));
      const directKids = children.filter((k) => k.parentId === lr.id);
      if ((lr.expand ?? 'groups') === 'none') {
        out.push({
          id: lr.id, kind: 'account', label: lr.label, depth: 1, accountIds: synth ? [...ids, ...pnlAccountIds(c)] : ids,
          values: rowVals.get(lr.id)!, goodWhen: isPnl ? (lr.goodWhen ?? (lr.sign === -1 ? 'up' : 'down')) : undefined, drillSign: lr.sign,
        });
      } else {
        out.push(...children);
        out.push({
          id: lr.id,
          kind: 'subtotal',
          label: lr.label,
          depth: 0,
          accountIds: synth ? undefined : ids,
          values: rowVals.get(lr.id)!,
          goodWhen: isPnl ? (lr.goodWhen ?? (lr.sign === -1 ? 'up' : 'down')) : undefined,
          drillSign: lr.sign,
          sumOf: directKids.map((k) => ({ id: k.id, sign: 1 as const })),
        });
      }
    } else if (lr.kind === 'subtotal') {
      out.push({
        id: lr.id,
        kind: lr.emphasis === 'grand' ? 'total' : 'subtotal',
        emphasis: lr.emphasis,
        label: lr.label,
        depth: 0,
        values: rowVals.get(lr.id)!,
        goodWhen: isPnl ? (lr.goodWhen ?? 'up') : undefined,
        sumOf: lr.of.map((o) => ({ id: o.id, sign: o.sign })),
        ...subtotalDrill(lr.id),
      });
    } else if (lr.kind === 'formula') {
      out.push({
        id: lr.id,
        kind: 'formula',
        label: lr.label,
        depth: 0,
        values: rowVals.get(lr.id)!,
        percent: lr.format === 'percent' || undefined,
        goodWhen: isPnl ? (lr.goodWhen ?? 'up') : undefined,
      });
    }
  }
  return { rows: out };
}

function pnlAccountIds(c: Ctx): string[] {
  return [...c.accounts.values()].filter((a) => isPnlAccount(a) && !a.id.startsWith('__')).map((a) => a.id);
}

/**
 * Drill for the synthetic earnings rows: P&L lines before / from the fiscal-year start.
 * With in-group windows: only companies in the group at the as-of month, and a company
 * that joined during the fiscal year moves its pre-joining lines from "current" to "prior"
 * (mirrors Ledger.balanceSheet), expressed as per-company drill windows.
 */
function syntheticDrill(c: Ctx, id: string): Array<DrillScope | null> {
  const { ledger, data } = c;
  return c.plan.columns.map((col) => {
    if (!col.cell || col.source !== 'actual' || !col.drill) return null;
    const end = col.cell.range.end;
    const fy = fiscalYearStart(end, c.plan.fyStartMonth);
    const prior = id === SYNTH_RE_PRIOR;
    const range: DateRange = prior ? { start: null, end: addDays(fy, -1) } : { start: fy, end };
    if (!ledger.hasWindows) return { ...col.drill, range, kinds: ALL_KINDS };
    const all = col.drill.companyIds.length ? col.drill.companyIds : data.companyIds;
    const keep = all.filter((x) => ledger.inGroup(x, monthStart(end)));
    if (keep.length === 0) return null;
    const windows: NonNullable<DrillScope['windows']> = {};
    let priorEnd = range.end;
    for (const x of keep) {
      const joined = ledger.windowOf(x)?.from ?? null;
      if (!joined || joined <= fy || joined > end) continue;
      if (prior) {
        windows[x] = { from: null, to: addDays(joined, -1) };
        if (addDays(joined, -1) > priorEnd) priorEnd = addDays(joined, -1);
      } else {
        windows[x] = { from: joined, to: null };
      }
    }
    if (prior) for (const x of keep) if (!windows[x]) windows[x] = { from: null, to: addDays(fy, -1) };
    return { ...col.drill, companyIds: keep, range: prior ? { start: null, end: priorEnd } : range, kinds: ALL_KINDS, windows };
  });
}

/** End of the month that starts at `m` ('YYYY-MM-01'). */
function monthEnd(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/**
 * Narrow a drill scope to the in-group windows the Ledger applied, so drilling a cell
 * returns exactly the lines it summed. Point-in-time: companies outside the group at the
 * as-of month drop out. Flow: each company's lines are clipped to its window.
 * Scopes that already carry `windows` (synthetic rows) are final.
 */
export function windowDrillScope(scope: DrillScope | null | undefined, ledger: Ledger, allCompanyIds: string[]): DrillScope | null {
  if (!scope) return null;
  if (!ledger.hasWindows || scope.windows) return scope;
  const ids = scope.companyIds.length ? scope.companyIds : allCompanyIds;
  if (scope.range.start === null) {
    const m = monthStart(scope.range.end);
    const keep = ids.filter((x) => ledger.inGroup(x, m));
    if (keep.length === ids.length) return scope;
    return keep.length ? { ...scope, companyIds: keep } : null;
  }
  const start = scope.range.start;
  const end = scope.range.end;
  const keep: string[] = [];
  const windows: NonNullable<DrillScope['windows']> = {};
  for (const x of ids) {
    const w = ledger.windowOf(x);
    if (!w) { keep.push(x); continue; }
    const from = w.from && w.from > start ? w.from : null;
    const to = w.until && monthEnd(w.until) < end ? monthEnd(w.until) : null;
    if ((from ?? start) > (to ?? end)) continue; // never in the group inside the range
    keep.push(x);
    if (from || to) windows[x] = { from, to };
  }
  if (keep.length === 0) return null;
  if (keep.length === ids.length && Object.keys(windows).length === 0) return scope;
  return { ...scope, companyIds: keep, ...(Object.keys(windows).length ? { windows } : {}) };
}

// ─── derived columns (variance, %, common size) + F/U ────────────────────────

export function fillDerived(columns: ReportColumn[], rows: ReportRow[], commonSizeBase: string | null): void {
  const idx = new Map(columns.map((c, i) => [c.id, i]));
  const baseRow = commonSizeBase ? rows.find((r) => r.id === commonSizeBase) : null;
  for (const r of rows) {
    if (r.kind === 'header' || r.kind === 'spacer') continue;
    const fu: Array<'F' | 'U' | null> = columns.map(() => null);
    let anyFu = false;
    columns.forEach((col, i) => {
      if (col.kind === 'variance_amount' || col.kind === 'variance_pct') {
        const a = r.values[idx.get(col.of!)!];
        const b = r.values[idx.get(col.against!)!];
        if (a == null || b == null) { r.values[i] = null; return; }
        const d = a - b === 0 ? 0 : a - b;
        if (col.kind === 'variance_amount') {
          r.values[i] = r.percent ? round1(d) : d;
          if (r.goodWhen && d !== 0) {
            fu[i] = (d > 0) === (r.goodWhen === 'up') ? 'F' : 'U';
            anyFu = true;
          }
        } else {
          r.values[i] = r.percent || b === 0 ? null : round1((d / Math.abs(b)) * 100);
        }
      } else if (col.kind === 'common_size') {
        const ci = idx.get(col.of!)!;
        const v = r.values[ci];
        const base = baseRow?.values[ci];
        r.values[i] = r.percent || v == null || !base ? null : round1((v / base) * 100);
      }
    });
    if (anyFu) r.fu = fu;
  }
}

/** Every subtotal equals the sum of its parts (cents, every money column). Returns violations. */
export function tieViolations(columns: ReportColumn[], rows: ReportRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bad: string[] = [];
  for (const r of rows) {
    if (!r.sumOf || r.percent) continue;
    columns.forEach((col, i) => {
      if (col.percent || col.kind === 'variance_pct' || col.kind === 'common_size') return;
      const v = r.values[i];
      if (v == null) return;
      let s = 0;
      for (const ref of r.sumOf!) s += ref.sign * (byId.get(ref.id)?.values[i] ?? 0);
      if (s !== v) bad.push(`${r.label} / ${col.label}: shows ${v}, parts sum to ${s}`);
    });
  }
  return bad;
}

// ─── cash flow (indirect) ────────────────────────────────────────────────────

const CASH_ROLES = ['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS'];
const FINANCING_CURRENT_ROLES = ['NOTES_PAYABLE', 'FLOOR_PLAN_PAYABLE', 'FLOOR_PLAN_NOTE', 'LEASE_LIABILITY'];

export function cashFlowCategory(a: AccountMeta, accumulatedDepIds: ReadonlySet<string>): CashFlowCategory | null {
  if (isPnlAccount(a)) return null;
  if (a.cashFlowCategory) return a.cashFlowCategory;
  if (a.isBank || a.roles.some((r) => CASH_ROLES.includes(r))) return 'CASH';
  const n = a.name.toLowerCase();
  if (a.type === 'ASSET') {
    if (accumulatedDepIds.has(a.id) || (n.includes('accumulated') && (n.includes('depreciation') || n.includes('amortization')))) return 'NONCASH';
    if (a.subType === 'CURRENT_ASSET') return 'OPERATING';
    return 'INVESTING';
  }
  if (a.type === 'LIABILITY') {
    if (a.roles.some((r) => FINANCING_CURRENT_ROLES.includes(r))) return 'FINANCING';
    return a.subType === 'CURRENT_LIABILITY' ? 'OPERATING' : 'FINANCING';
  }
  return 'FINANCING'; // EQUITY
}

function buildCashFlow(c: Ctx): Built {
  const { plan, ledger, data } = c;
  const cols = plan.columns;
  const accDep = new Set(data.accumulatedDepreciationIds);
  const bsAccounts = [...c.accounts.values()].filter((a) => !isPnlAccount(a) && !a.id.startsWith('__')).sort(accountSort);
  const cat = new Map(bsAccounts.map((a) => [a.id, cashFlowCategory(a, accDep)]));
  const pnlIds = pnlAccountIds(c);
  const cashIds = bsAccounts.filter((a) => cat.get(a.id) === 'CASH').map((a) => a.id);
  type ColCalc = { act: AccountMap; open: AccountMap; close: AccountMap; joined: AccountMap } | null;
  const calc: ColCalc[] = cols.map((col) => {
    if (!col.cell || col.source !== 'actual' || !col.cell.range.start) return null;
    const cell = col.cell;
    const act = ledger.net({ ...cell, kinds: PNL_KINDS });
    const open = ledger.net({ ...cell, range: { start: null, end: addDays(cell.range.start!, -1) }, kinds: ALL_KINDS });
    const close = ledger.net({ ...cell, range: { start: null, end: cell.range.end }, kinds: ALL_KINDS });
    const joined = ledger.groupBoundary({ ...cell, kinds: ALL_KINDS });
    return { act, open, close, joined };
  });
  const per = (f: (k: NonNullable<ColCalc>) => number): Array<number | null> => calc.map((k) => (k ? f(k) || 0 : null));
  const sumIds = (m: AccountMap, ids: string[]) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  const rows: ReportRow[] = [];
  const drillAct = (ids: string[], sign: 1 | -1): Partial<ReportRow> => ({ accountIds: ids, drillSign: sign });
  const ni = per((k) => -sumIds(k.act, pnlIds));
  rows.push({ id: 'op_h', kind: 'header', label: 'Operating activities', depth: 0, values: cols.map(() => null) });
  rows.push({ id: 'ni', kind: 'account', label: 'Net income', depth: 1, values: ni, ...drillAct(pnlIds, -1) });
  const section = (catKey: CashFlowCategory, prefix: string): ReportRow[] => {
    const out: ReportRow[] = [];
    for (const a of bsAccounts) {
      if (cat.get(a.id) !== catKey) continue;
      const v = per((k) => -(k.act.get(a.id) ?? 0));
      if (!c.req.showZeroRows && v.every((x) => !x)) continue;
      out.push({ id: `${prefix}:${a.id}`, kind: 'account', label: `${a.number} · ${a.name}`, depth: 2, accountId: a.id, accountNumber: a.number, values: v, ...drillAct([a.id], -1) });
    }
    return out;
  };
  const adj = section('NONCASH', 'adj');
  const wc = section('OPERATING', 'wc');
  const sumRows = (list: ReportRow[]) => cols.map((_, i) => (calc[i] ? list.reduce((s, r) => s + (r.values[i] ?? 0), 0) : null));
  if (adj.length) {
    rows.push({ id: 'adj_g', kind: 'group', label: 'Adjustments for non-cash items', depth: 1, values: sumRows(adj), collapsible: true, sumOf: adj.map((r) => ({ id: r.id, sign: 1 as const })), parentId: 'cfo' });
    adj.forEach((r) => (r.parentId = 'adj_g'));
    rows.push(...adj);
  }
  rows.push({ id: 'wc_g', kind: 'group', label: 'Changes in operating assets and liabilities', depth: 1, values: sumRows(wc), collapsible: true, sumOf: wc.map((r) => ({ id: r.id, sign: 1 as const })), parentId: 'cfo' });
  wc.forEach((r) => (r.parentId = 'wc_g'));
  rows.push(...wc);
  const cfoParts = [{ id: 'ni', sign: 1 as const }, ...(adj.length ? [{ id: 'adj_g', sign: 1 as const }] : []), { id: 'wc_g', sign: 1 as const }];
  rows.push({ id: 'cfo', kind: 'subtotal', label: 'Net cash from operating activities', depth: 0, values: cols.map((_, i) => (calc[i] ? (ni[i] ?? 0) + (adj.length ? sumRows(adj)[i] ?? 0 : 0) + (sumRows(wc)[i] ?? 0) : null)), sumOf: cfoParts, goodWhen: 'up' });
  const inv = section('INVESTING', 'inv');
  // Cash that companies brought into (or took out of) the group when they joined (left) it
  // inside the period: their balance sheets arrive whole, so only their cash is a flow.
  const joinedCash = per((k) => sumIds(k.joined, cashIds));
  if (joinedCash.some((v) => v)) {
    inv.push({ id: 'inv:group_change', kind: 'account', label: 'Cash of companies joining (leaving) the group', depth: 2, values: joinedCash, synthetic: true });
    c.notes.push('Companies that joined or left the group during the period are included from the month they joined (to the month they left); their cash on that date is shown under investing activities.');
  }
  rows.push({ id: 'inv_h', kind: 'header', label: 'Investing activities', depth: 0, values: cols.map(() => null) });
  inv.forEach((r) => { r.depth = 1; r.parentId = 'cfi'; });
  rows.push(...inv);
  rows.push({ id: 'cfi', kind: 'subtotal', label: 'Net cash from investing activities', depth: 0, values: sumRows(inv), sumOf: inv.map((r) => ({ id: r.id, sign: 1 as const })), goodWhen: 'up' });
  const fin = section('FINANCING', 'fin');
  rows.push({ id: 'fin_h', kind: 'header', label: 'Financing activities', depth: 0, values: cols.map(() => null) });
  fin.forEach((r) => { r.depth = 1; r.parentId = 'cff'; });
  rows.push(...fin);
  rows.push({ id: 'cff', kind: 'subtotal', label: 'Net cash from financing activities', depth: 0, values: sumRows(fin), sumOf: fin.map((r) => ({ id: r.id, sign: 1 as const })), goodWhen: 'up' });
  const byId = (id: string) => rows.find((r) => r.id === id)!.values;
  const net = cols.map((_, i) => (calc[i] ? (byId('cfo')[i] ?? 0) + (byId('cfi')[i] ?? 0) + (byId('cff')[i] ?? 0) : null));
  rows.push({ id: 'sp', kind: 'spacer', label: '', depth: 0, values: cols.map(() => null) });
  rows.push({ id: 'net', kind: 'total', emphasis: 'grand', label: 'Net change in cash', depth: 0, values: net, sumOf: [{ id: 'cfo', sign: 1 }, { id: 'cfi', sign: 1 }, { id: 'cff', sign: 1 }], goodWhen: 'up' });
  const beg = per((k) => sumIds(k.open, cashIds));
  rows.push({ id: 'beg', kind: 'account', label: 'Cash at beginning of period', depth: 0, values: beg, accountIds: cashIds, drillSign: 1, cellDrill: cols.map((col) => (col.drill && col.cell?.range.start ? { ...col.drill, range: { start: null, end: addDays(col.cell.range.start, -1) }, kinds: ALL_KINDS } : null)) });
  const end = cols.map((_, i) => (calc[i] ? (beg[i] ?? 0) + (net[i] ?? 0) : null));
  rows.push({ id: 'end', kind: 'total', label: 'Cash at end of period', depth: 0, values: end, sumOf: [{ id: 'beg', sign: 1 }, { id: 'net', sign: 1 }] });
  const bsCash = per((k) => sumIds(k.close, cashIds));
  rows.push({ id: 'bs_cash', kind: 'check', label: 'Cash per balance sheet', depth: 0, values: bsCash, accountIds: cashIds, drillSign: 1, cellDrill: cols.map((col) => (col.drill && col.cell ? { ...col.drill, range: { start: null, end: col.cell.range.end }, kinds: ALL_KINDS } : null)) });
  cols.forEach((col, i) => {
    if (!calc[i] || col.role === 'compare') return;
    const diff = (end[i] ?? 0) - (bsCash[i] ?? 0);
    if (diff !== 0 && !c.warnings.some((w) => w.code === 'CASH_DOES_NOT_TIE')) {
      c.warnings.push({ code: 'CASH_DOES_NOT_TIE', message: `Cash at end of period differs from the balance-sheet cash by ${diff} cents in ${col.label}.`, amountCents: diff });
    }
  });
  if (cashIds.length === 0) c.warnings.push({ code: 'CASH_DOES_NOT_TIE', message: 'No cash accounts are flagged (bank flag or cash role) — mark your bank accounts so the cash flow can reconcile.' });
  return { rows };
}

// ─── statement of changes in equity ──────────────────────────────────────────

function buildEquity(c: Ctx): { rows: ReportRow[]; columns: ReportColumn[] } {
  const { plan, ledger } = c;
  const base = plan.columns.find((x) => x.cell)!;
  const cell = base.cell!;
  const R = cell.range as { start: string; end: string };
  const open = ledger.net({ ...cell, range: { start: null, end: addDays(R.start, -1) }, kinds: ALL_KINDS });
  const act = ledger.net({ ...cell, kinds: PNL_KINDS });
  const closing = ledger.net({ ...cell, kinds: ['CLOSING'] });
  const close = ledger.net({ ...cell, range: { start: null, end: R.end }, kinds: ALL_KINDS });
  const joined = ledger.groupBoundary({ ...cell, kinds: ALL_KINDS });
  const drill = base.drill!;
  const columns: ReportColumn[] = [
    { id: 'beg', label: 'Beginning', sublabel: shortDate(addDays(R.start, -1)), kind: 'amount', source: 'actual', range: { start: null, end: addDays(R.start, -1) }, drill: { ...drill, range: { start: null, end: addDays(R.start, -1) }, kinds: ALL_KINDS } },
    { id: 'act', label: 'Contributions & distributions', kind: 'amount', source: 'actual', range: R, drill: { ...drill, kinds: PNL_KINDS } },
    { id: 'ni', label: 'Net income', kind: 'amount', source: 'actual', range: R, drill: { ...drill, kinds: PNL_KINDS } },
    { id: 'cls', label: 'Year-end close', kind: 'amount', source: 'actual', range: R, drill: { ...drill, kinds: ['CLOSING'] } },
    { id: 'end', label: 'Ending', sublabel: shortDate(R.end), kind: 'total', source: 'actual', range: { start: null, end: R.end }, current: true, drill: { ...drill, range: { start: null, end: R.end }, kinds: ALL_KINDS } },
  ];
  const eq = [...c.accounts.values()].filter((a) => a.type === 'EQUITY' && !a.id.startsWith('__')).sort(accountSort);
  const pnl = pnlAccountIds(c);
  const s = (m: AccountMap, ids: string[]) => -ids.reduce((t, id) => t + (m.get(id) ?? 0), 0) || 0;
  // Companies joining / leaving the group inside the period bring (take) their equity.
  const hasJoined = [...joined.values()].some((v) => v !== 0);
  const rows: ReportRow[] = [];
  const withJoined = (v: number[], g: number): number[] => (hasJoined ? [v[0], g, ...v.slice(1)] : v);
  for (const a of eq) {
    const v = withJoined([s(open, [a.id]), s(act, [a.id]), 0, s(closing, [a.id]), s(close, [a.id])], s(joined, [a.id]));
    if (!c.req.showZeroRows && v.every((x) => x === 0)) continue;
    rows.push({ id: `eq:${a.id}`, kind: 'account', label: `${a.number} · ${a.name}`, depth: 1, accountId: a.id, accountNumber: a.number, accountIds: [a.id], values: v, drillSign: -1, sumOf: undefined, cellDrill: hasJoined ? withJoinedDrill(columns.map((col) => col.drill ?? null)) : undefined });
  }
  const earn = withJoined([s(open, pnl), 0, s(act, pnl), s(closing, pnl), s(close, pnl)], s(joined, pnl));
  rows.push({
    id: 'eq:earnings', kind: 'account', label: 'Earnings not yet closed to retained earnings', depth: 1, accountIds: pnl, values: earn, drillSign: -1, synthetic: true,
    cellDrill: withJoinedDrill([columns[0].drill!, null, columns[2].drill!, columns[3].drill!, columns[4].drill!]),
  });
  function withJoinedDrill(d: Array<DrillScope | null>): Array<DrillScope | null> {
    return hasJoined ? [d[0], null, ...d.slice(1)] : d;
  }
  if (hasJoined) {
    columns.splice(1, 0, { id: 'grp', label: 'Companies joining (leaving)', sublabel: 'the group', kind: 'amount', source: 'actual', range: R, drill: null });
    c.notes.push('Companies that joined or left the group during the period bring in (take out) their equity on that date — shown in its own column.');
  }
  const total = columns.map((_, i) => rows.reduce((t, r) => t + (r.values[i] ?? 0), 0));
  rows.push({ id: 'eq_total', kind: 'total', emphasis: 'grand', label: 'Total equity', depth: 0, values: total, sumOf: rows.map((r) => ({ id: r.id, sign: 1 as const })) });
  // per row: beginning + (joining) + activity + NI + close = ending
  for (const r of rows) {
    const v = r.values as number[];
    const e = v[v.length - 1];
    const sum = v.slice(0, -1).reduce((t, x) => t + x, 0);
    if (sum !== e) c.warnings.push({ code: 'OUT_OF_BALANCE', message: `${r.label}: beginning + activity ≠ ending.`, amountCents: e - sum });
  }
  return { rows, columns };
}

// ─── trial balance (worksheet) ───────────────────────────────────────────────

function buildTrialBalance(c: Ctx): { rows: ReportRow[]; columns: ReportColumn[] } {
  const { plan, ledger, req } = c;
  const base = plan.columns.find((x) => x.cell)!;
  const E = base.cell!.range.end;
  const fy = fiscalYearStart(E, plan.fyStartMonth);
  const window = plan.columns[0].window ?? { start: monthStart(E), end: E };
  const companyIds = base.cell!.companyIds;
  const bs = ledger.balanceSheet({ range: { start: null, end: E }, companyIds }, plan.fyStartMonth);
  const fytd = ledger.net({ range: { start: fy, end: E }, companyIds, kinds: ALL_KINDS });
  const adj = ledger.net({ range: { start: window.start ?? monthStart(E), end: E }, companyIds, kinds: ['ADJUSTING'] });
  const worksheet = req.tbMode !== 'simple';
  const asOfDrill: DrillScope = { companyIds, range: { start: null, end: E }, kinds: ALL_KINDS };
  const fytdDrill: DrillScope = { companyIds, range: { start: fy, end: E }, kinds: ALL_KINDS };
  const adjDrill: DrillScope = { companyIds, range: { start: window.start ?? monthStart(E), end: E }, kinds: ['ADJUSTING'] };
  const pair = (id: string, label: string, drill: DrillScope | null, current = false): ReportColumn[] => [
    { id: `${id}_dr`, label: 'Debit', sublabel: label, kind: 'debit', source: 'actual', range: drill?.range ?? { start: null, end: E }, drill, current },
    { id: `${id}_cr`, label: 'Credit', sublabel: label, kind: 'credit', source: 'actual', range: drill?.range ?? { start: null, end: E }, drill, current },
  ];
  const columns: ReportColumn[] = worksheet
    ? [...pair('un', 'Unadjusted', null), ...pair('aj', 'Adjustments', adjDrill), ...pair('ad', 'Adjusted', asOfDrill, true)]
    : pair('ad', `As of ${shortDate(E)}`, asOfDrill, true);
  const accts = [...c.accounts.values()].filter((a) => !a.id.startsWith('__')).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const rows: ReportRow[] = [];
  const split = (net: number): [number, number] => (net >= 0 ? [net, 0] : [0, -net]);
  const pushRow = (id: string, label: string, adjusted: number, adjustment: number, a: AccountMeta | null, synthetic = false) => {
    const unadj = adjusted - adjustment;
    const vals = worksheet ? [...split(unadj), ...split(adjustment), ...split(adjusted)] : split(adjusted);
    if (!c.req.showZeroRows && vals.every((v) => v === 0)) return;
    const pnl = a ? isPnlAccount(a) : true;
    const rowDrill = synthetic
      ? { ...asOfDrill, range: { start: null, end: addDays(fy, -1) } }
      : pnl ? fytdDrill : asOfDrill;
    rows.push({
      id, kind: 'account', label, depth: 1, accountId: a?.id ?? null, accountNumber: a?.number ?? null,
      accountIds: a ? [a.id] : pnlAccountIds(c), values: vals, synthetic: synthetic || undefined, drillSign: 1,
      cellDrill: columns.map((col) => (col.id.startsWith('aj') ? (synthetic ? null : adjDrill) : col.id.startsWith('ad') ? rowDrill : null)),
    });
  };
  for (const a of accts) {
    const adjusted = isPnlAccount(a) ? (fytd.get(a.id) ?? 0) : (bs.get(a.id) ?? 0);
    pushRow(`tb:${a.id}`, `${a.number} · ${a.name}`, adjusted, adj.get(a.id) ?? 0, a);
  }
  pushRow('tb:re_prior', PRIOR_RE_LABEL, bs.get(SYNTH_RE_PRIOR) ?? 0, 0, null, true);
  const totals = columns.map((_, i) => rows.reduce((t, r) => t + (r.values[i] ?? 0), 0));
  rows.push({ id: 'tb_total', kind: 'total', emphasis: 'grand', label: 'Total', depth: 0, values: totals, sumOf: rows.map((r) => ({ id: r.id, sign: 1 as const })) });
  return { rows, columns };
}

// ─── GL summary (opening / debits / credits / closing per account) ───────────

function buildGlSummary(c: Ctx): { rows: ReportRow[]; columns: ReportColumn[] } {
  const { plan, ledger } = c;
  const base = plan.columns.find((x) => x.cell)!;
  const R = base.cell!.range as { start: string; end: string };
  const companyIds = base.cell!.companyIds;
  const fy = fiscalYearStart(R.start, plan.fyStartMonth);
  const openBs = ledger.net({ range: { start: null, end: addDays(R.start, -1) }, companyIds, kinds: ALL_KINDS });
  const openPnl = fy < R.start ? ledger.net({ range: { start: fy, end: addDays(R.start, -1) }, companyIds, kinds: ALL_KINDS }) : new Map<string, number>();
  const per = ledger.sums({ range: R, companyIds, kinds: ALL_KINDS });
  const d = base.drill!;
  const columns: ReportColumn[] = [
    { id: 'open', label: 'Opening', sublabel: 'Debit (credit)', kind: 'amount', source: 'actual', range: { start: null, end: addDays(R.start, -1) }, drill: null },
    { id: 'dr', label: 'Debits', kind: 'debit', source: 'actual', range: R, drill: d },
    { id: 'cr', label: 'Credits', kind: 'credit', source: 'actual', range: R, drill: d },
    { id: 'chg', label: 'Net change', kind: 'amount', source: 'actual', range: R, drill: d },
    { id: 'close', label: 'Closing', sublabel: 'Debit (credit)', kind: 'total', source: 'actual', range: { start: null, end: R.end }, drill: null, current: true },
  ];
  const accts = [...c.accounts.values()].filter((a) => !a.id.startsWith('__')).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const rows: ReportRow[] = [];
  for (const a of accts) {
    const open = isPnlAccount(a) ? (openPnl.get(a.id) ?? 0) : (openBs.get(a.id) ?? 0);
    const dr = per.dr.get(a.id) ?? 0;
    const cr = per.cr.get(a.id) ?? 0;
    const v = [open, dr, cr, dr - cr, open + dr - cr];
    if (!c.req.showZeroRows && v.every((x) => x === 0)) continue;
    const openDrill: DrillScope = isPnlAccount(a) ? { ...d, range: { start: fy, end: addDays(R.start, -1) }, kinds: ALL_KINDS } : { ...d, range: { start: null, end: addDays(R.start, -1) }, kinds: ALL_KINDS };
    const closeDrill: DrillScope = isPnlAccount(a) ? { ...d, range: { start: fy, end: R.end }, kinds: ALL_KINDS } : { ...d, range: { start: null, end: R.end }, kinds: ALL_KINDS };
    rows.push({
      id: `gl:${a.id}`, kind: 'account', label: `${a.number} · ${a.name}`, depth: 1, accountId: a.id, accountNumber: a.number, accountIds: [a.id], values: v, drillSign: 1,
      cellDrill: [fy < R.start || !isPnlAccount(a) ? openDrill : null, { ...d, kinds: ALL_KINDS }, { ...d, kinds: ALL_KINDS }, { ...d, kinds: ALL_KINDS }, closeDrill],
    });
  }
  const totals = columns.map((_, i) => rows.reduce((t, r) => t + (r.values[i] ?? 0), 0));
  rows.push({ id: 'gl_total', kind: 'total', emphasis: 'grand', label: 'Total', depth: 0, values: totals, sumOf: rows.map((r) => ({ id: r.id, sign: 1 as const })) });
  return { rows, columns };
}

// ─── entry point ─────────────────────────────────────────────────────────────

function columnStatus(data: EngineData, col: PlannedColumn, today: string): ReportColumn['status'] {
  if (!col.cell || col.source !== 'actual') return null;
  const r = col.cell.range;
  if (r.end >= today) return 'partial';
  const months = r.start ? monthsIn({ start: r.start, end: r.end }) : [monthStart(r.end)];
  const ids = col.cell.companyIds.length ? col.cell.companyIds : data.companyIds;
  const allHard = months.every((m) => ids.every((id) => data.periodStatus.some((p) => p.companyId === id && p.period === m && p.status === 'HARD_CLOSE')));
  return allHard ? 'final' : 'preliminary';
}

function publicColumn(col: PlannedColumn, status: ReportColumn['status']): ReportColumn {
  const { role: _role, cell: _cell, window: _w, compareKind: _k, ...rest } = col;
  void _role; void _cell; void _w; void _k;
  return { ...rest, status };
}

export function buildReport(req: ReportRequest, plan: Plan, data: EngineData, now: string = new Date().toISOString()): ReportResult {
  const accounts = new Map<string, AccountMeta>([...data.accounts, ...syntheticAccounts()].map((a) => [a.id, a]));
  // In-group windows apply to the financial statements; the trial balance and GL summary
  // are ledger tools and show every posted line (governance annotates them instead).
  const windowed = req.statement !== 'trial_balance' && req.statement !== 'gl_summary';
  const windows = windowed ? data.groupWindows ?? null : null;
  const ledger = new Ledger({ ...data, accounts: [...accounts.values()] }, req.filters ?? {}, windows);
  const c: Ctx = { req, plan, data, ledger, warnings: [], notes: [], accounts };
  let columns: ReportColumn[] = plan.columns.map((col) => publicColumn(col, columnStatus(data, col, data.today)));
  let rows: ReportRow[];
  let commonSizeBase: string | null = null;
  let keyRows: string[] = [];
  if (req.statement === 'income_statement' || req.statement === 'balance_sheet') {
    const layout = layoutFor(c);
    if (req.statement === 'balance_sheet' && layout.statement !== 'BS') throw new Error('This layout is a P&L layout; choose a balance-sheet layout.');
    if (req.statement === 'income_statement' && layout.statement !== 'PNL') throw new Error('This layout is a balance-sheet layout; choose a P&L layout.');
    const maps = columnMaps(c);
    rows = buildLayoutStatement(c, layout, maps).rows;
    commonSizeBase = layout.commonSizeBase;
    keyRows = layout.keyRows;
  } else if (req.statement === 'cash_flow') {
    rows = buildCashFlow(c).rows;
    keyRows = ['cfo', 'net'];
  } else if (req.statement === 'equity_changes') {
    ({ rows, columns } = buildEquity(c));
  } else if (req.statement === 'trial_balance') {
    ({ rows, columns } = buildTrialBalance(c));
  } else {
    ({ rows, columns } = buildGlSummary(c));
  }
  fillDerived(columns, rows, commonSizeBase);
  if (ledger.hasWindows && plan.pointInTime && req.statement === 'balance_sheet') {
    const fy = fiscalYearStart(plan.range.end, plan.fyStartMonth);
    const joiners = data.companies.filter((x) => {
      const j = ledger.windowOf(x.id)?.from;
      return plan.companyIds.includes(x.id) && !!j && j > fy && j <= plan.range.end;
    });
    if (joiners.length) c.notes.push(`${joiners.map((x) => x.name).join(', ')} joined the group this fiscal year: earnings before joining are in retained earnings (equity brought in), so current-year net income is the group's.`);
  }
  if (ledger.hasWindows) {
    columns = columns.map((col) => (col.drill ? { ...col, drill: windowDrillScope(col.drill, ledger, data.companyIds) } : col));
    rows = rows.map((r) => (r.cellDrill ? { ...r, cellDrill: r.cellDrill.map((d) => windowDrillScope(d, ledger, data.companyIds)) } : r));
  }

  // checks
  const checks: ReportResult['checks'] = [];
  const unfiltered = !ledger.hasAccountFilter && !ledger.hasDimensionFilter;
  if (req.statement === 'balance_sheet' && unfiltered) {
    const ta = rows.find((r) => r.id === 'ta');
    const tle = rows.find((r) => r.id === 'tle');
    if (ta && tle) {
      columns.forEach((col, i) => {
        if (col.kind !== 'amount' && col.kind !== 'total' && col.kind !== 'elimination') return;
        if (col.source !== 'actual' || ta.values[i] == null) return;
        const diff = (ta.values[i] ?? 0) - (tle.values[i] ?? 0);
        checks.push({ id: `bs:${col.id}`, label: `Assets = liabilities + equity (${col.label})`, ok: diff === 0, differenceCents: diff });
      });
      if (checks.some((x) => !x.ok)) {
        const d = checks.find((x) => !x.ok)!;
        c.warnings.push({ code: 'OUT_OF_BALANCE', message: `The balance sheet is out of balance by ${d.differenceCents} cents (${d.label}).`, amountCents: d.differenceCents ?? undefined });
      }
    }
  }
  if (req.statement === 'trial_balance') {
    const total = rows.find((r) => r.id === 'tb_total')!;
    for (let i = 0; i + 1 < columns.length; i += 2) {
      const diff = (total.values[i] ?? 0) - (total.values[i + 1] ?? 0);
      checks.push({ id: `tb:${columns[i].sublabel}`, label: `Debits = credits (${columns[i].sublabel})`, ok: diff === 0, differenceCents: diff });
    }
    if (checks.some((x) => !x.ok)) c.warnings.push({ code: 'OUT_OF_BALANCE', message: 'The trial balance does not balance.', amountCents: checks.find((x) => !x.ok)!.differenceCents ?? undefined });
  }
  if (req.statement === 'cash_flow') {
    const end = rows.find((r) => r.id === 'end')!;
    const bsCash = rows.find((r) => r.id === 'bs_cash')!;
    columns.forEach((col, i) => {
      if (end.values[i] == null || col.kind === 'variance_amount' || col.kind === 'variance_pct') return;
      const diff = (end.values[i] ?? 0) - (bsCash.values[i] ?? 0);
      checks.push({ id: `cf:${col.id}`, label: `Ending cash ties to the balance sheet (${col.label})`, ok: diff === 0, differenceCents: diff });
    });
  }
  const ties = tieViolations(columns, rows);
  if (ties.length) c.warnings.push({ code: 'OUT_OF_BALANCE', message: `Internal total check failed: ${ties[0]}` });

  // partial period
  const baseCols = columns.filter((col) => col.status === 'partial');
  if (baseCols.length && req.statement !== 'trial_balance') {
    c.warnings.push({ code: 'PARTIAL_PERIOD', message: `${baseCols.map((x) => x.label).slice(0, 3).join(', ')} ${baseCols.length === 1 ? 'is' : 'are'} still in progress — figures will change as entries post.` });
  }

  const companies = data.companies.filter((x) => plan.companyIds.includes(x.id)).map((x) => ({ id: x.id, name: x.name }));
  const scopeLabel =
    companies.length === 1 ? companies[0].name : `${plan.consolidated ? 'Consolidated · ' : ''}${companies.length} companies`;
  const chartSeries = keyRows
    .map((rid) => rows.find((r) => r.id === rid))
    .filter((r): r is ReportRow => !!r)
    .map((r) => ({
      rowId: r.id,
      label: r.label,
      points: columns
        .map((col, i) => ({ col, i }))
        .filter(({ col }) => col.kind === 'amount' && col.source === 'actual' && !col.of && plan.columns.find((p) => p.id === col.id)?.role === 'base')
        .map(({ col, i }) => ({ columnId: col.id, label: col.label, cents: r.values[i] })),
    }));

  return {
    statement: req.statement,
    title: req.layout?.kind === 'custom' && data.customLayout ? data.customLayout.name : TITLES[req.statement],
    subtitle: `${scopeLabel} · ${rangeLabel(plan.range)} · ${basisLabel(req)}`,
    basis: req.basis,
    basisLabel: basisLabel(req),
    rounding: req.rounding,
    range: plan.range,
    columns,
    rows,
    warnings: c.warnings,
    notes: c.notes,
    companies,
    checks,
    chartSeries,
    generatedAt: now,
    governance: null,
    groupWindowCompanyIds: ledger.hasWindows ? plan.companyIds.filter((id) => !!ledger.windowOf(id)) : [],
  };
}
