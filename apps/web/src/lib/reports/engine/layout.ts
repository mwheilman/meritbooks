/**
 * Statement layouts (pure): the built-in "As reported" P&L / balance sheet, the
 * "Standard lines → EBITDA" P&L, the custom row-designer model (report_layouts.rows),
 * account selectors, validation and the formula-row evaluator.
 *
 * Accounts are referenced BY TYPE / SUB-TYPE / GROUP / ROLE — never by hard-coded account
 * number (CANON §2). Number RANGES are available only as an explicit user choice in a
 * custom layout.
 */
import type { AccountMeta, AccountSelector, CustomLayout, LayoutRowDef, StatementKind } from './types';

/** Synthetic balance-sheet equity rows (earnings not yet closed to retained earnings). */
export const SYNTH_RE_PRIOR = '__re_prior';
export const SYNTH_NI_CURRENT = '__ni_current';

/** A selector with an optional in-code predicate (built-in layouts only; never serialized). */
export interface Selector extends AccountSelector {
  match?: (a: AccountMeta) => boolean;
}

export type LayoutRow =
  | Exclude<LayoutRowDef, { kind: 'accounts' }>
  | (Extract<LayoutRowDef, { kind: 'accounts' }> & { select: Selector });

export interface Layout {
  id: string;
  name: string;
  statement: 'PNL' | 'BS';
  rows: LayoutRow[];
  /** common-size denominator row id (P&L: revenue · BS: total assets) */
  commonSizeBase: string | null;
  /** chart key rows */
  keyRows: string[];
}

// ─── selectors ──────────────────────────────────────────────────────────────

