/**
 * A representative sample invoice document. Used by the design-screen preview when
 * the company has no invoice to preview with yet, and by the unit tests. Never
 * written anywhere; never shown as real data (the preview labels it "Sample").
 */

import type { InvoiceDoc } from './invoice-doc';
import { BUILT_IN_TEMPLATE, type InvoiceTemplate } from './templates/types';
import { payUrlFor } from './pay-link';

export const SAMPLE_TOKEN = '00000000-0000-4000-8000-000000000042';

export function sampleInvoiceDoc(
  over: Partial<InvoiceDoc> = {},
  template: Partial<InvoiceTemplate> = {},
  companyName = 'Your Company',
): InvoiceDoc {
  return {
    id: 'sample',
    invoice_number: 'INV-20261023-0042',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    status: 'SENT',
    po_number: 'PO-7781',
    terms: 'NET_30',
    terms_label: 'Net 30',
    customer_message: 'Thank you for your business.',
    public_token: SAMPLE_TOKEN,
    payment_methods_allowed: null,
    card_surcharge_enabled: null,
    subtotal_cents: 1_250_000,
    discount_cents: 0,
    tax_cents: 70_000,
    retainage_cents: 0,
    total_cents: 1_320_000,
    amount_paid_cents: 0,
    balance_cents: 1_320_000,
    bill_to: { line1: '118 Industrial Way', city_state_zip: 'Johnston, IA 50131' },
    ship_to: null,
    lines: [
      {
        line_number: 1, description: 'Kitchen cabinetry — fabrication and install', quantity: 1,
        unit_price_cents: 850_000, amount_cents: 850_000, item_label: 'Cabinet install', service_date: '2026-09-22',
        cost_code_label: '06-400 Cabinetry', tax_cents: 47_600, custom_fields: { room: 'Kitchen' },
      },
      {
        line_number: 2, description: 'Countertop templating', quantity: 4, unit_price_cents: 100_000, amount_cents: 400_000,
        item_label: 'Templating', service_date: '2026-09-25', cost_code_label: '06-610 Countertops', tax_cents: 22_400,
        custom_fields: { room: 'Kitchen' },
      },
    ],
    customer: { id: null, name: 'Acme Test Co', email: 'ap@acme.test' },
    entity: { id: null, name: companyName, short_code: null },
    job_label: 'J-1042 · Smith remodel',
    template: { ...BUILT_IN_TEMPLATE, ...template },
    template_source: 'BUILT_IN',
    cc_emails: [],
    customer_cc_emails: [],
    pay: { url: payUrlFor(SAMPLE_TOKEN), payable: true, mode: 'test', methods: ['ACH', 'CARD'], reason: null, code: 'OK' },
    ...over,
  };
}
