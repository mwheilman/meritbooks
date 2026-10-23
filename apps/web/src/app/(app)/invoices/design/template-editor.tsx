'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Button, Check, Eyebrow, Field, Input, Seg, Switch, Textarea, Select } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';
import {
  COLUMN_HELP, COLUMN_LABELS, DEFAULT_ACCENT, INVOICE_COLUMNS, INVOICE_LAYOUTS, REQUIRED_COLUMNS,
  type InvoiceColumn, type InvoiceLayout,
} from '@/lib/invoices/templates/types';
import type { TemplateBody } from '@/lib/invoices/templates/schema';
import type { FieldErrors } from './design-client';

const LAYOUTS: Record<InvoiceLayout, { name: string; blurb: string }> = {
  MODERN: { name: 'Modern', blurb: 'Brand-colour table header and balance block.' },
  CLASSIC: { name: 'Classic', blurb: 'Ruled masthead and table. Formal.' },
  MINIMAL: { name: 'Minimal', blurb: 'Thin brand rule, lots of white space.' },
  BOLD: { name: 'Bold', blurb: 'Full-width brand-colour header.' },
  COMPACT: { name: 'Compact', blurb: 'Dense. Best for many line items.' },
};

/** Brand colour shortcuts. Electric Blue first (the default); any hex is allowed. */
const SWATCHES = [DEFAULT_ACCENT, '#0A1628', '#3D4F65', '#1F6F5C', '#8A2D3B', '#B4541A', '#5B3E96'];

const slug = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 32) || 'field';

