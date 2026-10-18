'use client';

import { useState, useCallback, type ReactNode } from 'react';
import { Loader2, Lock, ShieldCheck, X } from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';

/**
 * Vendor payment-detail capture — the pay-run modal where a preparer records how
 * a vendor is paid: method (ACH / check) and, for ACH, the bank detail. MeritBooks
 * stores only the LAST 4 digits (masked) of the account/routing numbers — the full
 * numbers are sent once to be masked server-side and are never persisted or
 * returned. This is NOT a live-ACH origination store; there is no ACH provider.
 */

export interface VendorPaymentProfileView {
  vendorId: string;
  paymentMethod: 'ACH' | 'CHECK';
  accountType: 'checking' | 'savings' | null;
  accountMask: string | null;
  routingMask: string | null;
  bankName: string | null;
  notes: string | null;
  hasBankDetails: boolean;
}

export function VendorPaymentDetailsModal({
  vendorId,
  vendorName,
  existing,
  onClose,
  onSaved,
}: {
  vendorId: string;
  vendorName: string;
  existing: VendorPaymentProfileView | null;
  onClose: () => void;
  onSaved: (profile: VendorPaymentProfileView) => void;
}) {
  const [method, setMethod] = useState<'ACH' | 'CHECK'>(existing?.paymentMethod ?? 'ACH');
  const [accountType, setAccountType] = useState<'checking' | 'savings'>(existing?.accountType ?? 'checking');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState(existing?.bankName ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ap/vendor-payment-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId,
          paymentMethod: method,
          accountType: method === 'ACH' ? accountType : null,
          // Sent once, masked to last-4 server-side, never stored in full.
          routingNumber: method === 'ACH' ? routingNumber : null,
          accountNumber: method === 'ACH' ? accountNumber : null,
          bankName: method === 'ACH' ? bankName : null,
          notes,
        }),
      });
      const result = (await res.json()) as { profile?: VendorPaymentProfileView; error?: string };
      if (!res.ok || !result.profile) {
        addToast('error', result.error ?? 'Failed to save payment details');
        return;
      }
      addToast('success', `Saved payment details for ${vendorName}`);
      onSaved(result.profile);
      onClose();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setSaving(false);
    }
  }, [vendorId, vendorName, method, accountType, routingNumber, accountNumber, bankName, notes, onSaved, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-800 bg-surface-900 p-5 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Payment details</h3>
            <p className="text-2xs text-slate-500 mt-0.5 max-w-[300px] truncate">{vendorName}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X size={16} />
          </button>
        </div>

        <div className="rounded-lg border border-indigo-900/40 bg-indigo-950/20 p-2.5 flex items-start gap-2">
          <Lock size={13} className="text-indigo-400 mt-0.5 shrink-0" />
          <p className="text-2xs text-indigo-200/80 leading-relaxed">
            We store only the last 4 digits of any account. The full numbers are never saved — enter them once and
            we mask them immediately.
          </p>
        </div>

        <Field label="Payment method">
          <div className="grid grid-cols-2 gap-2">
            {(['ACH', 'CHECK'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={clsx(
                  'px-3 py-2 rounded-lg text-xs font-medium border transition-colors',
                  method === m
                    ? 'bg-emerald-600/20 border-emerald-600 text-emerald-300'
                    : 'bg-surface-950 border-slate-800 text-slate-400 hover:border-slate-700',
                )}
              >
                {m === 'ACH' ? 'ACH / bank transfer' : 'Check'}
              </button>
            ))}
          </div>
        </Field>

        {method === 'ACH' ? (
          <>
            <Field label="Account type">
              <div className="grid grid-cols-2 gap-2">
                {(['checking', 'savings'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setAccountType(t)}
                    className={clsx(
                      'px-3 py-2 rounded-lg text-xs font-medium border capitalize transition-colors',
                      accountType === t
                        ? 'bg-slate-700 border-slate-600 text-white'
                        : 'bg-surface-950 border-slate-800 text-slate-400 hover:border-slate-700',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Bank name">
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="e.g. First National"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={existing?.routingMask ? `Routing (on file ${existing.routingMask})` : 'Routing number'}>
                <input
                  value={routingNumber}
                  onChange={(e) => setRoutingNumber(e.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={existing?.routingMask ? 'Replace…' : '9 digits'}
                  className={clsx(inputCls, 'font-mono')}
                />
              </Field>
              <Field label={existing?.accountMask ? `Account (on file ${existing.accountMask})` : 'Account number'}>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={existing?.accountMask ? 'Replace…' : 'Account #'}
                  className={clsx(inputCls, 'font-mono')}
                />
              </Field>
            </div>
          </>
        ) : (
          <Field label="Notes (e.g. remit-to / memo)">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              className={inputCls}
            />
          </Field>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-950 border border-slate-800 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Save details
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full px-2.5 py-1.5 rounded-md bg-surface-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-2xs font-medium uppercase tracking-wider text-slate-500">{label}</label>
      {children}
    </div>
  );
}
