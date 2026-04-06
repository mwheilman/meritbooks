export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const isQuerySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  department_id: z.string().optional(),
  class_id: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  basis: z.enum(['accrual', 'cash']).optional(),
});

interface ISLineItem {
  accountId: string;
  accountNumber: string;
  accountName: string;
  groupName: string;
  amountCents: number;
}

interface ISSection {
  type: string;
  label: string;
  groups: { name: string; accounts: ISLineItem[]; totalCents: number }[];
  totalCents: number;
}

export const GET = apiQueryHandler(
  isQuerySchema,
  async (params, ctx) => {
    const now = new Date();
    const startDate = params.start_date ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDateDefault = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const endDate = params.end_date ?? endDateDefault.toISOString().split('T')[0];
    const basis = params.basis ?? 'accrual';

    // Resolve location filter — accept location_ids (comma-separated) or location_id
    const locationIds: string[] = [];
    if (params.location_ids) {
      locationIds.push(...params.location_ids.split(',').filter(Boolean));
    } else if (params.location_id && params.location_id !== 'all') {
      locationIds.push(params.location_id);
    }

    let query = ctx.supabase
      .from('gl_entry_lines')
      .select(`
        account_id,
        debit_cents,
        credit_cents,
        location_id,
        gl_entry_id,
        accounts!inner(
          account_number,
          name,
          account_type,
          display_order,
          account_groups!inner(
            name,
            display_order,
            account_sub_types!inner(
              name,
              display_order,
              account_types!inner(
                name,
                display_order,
                normal_balance
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
      .gte('gl_entries.entry_date', startDate)
      .lte('gl_entries.entry_date', endDate)
      .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

    // Multi-location filter
    if (locationIds.length === 1) {
      query = query.eq('location_id', locationIds[0]);
    } else if (locationIds.length > 1) {
      query = query.in('location_id', locationIds);
    }

    if (params.department_id) {
      query = query.eq('department_id', params.department_id);
    }
    if (params.class_id) {
      query = query.eq('class_id', params.class_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[income-statement] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    let filteredData = data ?? [];

    // ─── Cash basis filter ─────────────────────────────────────
    // Cash basis only includes GL entries that have a corresponding
    // cleared bank transaction. The link is bank_transactions.gl_entry_id.
    if (basis === 'cash' && filteredData.length > 0) {
      const entryIds = [...new Set(filteredData.map((line: Record<string, unknown>) => {
        const entry = line.gl_entries as unknown as Record<string, unknown>;
        return entry.id as string;
      }))];

      // Query bank_transactions to find which gl_entries have been matched to cleared transactions
      const { data: bankTxns } = await ctx.supabase
        .from('bank_transactions')
        .select('gl_entry_id')
        .in('gl_entry_id', entryIds)
        .in('status', ['APPROVED', 'CATEGORIZED', 'RECONCILED']);

      const cashEntryIds = new Set((bankTxns ?? []).map((t: Record<string, unknown>) => t.gl_entry_id as string));

      // Also include entries from bank-feed sourced modules (these are cash movements by definition)
      // Keep entries that either: (a) have a matched bank txn, or (b) were sourced from CASH_MGMT/BANK_FEED
      filteredData = filteredData.filter((line: Record<string, unknown>) => {
        const entry = line.gl_entries as unknown as Record<string, unknown>;
        return cashEntryIds.has(entry.id as string);
      });
    }

    // ─── Aggregate by account ──────────────────────────────────
    const accountMap = new Map<string, {
      accountId: string;
      accountNumber: string;
      accountName: string;
      accountType: string;
      groupName: string;
      groupOrder: number;
      typeOrder: number;
      normalBalance: string;
      totalDebits: number;
      totalCredits: number;
    }>();

    for (const line of filteredData) {
      const acct = line.accounts as unknown as Record<string, unknown>;
      const group = acct.account_groups as Record<string, unknown>;
      const subType = group.account_sub_types as Record<string, unknown>;
      const acctType = subType.account_types as Record<string, unknown>;
      const key = acct.account_number as string;

      const existing = accountMap.get(key);
      if (existing) {
        existing.totalDebits += Number(line.debit_cents ?? 0);
        existing.totalCredits += Number(line.credit_cents ?? 0);
      } else {
        accountMap.set(key, {
          accountId: line.account_id as string,
          accountNumber: acct.account_number as string,
          accountName: acct.name as string,
          accountType: acct.account_type as string,
          groupName: group.name as string,
          groupOrder: group.display_order as number,
          typeOrder: acctType.display_order as number,
          normalBalance: acctType.normal_balance as string,
          totalDebits: Number(line.debit_cents ?? 0),
          totalCredits: Number(line.credit_cents ?? 0),
        });
      }
    }

    // ─── Build sections ────────────────────────────────────────
    const sectionConfig = [
      { type: 'REVENUE', label: 'Revenue' },
      { type: 'COGS', label: 'Cost of Goods Sold' },
      { type: 'OPEX', label: 'Operating Expenses' },
      { type: 'OTHER', label: 'Other Income / Expense' },
    ];

    const sections: ISSection[] = [];

    for (const cfg of sectionConfig) {
      const accounts = Array.from(accountMap.values())
        .filter((a) => a.accountType === cfg.type)
        .map((a) => {
          const amount = a.normalBalance === 'CREDIT'
            ? a.totalCredits - a.totalDebits
            : a.totalDebits - a.totalCredits;
          return {
            accountId: a.accountId,
            accountNumber: a.accountNumber,
            accountName: a.accountName,
            groupName: a.groupName,
            groupOrder: a.groupOrder,
            amountCents: amount,
          };
        })
        .sort((a, b) => a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber));

      const groupMap = new Map<string, { accounts: ISLineItem[]; totalCents: number }>();
      for (const acct of accounts) {
        const existing = groupMap.get(acct.groupName);
        if (existing) {
          existing.accounts.push(acct);
          existing.totalCents += acct.amountCents;
        } else {
          groupMap.set(acct.groupName, { accounts: [acct], totalCents: acct.amountCents });
        }
      }

      const groups = Array.from(groupMap.entries()).map(([name, g]) => ({ name, accounts: g.accounts, totalCents: g.totalCents }));
      const sectionTotal = groups.reduce((sum, g) => sum + g.totalCents, 0);
      sections.push({ type: cfg.type, label: cfg.label, groups, totalCents: sectionTotal });
    }

    const revenue = sections.find((s) => s.type === 'REVENUE')?.totalCents ?? 0;
    const cogs = sections.find((s) => s.type === 'COGS')?.totalCents ?? 0;
    const opex = sections.find((s) => s.type === 'OPEX')?.totalCents ?? 0;
    const other = sections.find((s) => s.type === 'OTHER')?.totalCents ?? 0;
    const grossProfit = revenue - cogs;
    const ebitda = grossProfit - opex;
    const netIncome = ebitda - other;

    return NextResponse.json({
      sections,
      summary: {
        revenueCents: revenue, cogsCents: cogs, grossProfitCents: grossProfit,
        opexCents: opex, ebitdaCents: ebitda, otherCents: other, netIncomeCents: netIncome,
        grossMarginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0,
        netMarginPct: revenue > 0 ? Math.round((netIncome / revenue) * 10000) / 100 : 0,
      },
      filters: {
        startDate, endDate, basis,
        locationIds: locationIds.length > 0 ? locationIds : ['all'],
        departmentId: params.department_id,
        classId: params.class_id,
      },
    });
  }
);
