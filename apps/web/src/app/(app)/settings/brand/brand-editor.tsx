'use client';

import { useRef, useState } from 'react';
import { Button, Eyebrow, InlineNotice, Input, Seg, Switch } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';
import { onColorFor, ratioLabel } from '@/lib/branding/color';
import { fixPalette, suggestPalettes, PALETTE_ROLES, type BrandPalette, type PaletteRole, type SuggestedPalette } from '@/lib/branding/palette';
import { draftReport, paletteErrors, type BrandDraft } from '@/lib/branding/draft';
import { BRAND_FONTS, BRAND_FONT_LABELS, BRAND_FONT_STACKS, type LogoSlot, type ResolvedBrand } from '@/lib/branding/types';
import { extractFromFile, extractFromUrl } from './logo-colors';

const ROLE_LABEL: Record<PaletteRole, { name: string; help: string }> = {
  primary: { name: 'Brand colour', help: 'Buttons, links, the invoice header and balance.' },
  on_primary: { name: 'Text on brand colour', help: 'White or dark — whichever reads.' },
  secondary: { name: 'Secondary', help: 'Headings and secondary bands.' },
  accent: { name: 'Accent', help: 'Rules and highlights.' },
  ink: { name: 'Text', help: 'Body text on documents.' },
  surface: { name: 'Tint', help: 'Faint panels and table heads.' },
};

/** Which contrast checks speak for each colour field. */
const ROLE_CHECKS: Record<PaletteRole, string[]> = {
  primary: ['primary_on_white'],
  on_primary: ['on_primary'],
  secondary: ['secondary_on_white'],
  accent: ['accent_on_white'],
  ink: ['ink_on_surface', 'ink_on_white'],
  surface: ['ink_on_surface'],
};

const SLOTS: Array<{ slot: LogoSlot; key: 'logo_url' | 'logo_dark_url' | 'mark_url'; label: string; help: string; dark?: boolean }> = [
  { slot: 'logo', key: 'logo_url', label: 'Logo', help: 'For white backgrounds — invoices, the pay page, emails. Your colours are read from this one.' },
  { slot: 'logo_dark', key: 'logo_dark_url', label: 'Logo for dark backgrounds', help: 'Optional. A white or light version for coloured bands and the app’s dark rail.', dark: true },
  { slot: 'mark', key: 'mark_url', label: 'Square mark', help: 'Optional. Your icon on its own, for small spaces.' },
];

export interface BrandEditorProps {
  kind: 'tenant' | 'company';
  scopeName: string;
  locationId: string | null;
  draft: BrandDraft;
  onChange: (next: BrandDraft) => void;
  tenantResolved: ResolvedBrand;
  onEditTenant: () => void;
}

const samePalette = (a: BrandPalette, b: BrandPalette) => PALETTE_ROLES.every((r) => a[r].toUpperCase() === b[r].toUpperCase());

