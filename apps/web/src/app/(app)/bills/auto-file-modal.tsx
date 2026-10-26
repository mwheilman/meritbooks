'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Button, Dialog, Field, Icon, InlineNotice, Select, cx } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import s from './bills.module.css';

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
  const [over, setOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: locData, isLoading: locLoading } = useQuery<LocationOption[]>('/api/locations');
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

  const canPick = !busy && !!locationId;
  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOver(false);
    if (canPick) onPick(e.dataTransfer.files?.[0]);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Auto-file a bill"
      footNote="Nothing posts to the ledger until you approve it."
      actions={<Button onClick={onClose}>{busy ? 'Close' : 'Cancel'}</Button>}
    >
      <div className={s.dialogBody}>
        <p className="ink-2">
          Drop a vendor invoice and Merit reads it, matches or creates the vendor, and files a
          pending draft bill for your review. Low-confidence reads are held for a closer look.
        </p>

        <Field label="Company">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={busy || locLoading} data-autofocus>
            <option value="">{locLoading ? 'Loading companies…' : 'Select…'}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.short_code} · {l.name}
              </option>
            ))}
          </Select>
        </Field>

        <input
          ref={fileInputRef}
          type="file"
          className="sr"
          tabIndex={-1}
          aria-hidden="true"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          disabled={busy}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <button
          type="button"
          className={cx(s.drop, over && s.dropOver)}
          disabled={!canPick}
          aria-busy={busy || undefined}
          onClick={() => canPick && fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); if (canPick) setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          {busy ? (
            <>
              <span className="t-head" role="status">Reading {fileName || 'the invoice'}…</span>
              <span className="t-cap">Reading it, matching the vendor, and filing the draft.</span>
            </>
          ) : (
            <>
              <span className={s.dropIcon} aria-hidden="true"><Icon name="upload" /><Icon name="file-text" /></span>
              <span className="t-head">{locationId ? 'Drop an invoice, or click to upload' : 'Pick a company first'}</span>
              <span className="t-cap">PDF, JPEG, PNG or WebP · up to 10 MB</span>
            </>
          )}
        </button>

        {error && (
          <InlineNotice tone="neg" title="Not filed.">{error}</InlineNotice>
        )}
      </div>
    </Dialog>
  );
}
