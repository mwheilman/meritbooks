export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const bsQuerySchema = z.object({
  location_id: z.string().optional(),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

interface BSLineItem {
  accountId: string;
  accountNumber: string;
  accountName: string;
  groupName: string;
  balanceCents: number;
}

interface BSGroup {
  name: string;
  accounts: BSLineItem[];
  totalCents: number;
}

interface BSSubType {
  name: string;
  groups: BSGroup[];
  totalCents: number;
}

interface BSSection {
  type: string;
  label: string;
  subTypes: BSSubType[];
  totalCents: number;
}

export const GET = apiQueryHandler(
  bsQuerySchema,
  async (params, ctx) => {
    const asOfDate = params.as_of_date ?? new Date().toISOString().split('T')[0];

    // Query all BS account lines up to the as-of date
    let query = ctx.supabase
      .from('gl_entry_lines')
      .select(`
        account_id,
        debit_cents,
        credit_cents,
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
                normal_balance,
                display_order
              )
            )
          )
        ),
        gl_entries!inner(
          entry_date,
          status
        )
      `)
      .eq('gl_entries.status', 'POSTED')
      .lte('gl_entries.entry_date', asOfDate)
      .in('accounts.account_type', ['ASSET', 'LIABILITY', 'EQUITY']);

    if (params.location_id && params.location_id !== 'all') {
      query = query.eq('location_id', params.location_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[balance-sheet] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Aggregate by account
    const accountMap = new Map<string, {
      accountId: string;
      accountNumber: string;
      accountName: string;
      accountType: string;
      groupName: string;
      subTypeName: string;
      groupOrder: number;
      subTypeOrder: number;
      typeOrder: number;
      normalBalance: string;
      totalDebits: number;
      totalCredits: number;
    }>();

    for (const line of data ?? []) {
      const acct = line.accounts as any;
      const group = acct.account_groups;
      const subType = group.account_sub_types;
      const acctType = subType.account_types;
      const key = acct.account_number;

      const existing = accountMap.get(key);
      if (existing) {
        existing.totalDebits += Number(line.debit_cents ?? 0);
        existing.totalCredits += Number(line.credit_cents ?? 0);
      } else {
        accountMap.set(key, {
          accountId: line.account_id,
          accountNumber: acct.account_number,
          accountName: acct.name,
          accountType: acct.account_type,
          groupName: group.name,
          subTypeName: subType.name,
          groupOrder: group.display_order,
          subTypeOrder: subType.display_order,
          typeOrder: acctType.display_order,
          normalBalance: acctType.normal_balance,
          totalDebits: Number(line.debit_cents ?? 0),
          totalCredits: Number(line.credit_cents ?? 0),
        });
      }
    }

    // Build sections: Asset, Liability, Equity
    const sectionConfig = [
      { type: 'ASSET', label: 'Assets' },
      { type: 'LIABILITY', label: 'Liabilities' },
      { type: 'EQUITY', label: 'Equity' },
    ];

    const sections: BSSection[] = [];

    for (const cfg of sectionConfig) {
      const accounts = Array.from(accountMap.values())
        .filter((a) => a.accountType === cfg.type)
        .map((a) => {
          const balance = a.normalBalance === 'DEBIT'
            ? a.totalDebits - a.totalCredits
            : a.totalCredits - a.totalDebits;
          return { ...a, balanceCents: balance };
        })
        .sort((a, b) => a.subTypeOrder - b.subTypeOrder || a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber));

      // Group by subtype → group
      const subTypeMap = new Map<string, Map<string, BSLineItem[]>>();
      for (const acct of accounts) {
        if (!subTypeMap.has(acct.subTypeName)) subTypeMap.set(acct.subTypeName, new Map());
        const groupMap = subTypeMap.get(acct.subTypeName)!;
        if (!groupMap.has(acct.groupName)) groupMap.set(acct.groupName, []);
        groupMap.get(acct.groupName)!.push({
          accountId: acct.accountId,
          accountNumber: acct.accountNumber,
          accountName: acct.accountName,
          groupName: acct.groupName,
          balanceCents: acct.balanceCents,
        });
      }

      const subTypes: BSSubType[] = [];
      for (const [stName, groupMap] of subTypeMap) {
        const groups: BSGroup[] = [];
        for (const [gName, accts] of groupMap) {
          groups.push({
            name: gName,
            accounts: accts,
            totalCents: accts.reduce((s, a) => s + a.balanceCents, 0),
          });
        }
        subTypes.push({
          name: stName,
          groups,
          totalCents: groups.reduce((s, g) => s + g.totalCents, 0),
        });
      }

      sections.push({
        type: cfg.type,
        label: cfg.label,
        subTypes,
        totalCents: subTypes.reduce((s, st) => s + st.totalCents, 0),
      });
    }

    const totalAssets = sections.find((s) => s.type === 'ASSET')?.totalCents ?? 0;
    const totalLiabilities = sections.find((s) => s.type === 'LIABILITY')?.totalCents ?? 0;
    const totalEquity = sections.find((s) => s.type === 'EQUITY')?.totalCents ?? 0;
    const isBalanced = totalAssets === totalLiabilities + totalEquity;

    return NextResponse.json({
      sections,
      summary: {
        totalAssetsCents: totalAssets,
        totalLiabilitiesCents: totalLiabilities,
        totalEquityCents: totalEquity,
        liabilitiesPlusEquityCents: totalLiabilities + totalEquity,
        isBalanced,
        varianceCents: totalAssets - (totalLiabilities + totalEquity),
      },
      filters: {
        asOfDate,
        locationId: params.location_id ?? 'all',
      },
    });
  }
);
