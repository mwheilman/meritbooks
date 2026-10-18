'use client';

/**
 * BankFeedRefineBar — the view-only "refine + saved views" strip that sits above
 * the transaction table. It narrows the ALREADY-LOADED rows by confidence band and
 * vendor and lets the reviewer save/recall a lens (status + band + vendor + search
 * + sort). None of this posts, categorizes, or moves money — it only changes what
 * the current reviewer sees. Saved lenses live in localStorage (per company).
 */

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Bookmark, BookmarkPlus, ChevronDown, X, Check, Filter } from 'lucide-react';
import type { ConfidenceBand, ConfidenceBandFilter } from './bank-feed-refine';
import type { SavedView } from './bank-feed-views';

const BANDS: Array<{ key: ConfidenceBandFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'high', label: 'High ≥90%' },
  { key: 'medium', label: 'Med 70–89%' },
  { key: 'low', label: 'Low <70%' },
  { key: 'uncoded', label: 'Uncoded' },
];

export interface BankFeedRefineBarProps {
  band: ConfidenceBandFilter;
  onBandChange: (b: ConfidenceBandFilter) => void;
  bandCounts: Record<ConfidenceBand, number> & { all: number };
  vendor: string | null;
  onVendorChange: (v: string | null) => void;
  vendors: string[];
  views: SavedView[];
  activeViewId: string | null;
  onApplyView: (view: SavedView) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
}

export function BankFeedRefineBar({
  band,
  onBandChange,
  bandCounts,
  vendor,
  onVendorChange,
  vendors,
  views,
  activeViewId,
  onApplyView,
  onSaveView,
  onDeleteView,
}: BankFeedRefineBarProps) {
  const [vendorOpen, setVendorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const vendorRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click / Escape.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (vendorRef.current && !vendorRef.current.contains(e.target as Node)) setVendorOpen(false);
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) setSaving(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setVendorOpen(false);
        setSaving(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function commitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    setName('');
    setSaving(false);
  }

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Confidence band segmented control */}
        <div
          className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800"
          role="group"
          aria-label="Filter by confidence band"
        >
          {BANDS.map((b) => {
            const count = b.key === 'all' ? bandCounts.all : bandCounts[b.key as ConfidenceBand];
            const active = band === b.key;
            return (
              <button
                key={b.key}
                onClick={() => onBandChange(b.key)}
                aria-pressed={active}
                className={clsx(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs transition-colors',
                  active ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300',
                )}
              >
                <span>{b.label}</span>
                <span className={clsx('font-mono tabular-nums', active ? 'text-brand-400' : 'text-slate-600')}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Vendor filter */}
        <div ref={vendorRef} className="relative">
          <button
            onClick={() => setVendorOpen((o) => !o)}
            disabled={vendors.length === 0}
            aria-haspopup="listbox"
            aria-expanded={vendorOpen}
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs border transition-colors',
              vendor
                ? 'border-brand-500/40 bg-brand-500/10 text-brand-400'
                : 'border-slate-800 bg-surface-900 text-slate-400 hover:text-slate-300 disabled:opacity-40',
            )}
          >
            <Filter size={12} />
            <span className="max-w-[140px] truncate">{vendor ?? 'All vendors'}</span>
            {vendor ? (
              <X
                size={12}
                onClick={(e) => {
                  e.stopPropagation();
                  onVendorChange(null);
                  setVendorOpen(false);
                }}
                aria-label="Clear vendor filter"
                className="hover:text-white"
              />
            ) : (
              <ChevronDown size={12} />
            )}
          </button>
          {vendorOpen && vendors.length > 0 && (
            <div
              role="listbox"
              aria-label="Vendors"
              className="absolute z-30 left-0 top-full mt-1 w-56 max-h-64 overflow-y-auto bg-surface-900 border border-slate-700 rounded-lg shadow-xl"
            >
              <button
                role="option"
                aria-selected={vendor == null}
                onClick={() => {
                  onVendorChange(null);
                  setVendorOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-2xs text-slate-300 hover:bg-white/[0.04] border-b border-slate-800/50"
              >
                {vendor == null && <Check size={11} className="text-brand-400" />}
                <span className={clsx(vendor != null && 'ml-[19px]')}>All vendors</span>
              </button>
              {vendors.map((v) => (
                <button
                  key={v}
                  role="option"
                  aria-selected={vendor === v}
                  onClick={() => {
                    onVendorChange(v);
                    setVendorOpen(false);
                  }}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-2xs transition-colors',
                    vendor === v ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]',
                  )}
                >
                  {vendor === v ? <Check size={11} className="text-brand-400" /> : <span className="w-[11px]" />}
                  <span className="truncate">{v}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Save current view */}
        <div ref={saveRef} className="relative ml-auto">
          <button
            onClick={() => setSaving((s) => !s)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs border border-slate-800 bg-surface-900 text-slate-400 hover:text-slate-200 transition-colors"
            title="Save the current status + band + vendor + sort as a reusable view"
          >
            <BookmarkPlus size={12} /> Save view
          </button>
          {saving && (
            <div className="absolute z-30 right-0 top-full mt-1 w-64 bg-surface-900 border border-slate-700 rounded-lg shadow-xl p-3">
              <label htmlFor="save-view-name" className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-1.5">
                View name
              </label>
              <input
                id="save-view-name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSave();
                }}
                placeholder="e.g. Low-confidence review"
                className="w-full px-2.5 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-2xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
              />
              <div className="flex items-center justify-end gap-2 mt-2">
                <button
                  onClick={() => {
                    setSaving(false);
                    setName('');
                  }}
                  className="px-2.5 py-1 rounded text-2xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  onClick={commitSave}
                  disabled={!name.trim()}
                  className="px-2.5 py-1 rounded text-2xs font-medium bg-brand-600 text-white hover:bg-brand-500 disabled:bg-slate-800 disabled:text-slate-600"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Saved view chips */}
      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Bookmark size={12} className="text-slate-600 shrink-0" />
          {views.map((v) => {
            const active = v.id === activeViewId;
            return (
              <span
                key={v.id}
                className={clsx(
                  'group inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-2xs border transition-colors',
                  active
                    ? 'border-brand-500/40 bg-brand-500/10 text-brand-400'
                    : 'border-slate-800 bg-surface-900 text-slate-400 hover:text-slate-200',
                )}
              >
                <button onClick={() => onApplyView(v)} className="max-w-[160px] truncate" title={`Apply "${v.name}"`}>
                  {v.name}
                </button>
                <button
                  onClick={() => onDeleteView(v.id)}
                  aria-label={`Delete saved view ${v.name}`}
                  className="p-0.5 rounded-full text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
