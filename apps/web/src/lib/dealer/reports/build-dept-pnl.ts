/**
 * R7 Departmental P&L with service absorption — pure builder.
 *
 * Columns = the client's mapped departments (dealer_department_map, in department-
 * role order; roles mapped to the same department share one column) + Unassigned
 * (no department, or a department outside the map) + Total. Amounts follow the
 * income statement exactly (each account type's normal balance; net income =
 * revenue − cost of sales − operating expenses − other), so the Total column foots
 * to the client's P&L for the same period.
 *
 * Service absorption = (parts + service gross profit) ÷ fixed expenses, where fixed
 * expenses = operating expenses in the administration department column + operating
 * expenses with no department. A ratio only — nothing is allocated.
 */

import { DEPT_ROLES, type DeptRole } from '@/lib/dealer/types';
import { DEPT_ROLE } from '@/lib/dealer/ui/labels';
import type { DealerReport, DealerReportColumn, DealerReportRow } from './catalog';
import { centsLabel, makeReport } from './build-floor-plan';
import { pctLabel, ratioBps, row, spacer } from './model';

export interface PnlLineIn {
  account_id: string;
  account_number: string;
  account_name: string;
  account_type: 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';
  /** account_types.normal_balance — CREDIT or DEBIT. */
  normal_balance: string;
  department_id: string | null;
  debit_cents: number;
  credit_cents: number;
}

export interface DeptPnlInput {
  start: string;
  end: string;
  entityLabel: string;
  lines: PnlLineIn[];
  deptMap: Array<{ dept_role: DeptRole; department_id: string }>;
  departmentNames: Map<string, string>;
}

export const UNASSIGNED = 'unassigned';

export interface DeptColumn {
  key: string;
  departmentId: string | null;
  roles: DeptRole[];
}

export function deptColumns(map: DeptPnlInput['deptMap']): DeptColumn[] {
  const byDept = new Map<string, DeptRole[]>();
  for (const r of DEPT_ROLES) {
    const m = map.find((x) => x.dept_role === r);
    if (!m) continue;
    byDept.set(m.department_id, [...(byDept.get(m.department_id) ?? []), r]);
  }
  const cols: DeptColumn[] = [...byDept.entries()].map(([departmentId, roles]) => ({ key: `d:${departmentId}`, departmentId, roles }));
  cols.push({ key: UNASSIGNED, departmentId: null, roles: [] });
  return cols;
}

const SECTIONS: Array<{ type: PnlLineIn['account_type']; label: string; total: string }> = [
  { type: 'REVENUE', label: 'Revenue', total: 'Total revenue' },
  { type: 'COGS', label: 'Cost of sales', total: 'Total cost of sales' },
  { type: 'OPEX', label: 'Operating expenses', total: 'Total operating expenses' },
  { type: 'OTHER', label: 'Other income / expense', total: 'Total other' },
];

