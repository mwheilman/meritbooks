'use client';

import { useEffect, useState } from 'react';
import { ButtonLink, InlineNotice } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

/**
 * Settings → Invoice Display. The invoice LOOK (templates, logo, colour, columns, terms,
 * payment instructions, pay link + QR) moved to Invoices → Design (Slice 1B). What stays
 * here: each company's payment-method / retainage defaults and invoice-type text.
 */
interface Company { locationId: string; name: string; shortCode: string | null }

export function InvoiceBranding() {
  const { data, isLoading, error } = useQuery<{ entities: Company[] }>('/api/settings/invoice-branding');
  const companies = data?.entities ?? [];
  const [activeId, setActiveId] = useState('');
  const [typeLabel, setTypeLabel] = useState('');
  useEffect(() => {
    if (!activeId && companies.length) setActiveId(companies[0].locationId);
  }, [companies, activeId]);
  const active = companies.find((c) => c.locationId === activeId) ?? null;

  return (
    <div className="mb-settings-invoice">
      <InlineNotice tone="info" title="Invoice design moved to Invoices → Design.">
        Templates, logo, brand colour, columns, terms, payment instructions and the pay link with QR code are all set
        there, with a live preview. You can give each customer its own template.{' '}
        <ButtonLink href="/invoices/design" variant="primary">Open invoice design</ButtonLink>
      </InlineNotice>

      {isLoading && <div className="wg-loading" aria-busy="true"><span className="bar-l" style={{ width: 240 }} /></div>}
      {error && (
        <InlineNotice tone="neg" title="Couldn't load your companies.">Refresh the page to try again.</InlineNotice>
      )}
      {!isLoading && !error && companies.length === 0 && (
        <p className="t-cap">Add a company first. Payment defaults are set per company.</p>
      )}

      {active && (
        <>
          {companies.length > 1 && (
            <label className="field" style={{ maxWidth: 360, marginTop: 24 }}>
              <span className="field-label">Company</span>
              <select className="select" value={activeId} onChange={(e) => setActiveId(e.target.value)}>
                {companies.map((c) => <option key={c.locationId} value={c.locationId}>{c.name}</option>)}
              </select>
            </label>
          )}
          <div className="mt-10 pt-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">Payment &amp; retainage defaults</h3>
              <p className="text-2xs text-slate-500 mb-3">Company defaults. Customers and jobs can override these; invoices override everything.</p>
              <EntityInvoiceSettings scope="LOCATION" id={active.locationId} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">Invoice-type text</h3>
              <p className="text-2xs text-slate-500 mb-3">Set default text for a kind of invoice (e.g. “Progress Bill”, “Deposit”). The label must match the invoice’s type.</p>
              <input value={typeLabel} onChange={(e) => setTypeLabel(e.target.value)} placeholder="Invoice type label, e.g. Progress Bill"
                aria-label="Invoice type label"
                className="w-full px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-white mb-3" />
              {typeLabel.trim() ? <InvoiceTextOverrides scope="INVOICE_TYPE" refId={typeLabel.trim()} /> : <p className="text-2xs text-slate-500">Enter a type label to edit its text.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