function cmpAccountNumber(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function inRange(num: string, from: string, to: string): boolean {
  return cmpAccountNumber(num, from) >= 0 && cmpAccountNumber(num, to) <= 0;
}

/** Does an account satisfy a selector? Criteria AND together; values within one criterion OR. */
export function matchesSelector(a: AccountMeta, s: Selector): boolean {
  if (a.id === SYNTH_RE_PRIOR) return !!s.synthetic?.includes('re_prior');
  if (a.id === SYNTH_NI_CURRENT) return !!s.synthetic?.includes('ni_current');
  if (s.excludeAccountIds?.includes(a.id)) return false;
  const hasCriteria = !!(s.types?.length || s.subTypes?.length || s.groupIds?.length || s.roles?.length || s.accountIds?.length || s.ranges?.length || s.match);
  if (!hasCriteria) return false;
  if (s.types?.length && !s.types.includes(a.type)) return false;
  if (s.subTypes?.length && !s.subTypes.includes(a.subType)) return false;
  if (s.groupIds?.length && !s.groupIds.includes(a.groupId)) return false;
  if (s.roles?.length && !a.roles.some((r) => s.roles!.includes(r))) return false;
  if (s.accountIds?.length && !s.accountIds.includes(a.id)) return false;
  if (s.ranges?.length && !s.ranges.some((r) => inRange(a.number, r.from, r.to))) return false;
  if (s.match && !s.match(a)) return false;
  return true;
}

export const PNL_TYPES = new Set(['REVENUE', 'COGS', 'OPEX', 'OTHER']);
export const BS_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY']);

export function isPnlAccount(a: Pick<AccountMeta, 'type'>): boolean {
  return PNL_TYPES.has(a.type);
}

/** OTHER-type accounts presented as income: OTHER_INCOME sub-type, or a credit-normal OTHER account. */
export function isOtherIncome(a: AccountMeta): boolean {
  return a.type === 'OTHER' && (a.subType === 'OTHER_INCOME' || (a.subType !== 'OTHER_EXPENSE' && a.normalBalance === 'CREDIT'));
}

const DA_ROLES = ['ROU_AMORTIZATION_EXPENSE'];
const INTEREST_ROLES = ['INTEREST_EXPENSE', 'LEASE_INTEREST_EXPENSE', 'FLOOR_PLAN_INTEREST'];
const TAX_ROLES = ['INCOME_TAX_EXPENSE'];

/** Depreciation & amortization expense (role, or the depreciation-expense name convention). */
export function isDandA(a: AccountMeta): boolean {
  if (!(a.type === 'OPEX' || a.type === 'OTHER' || a.type === 'COGS')) return false;
  if (a.roles.some((r) => DA_ROLES.includes(r))) return true;
  const n = a.name.toLowerCase();
  return (n.includes('depreciation') || n.includes('amortization')) && !n.includes('accumulated');
}
export function isInterestExpense(a: AccountMeta): boolean {
  if (!(a.type === 'OPEX' || a.type === 'OTHER')) return false;
  if (a.roles.some((r) => INTEREST_ROLES.includes(r))) return true;
  return a.name.toLowerCase().includes('interest expense');
}
export function isIncomeTax(a: AccountMeta): boolean {
  if (!(a.type === 'OPEX' || a.type === 'OTHER')) return false;
  if (a.roles.some((r) => TAX_ROLES.includes(r))) return true;
  const n = a.name.toLowerCase();
  return n.includes('income tax') && !n.includes('payable');
}

// ─── built-in layouts ───────────────────────────────────────────────────────

export function standardPnl(): Layout {
  return {
    id: 'standard:pnl',
    name: 'As reported',
    statement: 'PNL',
    commonSizeBase: 'rev',
    keyRows: ['rev', 'gp', 'op', 'ni'],
    rows: [
      { id: 'rev_h', kind: 'header', label: 'Revenue' },
      { id: 'rev', kind: 'accounts', label: 'Total revenue', select: { types: ['REVENUE'] }, sign: -1, expand: 'groups', goodWhen: 'up' },
      { id: 'cogs_h', kind: 'header', label: 'Cost of sales' },
      { id: 'cogs', kind: 'accounts', label: 'Total cost of sales', select: { types: ['COGS'] }, sign: 1, expand: 'groups', goodWhen: 'down' },
      { id: 'gp', kind: 'subtotal', label: 'Gross profit', of: [{ id: 'rev', sign: 1 }, { id: 'cogs', sign: -1 }], emphasis: 'sub' },
      { id: 'gm', kind: 'formula', label: 'Gross margin', expr: '{gp} / {rev} * 100', format: 'percent' },
      { id: 'sp1', kind: 'spacer' },
      { id: 'opex_h', kind: 'header', label: 'Operating expenses' },
      { id: 'opex', kind: 'accounts', label: 'Total operating expenses', select: { types: ['OPEX'] }, sign: 1, expand: 'groups', goodWhen: 'down' },
      { id: 'op', kind: 'subtotal', label: 'Operating income', of: [{ id: 'gp', sign: 1 }, { id: 'opex', sign: -1 }], emphasis: 'sub' },
      { id: 'sp2', kind: 'spacer' },
      { id: 'oth_h', kind: 'header', label: 'Other income and expense' },
      { id: 'oi', kind: 'accounts', label: 'Total other income', select: { types: ['OTHER'], match: isOtherIncome }, sign: -1, expand: 'accounts', goodWhen: 'up' },
      { id: 'oe', kind: 'accounts', label: 'Total other expense', select: { types: ['OTHER'], match: (a) => !isOtherIncome(a) }, sign: 1, expand: 'accounts', goodWhen: 'down' },
      { id: 'noi', kind: 'subtotal', label: 'Net other income (expense)', of: [{ id: 'oi', sign: 1 }, { id: 'oe', sign: -1 }] },
      { id: 'ni', kind: 'subtotal', label: 'Net income', of: [{ id: 'op', sign: 1 }, { id: 'noi', sign: 1 }], emphasis: 'grand' },
      { id: 'nm', kind: 'formula', label: 'Net margin', expr: '{ni} / {rev} * 100', format: 'percent' },
    ],
  };
}

/** Standard lines → EBITDA (portal parity: Revenue → COGS → GP → opex → EBITDA → D&A, interest, tax → NI). */
export function ebitdaPnl(): Layout {
  const below = (a: AccountMeta) => isDandA(a) || isInterestExpense(a) || isIncomeTax(a);
  return {
    id: 'standard:ebitda',
    name: 'Standard lines → EBITDA',
    statement: 'PNL',
    commonSizeBase: 'rev',
    keyRows: ['rev', 'gp', 'ebitda', 'ni'],
    rows: [
      { id: 'rev', kind: 'accounts', label: 'Revenue', select: { types: ['REVENUE'] }, sign: -1, expand: 'groups', goodWhen: 'up' },
      { id: 'cogs', kind: 'accounts', label: 'Cost of sales', select: { types: ['COGS'], match: (a) => !isDandA(a) }, sign: 1, expand: 'groups', goodWhen: 'down' },
      { id: 'gp', kind: 'subtotal', label: 'Gross profit', of: [{ id: 'rev', sign: 1 }, { id: 'cogs', sign: -1 }], emphasis: 'sub' },
      { id: 'gm', kind: 'formula', label: 'Gross margin', expr: '{gp} / {rev} * 100', format: 'percent' },
      { id: 'opex', kind: 'accounts', label: 'Operating expenses (before D&A)', select: { types: ['OPEX'], match: (a) => !below(a) }, sign: 1, expand: 'groups', goodWhen: 'down' },
      { id: 'oi', kind: 'accounts', label: 'Other operating income (expense)', select: { types: ['OTHER'], match: (a) => !below(a) }, sign: -1, expand: 'accounts', goodWhen: 'up' },
      { id: 'ebitda', kind: 'subtotal', label: 'EBITDA', of: [{ id: 'gp', sign: 1 }, { id: 'opex', sign: -1 }, { id: 'oi', sign: 1 }], emphasis: 'sub' },
      { id: 'ebitda_m', kind: 'formula', label: 'EBITDA margin', expr: '{ebitda} / {rev} * 100', format: 'percent' },
      { id: 'da', kind: 'accounts', label: 'Depreciation and amortization', select: { types: ['OPEX', 'OTHER', 'COGS'], match: isDandA }, sign: 1, expand: 'accounts', goodWhen: 'down' },
      { id: 'int', kind: 'accounts', label: 'Interest expense', select: { types: ['OPEX', 'OTHER'], match: (a) => isInterestExpense(a) && !isDandA(a) }, sign: 1, expand: 'accounts', goodWhen: 'down' },
      { id: 'tax', kind: 'accounts', label: 'Income taxes', select: { types: ['OPEX', 'OTHER'], match: (a) => isIncomeTax(a) && !isDandA(a) && !isInterestExpense(a) }, sign: 1, expand: 'accounts', goodWhen: 'down' },
      { id: 'ni', kind: 'subtotal', label: 'Net income', of: [{ id: 'ebitda', sign: 1 }, { id: 'da', sign: -1 }, { id: 'int', sign: -1 }, { id: 'tax', sign: -1 }], emphasis: 'grand' },
      { id: 'nm', kind: 'formula', label: 'Net margin', expr: '{ni} / {rev} * 100', format: 'percent' },
    ],
  };
}

export function standardBalanceSheet(): Layout {
  const otherAsset = (a: AccountMeta) => a.type === 'ASSET' && a.subType !== 'CURRENT_ASSET' && a.subType !== 'FIXED_ASSET';
  const otherLiab = (a: AccountMeta) => a.type === 'LIABILITY' && a.subType !== 'CURRENT_LIABILITY';
  return {
    id: 'standard:bs',
    name: 'As reported',
    statement: 'BS',
    commonSizeBase: 'ta',
    keyRows: ['ta', 'tl', 'eq'],
    rows: [
      { id: 'assets_h', kind: 'header', label: 'Assets' },
      { id: 'ca', kind: 'accounts', label: 'Total current assets', select: { types: ['ASSET'], subTypes: ['CURRENT_ASSET'] }, sign: 1, expand: 'groups' },
      { id: 'fa', kind: 'accounts', label: 'Total fixed assets', select: { types: ['ASSET'], subTypes: ['FIXED_ASSET'] }, sign: 1, expand: 'groups' },
      { id: 'oa', kind: 'accounts', label: 'Total other assets', select: { types: ['ASSET'], match: otherAsset }, sign: 1, expand: 'groups' },
      { id: 'ta', kind: 'subtotal', label: 'Total assets', of: [{ id: 'ca', sign: 1 }, { id: 'fa', sign: 1 }, { id: 'oa', sign: 1 }], emphasis: 'grand' },
      { id: 'sp1', kind: 'spacer' },
      { id: 'liab_h', kind: 'header', label: 'Liabilities' },
      { id: 'cl', kind: 'accounts', label: 'Total current liabilities', select: { types: ['LIABILITY'], subTypes: ['CURRENT_LIABILITY'] }, sign: -1, expand: 'groups' },
      { id: 'ltl', kind: 'accounts', label: 'Total long-term liabilities', select: { types: ['LIABILITY'], match: otherLiab }, sign: -1, expand: 'groups' },
      { id: 'tl', kind: 'subtotal', label: 'Total liabilities', of: [{ id: 'cl', sign: 1 }, { id: 'ltl', sign: 1 }], emphasis: 'sub' },
      { id: 'eq_h', kind: 'header', label: 'Equity' },
      { id: 'eq', kind: 'accounts', label: 'Total equity', select: { types: ['EQUITY'], synthetic: ['re_prior', 'ni_current'] }, sign: -1, expand: 'accounts' },
      { id: 'tle', kind: 'subtotal', label: 'Total liabilities and equity', of: [{ id: 'tl', sign: 1 }, { id: 'eq', sign: 1 }], emphasis: 'grand' },
      { id: 'sp2', kind: 'spacer' },
      { id: 'wc', kind: 'formula', label: 'Working capital (current assets − current liabilities)', expr: '{ca} - {cl}', format: 'amount' },
      { id: 'cr', kind: 'formula', label: 'Current ratio', expr: '{ca} / {cl} * 100', format: 'percent' },
    ],
  };
}

export function builtinLayout(statement: StatementKind, kind: 'standard' | 'ebitda'): Layout {
  if (statement === 'balance_sheet') return standardBalanceSheet();
  return kind === 'ebitda' ? ebitdaPnl() : standardPnl();
}

/** A stored custom layout → engine layout. Base row for common-size: first REVENUE / ASSET accounts row. */
export function fromCustom(c: CustomLayout): Layout {
  const base = c.rows.find(
    (r) => r.kind === 'accounts' && (r.select.types ?? []).includes(c.statement === 'PNL' ? 'REVENUE' : 'ASSET'),
  );
  const keys = c.rows.filter((r) => r.kind === 'subtotal').map((r) => r.id).slice(-3);
  return { id: c.id, name: c.name, statement: c.statement, rows: c.rows as LayoutRow[], commonSizeBase: base?.id ?? null, keyRows: keys };
}

// ─── formula rows ───────────────────────────────────────────────────────────

type Tok = { t: 'num'; v: number } | { t: 'ref'; id: string } | { t: 'op'; v: '+' | '-' | '*' | '/' } | { t: 'lp' } | { t: 'rp' };

export class FormulaError extends Error {}

export function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '{') {
      const j = expr.indexOf('}', i);
      if (j < 0) throw new FormulaError('Unclosed { in formula');
      const id = expr.slice(i + 1, j).trim();
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) throw new FormulaError(`Bad row reference {${id}}`);
      out.push({ t: 'ref', id });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const v = Number(expr.slice(i, j));
      if (!Number.isFinite(v)) throw new FormulaError(`Bad number ${expr.slice(i, j)}`);
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    throw new FormulaError(`Unexpected "${c}" in formula`);
  }
  if (out.length === 0) throw new FormulaError('Empty formula');
  return out;
}

