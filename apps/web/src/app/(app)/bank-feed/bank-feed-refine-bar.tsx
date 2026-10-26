'use client';

/**
 * BankFeedRefineBar — the view-only "refine + saved views" strip above the queue. The
 * confidence bands (kit Bands: Decide / Check / Ready, lowest first, plus Uncoded and
 * All) narrow the ALREADY-LOADED rows; a vendor filter narrows further; a lens (status +
 * band + vendor + search + sort) can be saved and recalled. None of this posts,
 * categorizes, or moves money — it only changes what the current reviewer sees. Saved
 * lenses live in localStorage (per company).
 */

import { useRef, useState } from 'react';
import { Bands, Button, Field, Icon, Input, Popover, Select, type BandItem } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import type { ConfidenceBand, ConfidenceBandFilter } from './bank-feed-refine';
import type { SavedView } from './bank-feed-views';
import styles from './bank-feed.module.css';

const BANDS: Array<{ key: ConfidenceBandFilter; label: string; caption: string }> = [
  { key: 'all', label: 'All', caption: 'Every loaded line' },
  { key: 'low', label: 'Decide', caption: 'Under 70' },
  { key: 'medium', label: 'Check', caption: '70–89 · one look each' },
  { key: 'high', label: 'Ready', caption: '90+ · ready to batch' },
  { key: 'uncoded', label: 'Uncoded', caption: 'Not scored yet' },
];

export interface BankFeedRefineBarProps {
  band: ConfidenceBandFilter;
  onBandChange: (b: ConfidenceBandFilter) => void;
  bandCounts: Record<ConfidenceBand, number> & { all: number };
  /** Signed cents per band (same vendor scope as the counts) for the band captions. */
  bandTotals?: Record<ConfidenceBandFilter, number>;
  vendor: string | null;
  onVendorChange: (v: string | null) => void;
  vendors: string[];
  views: SavedView[];
  activeViewId: string | null;
  onApplyView: (view: SavedView) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
}

const ALL_VENDORS = '__all__';

export function BankFeedRefineBar({
  band,
  onBandChange,
  bandCounts,
  bandTotals,
  vendor,
  onVendorChange,
  vendors,
  views,
  activeViewId,
  onApplyView,
  onSaveView,
  onDeleteView,
}: BankFeedRefineBarProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const saveRef = useRef<HTMLButtonElement>(null);

  function closeSave() {
    setSaving(false);
    setName('');
  }

  function commitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    closeSave();
  }

  const bandItems: BandItem<ConfidenceBandFilter>[] = BANDS.map((b) => {
    const count = b.key === 'all' ? bandCounts.all : bandCounts[b.key as ConfidenceBand];
    const total = bandTotals?.[b.key];
    return {
      value: b.key,
      label: b.label,
      count: count.toLocaleString(),
      caption: (
        <span className="tnum">
          {b.caption}
          {total != null && count > 0 ? ` · ${formatMoney(total)}` : ''}
        </span>
      ),
    };
  });

  // Keep a vendor that is no longer in the loaded rows selectable (so the filter can be cleared).
  const vendorOptions = vendor && !vendors.includes(vendor) ? [vendor, ...vendors] : vendors;

  return (
    <>
      <Bands<ConfidenceBandFilter>
        className={styles.bands}
        aria-label="Filter by confidence band"
        value={band}
        onChange={onBandChange}
        items={bandItems}
      />

      <div className={styles.toolbar}>
        <Select
          className={styles.vendorSelect}
          aria-label="Filter by vendor"
          value={vendor ?? ALL_VENDORS}
          disabled={vendorOptions.length === 0}
          onChange={(e) => onVendorChange(e.target.value === ALL_VENDORS ? null : e.target.value)}
        >
          <option value={ALL_VENDORS}>All vendors</option>
          {vendorOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
        {vendor && (
          <Button variant="quiet" icon="x" onClick={() => onVendorChange(null)}>
            Clear vendor
          </Button>
        )}

        {views.length > 0 && (
          <div className={styles.views} role="group" aria-label="Saved views">
            {views.map((v) => {
              const active = v.id === activeViewId;
              return (
                <span key={v.id} className={styles.view} data-on={active}>
                  <button
                    type="button"
                    className={styles.viewApply}
                    onClick={() => onApplyView(v)}
                    aria-pressed={active}
                    title={`Apply "${v.name}"`}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    className={styles.viewDel}
                    onClick={() => onDeleteView(v.id)}
                    aria-label={`Delete saved view ${v.name}`}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <span className="sp" />
        <Button
          ref={saveRef}
          variant="quiet"
          icon="plus"
          onClick={() => setSaving((s) => !s)}
          aria-haspopup="dialog"
          aria-expanded={saving}
          title="Save the current status, band, vendor, search and sort as a view"
        >
          Save view
        </Button>
        <Popover open={saving} onClose={closeSave} anchorRef={saveRef} width={300} placement="bottom-end" aria-label="Save this view">
          <form
            className={styles.saveForm}
            onSubmit={(e) => {
              e.preventDefault();
              commitSave();
            }}
          >
            <Field label="View name" help="Saved in this browser, for this company.">
              <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Low-confidence review" maxLength={60} />
            </Field>
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="quiet" onClick={closeSave}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={!name.trim()}>
                Save view
              </Button>
            </div>
          </form>
        </Popover>
      </div>
    </>
  );
}
