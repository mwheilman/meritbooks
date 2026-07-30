'use server';

import { createAuthedServerSupabase } from '@/lib/supabase/authed';

const ZERO_METRICS: DashboardMetrics = {
  pendingReview: 0,
  pendingReceipts: 0,
  pendingBills: 0,
  pendingJEs: 0,
  totalTransactionsToday: 0,
  cashPositionCents: 0,
  openAPCents: 0,
  openARCents: 0,
};

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
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return ZERO_METRICS;

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
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return [];

  // NOTE: `locations` lives in the `core` schema (post core-carve) while
  // bank_transactions is in `public`, so a PostgREST embed (`locations(name)`)
  // fails with PGRST200 "no relationship found" — REST embeds don't cross the
  // public→core boundary here. Two-step instead: fetch the transactions, then
  // resolve location names from core.locations by id.
  const { data: txns } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, status, created_at, location_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = txns ?? [];
  const locIds = [...new Set(rows.map((t) => t.location_id).filter(Boolean))];
  let names: Record<string, string> = {};
  if (locIds.length) {
    const { data: locs } = await supabase
      .schema('core').from('locations')
      .select('id, name')
      .in('id', locIds);
    names = Object.fromEntries((locs ?? []).map((l) => [l.id as string, l.name as string]));
  }

  return rows.map((t) => ({
    id: t.id,
    type: 'bank_txn' as const,
    description: t.description,
    amount_cents: t.amount_cents,
    status: t.status,
    location_name: t.location_id ? names[t.location_id] ?? null : null,
    created_at: t.created_at,
    user_name: null,
  }));
}
