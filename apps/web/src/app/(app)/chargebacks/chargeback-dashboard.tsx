'use client';

import { useState, useCallback } from 'react';
import { Calculator, DollarSign, Users, Clock, Loader2, AlertCircle, FileText, RefreshCw } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

interface OhRateResult {
  totalOpexCents: number;
  ownerExcludedCents: number;
  dealTeamExcludedCents: number;
  directAssignedExcludedCents: number;
  sharedPoolCents: number;
  productionCount: number;
  hoursPerEmployee: number;
  totalCapacityHours: number;
  ohRateCents: number;
  effectiveDate: string;
}

interface ChargebackInvoice {
  locationId: string;
  locationName: string;
  invoiceNumber: string;
  sections: {
    cogsLaborCents: number;
    opexLaborCents: number;
    cogsExpensesCents: number;
    opexExpensesCents: number;
    sharedCostsCents: number;
    directAssignedCents: number;
  };
  totalCents: number;
  lineItems: { section: string; description: string; hours?: number; amountCents: number; glClassification: string }[];
}

export function ChargebackDashboard() {
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);
  const [generating, setGenerating] = useState(false);
  const [invoices, setInvoices] = useState<ChargebackInvoice[] | null>(null);
  const [genError, setGenError] = useState('');

  const { data: ohRate, isLoading: ohLoading, error: ohError } = useQuery<OhRateResult>(
    `/api/overhead-rate?year=${year}&month=${month}`
  );

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError('');
    try {
      const res = await fetch('/api/chargebacks/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGenError(data.error ?? 'Generation failed');
        return;
      }
      setInvoices(data.invoices ?? []);
    } catch {
      setGenError('Network error');
    } finally {
      setGenerating(false);
    }
  }, [year, month]);

  const totalBilled = invoices?.reduce((s, inv) => s + inv.totalCents, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* OH Rate Metrics */}
      <div className="grid grid-cols-4 gap-4">
        <MetricBox
          label="Current OH Rate"
          value={ohLoading ? '...' : ohRate ? `${formatMoney(ohRate.ohRateCents)}/hr` : '$0.00/hr'}
          sub={`Effective ${year}-${String(month).padStart(2, '0')}-01`}
          icon={<Calculator className="w-5 h-5 text-emerald-400" />}
        />
        <MetricBox
          label="Shared Pool"
          value={ohLoading ? '...' : formatMoney(ohRate?.sharedPoolCents ?? 0)}
          sub={`${formatMoney(ohRate?.totalOpexCents ?? 0)} total − exclusions`}
          icon={<DollarSign className="w-5 h-5 text-blue-400" />}
        />
        <MetricBox
          label="Billing Capacity"
          value={ohLoading ? '...' : `${ohRate?.totalCapacityHours ?? 0} hrs`}
          sub={`${ohRate?.productionCount ?? 0} production × ${ohRate?.hoursPerEmployee ?? 150} hrs`}
          icon={<Clock className="w-5 h-5 text-amber-400" />}
        />
        <MetricBox
          label="Production Employees"
          value={ohLoading ? '...' : String(ohRate?.productionCount ?? 0)}
          sub="Active this period"
          icon={<Users className="w-5 h-5 text-purple-400" />}
        />
      </div>

      {ohError && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> Failed to load OH rate: {String(ohError)}
        </div>
      )}

      {/* Exclusion Breakdown */}
      {ohRate && (
        <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-4">
          <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Pool Exclusions</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Owner Group (90% excluded):</span>
              <span className="font-mono text-white ml-2">{formatMoney(ohRate.ownerExcludedCents)}</span>
            </div>
            <div>
              <span className="text-gray-400">Deal Team (100%):</span>
              <span className="font-mono text-white ml-2">{formatMoney(ohRate.dealTeamExcludedCents)}</span>
            </div>
            <div>
              <span className="text-gray-400">Direct Assigned (100%):</span>
              <span className="font-mono text-white ml-2">{formatMoney(ohRate.directAssignedExcludedCents)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Generate Button */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">
          {invoices ? `${invoices.length} Chargeback Invoices Generated` : 'Chargeback Invoices'}
        </h2>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Generate {year}-{String(month).padStart(2, '0')} Invoices
        </button>
      </div>

      {genError && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{genError}</div>
      )}

      {/* Invoice Table */}
      {invoices && invoices.length === 0 && (
        <div className="text-center py-12">
          <FileText className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No chargebacks to generate</p>
          <p className="text-sm text-gray-500 mt-1">No time entries or shared cost rules found for this period.</p>
        </div>
      )}

      {invoices && invoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                <th className="pb-3 pr-4">Company</th>
                <th className="pb-3 pr-4">Invoice #</th>
                <th className="pb-3 pr-4 text-right">COGS Labor</th>
                <th className="pb-3 pr-4 text-right">OpEx Labor</th>
                <th className="pb-3 pr-4 text-right">COGS Exp</th>
                <th className="pb-3 pr-4 text-right">OpEx Exp</th>
                <th className="pb-3 pr-4 text-right">Shared</th>
                <th className="pb-3 pr-4 text-right">Direct</th>
                <th className="pb-3 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/30">
              {invoices.map((inv) => (
                <tr key={inv.locationId} className="hover:bg-gray-800/20 transition-colors">
                  <td className="py-2.5 pr-4 text-white font-medium">{inv.locationName}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-gray-400">{inv.invoiceNumber}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.cogsLaborCents > 0 ? formatMoney(inv.sections.cogsLaborCents) : '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.opexLaborCents > 0 ? formatMoney(inv.sections.opexLaborCents) : '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.cogsExpensesCents > 0 ? formatMoney(inv.sections.cogsExpensesCents) : '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.opexExpensesCents > 0 ? formatMoney(inv.sections.opexExpensesCents) : '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.sharedCostsCents > 0 ? formatMoney(inv.sections.sharedCostsCents) : '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-gray-300">{inv.sections.directAssignedCents > 0 ? formatMoney(inv.sections.directAssignedCents) : '—'}</td>
                  <td className="py-2.5 text-right font-mono text-white font-semibold">{formatMoney(inv.totalCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-700">
                <td colSpan={8} className="py-2.5 pr-4 text-sm font-semibold text-white">Total Chargebacks</td>
                <td className="py-2.5 text-right font-mono text-lg font-semibold text-emerald-400">{formatMoney(totalBilled)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Show empty state if no invoices generated yet */}
      {!invoices && !generating && (
        <div className="text-center py-12 bg-gray-800/20 border border-gray-700/30 rounded-lg">
          <Calculator className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">Click "Generate Invoices" to calculate chargebacks</p>
          <p className="text-sm text-gray-500 mt-1">Uses time entries, shared cost rules, and the overhead rate for {year}-{String(month).padStart(2, '0')}</p>
        </div>
      )}
    </div>
  );
}

function MetricBox({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: React.ReactNode }) {
  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-400">{label}</span>
        {icon}
      </div>
      <p className="text-xl font-mono font-semibold text-white">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  );
}
