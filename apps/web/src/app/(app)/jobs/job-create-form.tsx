'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@/hooks/use-query';
import { formatMoney } from '@meritbooks/shared';
import { X, Loader2, HardHat, Briefcase, Calculator } from 'lucide-react';

interface LocationOption { id: string; name: string; short_code: string; }
interface CustomerOption { id: string; name: string; }

const PRICING_MODELS = [
  { value: 'FIXED_PRICE', label: 'Fixed Price', group: 'project' },
  { value: 'COST_PLUS', label: 'Cost Plus', group: 'project' },
  { value: 'TIME_AND_MATERIALS', label: 'Time & Materials', group: 'project' },
  { value: 'UNIT_PRICE', label: 'Unit Price', group: 'project' },
  { value: 'RETAINER', label: 'Monthly Retainer', group: 'service' },
  { value: 'SUBSCRIPTION', label: 'Subscription', group: 'service' },
  { value: 'HOURLY', label: 'Hourly', group: 'service' },
] as const;

const JOB_TYPES = [
  { value: 'CONSTRUCTION', label: 'Construction' },
  { value: 'HVAC', label: 'HVAC' },
  { value: 'CABINETRY', label: 'Cabinetry' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'OTHER', label: 'Other' },
];

const REV_REC_DEFAULTS: Record<string, string> = {
  RETAINER: 'RATABLY',
  SUBSCRIPTION: 'SUBSCRIPTION',
  HOURLY: 'AS_BILLED',
  TIME_AND_MATERIALS: 'AS_BILLED',
  FIXED_PRICE: 'COMPLETED_CONTRACT',
  COST_PLUS: 'PCT_COSTS_INCURRED',
  UNIT_PRICE: 'COMPLETED_CONTRACT',
};

function dollarToCents(v: string): number { return Math.round((parseFloat(v) || 0) * 100); }
function centsInput(cents: number): string { return cents > 0 ? (cents / 100).toFixed(2) : ''; }

