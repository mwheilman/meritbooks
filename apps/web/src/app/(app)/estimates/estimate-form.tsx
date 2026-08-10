'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks/use-query';
import { X, Loader2, Plus, FileText } from 'lucide-react';
import type { CustomerOption, AccountOption, JobOption, EstimateDetail } from './types';

interface FormLine {
  description: string;
  revenue_account_id: string;
  quantity: number;
  unit_price_cents: number;
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const plusDaysISO = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const emptyLine = (): FormLine => ({ description: '', revenue_account_id: '', quantity: 1, unit_price_cents: 0 });

/**
 * Create / edit an estimate. The page computes subtotal / tax / total in CENTS
 * live; the server recomputes them authoritatively on save. Editing is blocked
 * server-side for a converted estimate (this form only opens for non-converted).
 */
export function EstimateForm({
  mode,
  initial,
  locationId,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: EstimateDetail | null;
  locationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState(initial?.customer?.id ?? '');
  const [jobId, setJobId] = useState(initial?.job?.id ?? '');
  const [estimateDate, setEstimateDate] = useState(initial?.estimateDate ?? todayISO());
  const [expirationDate, setExpirationDate] = useState(initial?.expirationDate ?? plusDaysISO(30));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [taxCents, setTaxCents] = useState(initial?.taxCents ?? 0);
  const [lines, setLines] = useState<FormLine[]>(
    initial?.lines.length
      ? initial.lines.map((l) => ({
          description: l.description,
          revenue_account_id: l.revenueAccountId ?? '',
          quantity: l.quantity,
          unit_price_cents: l.unitPriceCents,
        }))
      : [emptyLine()],
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Org-wide reference data (customers/accounts are not location-scoped in their
  // routes); jobs ARE scoped to the active company via useQuery's auto-scoping.
  const { data: custData } = useQuery<{ customers?: CustomerOption[]; data?: CustomerOption[] }>(
    '/api/customers?per_page=200',
    undefined,
    { scope: false },
  );
  const { data: acctData } = useQuery<{ recent?: AccountOption[]; accounts?: AccountOption[] }>(
    '/api/accounts/search?q=4',
    undefined,
    { scope: false },
  );
  const { data: jobData } = useQuery<{ data?: JobOption[] }>('/api/jobs?status=ACTIVE&per_page=200');

  const customers = custData?.customers ?? custData?.data ?? [];
  const accounts = useMemo(
    () => [...(acctData?.recent ?? []), ...(acctData?.accounts ?? [])],
    [acctData],
  );
  const jobs = jobData?.data ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const subtotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const total = subtotal + taxCents;

  const addLine = () => setLines([...lines, emptyLine()]);
  const removeLine = (i: number) => {
    if (lines.length > 1) setLines(lines.filter((_, j) => j !== i));
  };
  const updateLine = (i: number, field: keyof FormLine, value: string | number) => {
    setLines(lines.map((l, j) => (j === i ? { ...l, [field]: value } : l)));
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!customerId) {
      setFormError('Select a customer');
      return;
    }
    if (lines.some((l) => !l.description || !l.revenue_account_id)) {
      setFormError('Every line needs a description and a revenue account');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        location_id: locationId,
        customer_id: customerId,
        job_id: jobId || null,
        estimate_date: estimateDate,
        expiration_date: expirationDate || null,
        notes: notes || undefined,
        tax_cents: taxCents,
        lines: lines.map((l) => ({
          description: l.description,
          revenue_account_id: l.revenue_account_id,
          quantity: l.quantity,
          unit_price_cents: l.unit_price_cents,
        })),
      };
      const res = await fetch(
        mode === 'create' ? '/api/estimates' : `/api/estimates/${initial?.id}`,
        {
          method: mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(result.error ?? 'Failed to save estimate');
        return;
      }
      onSaved();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-8 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? 'Create estimate' : 'Edit estimate'}
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl mb-8"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white">
            {mode === 'create' ? 'New Estimate' : `Edit ${initial?.estimateNumber ?? 'Estimate'}`}
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="est-customer" className="block text-xs text-gray-400 mb-1">
                Customer *
              </label>
              <select
                id="est-customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              >
                <option value="">Select customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="est-job" className="block text-xs text-gray-400 mb-1">
                Job / project (optional)
              </label>
              <select
                id="est-job"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              >
                <option value="">No job</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.job_number} · {j.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="est-date" className="block text-xs text-gray-400 mb-1">
                Estimate date *
              </label>
              <input
                id="est-date"
                type="date"
                value={estimateDate}
                onChange={(e) => setEstimateDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              />
            </div>
            <div>
              <label htmlFor="est-exp" className="block text-xs text-gray-400 mb-1">
                Valid until (expiration)
              </label>
              <input
                id="est-exp"
                type="date"
                value={expirationDate}
                onChange={(e) => setExpirationDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Line items</span>
              <button onClick={addLine} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                <Plus className="w-3 h-3" /> Add line
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Description</label>}
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => updateLine(i, 'description', e.target.value)}
                      placeholder="Service or item"
                      aria-label={`Line ${i + 1} description`}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder:text-gray-600"
                    />
                  </div>
                  <div className="col-span-3">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Revenue account</label>}
                    <select
                      value={line.revenue_account_id}
                      onChange={(e) => updateLine(i, 'revenue_account_id', e.target.value)}
                      aria-label={`Line ${i + 1} revenue account`}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white"
                    >
                      <option value="">Select account</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.account_number} · {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-1">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Qty</label>}
                    <input
                      type="number"
                      value={line.quantity}
                      min={0}
                      step={0.01}
                      aria-label={`Line ${i + 1} quantity`}
                      onChange={(e) => updateLine(i, 'quantity', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono tabular-nums"
                    />
                  </div>
                  <div className="col-span-2">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Unit price</label>}
                    <input
                      type="number"
                      value={(line.unit_price_cents / 100).toFixed(2)}
                      min={0}
                      step={0.01}
                      aria-label={`Line ${i + 1} unit price`}
                      onChange={(e) =>
                        updateLine(i, 'unit_price_cents', Math.round(parseFloat(e.target.value) * 100) || 0)
                      }
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono tabular-nums"
                    />
                  </div>
                  <div className="col-span-1 text-right font-mono text-sm text-white py-1.5 tabular-nums">
                    {formatMoney(Math.round(line.quantity * line.unit_price_cents))}
                  </div>
                  <div className="col-span-1">
                    {lines.length > 1 && (
                      <button
                        onClick={() => removeLine(i)}
                        aria-label={`Remove line ${i + 1}`}
                        className="p-1 text-gray-500 hover:text-red-400"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-700/50 pt-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Subtotal</span>
              <span className="font-mono text-white tabular-nums">{formatMoney(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm items-center">
              <span className="text-gray-400">Tax</span>
              <input
                type="number"
                value={(taxCents / 100).toFixed(2)}
                min={0}
                step={0.01}
                aria-label="Tax amount"
                onChange={(e) => setTaxCents(Math.round(parseFloat(e.target.value) * 100) || 0)}
                className="w-28 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono tabular-nums"
              />
            </div>
            <div className="flex justify-between text-base font-semibold border-t border-gray-700/50 pt-2">
              <span className="text-white">Total</span>
              <span className="font-mono text-emerald-400 tabular-nums">{formatMoney(total)}</span>
            </div>
          </div>

          <div>
            <label htmlFor="est-notes" className="block text-xs text-gray-400 mb-1">
              Notes (shown on the estimate)
            </label>
            <textarea
              id="est-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Terms, scope caveats, thank-you note…"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {mode === 'create' ? 'Create Estimate' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
