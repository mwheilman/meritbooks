export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { getOrgToday } from '@/lib/dates/org-today';
import { applyEarningsToBalanceSheet, fetchUnclosedEarnings } from '@/lib/reports/bs-earnings';
import { asOfMonth, governRoute } from '@/lib/reports/governance/route-guard';

const bsQuerySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.string().optional(),
});

interface BSLineItem {
  accountId: string;
  accountNumber: string;
  accountName: string;
  groupName: string;
  balanceCents: number;
  /** Presentation line with no GL account (e.g. "Net income (current year)"). */
  synthetic?: boolean;
}

interface BSGroup { name: string; accounts: BSLineItem[]; totalCents: number }
interface BSSubType { name: string; groups: BSGroup[]; totalCents: number }
interface BSSection { type: string; label: string; subTypes: BSSubType[]; totalCents: number }

export const GET = apiQueryHandler(
  bsQuerySchema,
  async (params, ctx) => {
    // Default as-of = today in the ORG's timezone (not the server's UTC date).
    const asOfDate = params.as_of_date ?? (await getOrgToday(ctx.supabase, ctx.orgId));

    // Resolve location filter
    const locationIds: string[] = [];
    if (params.location_ids) {
      locationIds.push(...params.location_ids.split(',').filter(Boolean));
    } else if (params.location_id && params.location_id !== 'all') {
      locationIds.push(params.location_id);
    }

    // Number governance: a balance as of a month needs every month through it released
    // (cumulative rule) for a non-finance caller — else 403 NOT_RELEASED, no figures.
    const gov = await governRoute(
      { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId },
      { months: [asOfMonth(asOfDate)], locationIds, cumulative: true },
    );
    if (gov instanceof NextResponse) return gov;

    // Paged read: PostgREST caps a response at 1,000 rows, so an unpaged read
    // silently truncates the ledger once a company passes 1,000 lines.
    const buildQuery = () => {
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

      if (locationIds.length === 1) {
        query = query.eq('location_id', locationIds[0]);
      } else if (locationIds.length > 1) {
        query = query.in('location_id', locationIds);
      }
      return query;
    };

    const { data, error } = await fetchAll(buildQuery, { label: 'balance-sheet gl_entry_lines' });

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
          subTypeName: subType.name as string,
          groupOrder: group.display_order as number,
          subTypeOrder: subType.display_order as number,
          typeOrder: acctType.display_order as number,
          normalBalance: acctType.normal_balance as string,
          totalDebits: Number(line.debit_cents ?? 0),
          totalCredits: Number(line.credit_cents ?? 0),
        });
      }
    }

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
          groups.push({ name: gName, accounts: accts, totalCents: accts.reduce((s, a) => s + a.balanceCents, 0) });
        }
        subTypes.push({ name: stName, groups, totalCents: groups.reduce((s, g) => s + g.totalCents, 0) });
      }

      sections.push({
        type: cfg.type, label: cfg.label, subTypes,
        totalCents: subTypes.reduce((s, st) => s + st.totalCents, 0),
      });
    }

    const totalAssets = sections.find((s) => s.type === 'ASSET')?.totalCents ?? 0;
    const totalLiabilities = sections.find((s) => s.type === 'LIABILITY')?.totalCents ?? 0;
    const totalEquity = sections.find((s) => s.type === 'EQUITY')?.totalCents ?? 0;

    const booked = {
      sections,
      summary: {
        totalAssetsCents: totalAssets,
        totalLiabilitiesCents: totalLiabilities,
        totalEquityCents: totalEquity,
        liabilitiesPlusEquityCents: totalLiabilities + totalEquity,
        isBalanced: totalAssets === totalLiabilities + totalEquity,
        varianceCents: totalAssets - (totalLiabilities + totalEquity),
      },
    };

    // Equity must carry the earnings not yet closed to retained earnings — prior
    // years (until the year-end close posts) + current-year net income — or the
    // statement is off by exactly cumulative net income (audit L5).
    let presented: typeof booked;
    try {
      const earnings = await fetchUnclosedEarnings(ctx.supabase, ctx.orgId, { asOfDate, locationIds });
      presented = applyEarningsToBalanceSheet(booked, earnings);
    } catch (e) {
      console.error('[balance-sheet] earnings roll-in failed:', e);
      return NextResponse.json({ error: 'Failed to compute current-year earnings', code: 'QUERY_ERROR' }, { status: 500 });
    }

    return NextResponse.json({
      ...presented,
      filters: { asOfDate, locationIds: locationIds.length > 0 ? locationIds : ['all'] },
      governance: gov.info,
    });
  }
);
