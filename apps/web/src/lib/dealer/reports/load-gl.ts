/**
 * Loader for R7 Departmental P&L — the SAME ledger read the income statement makes
 * (posted lines, entry date in the period, REVENUE / COGS / OPEX / OTHER accounts,
 * the account-group chain inner-joined exactly as /api/reports/income-statement
 * does), scoped to this client, so the Total column ties to the client P&L.
 */

import type { DeptRole } from '@/lib/dealer/types';
import type { DealerReport } from './catalog';
import { buildDeptPnl, type PnlLineIn } from './build-dept-pnl';
import { all, departmentNames, num, str, type ReportCtx, type Row } from './load-shared';

const PNL_SELECT = `
  id,
  account_id,
  department_id,
  debit_cents,
  credit_cents,
  accounts!inner(
    account_number,
    name,
    account_type,
    account_groups!inner(
      account_sub_types!inner(
        account_types!inner(normal_balance)
      )
    )
  ),
  gl_entries!inner(entry_date, status)
`;

function normalBalance(acct: Row): string {
  const g = acct.account_groups as Row | null;
  const st = g?.account_sub_types as Row | null;
  const t = st?.account_types as Row | null;
  return String(t?.normal_balance ?? (acct.account_type === 'REVENUE' ? 'CREDIT' : 'DEBIT'));
}

export async function loadDeptPnl(d: ReportCtx, start: string, end: string, entityLabel: string): Promise<DealerReport> {
  const [lines, mapRows] = await Promise.all([
    all('Ledger lines', () =>
      d.db
        .from('gl_entry_lines')
        .select(PNL_SELECT)
        .eq('org_id', d.orgId)
        .eq('location_id', d.locationId)
        .eq('gl_entries.status', 'POSTED')
        .gte('gl_entries.entry_date', start)
        .lte('gl_entries.entry_date', end)
        .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']),
    ),
    all('Department map', () => d.db.from('dealer_department_map').select('id, dept_role, department_id').eq('org_id', d.orgId).eq('location_id', d.locationId)),
  ]);
  const deptMap = mapRows.map((m) => ({ dept_role: m.dept_role as DeptRole, department_id: m.department_id as string }));
  const names = await departmentNames(d, deptMap.map((m) => m.department_id));
  const pnlLines: PnlLineIn[] = lines.map((l) => {
    const acct = (l.accounts ?? {}) as Row;
    return {
      account_id: l.account_id as string,
      account_number: String(acct.account_number ?? ''),
      account_name: String(acct.name ?? 'Account'),
      account_type: acct.account_type as PnlLineIn['account_type'],
      normal_balance: normalBalance(acct),
      department_id: str(l.department_id),
      debit_cents: num(l.debit_cents),
      credit_cents: num(l.credit_cents),
    };
  });
  return buildDeptPnl({ start, end, entityLabel, lines: pnlLines, deptMap, departmentNames: names });
}