export function JobCreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  // Form state
  const [locationId, setLocationId] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [name, setName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [jobType, setJobType] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [pricingModel, setPricingModel] = useState('FIXED_PRICE');

  // Project fields
  const [contractCents, setContractCents] = useState(0);
  const [estimatedCostCents, setEstimatedCostCents] = useState(0);
  const [markupPct, setMarkupPct] = useState(0);
  const [retainagePct, setRetainagePct] = useState(0);
  const [startDate, setStartDate] = useState('');
  const [completionDate, setCompletionDate] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteCity, setSiteCity] = useState('');
  const [siteState, setSiteState] = useState('');
  const [siteZip, setSiteZip] = useState('');
  const [superintendent, setSuperintendent] = useState('');
  const [projectManager, setProjectManager] = useState('');

  // Service fields
  const [retainerCents, setRetainerCents] = useState(0);
  const [hourlyRateCents, setHourlyRateCents] = useState(0);
  const [budgetHours, setBudgetHours] = useState(0);
  const [totalMilestones, setTotalMilestones] = useState(0);
  const [serviceStart, setServiceStart] = useState('');
  const [serviceEnd, setServiceEnd] = useState('');
  const [billingFrequency, setBillingFrequency] = useState('MONTHLY');

  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  const isService = ['RETAINER', 'SUBSCRIPTION', 'HOURLY'].includes(pricingModel);
  const revRecMethod = REV_REC_DEFAULTS[pricingModel] ?? 'COMPLETED_CONTRACT';

  // Estimated margin calculation
  let estRevenue = 0;
  let estMarginPct = 0;
  if (pricingModel === 'FIXED_PRICE' || pricingModel === 'UNIT_PRICE') {
    estRevenue = contractCents;
  } else if (pricingModel === 'COST_PLUS') {
    estRevenue = estimatedCostCents > 0 ? Math.round(estimatedCostCents * (1 + markupPct / 100)) : 0;
  } else if (pricingModel === 'TIME_AND_MATERIALS') {
    estRevenue = budgetHours > 0 && hourlyRateCents > 0 ? Math.round(budgetHours * hourlyRateCents * (1 + markupPct / 100)) : 0;
  } else if (pricingModel === 'RETAINER' || pricingModel === 'SUBSCRIPTION') {
    const months = serviceStart && serviceEnd
      ? Math.max(1, Math.ceil((new Date(serviceEnd).getTime() - new Date(serviceStart).getTime()) / (30 * 86400000)))
      : 12;
    estRevenue = retainerCents * months;
  } else if (pricingModel === 'HOURLY') {
    estRevenue = budgetHours * hourlyRateCents;
  }
  if (estRevenue > 0 && estimatedCostCents > 0) {
    estMarginPct = Math.round((1 - estimatedCostCents / estRevenue) * 100);
  }

  const handleSubmit = async () => {
    setFormError('');
    if (!locationId) { setFormError('Select a company'); return; }
    if (!jobNumber) { setFormError('Job number is required'); return; }
    if (!name) { setFormError('Job name is required'); return; }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        location_id: locationId,
        job_number: jobNumber,
        name,
        customer_name: customerName || undefined,
        job_type: jobType || undefined,
        status,
        pricing_model: pricingModel,
        markup_pct: markupPct,
        notes: notes || undefined,
      };

      // Project fields
      if (!isService) {
        if (contractCents > 0) body.contract_amount_cents = contractCents;
        if (estimatedCostCents > 0) body.estimated_cost_cents = estimatedCostCents;
        if (retainagePct > 0) body.retainage_pct = retainagePct;
        if (startDate) body.start_date = startDate;
        if (completionDate) body.estimated_completion_date = completionDate;
        if (siteAddress) body.job_site_address = siteAddress;
        if (siteCity) body.job_site_city = siteCity;
        if (siteState) body.job_site_state = siteState;
        if (siteZip) body.job_site_zip = siteZip;
        if (superintendent) body.superintendent = superintendent;
        if (projectManager) body.project_manager = projectManager;
      }

      // Service fields
      if (isService) {
        if (retainerCents > 0) body.monthly_retainer_cents = retainerCents;
        if (hourlyRateCents > 0) body.hourly_rate_cents = hourlyRateCents;
        if (budgetHours > 0) body.budget_hours = budgetHours;
        if (totalMilestones > 0) body.total_milestones = totalMilestones;
        if (serviceStart) body.service_start_date = serviceStart;
        if (serviceEnd) body.service_end_date = serviceEnd;
        body.billing_frequency = billingFrequency;
      }

      // T&M needs hourly rate + budget hours too
      if (pricingModel === 'TIME_AND_MATERIALS') {
        if (hourlyRateCents > 0) body.hourly_rate_cents = hourlyRateCents;
        if (budgetHours > 0) body.budget_hours = budgetHours;
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) {
        setFormError(result.error ?? 'Failed to create job');
        return;
      }
      onCreated();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-6 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mb-8">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <div className="flex items-center gap-3">
            {isService ? <Briefcase className="w-5 h-5 text-emerald-400" /> : <HardHat className="w-5 h-5 text-emerald-400" />}
            <div>
              <h2 className="text-base font-semibold text-white">{isService ? 'New Service Engagement' : 'New Project'}</h2>
              <p className="text-xs text-gray-500 mt-0.5">Rev rec: {revRecMethod.replace(/_/g, ' ').toLowerCase()}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-5">
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{formError}</div>
          )}

          {/* Identity */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Company *</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="">Select company</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Job Type</label>
              <select value={jobType} onChange={(e) => setJobType(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="">Select type</option>
                {JOB_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Job Number *</label>
              <input type="text" value={jobNumber} onChange={(e) => setJobNumber(e.target.value)}
                placeholder="e.g. 2026-042"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-gray-400 mb-1">Job Name *</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Johnson Residence HVAC Install"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Customer</label>
              <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer name"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Status</label>
              <div className="flex gap-2">
                {['BID', 'ACTIVE'].map((s) => (
                  <button key={s} onClick={() => setStatus(s)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      status === s ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-white'
                    }`}>
                    {s === 'BID' ? 'Bid / Estimate' : 'Active'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Pricing Model Selection */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">Pricing Model *</label>
            <div className="grid grid-cols-4 gap-2">
              {PRICING_MODELS.map((pm) => (
                <button key={pm.value} onClick={() => setPricingModel(pm.value)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    pricingModel === pm.value
                      ? pm.group === 'service'
                        ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
                        : 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
                  }`}>
                  {pm.label}
                </button>
              ))}
            </div>
          </div>

          {/* Conditional Fields: Project */}
          {!isService && (
            <div className="border border-gray-700/50 rounded-lg p-4 space-y-4">
              <div className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <HardHat className="w-3.5 h-3.5" /> Project Details
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Contract Amount</label>
                  <input type="number" value={centsInput(contractCents)} min={0} step={0.01}
                    onChange={(e) => setContractCents(dollarToCents(e.target.value))}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Estimated Cost</label>
                  <input type="number" value={centsInput(estimatedCostCents)} min={0} step={0.01}
                    onChange={(e) => setEstimatedCostCents(dollarToCents(e.target.value))}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                </div>
                {pricingModel === 'COST_PLUS' && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Markup %</label>
                    <input type="number" value={markupPct || ''} min={0} max={100} step={0.5}
                      onChange={(e) => setMarkupPct(parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Retainage %</label>
                  <input type="number" value={retainagePct || ''} min={0} max={100} step={0.5}
                    onChange={(e) => setRetainagePct(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Start Date</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Est. Completion</label>
                  <input type="date" value={completionDate} onChange={(e) => setCompletionDate(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Superintendent</label>
                  <input type="text" value={superintendent} onChange={(e) => setSuperintendent(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Project Manager</label>
                  <input type="text" value={projectManager} onChange={(e) => setProjectManager(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Job Site</label>
                <div className="grid grid-cols-4 gap-2">
                  <input type="text" value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} placeholder="Address" className="col-span-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
                  <input type="text" value={siteCity} onChange={(e) => setSiteCity(e.target.value)} placeholder="City" className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
                  <div className="flex gap-2">
                    <input type="text" value={siteState} onChange={(e) => setSiteState(e.target.value)} placeholder="ST" maxLength={2} className="w-14 px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white text-center placeholder:text-gray-600" />
                    <input type="text" value={siteZip} onChange={(e) => setSiteZip(e.target.value)} placeholder="ZIP" className="flex-1 px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Conditional Fields: Service */}
          {isService && (
            <div className="border border-emerald-700/30 rounded-lg p-4 space-y-4">
              <div className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <Briefcase className="w-3.5 h-3.5" /> Service Engagement Details
              </div>
              <div className="grid grid-cols-3 gap-4">
                {(pricingModel === 'RETAINER' || pricingModel === 'SUBSCRIPTION') && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Monthly Amount</label>
                    <input type="number" value={centsInput(retainerCents)} min={0} step={0.01}
                      onChange={(e) => setRetainerCents(dollarToCents(e.target.value))}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                  </div>
                )}
                {(pricingModel === 'HOURLY' || pricingModel === 'TIME_AND_MATERIALS') && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Hourly Rate</label>
                      <input type="number" value={centsInput(hourlyRateCents)} min={0} step={0.01}
                        onChange={(e) => setHourlyRateCents(dollarToCents(e.target.value))}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Budget Hours</label>
                      <input type="number" value={budgetHours || ''} min={0} step={1}
                        onChange={(e) => setBudgetHours(parseInt(e.target.value) || 0)}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
                    </div>
                  </>
                )}
                {pricingModel === 'SUBSCRIPTION' && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Billing Frequency</label>
                    <select value={billingFrequency} onChange={(e) => setBillingFrequency(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="ANNUALLY">Annually</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Service Start</label>
                  <input type="date" value={serviceStart} onChange={(e) => setServiceStart(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Service End</label>
                  <input type="date" value={serviceEnd} onChange={(e) => setServiceEnd(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
                </div>
              </div>
            </div>
          )}

          {/* T&M also needs hourly rate + budget hours */}
          {pricingModel === 'TIME_AND_MATERIALS' && !isService && (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Hourly Rate</label>
                <input type="number" value={centsInput(hourlyRateCents)} min={0} step={0.01}
                  onChange={(e) => setHourlyRateCents(dollarToCents(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Budget Hours</label>
                <input type="number" value={budgetHours || ''} min={0} step={1}
                  onChange={(e) => setBudgetHours(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Markup %</label>
                <input type="number" value={markupPct || ''} min={0} max={100} step={0.5}
                  onChange={(e) => setMarkupPct(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right" />
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600 resize-none"
              placeholder="Internal notes about this job..." />
          </div>

          {/* Estimated margin indicator */}
          {estRevenue > 0 && (
            <div className="flex items-center gap-4 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50">
              <Calculator className="w-4 h-4 text-gray-500" />
              <div className="flex items-center gap-6 text-sm">
                <span className="text-gray-400">Est. Revenue: <span className="font-mono text-white">{formatMoney(estRevenue)}</span></span>
                {estimatedCostCents > 0 && (
                  <>
                    <span className="text-gray-400">Est. Cost: <span className="font-mono text-white">{formatMoney(estimatedCostCents)}</span></span>
                    <span className="text-gray-400">Margin: <span className={`font-mono font-medium ${estMarginPct >= 20 ? 'text-emerald-400' : estMarginPct >= 10 ? 'text-amber-400' : 'text-red-400'}`}>{estMarginPct}%</span></span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : isService ? <Briefcase className="w-4 h-4" /> : <HardHat className="w-4 h-4" />}
            Create {isService ? 'Engagement' : 'Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
