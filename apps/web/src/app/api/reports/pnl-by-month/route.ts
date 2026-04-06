export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const schema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  department_id: z.string().optional(),
  class_id: z.string().optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  basis: z.enum(['accrual', 'cash']).optional(),
});

function pad(n: number) { return String(n).padStart(2, '0'); }

export const GET = apiQueryHandler(
  schema,
  async (params, ctx) => {
    const year = parseInt(params.year ?? String(new Date().getFullYear()), 10);
    const basis = params.basis ?? 'accrual';

    // Resolve location filter
    const locationIds: string[] = [];
    if (params.location_ids) {
      locationIds.push(...params.location_ids.split(',').filter(Boolean));
    } else if (params.location_id && params.location_id !== 'all') {
      locationIds.push(params.location_id);
    }

    // Query all GL entry lines for the full year
    let query = ctx.supabase
      .from('gl_entry_lines')
      .select(`
        account_id,
        debit_cents,
        credit_cents,
        gl_entry_id,
        accounts!inner(
          account_number,
          name,
          account_type,
          account_groups!inner(
            name,
            display_order,
            account_sub_types!inner(
              account_types!inner(
                normal_balance,
                display_order
              )
            )
          )
        ),
        gl_entries!inner(
          id,
          entry_date,
          status
        )
      `)
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', `${year}-01-01`)
      .lte('gl_entries.entry_date', `${year}-12-31`)
      .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

    if (locationIds.length === 1) {
      query = query.eq('location_id', locationIds[0]);
    } else if (locationIds.length > 1) {
      query = query.in('location_id', locationIds);
    }
    if (params.department_id) query = query.eq('department_id', params.department_id);
    if (params.class_id) query = query.eq('class_id', params.class_id);

    const { data, error } = await query;

    if (error) {
      console.error('[pnl-by-month] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    let filteredData = data ?? [];

    // Cash basis filter
    if (basis === 'cash' && filteredData.length > 0) {
      const entryIds = [...new Set(filteredData.map((line: Record<string, unknown>) => {
        const entry = line.gl_entries as unknown as Record<string, unknown>;
        return entry.id as string;
      }))];

      const { data: bankTxns } = await ctx.supabase
        .from('bank_transactions')
        .select('gl_entry_id')
        .in('gl_entry_id', entryIds)
        .in('status', ['APPROVED', 'CATEGORIZED', 'RECONCILED']);

      const cashEntryIds = new Set((bankTxns ?? []).map((t: Record<string, unknown>) => t.gl_entry_id as string));
      filteredData = filteredData.filter((line: Record<string, unknown>) => {
        const entry = line.gl_entries as unknown as Record<string, unknown>;
        return cashEntryIds.has(entry.id as string);
      });
    }

    // Build monthly buckets: accountNumber → month(0-11) → amount
    const accountMeta = new Map<string, {
      accountId: string;
      accountNumber: string;
      accountName: string;
      accountType: string;
      groupName: string;
      groupOrder: number;
      normalBalance: string;
    }>();

    const monthlyAmounts = new Map<string, number[]>(); // accountNumber → [12 months]

    for (const line of filteredData) {
      const acct = line.accounts as unknown as Record<string, unknown>;
      const group = acct.account_groups as Record<string, unknown>;
      const subType = group.account_sub_types as Record<string, unknown>;
      const acctType = subType.account_types as Record<string, unknown>;
      const acctNum = acct.account_number as string;
      const entryDate = (line.gl_entries as unknown as Record<string, unknown>).entry_date as string;
      const monthIdx = parseInt(entryDate.slice(5, 7), 10) - 1; // 0-based

      if (!accountMeta.has(acctNum)) {
        accountMeta.set(acctNum, {
          accountId: line.account_id as string,
          accountNumber: acctNum,
          accountName: acct.name as string,
          accountType: acct.account_type as string,
          groupName: group.name as string,
          groupOrder: group.display_order as number,
          normalBalance: acctType.normal_balance as string,
        });
        monthlyAmounts.set(acctNum, new Array(12).fill(0));
      }

      const months = monthlyAmounts.get(acctNum)!;
      const normalBalance = accountMeta.get(acctNum)!.normalBalance;
      const amount = normalBalance === 'CREDIT'
        ? Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0)
        : Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);
      months[monthIdx] += amount;
    }

    // Build rows grouped by section
    const sectionConfig = [
      { type: 'REVENUE', label: 'Revenue' },
      { type: 'COGS', label: 'Cost of Goods Sold' },
      { type: 'OPEX', label: 'Operating Expenses' },
      { type: 'OTHER', label: 'Other Income / Expense' },
    ];

    const sections = sectionConfig.map((cfg) => {
      const accounts = Array.from(accountMeta.values())
        .filter((a) => a.accountType === cfg.type)
        .sort((a, b) => a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber))
        .map((a) => ({
          accountId: a.accountId,
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          groupName: a.groupName,
          months: monthlyAmounts.get(a.accountNumber)!,
          totalCents: monthlyAmounts.get(a.accountNumber)!.reduce((s, m) => s + m, 0),
        }));

      const sectionMonths = new Array(12).fill(0);
      for (const a of accounts) {
        for (let i = 0; i < 12; i++) sectionMonths[i] += a.months[i];
      }

      return {
        type: cfg.type,
        label: cfg.label,
        accounts,
        months: sectionMonths,
        totalCents: sectionMonths.reduce((s, m) => s + m, 0),
      };
    });

    // Compute summary rows
    const revenueMonths = sections.find((s) => s.type === 'REVENUE')?.months ?? new Array(12).fill(0);
    const cogsMonths = sections.find((s) => s.type === 'COGS')?.months ?? new Array(12).fill(0);
    const opexMonths = sections.find((s) => s.type === 'OPEX')?.months ?? new Array(12).fill(0);
    const otherMonths = sections.find((s) => s.type === 'OTHER')?.months ?? new Array(12).fill(0);

    const grossProfitMonths = revenueMonths.map((r: number, i: number) => r - cogsMonths[i]);
    const netIncomeMonths = grossProfitMonths.map((gp: number, i: number) => gp - opexMonths[i] - otherMonths[i]);

    const monthHeaders = Array.from({ length: 12 }, (_, i) =>
      new Date(year, i).toLocaleString('en', { month: 'short' })
    );

    return NextResponse.json({
      year,
      basis,
      monthHeaders,
      sections,
      summaryRows: {
        grossProfit: { label: 'Gross Profit', months: grossProfitMonths, totalCents: grossProfitMonths.reduce((s: number, m: number) => s + m, 0) },
        netIncome: { label: 'Net Income', months: netIncomeMonths, totalCents: netIncomeMonths.reduce((s: number, m: number) => s + m, 0) },
      },
      filters: { year, basis, locationIds: locationIds.length > 0 ? locationIds : ['all'] },
    });
  }
);
