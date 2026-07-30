'use client';

import { useCallback, useRef, useState } from 'react';
import { Sparkles, Upload, FileText, Loader2, X, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

interface LocationOption { id: string; name: string; short_code: string }

interface IntakeResponse {
  bill_id: string;
  vendor_id: string;
  vendor_created: boolean;
  tier: 'auto' | 'review' | 'escalate';
  status: 'PENDING' | 'ON_HOLD';
  confidence: number;
  lines_created: number;
}

/**
 * One-shot autonomous intake: pick a company + drop an invoice, and the machine
 * parses it, resolves-or-creates the vendor, and files a PENDING (or ON_HOLD)
 * draft bill. A human still approves the money — this only does the data entry.
 */
export function AutoFileModal({ onClose, onFiled }: { onClose: () => void; onFiled: () => void }) {
  const [locationId, setLocationId] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];

  const submit = useCallback(
    async (file: File) => {
      setError('');
      if (!locationId) {
        setError('Select a company first.');
        return;
      }
      setBusy(true);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('location_id', locationId);

      try {
        const res = await fetch('/api/bills/intake', { method: 'POST', body: formData });
        const data: IntakeResponse | { error?: string } = await res.json();
        if (!res.ok || !('bill_id' in data)) {
          const msg = ('error' in data && data.error) || 'Failed to file invoice';
          setError(msg);
          addToast('error', msg);
          setBusy(false);
          return;
        }

        const vendorNote = data.vendor_created ? ' New vendor created.' : '';
        if (data.status === 'ON_HOLD') {
          addToast('error', `Held for review — low confidence.${vendorNote}`);
        } else {
          addToast('success', `Filed as PENDING — review it.${vendorNote}`);
        }
        onFiled();
      } catch {
        const msg = 'Network error while filing the invoice.';
        setError(msg);
        addToast('error', msg);
        setBusy(false);
      }
    },
    [locationId, onFiled],
  );

  const onPick = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setFileName(file.name);
      void submit(file);
    },
    [submit],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-indigo-400" />
            <h2 className="text-base font-semibold text-white">Auto-file invoice</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-xs text-slate-400 leading-relaxed">
            Drop a vendor invoice and the machine will read it, match or create the vendor, and
            file a <span className="text-emerald-400 font-medium">PENDING</span> draft bill for your
            review. Low-confidence extractions are held for a closer look. Nothing posts to the
            ledger until you approve it.
          </p>

          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium">Company</label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white disabled:opacity-50"
            >
              <option value="">Select...</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.short_code} · {l.name}
                </option>
              ))}
            </select>
          </div>

          <div
            onClick={() => !busy && locationId && fileInputRef.current?.click()}
            className={clsx(
              'border-2 border-dashed rounded-xl p-8 text-center transition-colors',
              busy || !locationId
                ? 'border-slate-800 cursor-not-allowed opacity-60'
                : 'border-slate-700 cursor-pointer hover:border-indigo-500/40 hover:bg-indigo-500/[0.02]',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              disabled={busy}
              onChange={(e) => onPick(e.target.files?.[0])}
            />
            {busy ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 size={24} className="text-indigo-400 animate-spin" />
                <p className="text-sm text-indigo-300">Reading {fileName || 'the invoice'}...</p>
                <p className="text-xs text-slate-500">Parsing, matching the vendor, and filing the draft</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-center gap-3 mb-2">
                  <Upload size={20} className="text-slate-500" />
                  <FileText size={20} className="text-slate-500" />
                </div>
                <p className="text-sm text-slate-300">
                  {locationId ? 'Drop an invoice or click to upload' : 'Pick a company first'}
                </p>
                <p className="text-xs text-slate-500 mt-1">PDF, JPEG, PNG, WebP · up to 10MB</p>
              </>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={13} className="text-red-400" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
