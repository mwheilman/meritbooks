export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { governDateRange } from '@/lib/reports/governance/route-guard';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { z } from 'zod';
import { fetchAll } from '@/lib/supabase/fetch-all';

const querySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Account metadata needed to classify a line into a cash-flow section. */
interface AcctMeta {
  type: string;
  subType: string;
  isBank: boolean;
  name: string;
}

const isDepreciationName = (name: string) => {
  const n = name.toLowerCase();
  return n.includes('depreciation') || n.includes('amortization');
};
const isAccumulatedDepreciation = (name: string) => {
  const n = name.toLowerCase();
  return n.includes('accumulated') && isDepreciationName(n);
};

/**
 * Resolve a set of role keys to their account ids (RLS-scoped client), tolerating
 * unseeded roles. Used to identify cash / AR / AP families BY ROLE — never by a
 * hard-coded account-number range (CANON-ANCHOR §2: the COA is a per-tenant
 * template; account numbers are not guaranteed).
 */
async function resolveRoleIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orgId: string,
  roles: AccountRoleKey[]
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const role of roles) {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      ids.add(ref.id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
      // role not seeded in this tenant → nothing to add
    }
  }
  return ids;
}

export async function GET(request: Request) {
  // SECURITY: run AS THE USER so org_isolation RLS enforces tenant isolation on
  // every GL query. Was the RLS-bypassing admin client (FPB Dimension 15/AC15).
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));
  const locFilter = params.location_ids
    ? params.location_ids.split(",").filter(Boolean)
    : (params.location_id && params.location_id !== "all" ? [params.location_id] : []);

  // Number governance: the period's activity AND its beginning cash (a balance — cumulative
  // rule) must be released for a non-finance caller, else 403 NOT_RELEASED.
  const gov = await governDateRange(
    { supabase, orgId, userId: ctx.userId },
    { startDate: params.start_date, endDate: params.end_date, locationIds: locFilter, cumulative: true },
  );
  if (gov instanceof NextResponse) return gov;

  // Posted entries in the period (RLS scopes to this org). Only an EXISTENCE probe
  // now — the period's lines are read below by joining to gl_entries with the
  // same filters, paged, instead of an unbounded id list (PostgREST caps any
  // response at 1,000 rows, which silently truncated both the id list and lines).
  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', params.start_date)
    .lte('entry_date', params.end_date);
  if (locFilter.length === 1) entriesQ = entriesQ.eq("location_id", locFilter[0]);
  else if (locFilter.length > 1) entriesQ = entriesQ.in("location_id", locFilter);

  const { data: entryIds } = await entriesQ.limit(1);
  if (!entryIds || entryIds.length === 0) {
    return NextResponse.json({
      period: { startDate: params.start_date, endDate: params.end_date },
      operating: { netIncome: 0, adjustments: [], changesInWorkingCapital: [], totalCents: 0 },
      investing: { items: [], totalCents: 0 },
      financing: { items: [], totalCents: 0 },
      netChangeCents: 0,
      beginningCashCents: 0,
      endingCashCents: 0,
      governance: gov.info,
    });
  }

  // ── Account metadata map: classify BY TYPE / SUB-TYPE / ROLE, not by number ──
  const { data: accts } = await supabase
    .from('accounts')
    .select('id, account_type, account_sub_type, is_bank_account, name');
  const acctMeta = new Map<string, AcctMeta>();
  for (const a of accts ?? []) {
    acctMeta.set(a.id as string, {
      type: (a.account_type as string) ?? '',
      subType: (a.account_sub_type as string) ?? '',
      isBank: Boolean(a.is_bank_account),
      name: (a.name as string) ?? '',
    });
  }

  // Cash & cash-equivalents — the reconciling section, excluded from the buckets.
  // Identified by the bank-account flag plus the cash roles (never a number range).
  const cashIds = new Set<string>();
  for (const [id, m] of acctMeta) if (m.isBank) cashIds.add(id);
  if (orgId) {
    for (const id of await resolveRoleIds(supabase, orgId, ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'])) {
      cashIds.add(id);
    }
  }
  // AR / AP families, resolved by role (control + related sub-ledger accounts).
  const arIds = orgId
    ? await resolveRoleIds(supabase, orgId, ['AR_CONTROL', 'UNBILLED_RECEIVABLE', 'RETAINAGE_RECEIVABLE', 'ALLOWANCE_DOUBTFUL'])
    : new Set<string>();
  const apIds = orgId
    ? await resolveRoleIds(supabase, orgId, ['AP_CONTROL', 'RETAINAGE_PAYABLE', 'ACCRUED_EXPENSES'])
    : new Set<string>();

  // Every line of a POSTED entry in the period — identical row set to the old
  // `.in('gl_entry_id', <period entry ids>)`, expressed as an inner join on the
  // same entry filters so it can be paged.
  const { data: lines } = await fetchAll(() => {
    let q = supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents, gl_entries!inner(id)')
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', params.start_date)
      .lte('gl_entries.entry_date', params.end_date);
    if (locFilter.length === 1) q = q.eq('gl_entries.location_id', locFilter[0]);
    else if (locFilter.length > 1) q = q.in('gl_entries.location_id', locFilter);
    return q;
  }, { label: 'cash-flow period gl_entry_lines' });

  // Accumulators. Asset movements are stored as (debit − credit) = increase in the
  // asset; liability/equity movements as (credit − debit) = increase in the balance.
  let revenue = 0, cogs = 0, opex = 0, otherIncome = 0, otherExpense = 0, depreciation = 0;
  let arChange = 0, otherCurrentAssetChange = 0;      // operating (working capital, assets)
  let apChange = 0, otherCurrentLiabChange = 0;       // operating (working capital, liabilities)
  let fixedAssetChange = 0;                            // investing
  let debtChange = 0, equityChange = 0;               // financing

  for (const line of lines ?? []) {
    const m = acctMeta.get(line.account_id as string);
    if (!m) continue;
    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);

    // Cash itself is the reconciling item — never a line in the sections.
    if (cashIds.has(line.account_id as string)) continue;

    switch (m.type) {
      case 'REVENUE':
        revenue += credit - debit;
        break;
      case 'COGS':
        cogs += debit - credit;
        break;
      case 'OPEX':
        opex += debit - credit;
        if (isDepreciationName(m.name)) depreciation += debit - credit; // non-cash add-back
        break;
      case 'OTHER':
        if (m.subType === 'OTHER_INCOME') otherIncome += credit - debit;
        else otherExpense += debit - credit; // OTHER_EXPENSE
        break;
      case 'ASSET':
        if (m.subType === 'FIXED_ASSET' || m.subType === 'OTHER_ASSET') {
          // Accumulated depreciation/amortization is a non-cash contra-asset; its
          // movement is captured by the D&A add-back above, so exclude it from
          // investing (otherwise it would double-count the add-back and the CF
          // would not tie).
          if (!isAccumulatedDepreciation(m.name)) fixedAssetChange += debit - credit;
        } else {
          // CURRENT_ASSET (non-cash): AR vs. everything else (inventory, prepaid…)
          if (arIds.has(line.account_id as string)) arChange += debit - credit;
          else otherCurrentAssetChange += debit - credit;
        }
        break;
      case 'LIABILITY':
        if (m.subType === 'LONG_TERM_LIABILITY') {
          debtChange += credit - debit; // financing
        } else {
          // CURRENT_LIABILITY: AP vs. everything else (deferred rev, taxes, CC…)
          if (apIds.has(line.account_id as string)) apChange += credit - debit;
          else otherCurrentLiabChange += credit - debit;
        }
        break;
      case 'EQUITY':
        equityChange += credit - debit; // financing
        break;
      default:
        break;
    }
  }

  const netIncome = revenue - cogs - opex + otherIncome - otherExpense;

  // An increase in an operating asset is a cash OUTFLOW; an increase in an
  // operating liability is a cash INFLOW.
  const operatingTotal =
    netIncome + depreciation - arChange - otherCurrentAssetChange + apChange + otherCurrentLiabChange;
  const investingTotal = -fixedAssetChange;             // capex (asset increase) is an outflow
  const financingTotal = debtChange + equityChange;
  const netChange = operatingTotal + investingTotal + financingTotal;

  // Beginning cash: running balance of cash/equivalent accounts before start_date.
  let beginningCash = 0;
  if (cashIds.size > 0) {
    // Cash-account lines of every POSTED entry before start_date (all history), via
    // an inner join on the same entry filters, paged — the old unbounded id list of
    // all prior entries was capped at 1,000 rows and understated beginning cash.
    const cashIdList = Array.from(cashIds);
    const { data: cashLines } = await fetchAll(() => {
      let q = supabase
        .from('gl_entry_lines')
        .select('account_id, debit_cents, credit_cents, gl_entries!inner(id)')
        .eq('gl_entries.status', 'POSTED')
        .lt('gl_entries.entry_date', params.start_date)
        .in('account_id', cashIdList);
      if (locFilter.length === 1) q = q.eq('gl_entries.location_id', locFilter[0]);
      else if (locFilter.length > 1) q = q.in('gl_entries.location_id', locFilter);
      return q;
    }, { label: 'cash-flow beginning-cash gl_entry_lines' });
    for (const cl of cashLines ?? []) {
      beginningCash += Number(cl.debit_cents ?? 0) - Number(cl.credit_cents ?? 0);
    }
  }

  return NextResponse.json({
    period: { startDate: params.start_date, endDate: params.end_date },
    operating: {
      netIncome,
      adjustments: [
        { label: 'Depreciation & Amortization', amountCents: depreciation },
      ].filter((a) => a.amountCents !== 0),
      changesInWorkingCapital: [
        { label: 'Accounts Receivable', amountCents: -arChange },
        { label: 'Other Current Assets', amountCents: -otherCurrentAssetChange },
        { label: 'Accounts Payable', amountCents: apChange },
        { label: 'Other Current Liabilities', amountCents: otherCurrentLiabChange },
      ].filter((a) => a.amountCents !== 0),
      totalCents: operatingTotal,
    },
    investing: {
      items: [
        { label: 'Capital Expenditures', amountCents: -fixedAssetChange },
      ].filter((a) => a.amountCents !== 0),
      totalCents: investingTotal,
    },
    financing: {
      items: [
        { label: 'Debt Proceeds / (Payments)', amountCents: debtChange },
        { label: 'Equity Transactions', amountCents: equityChange },
      ].filter((a) => a.amountCents !== 0),
      totalCents: financingTotal,
    },
    netChangeCents: netChange,
    beginningCashCents: beginningCash,
    endingCashCents: beginningCash + netChange,
    governance: gov.info,
  });
}
