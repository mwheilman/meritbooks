export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const mode = searchParams.get('mode') ?? 'summary'; // 'summary' or 'detail'

  // Get bills in the period with vendor info
  let billQ = supabase
    .from('bills')
    .select(`
      id, bill_number, bill_date, total_cents, status,
      vendor:vendors!bills_vendor_id_fkey(id, name, is_1099_eligible),
      location:locations!bills_location_id_fkey(name, short_code)
    `)
    .gte('bill_date', startDate)
    .lte('bill_date', endDate)
    .not('status', 'eq', 'VOIDED');
  if (locationId) billQ = billQ.eq('location_id', locationId);
  const { data: bills } = await billQ;

  // Get bank transactions with vendor patterns for expenses
  let txnQ = supabase
    .from('bank_transactions')
    .select(`
      id, description, transaction_date, amount_cents, status,
      vendor:vendors!bank_transactions_final_vendor_id_fkey(id, name, is_1099_eligible),
      location:locations!bank_transactions_location_id_fkey(name, short_code),
      account:accounts!bank_transactions_final_account_id_fkey(account_number, name, account_type)
    `)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
    .lt('amount_cents', 0); // expenses are negative
  if (locationId) txnQ = txnQ.eq('location_id', locationId);
  const { data: txns } = await txnQ;

  // Aggregate by vendor
  const vendorMap = new Map<string, {
    vendorId: string;
    vendorName: string;
    is1099: boolean;
    totalCents: number;
    transactionCount: number;
    accounts: Map<string, { accountNumber: string; accountName: string; totalCents: number }>;
    transactions: { date: string; description: string; amountCents: number; type: string; locationCode: string }[];
  }>();

  const addToVendor = (vendorId: string, vendorName: string, is1099: boolean, amount: number, acctNum: string, acctName: string, date: string, desc: string, type: string, locCode: string) => {
    const existing = vendorMap.get(vendorId);
    if (existing) {
      existing.totalCents += amount;
      existing.transactionCount++;
      const acct = existing.accounts.get(acctNum);
      if (acct) { acct.totalCents += amount; }
      else { existing.accounts.set(acctNum, { accountNumber: acctNum, accountName: acctName, totalCents: amount }); }
      if (mode === 'detail') existing.transactions.push({ date, description: desc, amountCents: amount, type, locationCode: locCode });
    } else {
      const accounts = new Map<string, { accountNumber: string; accountName: string; totalCents: number }>();
      accounts.set(acctNum, { accountNumber: acctNum, accountName: acctName, totalCents: amount });
      vendorMap.set(vendorId, {
        vendorId, vendorName, is1099, totalCents: amount, transactionCount: 1, accounts,
        transactions: mode === 'detail' ? [{ date, description: desc, amountCents: amount, type, locationCode: locCode }] : [],
      });
    }
  };

  // Process bills
  for (const bill of bills ?? []) {
    const v = Array.isArray(bill.vendor) ? bill.vendor[0] : bill.vendor;
    const loc = Array.isArray(bill.location) ? bill.location[0] : bill.location;
    if (!v) continue;
    addToVendor(v.id, v.name, v.is_1099_eligible, Number(bill.total_cents), '', 'AP - Bills', bill.bill_date, `Bill ${bill.bill_number ?? ''}`, 'bill', (loc as { short_code: string } | null)?.short_code ?? '');
  }

  // Process bank transactions
  for (const txn of txns ?? []) {
    const v = Array.isArray(txn.vendor) ? txn.vendor[0] : txn.vendor;
    const loc = Array.isArray(txn.location) ? txn.location[0] : txn.location;
    const acct = Array.isArray(txn.account) ? txn.account[0] : txn.account;
    if (!v) continue;
    addToVendor(v.id, v.name, v.is_1099_eligible, Math.abs(Number(txn.amount_cents)),
      (acct as { account_number: string } | null)?.account_number ?? '',
      (acct as { name: string } | null)?.name ?? 'Uncategorized',
      txn.transaction_date, txn.description, 'bank_txn',
      (loc as { short_code: string } | null)?.short_code ?? '');
  }

  const vendors = Array.from(vendorMap.values())
    .map((v) => ({
      ...v,
      accounts: Array.from(v.accounts.values()).sort((a, b) => b.totalCents - a.totalCents),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const totalExpenseCents = vendors.reduce((s, v) => s + v.totalCents, 0);

  return NextResponse.json({
    period: { startDate, endDate },
    mode,
    data: vendors,
    summary: {
      totalExpenseCents,
      vendorCount: vendors.length,
      transactionCount: vendors.reduce((s, v) => s + v.transactionCount, 0),
    },
  });
}
