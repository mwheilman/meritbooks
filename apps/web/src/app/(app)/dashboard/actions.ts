'use server';

import { createServerSupabase } from '@/lib/supabase/server';

export interface DashboardMetrics {
  pendingReview: number;
  pendingReceipts: number;
  pendingBills: number;
  pendingJEs: number;
  totalTransactionsToday: number;
  cashPositionCents: number;
  openAPCents: number;
  openARCents: number;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const supabase = await createServerSupabase();

  const [
    { count: pendingReceipts },
    { count: pendingBills },
    { count: pendingBankTxns },
    { data: cashData },
    { data: apData },
    { data: arData },
  ] = await Promise.all([
    supabase
      .from('receipts')
      .select('*', { count: 'exact', head: true })
      .in('status', ['PENDING', 'CATEGORIZED']),
    supabase
      .from('bills')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'PENDING'),
    supabase
      .from('bank_transactions')
      .select('*', { count: 'exact', head: true })
      .in('status', ['PENDING', 'CATEGORIZED']),
    supabase
      .from('bank_accounts')
      .select('current_balance_cents')
      .eq('is_active', true),
    supabase
      .from('bills')
      .select('balance_cents')
      .not('status', 'in', '("PAID","VOIDED")'),
    supabase
      .from('invoices')
      .select('balance_cents')
      .not('status', 'in', '("PAID","VOIDED","DRAFT")'),
  ]);

  const cashPositionCents = cashData?.reduce((sum, row) => sum + (row.current_balance_cents || 0), 0) ?? 0;
  const openAPCents = apData?.reduce((sum, row) => sum + (row.balance_cents || 0), 0) ?? 0;
  const openARCents = arData?.reduce((sum, row) => sum + (row.balance_cents || 0), 0) ?? 0;

  return {
    pendingReview: (pendingReceipts ?? 0) + (pendingBills ?? 0) + (pendingBankTxns ?? 0),
    pendingReceipts: pendingReceipts ?? 0,
    pendingBills: pendingBills ?? 0,
    pendingJEs: 0,
    totalTransactionsToday: 0,
    cashPositionCents,
    openAPCents,
    openARCents,
  };
}

export interface RecentActivity {
  id: string;
  type: 'receipt' | 'bill' | 'bank_txn' | 'je' | 'approval';
  description: string;
  amount_cents: number | null;
  status: string;
  location_name: string | null;
  created_at: string;
  user_name: string | null;
}

export async function getRecentActivity(limit = 20): Promise<RecentActivity[]> {
  const supabase = await createServerSupabase();

  const { data: txns } = await supabase
    .from('bank_transactions')
    .select(`
      id,
      description,
      amount_cents,
      status,
      created_at,
      locations ( name )
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (txns ?? []).map((t) => {
    // Supabase FK joins return arrays — extract first element
    const loc = Array.isArray(t.locations) ? t.locations[0] : t.locations;
    return {
      id: t.id,
      type: 'bank_txn' as const,
      description: t.description,
      amount_cents: t.amount_cents,
      status: t.status,
      location_name: (loc as { name: string } | null)?.name ?? null,
      created_at: t.created_at,
      user_name: null,
    };
  });
}