export function buildDeptPnl(input: DeptPnlInput): DealerReport {
  const dcols = deptColumns(input.deptMap);
  const colOfDept = new Map<string, string>();
  for (const c of dcols) if (c.departmentId) colOfDept.set(c.departmentId, c.key);
  const cols: DealerReportColumn[] = [
    ...dcols.map((c) => ({
      key: c.key,
      label: c.departmentId ? c.roles.map((r) => DEPT_ROLE[r].label).join(' / ') : 'Unassigned',
      kind: 'money' as const,
    })),
    { key: 'total', label: 'Total', kind: 'money' },
  ];

  // account → column → amount (normal-balance sign, as the income statement does).
  type Acct = { number: string; name: string; type: PnlLineIn['account_type']; by: Map<string, number> };
  const accts = new Map<string, Acct>();
  for (const l of input.lines) {
    const amt = l.normal_balance === 'CREDIT' ? l.credit_cents - l.debit_cents : l.debit_cents - l.credit_cents;
    const col = (l.department_id && colOfDept.get(l.department_id)) || UNASSIGNED;
    const a = accts.get(l.account_id) ?? { number: l.account_number, name: l.account_name, type: l.account_type, by: new Map<string, number>() };
    a.by.set(col, (a.by.get(col) ?? 0) + amt);
    accts.set(l.account_id, a);
  }
  const vals = (by: Map<string, number>) => {
    const v: Record<string, number> = {};
    let t = 0;
    for (const c of dcols) {
      const x = by.get(c.key) ?? 0;
      v[c.key] = x;
      t += x;
    }
    v.total = t;
    return v;
  };
  const sectionTotals = new Map<string, Map<string, number>>();
  const rows: DealerReportRow[] = [];
  const combine = (sign: Record<string, number>) => {
    const out = new Map<string, number>();
    for (const c of dcols) {
      let x = 0;
      for (const [type, s] of Object.entries(sign)) x += s * (sectionTotals.get(type)?.get(c.key) ?? 0);
      out.set(c.key, x);
    }
    return out;
  };

  for (const s of SECTIONS) {
    const list = [...accts.values()].filter((a) => a.type === s.type).sort((a, b) => a.number.localeCompare(b.number));
    const tot = new Map<string, number>();
    for (const a of list) for (const [k, x] of a.by) tot.set(k, (tot.get(k) ?? 0) + x);
    sectionTotals.set(s.type, tot);
    if (list.length === 0 && s.type === 'OTHER') continue;
    rows.push(row('section', s.label, cols, {}));
    for (const a of list) rows.push(row('account', a.name, cols, vals(a.by), { code: a.number, indent: 1 }));
    rows.push(row('subtotal', s.total, cols, vals(tot)));
    if (s.type === 'COGS') {
      rows.push(row('subtotal', 'Gross profit', cols, vals(combine({ REVENUE: 1, COGS: -1 }))));
      rows.push(spacer(cols));
    }
    if (s.type === 'OPEX') {
      rows.push(row('subtotal', 'Operating income', cols, vals(combine({ REVENUE: 1, COGS: -1, OPEX: -1 }))));
      rows.push(spacer(cols));
    }
  }
  const net = vals(combine({ REVENUE: 1, COGS: -1, OPEX: -1, OTHER: -1 }));
  if (accts.size > 0) rows.push(row('total', 'Net income', cols, net));

  // Service absorption.
  const gp = combine({ REVENUE: 1, COGS: -1 });
  const opex = sectionTotals.get('OPEX') ?? new Map<string, number>();
  const colFor = (r: DeptRole) => dcols.find((c) => c.roles.includes(r))?.key ?? null;
  const psCols = [...new Set([colFor('PARTS'), colFor('SERVICE')].filter((x): x is string => !!x))];
  const adminCol = colFor('ADMIN');
  const fixedCols = [...new Set([adminCol, UNASSIGNED].filter((x): x is string => !!x))];
  const fixedPartsOverlap = !!adminCol && psCols.includes(adminCol);
  const fixedExpenses = fixedCols.reduce((s, k) => s + (opex.get(k) ?? 0), 0);
  const fixedGross = psCols.reduce((s, k) => s + (gp.get(k) ?? 0), 0);
  const absorption = ratioBps(fixedGross, fixedExpenses);
  const kpis = [
    {
      label: 'Service absorption',
      value: absorption == null ? 'Not measurable (no fixed expenses in the period)' : pctLabel(absorption),
      hint: `parts + service gross profit ${centsLabel(fixedGross)} ÷ fixed expenses ${centsLabel(fixedExpenses)}`,
    },
  ];
  const nameOf = (c: DeptColumn) => (c.departmentId ? input.departmentNames.get(c.departmentId) ?? 'department' : '');
  const mapping = dcols
    .filter((c) => c.departmentId)
    .map((c) => `${c.roles.map((r) => DEPT_ROLE[r].label).join(' / ')} = ${nameOf(c)}`)
    .join('; ');
  const notes = [
    'Service absorption = (parts gross profit + service gross profit) ÷ fixed expenses. Fixed expenses here = operating expenses in the administration department column plus operating expenses with no department. It is a ratio only — no cost is allocated between departments.',
    'Amounts are posted general-ledger activity for this client in the period; the Total column ties to the client’s profit and loss for the same dates. Unassigned holds lines with no department or a department outside the dealer department map.',
  ];
  if (mapping) notes.push(`Department map: ${mapping}.`);
  if (fixedPartsOverlap) notes.push('Administration shares a department with parts or service, so service absorption mixes fixed and departmental costs — map administration to its own department for a clean ratio.');
  if (!psCols.length) notes.push('Parts and service are not mapped to departments, so service absorption is zero.');
  return makeReport('dealer_dept_pnl', input.entityLabel, { start: input.start, end: input.end }, cols, rows, notes, kpis);
}