export function BrandEditor({ kind, scopeName, locationId, draft, onChange, tenantResolved, onEditTenant }: BrandEditorProps) {
  const [uploading, setUploading] = useState<LogoSlot | null>(null);
  const [reading, setReading] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedPalette[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const fileRefs = useRef<Record<LogoSlot, HTMLInputElement | null>>({ logo: null, logo_dark: null, mark: null });

  const set = <K extends keyof BrandDraft>(k: K, v: BrandDraft[K]) => onChange({ ...draft, [k]: v });
  const setColor = (role: PaletteRole, raw: string) => {
    const v = raw.trim() === '' ? '' : raw.startsWith('#') ? raw : `#${raw}`;
    const palette = { ...draft.palette, [role]: v.toUpperCase() };
    onChange({ ...draft, palette, palette_source: 'manual' });
  };

  const report = draftReport(draft);
  const errs = paletteErrors(draft.palette);
  const failingRequired = report.checks.filter((c) => c.required && !c.pass);

  async function readColours(source: File | string) {
    setReading(true);
    setReadError(null);
    try {
      const ex = typeof source === 'string' ? await extractFromUrl(source) : await extractFromFile(source);
      const list = suggestPalettes(ex);
      setSuggestions(list);
      return { ex, list };
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'The logo’s colours could not be read.');
      return null;
    } finally {
      setReading(false);
    }
  }

  async function upload(slot: LogoSlot, key: 'logo_url' | 'logo_dark_url' | 'mark_url', file: File) {
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      addToast('error', file.type === 'image/svg+xml' ? 'SVG logos aren’t supported yet. Export a PNG at least 600 px wide.' : 'Use a PNG or JPG image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      addToast('error', 'The logo must be under 2 MB.');
      return;
    }
    setUploading(slot);
    // Colours are read in the browser while the file uploads (the light logo only).
    const colours = slot === 'logo' ? readColours(file) : Promise.resolve(null);
    try {
      // The target rides the query string: the server checks permission + size before it
      // parses the multipart body.
      const fd = new FormData();
      fd.append('file', file);
      const qs = new URLSearchParams({ slot });
      if (locationId) qs.set('location_id', locationId);
      const res = await fetch(`/api/settings/brand/logo?${qs.toString()}`, { method: 'POST', body: fd });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        addToast('error', body.error ?? 'Could not upload the logo. Try again.');
        return;
      }
      const read = await colours;
      let next: BrandDraft = { ...draft, [key]: body.url };
      // A fresh logo on a derived (never hand-tuned) brand takes the first suggestion.
      if (read && read.list[0] && draft.palette_source === 'derived') {
        next = { ...next, palette: read.list[0].palette, extracted_colors: read.ex.colors.slice(0, 8).map((c) => c.hex) };
      } else if (read) {
        next = { ...next, extracted_colors: read.ex.colors.slice(0, 8).map((c) => c.hex) };
      }
      onChange(next);
      addToast('success', slot === 'logo' ? 'Uploaded the logo and read its colours. Save to keep them.' : 'Uploaded. Save to keep it.');
    } finally {
      setUploading(null);
    }
  }

  if (kind === 'company' && draft.use_tenant_brand) {
    return (
      <section className="mb-brand-sec">
        <Eyebrow>{['Company', 'Brand source']}</Eyebrow>
        <Switch
          label="Use the tenant brand"
          checked
          onChange={(e) => set('use_tenant_brand', e.target.checked)}
        />
        <p className="mb-brand-help">
          {scopeName}’s invoices, emails and portals use the tenant brand
          {tenantResolved.source === 'MERIT_DEFAULT' ? ' — which is still the Merit default.' : '.'} Turn this off to give {scopeName} its own logo and colours.
        </p>
        <Button variant="quiet" onClick={onEditTenant}>Edit the tenant brand</Button>
      </section>
    );
  }

  return (
    <>
      {kind === 'company' && (
        <section className="mb-brand-sec">
          <Eyebrow>{['Company', 'Brand source']}</Eyebrow>
          <Switch label="Use the tenant brand" checked={false} onChange={(e) => set('use_tenant_brand', e.target.checked)} />
          <p className="mb-brand-help">
            {scopeName} has its own brand. Logo slots you leave empty use the tenant’s logo.
          </p>
        </section>
      )}

      <section className="mb-brand-sec">
        <Eyebrow>{['01', 'Logo']}</Eyebrow>
        {SLOTS.map((s) => {
          const url = draft[s.key];
          return (
            <div className="field" key={s.slot}>
              <span className="field-label">{s.label}</span>
              <div className="mb-brand-logo">
                <span className={s.dark ? 'mb-brand-logo-box mb-brand-logo-box--dark' : 'mb-brand-logo-box'}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {url ? <img src={url} alt={`Current ${s.label.toLowerCase()}`} /> : <span>None</span>}
                </span>
                <input
                  ref={(el) => { fileRefs.current[s.slot] = el; }}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void upload(s.slot, s.key, f);
                  }}
                />
                <Button onClick={() => fileRefs.current[s.slot]?.click()} disabled={uploading !== null} aria-busy={uploading === s.slot || undefined}>
                  {uploading === s.slot ? 'Uploading…' : url ? 'Replace' : 'Upload'}
                </Button>
                {url && <Button variant="quiet" onClick={() => set(s.key, null)}>Remove</Button>}
                {s.slot === 'logo' && url && (
                  <Button variant="quiet" onClick={() => void readColours(url)} disabled={reading}>
                    {reading ? 'Reading colours…' : 'Suggest colours from logo'}
                  </Button>
                )}
              </div>
              <span className="field-help">{s.help} PNG or JPG, under 2 MB.</span>
            </div>
          );
        })}
        {readError && <InlineNotice tone="warn" title="Couldn't read the logo's colours.">{readError} You can still set colours by hand below.</InlineNotice>}
      </section>

      <section className="mb-brand-sec">
        <Eyebrow>{['02', 'Colours']}</Eyebrow>
        {draft.extracted_colors.length > 0 && (
          <div className="field">
            <span className="field-label">Colours found in your logo</span>
            <div className="mb-brand-found">
              {draft.extracted_colors.map((c) => (
                <span key={c} className="mb-brand-found-sw" title={c}>
                  <i style={{ background: c }} />
                  <span className="tnum">{c}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="field">
            <span className="field-label">Suggested palettes</span>
            <div className="mb-brand-suggest" role="group" aria-label="Suggested palettes">
              {suggestions.map((s) => {
                const on = samePalette(s.palette, draft.palette);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="mb-brand-card"
                    aria-pressed={on}
                    onClick={() => onChange({ ...draft, palette: s.palette, palette_source: 'derived' })}
                  >
                    <span className="mb-brand-card-strip" aria-hidden="true">
                      {(['primary', 'secondary', 'accent', 'ink', 'surface'] as const).map((r) => <i key={r} style={{ background: s.palette[r] }} />)}
                    </span>
                    <b>{s.name}</b>
                    <span>{s.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mb-brand-colors">
          {PALETTE_ROLES.map((role) => {
            const checks = report.checks.filter((c) => ROLE_CHECKS[role].includes(c.id));
            const bad = checks.find((c) => !c.pass);
            const value = draft.palette[role];
            const valid = !errs[role];
            return (
              <div className="mb-brand-color" key={role}>
                <label className="field-label" htmlFor={`brand-${role}`}>{ROLE_LABEL[role].name}</label>
                <div className="mb-brand-color-row">
                  <input
                    type="color"
                    className="mb-brand-picker"
                    aria-label={`${ROLE_LABEL[role].name} picker`}
                    value={valid ? value.toLowerCase() : '#000000'}
                    onChange={(e) => setColor(role, e.target.value)}
                  />
                  <Input
                    id={`brand-${role}`}
                    className="mb-brand-hex"
                    value={value}
                    maxLength={7}
                    invalid={!valid || (!!bad && bad.required)}
                    onChange={(e) => setColor(role, e.target.value)}
                  />
                  {role === 'on_primary' && valid && (
                    <Button variant="quiet" onClick={() => setColor('on_primary', onColorFor(draft.palette.primary))}>Auto</Button>
                  )}
                </div>
                <span className={!valid || (bad && bad.required) ? 'field-error' : bad ? 'mb-brand-warn' : 'field-help'}>
                  {!valid
                    ? errs[role]
                    : checks.length
                      ? checks.map((c) => `${ratioLabel(c.ratio)} ${c.id.endsWith('white') ? 'on white' : c.id === 'on_primary' ? 'on the brand colour' : 'on the tint'}${c.pass ? ' · passes' : c.required ? ` · needs ${c.min}:1` : ' · low'}`).join(' · ')
                      : ROLE_LABEL[role].help}
                </span>
              </div>
            );
          })}
        </div>

        {failingRequired.length > 0 && Object.keys(errs).length === 0 && (
          <InlineNotice tone="warn" title="Some text would be hard to read.">
            {failingRequired.map((c) => c.label).join('; ')}.{' '}
            <Button variant="quiet" onClick={() => onChange({ ...draft, palette: fixPalette(draft.palette) })}>Fix contrast</Button>
            <span className="t-cap"> Darkens only what fails; hues stay.</span>
          </InlineNotice>
        )}
      </section>

      <section className="mb-brand-sec">
        <Eyebrow>{['03', 'Type']}</Eyebrow>
        <div className="field">
          <span className="field-label">Font on documents and emails</span>
          <Seg
            aria-label="Font"
            value={draft.font}
            onChange={(v) => set('font', v)}
            items={BRAND_FONTS.map((f) => ({ value: f, label: <span style={{ fontFamily: BRAND_FONT_STACKS[f] }}>{BRAND_FONT_LABELS[f]}</span> }))}
          />
          <span className="field-help">PDFs print a matching built-in face: serif for Serif, sans serif otherwise.</span>
        </div>
      </section>
    </>
  );
}
