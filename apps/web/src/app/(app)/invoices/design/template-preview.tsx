'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Eyebrow, Select } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import type { TemplateBody } from '@/lib/invoices/templates/schema';

interface InvoiceOption { id: string; invoiceNumber: string; customer: { name: string } | null }

/**
 * Live PDF preview of the template being edited. Re-renders (debounced) as the draft
 * changes; nothing is saved. "Preview with" switches between a labelled sample invoice
 * and one of this company's real invoices.
 */
export function TemplatePreview({ draft, valid, locationId }: { draft: TemplateBody; valid: boolean; locationId: string }) {
  const [invoiceId, setInvoiceId] = useState<string>('');
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastUrl = useRef<string | null>(null);

  const { data: recent } = useQuery<{ data: InvoiceOption[] }>('/api/invoices', { per_page: '10', location_id: locationId });
  const options = recent?.data ?? [];

  const key = JSON.stringify({ draft, invoiceId, locationId, nonce });
  useEffect(() => {
    if (!valid) return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setState('loading');
      setErr(null);
      try {
        const res = await fetch('/api/invoice-templates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template: draft, location_id: locationId, invoice_id: invoiceId || null }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `The preview could not be drawn (${res.status}).`);
        }
        const blob = await res.blob();
        const next = URL.createObjectURL(blob);
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = next;
        setUrl(next);
        setState('ready');
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setErr(e instanceof Error ? e.message : 'The preview could not be drawn.');
        setState('error');
      }
    }, 500);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, valid]);

  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); }, []);

  return (
    <section aria-label="Preview">
      <div className="mb-design-preview-bar">
        <Eyebrow>{['Preview']}</Eyebrow>
        <span className="sp" style={{ flex: 1 }} />
        <label className="t-cap" htmlFor="preview-with">Preview with</label>
        <Select id="preview-with" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
          <option value="">Sample invoice</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.invoiceNumber}{o.customer ? ` · ${o.customer.name}` : ''}</option>
          ))}
        </Select>
        {url && <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a>}
      </div>
      {!valid ? (
        <div className="mb-design-frame-state">Fix the highlighted fields and the preview updates.</div>
      ) : state === 'error' ? (
        <div className="mb-design-frame-state">
          <div>
            <p style={{ marginBottom: 12 }}>{err}</p>
            <Button onClick={() => setNonce((n) => n + 1)}>Try again</Button>
          </div>
        </div>
      ) : url ? (
        <iframe className="mb-design-frame" src={`${url}#toolbar=0&view=FitH`} title="Invoice preview" aria-busy={state === 'loading'} />
      ) : (
        <div className="mb-design-frame-state wg-loading" aria-busy="true">Drawing the preview…</div>
      )}
      <p className="t-cap" style={{ marginTop: 8 }}>
        {invoiceId ? 'A real invoice in your draft design. Nothing is saved or sent.' : 'Sample data, not a real invoice. Amounts and customer are examples.'}
      </p>
    </section>
  );
}