type Node = { k: 'num'; v: number } | { k: 'ref'; id: string } | { k: 'neg'; a: Node } | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node };

export function parseFormula(expr: string): Node {
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const expr_ = (): Node => {
    let a = term();
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '+' || (peek() as { v: string }).v === '-')) {
      const op = (toks[p++] as { v: '+' | '-' }).v;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  };
  const term = (): Node => {
    let a = factor();
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '*' || (peek() as { v: string }).v === '/')) {
      const op = (toks[p++] as { v: '*' | '/' }).v;
      a = { k: 'bin', op, a, b: factor() };
    }
    return a;
  };
  const factor = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaError('Formula ends unexpectedly');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'ref') return { k: 'ref', id: t.id };
    if (t.t === 'op' && t.v === '-') return { k: 'neg', a: factor() };
    if (t.t === 'lp') {
      const n = expr_();
      if (toks[p++]?.t !== 'rp') throw new FormulaError('Missing )');
      return n;
    }
    throw new FormulaError('Unexpected token in formula');
  };
  const n = expr_();
  if (p !== toks.length) throw new FormulaError('Unexpected trailing input in formula');
  return n;
}

export function formulaRefs(expr: string): string[] {
  return tokenize(expr).filter((t): t is { t: 'ref'; id: string } => t.t === 'ref').map((t) => t.id);
}