export function TemplateEditor({
  draft, errors, locationId, onChange, footer,
}: {
  draft: TemplateBody;
  errors: FieldErrors;
  locationId: string;
  onChange: (next: TemplateBody) => void;
  footer: ReactNode;
}) {
  const set = <K extends keyof TemplateBody>(k: K, v: TemplateBody[K]) => onChange({ ...draft, [k]: v });
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('location_id', locationId);
      const res = await fetch('/api/settings/invoice-branding/logo', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) { addToast('error', body.error ?? 'Could not upload the logo. Try again.'); return; }
      set('logo_url', body.url);
      addToast('success', 'Uploaded the logo. Save to keep it.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const toggleColumn = (c: InvoiceColumn, on: boolean) => {
    const next = on ? [...draft.visible_columns, c] : draft.visible_columns.filter((x) => x !== c);
    set('visible_columns', INVOICE_COLUMNS.filter((x) => next.includes(x)));
  };

  return (
    <form onSubmit={(e) => e.preventDefault()} aria-label="Template settings">
      <section className="mb-design-sec">
        <Eyebrow>{['01', 'Layout and brand']}</Eyebrow>
        <Field label="Template name" error={errors.name}>
          <Input value={draft.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label" id="layout-label">Layout</span>
          <div className="mb-design-layouts" role="group" aria-labelledby="layout-label">
            {INVOICE_LAYOUTS.map((l) => (
              <button key={l} type="button" className="mb-design-layout" aria-pressed={draft.style === l} onClick={() => set('style', l)}>
                <b>{LAYOUTS[l].name}</b>
                <span>{LAYOUTS[l].blurb}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">Font</span>
          <Seg
            aria-label="Font"
            value={draft.font}
            onChange={(v) => set('font', v)}
            items={[{ value: 'SANS', label: 'Sans serif' }, { value: 'SERIF', label: 'Serif' }]}
          />
        </div>
        <Field label="Brand colour" help="Your company's colour for the header, table and balance. Electric Blue is the default." error={errors.accent_color}>
          <div className="mb-design-swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className="mb-design-sw"
                style={{ background: c }}
                aria-label={`Use ${c}`}
                aria-pressed={draft.accent_color.toLowerCase() === c.toLowerCase()}
                onClick={() => set('accent_color', c)}
              />
            ))}
            <Input
              className="mb-design-hex"
              value={draft.accent_color}
              maxLength={7}
              aria-label="Brand colour hex code"
              onChange={(e) => set('accent_color', e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`)}
            />
          </div>
        </Field>
        <div className="field">
          <span className="field-label">Logo</span>
          <div className="mb-design-logo">
            {draft.logo_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={draft.logo_url} alt="Current logo" />
              : <span className="mb-design-logo-empty">No logo. The company name prints instead.</span>}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <Button onClick={() => fileRef.current?.click()} disabled={uploading} aria-busy={uploading || undefined}>
              {uploading ? 'Uploading…' : draft.logo_url ? 'Replace logo' : 'Upload logo'}
            </Button>
            {draft.logo_url && <Button variant="quiet" onClick={() => set('logo_url', null)}>Remove</Button>}
          </div>
          <span className="field-help">PNG or JPG, under 2 MB.</span>
          {errors.logo_url && <span className="field-error">{errors.logo_url}</span>}
        </div>
      </section>

      <section className="mb-design-sec">
        <Eyebrow>{['02', 'Line columns']}</Eyebrow>
        <p className="t-cap" style={{ marginBottom: 12 }}>
          Choose what prints on each line. Columns with nothing in them on an invoice are left off that invoice. Your GL account numbers never print.
        </p>
        <div className="mb-design-cols">
          {INVOICE_COLUMNS.map((c) => {
            const required = REQUIRED_COLUMNS.includes(c);
            return (
              <div key={c}>
                <Check
                  label={COLUMN_LABELS[c]}
                  checked={draft.visible_columns.includes(c)}
                  disabled={required}
                  onChange={(e) => toggleColumn(c, e.target.checked)}
                />
                <span className="mb-design-col-help">{COLUMN_HELP[c]}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-design-sec">
        <Eyebrow>{['03', 'Custom fields']}</Eyebrow>
        <div className="field">
          <span className="field-label">Header and footer fields</span>
          <div className="mb-design-pairs">
            {draft.custom_fields.map((f, i) => (
              <div key={i} className="mb-design-pair">
                <Input aria-label={`Field ${i + 1} label`} placeholder="Label, e.g. License #" value={f.label} maxLength={40}
                  onChange={(e) => set('custom_fields', draft.custom_fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <Input aria-label={`Field ${i + 1} value`} placeholder="Value, e.g. IA-C123456" value={f.value} maxLength={200}
                  onChange={(e) => set('custom_fields', draft.custom_fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <Select aria-label={`Field ${i + 1} placement`} value={f.placement}
                  onChange={(e) => set('custom_fields', draft.custom_fields.map((x, j) => (j === i ? { ...x, placement: e.target.value === 'FOOTER' ? 'FOOTER' : 'HEADER' } : x)))}>
                  <option value="HEADER">Header</option>
                  <option value="FOOTER">Footer</option>
                </Select>
                <Button variant="quiet" iconOnly icon="x" aria-label={`Remove field ${i + 1}`}
                  onClick={() => set('custom_fields', draft.custom_fields.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
          {Object.entries(errors).filter(([k]) => k.startsWith('custom_fields')).slice(0, 1).map(([k, m]) => <span key={k} className="field-error">{m}</span>)}
          <div style={{ marginTop: 8 }}>
            <Button icon="plus" disabled={draft.custom_fields.length >= 8}
              onClick={() => set('custom_fields', [...draft.custom_fields, { label: '', value: '', placement: 'HEADER' }])}>
              Add field
            </Button>
          </div>
          <span className="field-help">Printed with the invoice details (header) or along the bottom (footer). Up to 8.</span>
        </div>
        <div className="field">
          <span className="field-label">Custom line columns</span>
          <div className="mb-design-pairs">
            {draft.line_fields.map((f, i) => (
              <div key={i} className="mb-design-pair mb-design-pair--line">
                <Input aria-label={`Line column ${i + 1} label`} placeholder="Column label, e.g. Room" value={f.label} maxLength={30}
                  onChange={(e) => set('line_fields', draft.line_fields.map((x, j) => (j === i ? { label: e.target.value, key: x.key || slug(e.target.value) } : x)))}
                  onBlur={() => set('line_fields', draft.line_fields.map((x, j) => (j === i && !x.key ? { ...x, key: slug(x.label) } : x)))} />
                <Input aria-label={`Line column ${i + 1} key`} value={f.key} maxLength={32}
                  onChange={(e) => set('line_fields', draft.line_fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                <Button variant="quiet" iconOnly icon="x" aria-label={`Remove line column ${i + 1}`}
                  onClick={() => set('line_fields', draft.line_fields.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
          {Object.entries(errors).filter(([k]) => k.startsWith('line_fields')).slice(0, 1).map(([k, m]) => <span key={k} className="field-error">{m}</span>)}
          <div style={{ marginTop: 8 }}>
            <Button icon="plus" disabled={draft.line_fields.length >= 4}
              onClick={() => {
                const cols = draft.visible_columns.includes('custom') ? draft.visible_columns : INVOICE_COLUMNS.filter((x) => [...draft.visible_columns, 'custom'].includes(x));
                onChange({ ...draft, visible_columns: cols, line_fields: [...draft.line_fields, { label: '', key: '' }] });
              }}>
              Add line column
            </Button>
          </div>
          <span className="field-help">A value per line (stored under the key). Prints when &ldquo;Custom line fields&rdquo; is on and a line has a value.</span>
        </div>
      </section>

      <section className="mb-design-sec">
        <Eyebrow>{['04', 'Words on the invoice']}</Eyebrow>
        <Field label="Remit to" help="Who to pay and where to mail a check. Prints under From." error={errors.remit_to}>
          <Textarea rows={3} value={draft.remit_to ?? ''} maxLength={500} onChange={(e) => set('remit_to', e.target.value)} />
        </Field>
        <Field label="Payment instructions" help="Prints when online payment isn't available, and as 'Other ways to pay' when it is. For example bank wire details." error={errors.payment_instructions}>
          <Textarea rows={3} value={draft.payment_instructions ?? ''} maxLength={1000} onChange={(e) => set('payment_instructions', e.target.value)} />
        </Field>
        <Field label="Terms" help="Late fees, warranty, the fine print." error={errors.terms_text}>
          <Textarea rows={3} value={draft.terms_text ?? ''} maxLength={2000} onChange={(e) => set('terms_text', e.target.value)} />
        </Field>
        <Field label="Default message to the customer" help="An invoice's own message replaces it." error={errors.default_message}>
          <Textarea rows={2} value={draft.default_message ?? ''} maxLength={1000} onChange={(e) => set('default_message', e.target.value)} />
        </Field>
        <Field label="Footer" help="One line along the bottom of every page." error={errors.footer_text}>
          <Input value={draft.footer_text ?? ''} maxLength={300} onChange={(e) => set('footer_text', e.target.value)} />
        </Field>
      </section>

      <section className="mb-design-sec">
        <Eyebrow>{['05', 'Pay link and delivery']}</Eyebrow>
        <div className="mb-design-switches">
          <Switch label="Print the pay link on the PDF and show a Pay button in the email"
            checked={draft.show_pay_button} onChange={(e) => set('show_pay_button', e.target.checked)} />
          <Switch label="Print a QR code customers can scan to pay"
            checked={draft.show_qr} onChange={(e) => set('show_qr', e.target.checked)} />
          <Switch label="Allow attaching files when emailing the invoice"
            checked={draft.attachments_allowed} onChange={(e) => set('attachments_allowed', e.target.checked)} />
        </div>
        <p className="t-cap" style={{ marginTop: 12 }}>
          The pay link and QR code only print when this company can take online payments and the invoice has a balance. Otherwise your payment instructions print instead.
        </p>
      </section>

      {footer}
    </form>
  );
}
