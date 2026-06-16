'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Upload, Check, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

type Style = 'MODERN' | 'CLASSIC' | 'MINIMAL' | 'BOLD' | 'COMPACT';
interface Entity {
  locationId: string; name: string; shortCode: string;
  style: Style; accentColor: string; logoUrl: string | null;
  remitTo: string; footerText: string; defaultMessage: string;
}

const STYLES: { key: Style; label: string; blurb: string }[] = [
  { key: 'MODERN', label: 'Modern', blurb: 'Accent header band, filled balance, sans-serif. Contemporary.' },
  { key: 'CLASSIC', label: 'Classic', blurb: 'Centered serif masthead, ruled table. Formal and traditional.' },
  { key: 'MINIMAL', label: 'Minimal', blurb: 'Monospaced figures, hairline rules, lots of white space. Technical.' },
  { key: 'BOLD', label: 'Bold', blurb: 'Full-width colored header block. Brand-forward and confident.' },
  { key: 'COMPACT', label: 'Compact', blurb: 'Dense, businesslike layout. Best for invoices with many line items.' },
];
const SWATCHES = ['#10b981', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#0891b2', '#111827'];

export function InvoiceBranding() {
  const { data, isLoading, error } = useQuery<{ entities: Entity[] }>('/api/settings/invoice-branding');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [typeLabel, setTypeLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data?.entities?.length) {
      setEntities(data.entities);
      setActiveId((cur) => cur || data.entities[0].locationId);
    }
  }, [data]);

  const active = entities.find((e) => e.locationId === activeId);
  const patch = useCallback((p: Partial<Entity>) => {
    setEntities((list) => list.map((e) => (e.locationId === activeId ? { ...e, ...p } : e)));
  }, [activeId]);

  const previewUrl = active
    ? `/api/settings/invoice-branding/preview?style=${active.style}&accent=${encodeURIComponent(active.accentColor)}&entity=${encodeURIComponent(active.name)}${active.logoUrl ? `&logo=${encodeURIComponent(active.logoUrl)}` : ''}`
    : '';

  const onUpload = useCallback(async (file: File) => {
    if (!active) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('location_id', active.locationId);
      const res = await fetch('/api/settings/invoice-branding/logo', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) { addToast('error', body.error ?? 'Upload failed'); return; }
      patch({ logoUrl: body.url });
      addToast('success', 'Logo uploaded');
    } finally { setUploading(false); }
  }, [active, patch]);

  const save = useCallback(async () => {
    if (!active) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/invoice-branding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: active.locationId, style: active.style, accent_color: active.accentColor,
          logo_url: active.logoUrl, remit_to: active.remitTo, footer_text: active.footerText,
          default_message: active.defaultMessage,
        }),
      });
      const body = await res.json();
      if (!res.ok) { addToast('error', body.error ?? 'Save failed'); return; }
      addToast('success', `Saved invoice display options for ${active.name}`);
    } finally { setSaving(false); }
  }, [active]);

  if (isLoading) return <div className="flex items-center gap-2 text-slate-400 p-6"><Loader2 className="animate-spin" size={16} /> Loading…</div>;
  if (error) return <div className="p-6 text-red-400">Couldn’t load branding settings. Refresh to try again.</div>;
  if (!active) return <div className="p-6 text-slate-400">No active entities to brand yet.</div>;

  return (
    <div>
      <div className="mb-1"><h2 className="text-lg font-semibold text-white">Invoice display</h2></div>
      <p className="text-sm text-slate-400 mb-5">Pick the look customers see on invoices and the hosted payment page. Each entity can have its own.</p>

      {entities.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {entities.map((e) => (
            <button key={e.locationId} onClick={() => setActiveId(e.locationId)}
              className={clsx('px-3 py-1.5 rounded-md text-sm', e.locationId === activeId ? 'bg-emerald-500/10 text-emerald-400 font-medium' : 'text-slate-400 hover:text-white hover:bg-slate-800/50')}>
              {e.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Controls */}
        <div className="space-y-6">
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Style</label>
            <div className="space-y-2">
              {STYLES.map((s) => (
                <button key={s.key} onClick={() => patch({ style: s.key })}
                  className={clsx('w-full text-left rounded-lg border p-3 transition', active.style === s.key ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-700 hover:border-slate-600')}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">{s.label}</span>
                    {active.style === s.key && <Check size={15} className="text-emerald-400" />}
                  </div>
                  <span className="text-xs text-slate-400">{s.blurb}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Accent color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {SWATCHES.map((c) => (
                <button key={c} onClick={() => patch({ accentColor: c })} title={c}
                  className={clsx('w-8 h-8 rounded-full border-2', active.accentColor.toLowerCase() === c ? 'border-white' : 'border-transparent')}
                  style={{ background: c }} />
              ))}
              <input type="color" value={active.accentColor} onChange={(e) => patch({ accentColor: e.target.value })}
                className="w-8 h-8 rounded cursor-pointer bg-transparent" title="Custom color" />
              <input type="text" value={active.accentColor} onChange={(e) => patch({ accentColor: e.target.value })}
                className="w-24 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-white font-mono" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Logo</label>
            <div className="flex items-center gap-3">
              {active.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={active.logoUrl} alt="logo" className="h-10 max-w-[140px] object-contain bg-white rounded p-1" />
              ) : (
                <div className="h-10 px-3 flex items-center text-xs text-slate-500 border border-dashed border-slate-700 rounded">No logo</div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-slate-800 text-slate-200 hover:bg-slate-700">
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload
              </button>
              {active.logoUrl && <button onClick={() => patch({ logoUrl: null })} className="text-xs text-slate-500 hover:text-red-400">Remove</button>}
            </div>
            <p className="text-2xs text-slate-500 mt-1">PNG, JPG, SVG, or WebP · under 2 MB</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Remit-to (pay-to block)</label>
            <textarea value={active.remitTo} onChange={(e) => patch({ remitTo: e.target.value })} rows={3}
              className="w-full px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-white"
              placeholder={`${active.name}\nPO Box 4410\nJohnston, IA 50131`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Footer</label>
            <input value={active.footerText} onChange={(e) => patch({ footerText: e.target.value })}
              className="w-full px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-white"
              placeholder="Questions? billing@yourco.com · (515) 555-0142" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Default invoice message</label>
            <textarea value={active.defaultMessage} onChange={(e) => patch({ defaultMessage: e.target.value })} rows={2}
              className="w-full px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-white"
              placeholder="Thank you for your business. Bank transfer (ACH) is free." />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button onClick={save} disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
            </button>
            <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
              <ExternalLink size={14} /> Open preview PDF
            </a>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Preview</label>
          <div className="rounded-lg overflow-hidden border border-slate-700 bg-slate-900" style={{ height: 560 }}>
            <iframe key={previewUrl} src={previewUrl} title="Invoice preview" className="w-full h-full" />
          </div>
          <p className="text-2xs text-slate-500 mt-1">Sample data. Reflects style, color, and logo as you change them.</p>
        </div>
      </div>

      <div className="mt-10 pt-6 border-t border-slate-800 grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h3 className="text-sm font-semibold text-white mb-1">Payment &amp; retainage defaults</h3>
          <p className="text-2xs text-slate-500 mb-3">Entity-level defaults. Customers and jobs can override these; invoices override everything.</p>
          <EntityInvoiceSettings scope="LOCATION" id={active.locationId} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white mb-1">Invoice-type text</h3>
          <p className="text-2xs text-slate-500 mb-3">Set default text for a kind of invoice (e.g. “Progress Bill”, “Deposit”). The label must match the invoice’s type.</p>
          <input value={typeLabel} onChange={(e) => setTypeLabel(e.target.value)} placeholder="Invoice type label, e.g. Progress Bill"
            className="w-full px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-white mb-3" />
          {typeLabel.trim() ? <InvoiceTextOverrides scope="INVOICE_TYPE" refId={typeLabel.trim()} /> : <p className="text-2xs text-slate-500">Enter a type label to edit its text.</p>}
        </div>
      </div>
    </div>
  );
}