/** Evaluate; a missing ref or ÷0 yields null (never Infinity / NaN). */
export function evalFormula(node: Node, ref: (id: string) => number | null): number | null {
  switch (node.k) {
    case 'num': return node.v;
    case 'ref': return ref(node.id);
    case 'neg': {
      const a = evalFormula(node.a, ref);
      return a == null ? null : -a;
    }
    case 'bin': {
      const a = evalFormula(node.a, ref);
      const b = evalFormula(node.b, ref);
      if (a == null || b == null) return null;
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (b === 0) return null;
      return a / b;
    }
  }
}

// ─── custom layout validation (on save) ─────────────────────────────────────

export interface LayoutIssue {
  rowId: string | null;
  message: string;
}

const ROW_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_LAYOUT_ROWS = 300;

/** Validate a custom layout. Empty list = valid. Rejects duplicate ids, dangling refs and cycles. */
export function validateLayout(rows: LayoutRowDef[], statement: 'PNL' | 'BS'): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (!Array.isArray(rows) || rows.length === 0) return [{ rowId: null, message: 'A layout needs at least one row.' }];
  if (rows.length > MAX_LAYOUT_ROWS) issues.push({ rowId: null, message: `At most ${MAX_LAYOUT_ROWS} rows.` });
  const ids = new Set<string>();
  for (const r of rows) {
    if (!ROW_ID_RE.test(r.id)) issues.push({ rowId: r.id, message: `Row id "${r.id}" must be lowercase letters, digits or _ (max 40).` });
    if (ids.has(r.id)) issues.push({ rowId: r.id, message: `Duplicate row id "${r.id}".` });
    ids.add(r.id);
    if (r.kind !== 'spacer' && (!r.label || r.label.length > 120)) issues.push({ rowId: r.id, message: 'Every row needs a label (max 120 characters).' });
  }
  const deps = new Map<string, string[]>();
  for (const r of rows) {
    if (r.kind === 'accounts') {
      const s = r.select;
      const any = s.types?.length || s.subTypes?.length || s.groupIds?.length || s.roles?.length || s.accountIds?.length || s.ranges?.length || s.synthetic?.length;
      if (!any) issues.push({ rowId: r.id, message: 'Choose which accounts this row includes.' });
      if (r.sign !== 1 && r.sign !== -1) issues.push({ rowId: r.id, message: 'Sign must be +1 or −1.' });
      if (statement === 'PNL' && s.synthetic?.length) issues.push({ rowId: r.id, message: 'Earnings-not-yet-closed rows belong on a balance sheet layout.' });
      for (const rg of s.ranges ?? []) {
        if (!rg.from || !rg.to) issues.push({ rowId: r.id, message: 'An account range needs a from and a to number.' });
      }
    }
    if (r.kind === 'subtotal') {
      if (!r.of?.length) issues.push({ rowId: r.id, message: 'A subtotal must add up at least one row.' });
      for (const o of r.of ?? []) if (!ids.has(o.id)) issues.push({ rowId: r.id, message: `Subtotal refers to unknown row "${o.id}".` });
      deps.set(r.id, (r.of ?? []).map((o) => o.id));
    }
    if (r.kind === 'formula') {
      try {
        parseFormula(r.expr);
        const refs = formulaRefs(r.expr);
        for (const id of refs) if (!ids.has(id)) issues.push({ rowId: r.id, message: `Formula refers to unknown row "${id}".` });
        deps.set(r.id, refs);
      } catch (e) {
        issues.push({ rowId: r.id, message: e instanceof Error ? e.message : 'Invalid formula' });
      }
    }
  }
  // cycle detection (DFS)
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      issues.push({ rowId: id, message: `Circular reference: ${[...path, id].join(' → ')}` });
      return;
    }
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const id of deps.keys()) visit(id, []);
  return issues;
}

/** Topological evaluation order for subtotal / formula rows (accounts rows first). */
export function evaluationOrder(rows: LayoutRow[]): string[] {
  const deps = new Map<string, string[]>();
  for (const r of rows) {
    if (r.kind === 'subtotal') deps.set(r.id, r.of.map((o) => o.id));
    else if (r.kind === 'formula') deps.set(r.id, formulaRefs(r.expr));
    else deps.set(r.id, []);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, stack: Set<string>) => {
    if (seen.has(id) || stack.has(id)) return;
    stack.add(id);
    for (const d of deps.get(id) ?? []) visit(d, stack);
    stack.delete(id);
    seen.add(id);
    out.push(id);
  };
  for (const r of rows) visit(r.id, new Set());
  return out;
}
