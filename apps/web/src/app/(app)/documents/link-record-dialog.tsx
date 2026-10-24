'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog, Field, InlineNotice, Search, Select, useDebounce, useQuery } from '@meritbooks/merit-ui';
import { LINK_TYPES } from './documents-types';
import s from './documents.module.css';

interface PickRow {
  id: string;
  label: string;
  locationId: string | null;
}

export interface LinkRecordDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen record; may be async (the dialog shows busy until it settles). */
  onPick: (type: string, id: string, label: string) => Promise<void> | void;
  /** Fix the record type (e.g. 'vendor' when a W-9 needs its vendor). */
  fixedType?: string | null;
  /** Pre-select a type (the document's likely module). */
  defaultType?: string | null;
  /** Narrow to one company. */
  locationId?: string | null;
  title?: string;
}

/**
 * "Link to existing record" — pick a lease / loan / vendor / … the document belongs to.
 * Searches through /api/documents/link-targets (RLS: only records the person can see).
 */
export function LinkRecordDialog({ open, onClose, onPick, fixedType = null, defaultType = null, locationId = null, title }: LinkRecordDialogProps) {
  const [type, setType] = useState<string>(fixedType ?? defaultType ?? 'lease');
  const [q, setQ] = useState('');
  const term = useDebounce(q, 250);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType(fixedType ?? defaultType ?? 'lease');
      setQ('');
    }
  }, [open, fixedType, defaultType]);

  const { data, error, isLoading } = useQuery<{ data: PickRow[] }>(
    open ? '/api/documents/link-targets' : null,
    { type, q: term || undefined, location_id: locationId ?? undefined },
    { scope: false },
  );
  const rows = data?.data ?? [];
  const typeLabel = LINK_TYPES.find((t) => t.value === type)?.label ?? 'record';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? 'Link to an existing record'}
      width={560}
      actions={<Button onClick={onClose}>Cancel</Button>}
      footNote="The link shows on both sides: the document lists the record, and the record lists its source document."
    >
      <div className={s.inline}>
        {!fixedType && (
          <Field label="Record type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {LINK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={`Find the ${typeLabel.toLowerCase()}`}>
          <Search aria-label={`Search ${typeLabel}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, number…" />
        </Field>
      </div>
      {error ? (
        <InlineNotice tone="neg" title="Couldn’t search.">{error}</InlineNotice>
      ) : isLoading && rows.length === 0 ? (
        <p className="t-cap" style={{ marginTop: 12 }}>Searching…</p>
      ) : rows.length === 0 ? (
        <p className="t-cap" style={{ marginTop: 12 }}>No {typeLabel.toLowerCase()} records match. Create it in its module first, then link it here.</p>
      ) : (
        <ul className={s.picks} aria-label="Matching records">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={busy !== null}
                aria-busy={busy === r.id}
                onClick={async () => {
                  setBusy(r.id);
                  try {
                    await onPick(type, r.id, r.label);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <span className="t-body">{r.label}</span>
                {busy === r.id && <span className="t-cap"> — linking…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
