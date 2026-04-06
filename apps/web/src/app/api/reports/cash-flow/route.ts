export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

const querySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));
  const locFilter = params.location_ids ? params.location_ids.split(",").filter(Boolean) : (params.location_id && params.location_id !== "all" ? [params.location_id] : []);

  // Get all GL entries in the period with account type info
  let query = supabase
    .from('gl_entry_lines')
    .select(`
      debit_cents, credit_cents,
      account:accounts!gl_entry_lines_account_id_fkey(
        account_number, name, account_type,
        account_groups!accounts_account_group_id_fkey(
          name,
          account_sub_types!account_groups_account_sub_type_id_fkey(name, code)
        )
      ),
      gl_entry:gl_entries!gl_entry_lines_gl_entry_id_fkey(entry_date, status, location_id)
    `);

  // We need to filter by date and posted status
  // Since Supabase doesn't filter on joined fields easily, get entry IDs first
  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', params.start_date)
    .lte('entry_date', params.end_date);

  if (locFilter.length === 1) entriesQ = entriesQ.eq("location_id", locFilter[0]); else if (locFilter.length > 1) entriesQ = entriesQ.in("location_id", locFilter);

  const { data: entryIds } = await entriesQ;
  if (!entryIds || entryIds.length === 0) {
    return NextResponse.json({
      period: { startDate: params.start_date, endDate: params.end_date },
      operating: { netIncome: 0, adjustments: [], changesInWorkingCapital: [], totalCents: 0 },
      investing: { items: [], totalCents: 0 },
      financing: { items: [], totalCents: 0 },
      netChangeCents: 0,
      beginningCashCents: 0,
      endingCashCents: 0,
    });
  }

  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select(`
      debit_cents, credit_cents,
      account:accounts!gl_entry_lines_account_id_fkey(
        account_number, name, account_type
      )
    `)
    .in('gl_entry_id', entryIds.map((e) => e.id));

  // Classify by account type for indirect method
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let otherIncome = 0;
  let otherExpense = 0;
  let arChange = 0;      // Current assets changes
  let apChange = 0;      // Current liabilities changes
  let inventoryChange = 0;
  let prepaidChange = 0;
  let fixedAssetChange = 0;  // Investing
  let debtChange = 0;       // Financing
  let equityChange = 0;     // Financing
  let depreciation = 0;     // Non-cash add-back

  for (const line of lines ?? []) {
    const acct = Array.isArray(line.account) ? line.account[0] : line.account;
    if (!acct) continue;

    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    const num = acct.account_number ?? '';
    const type = acct.account_type ?? '';

    // Revenue (4xxxx): credits increase revenue
    if (type === 'REVENUE') {
      revenue += credit - debit;
    }
    // COGS (5xxxx): debits increase expense
    else if (type === 'COGS') {
      cogs += debit - credit;
    }
    // OpEx (6xxxx-7xxxx): debits increase expense
    else if (type === 'OPEX') {
      opex += debit - credit;
      // Check for depreciation accounts (typically 6xxx5 or 7xxx)
      if (acct.name?.toLowerCase().includes('depreciation') || acct.name?.toLowerCase().includes('amortization')) {
        depreciation += debit - credit;
      }
    }
    // Other Income/Expense (8xxxx-9xxxx)
    else if (type === 'OTHER') {
      if (num >= '80000' && num < '85000') {
        otherIncome += credit - debit;
      } else {
        otherExpense += debit - credit;
      }
    }
    // Assets: changes in current assets affect operating CF
    else if (type === 'ASSET') {
      if (num >= '12000' && num < '13000') {
        arChange += debit - credit; // AR increase = cash outflow
      } else if (num >= '13000' && num < '14000') {
        inventoryChange += debit - credit;
      } else if (num >= '14000' && num < '15000') {
        prepaidChange += debit - credit;
      } else if (num >= '15000' && num < '20000') {
        fixedAssetChange += debit - credit; // Fixed assets = investing
      }
    }
    // Liabilities: changes affect operating/financing
    else if (type === 'LIABILITY') {
      if (num >= '20000' && num < '25000') {
        apChange += credit - debit; // AP increase = cash inflow
      } else {
        debtChange += credit - debit; // Long-term debt = financing
      }
    }
    // Equity
    else if (type === 'EQUITY') {
      equityChange += credit - debit;
    }
  }

  const netIncome = revenue - cogs - opex + otherIncome - otherExpense;

  const operatingTotal = netIncome + depreciation - arChange + apChange - inventoryChange - prepaidChange;
  const investingTotal = -fixedAssetChange;
  const financingTotal = debtChange + equityChange;
  const netChange = operatingTotal + investingTotal + financingTotal;

  // Get beginning cash balance (sum of cash accounts before start_date)
  let cashQ = supabase
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents')
    .gte('account_id', '') // Will filter by account number below
  ;

  // Get cash account IDs (10xxx-11xxx)
  const { data: cashAccounts } = await supabase
    .from('accounts')
    .select('id')
    .gte('account_number', '10000')
    .lt('account_number', '12000');

  let beginningCash = 0;
  if (cashAccounts && cashAccounts.length > 0) {
    // Get all entries before start date for cash accounts
    let priorQ = supabase
      .from('gl_entries')
      .select('id')
      .eq('status', 'POSTED')
      .lt('entry_date', params.start_date);
    if (locFilter.length === 1) priorQ = priorQ.eq("location_id", locFilter[0]); else if (locFilter.length > 1) priorQ = priorQ.in("location_id", locFilter);

    const { data: priorEntries } = await priorQ;
    if (priorEntries && priorEntries.length > 0) {
      const { data: cashLines } = await supabase
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .in('gl_entry_id', priorEntries.map((e) => e.id))
        .in('account_id', cashAccounts.map((a) => a.id));

      for (const cl of cashLines ?? []) {
        beginningCash += Number(cl.debit_cents ?? 0) - Number(cl.credit_cents ?? 0);
      }
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
        { label: 'Inventory', amountCents: -inventoryChange },
        { label: 'Prepaid Expenses', amountCents: -prepaidChange },
        { label: 'Accounts Payable', amountCents: apChange },
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
  });
}
