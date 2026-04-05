import { createAdminSupabase } from '@/lib/supabase/server';
import { formatMoney } from '@meritbooks/shared';
import { clsx } from 'clsx';

interface CompanyData {
  id: string;
  name: string;
  short_code: string;
  pendingCount: number;
  cashCents: number;
  cashStatus: 'HEALTHY' | 'ADEQUATE' | 'NEAR_MINIMUM' | 'BELOW_MINIMUM';
}

async function getCompanySummary(): Promise<CompanyData[]> {
  const supabase = createAdminSupabase();

  // Get all active locations
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code, minimum_cash_cents, is_active')
    .eq('is_active', true)
    .order('name');

  if (!locations || locations.length === 0) return [];

  // For each location, get pending count and cash position in parallel
  const results = await Promise.all(
    locations.map(async (loc) => {
      const [pendingResult, cashResult] = await Promise.all([
        supabase
          .from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('location_id', loc.id)
          .in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED']),
        supabase
          .from('bank_accounts')
          .select('current_balance_cents')
          .eq('location_id', loc.id)
          .eq('is_active', true),
      ]);

      const cashCents = (cashResult.data ?? []).reduce(
        (sum, r) => sum + (r.current_balance_cents ?? 0),
        0
      );

      const minCash = loc.minimum_cash_cents ?? 0;
      let cashStatus: CompanyData['cashStatus'] = 'HEALTHY';
      if (minCash > 0) {
        const ratio = cashCents / minCash;
        if (ratio < 1) cashStatus = 'BELOW_MINIMUM';
        else if (ratio < 1.2) cashStatus = 'NEAR_MINIMUM';
        else if (ratio < 2) cashStatus = 'ADEQUATE';
      }

      return {
        id: loc.id,
        name: loc.name,
        short_code: loc.short_code,
        pendingCount: pendingResult.count ?? 0,
        cashCents,
        cashStatus,
      };
    })
  );

  return results;
}

const CASH_STATUS_CONFIG = {
  HEALTHY: { label: 'Healthy', className: 'text-emerald-400 bg-emerald-500/10' },
  ADEQUATE: { label: 'Adequate', className: 'text-blue-400 bg-blue-500/10' },
  NEAR_MINIMUM: { label: 'Near Min', className: 'text-amber-400 bg-amber-500/10' },
  BELOW_MINIMUM: { label: 'Below Min', className: 'text-red-400 bg-red-500/10' },
};

export async function CompanySummaryTable() {
  const companies = await getCompanySummary();

  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-white">Portfolio Companies</h2>
      </div>
      {companies.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-slate-500">
          No companies found. Add portfolio companies in Settings.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800/50">
                <th className="px-5 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
                <th className="px-5 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Cash</th>
                <th className="px-5 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Pending</th>
                <th className="px-5 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {companies.map((co) => {
                const statusConfig = CASH_STATUS_CONFIG[co.cashStatus];
                return (
                  <tr key={co.id} className="table-row-hover">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                          {co.short_code}
                        </span>
                        <span className="text-sm text-slate-200">{co.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right text-sm font-mono tabular-nums text-slate-300">
                      {formatMoney(co.cashCents)}
                    </td>
                    <td className="px-5 py-3 text-center">
                      {co.pendingCount > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
                          {co.pendingCount}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-600">0</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className={clsx(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium',
                        statusConfig.className
                      )}>
                        {statusConfig.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
