/**
 * Invoice email content assertions.
 *
 * The email is the only artefact a customer sees before deciding to pay, and it
 * is not rendered anywhere we can eyeball in CI. These assertions cover the
 * things that break silently: an unescaped customer name, a missing pay link, a
 * total that disagrees with the invoice, an unreadable accent.
 */

import { describe, it, expect } from 'vitest';
import { buildInvoiceEmail, readableOn } from './invoice-email';
import type { InvoiceDoc } from './invoice-doc';
import { sampleInvoiceDoc } from './sample-doc';

const PAY_URL = 'https://meritbooks-web.vercel.app/pay/198e916c-37c4-4a99-a3bc-29cae886f302';

const doc = (over: Partial<InvoiceDoc> = {}): InvoiceDoc =>
  sampleInvoiceDoc({
    invoice_number: 'INV-2026-0042',
    invoice_date: '2026-07-01',
    due_date: '2026-07-31',
    customer_message: null,
    public_token: '198e916c-37c4-4a99-a3bc-29cae886f302',
    subtotal_cents: 250_000,
    tax_cents: 0,
    total_cents: 250_000,
    balance_cents: 250_000,
    lines: [
      { line_number: 1, description: 'Progress draw #2', quantity: 1, unit_price_cents: 250_000, amount_cents: 250_000 },
    ],
    customer: { id: null, name: 'Fabrikam Inc.', email: 'ap@fabrikam.test' },
    entity: { id: null, name: 'Northwind Construction', short_code: 'NWC' },
    pay: { url: PAY_URL, payable: true, mode: 'live', methods: ['ACH', 'CARD'], reason: null, code: 'OK', cardPassThrough: true, cardFeePct: 3 },
    ...over,
  });

describe('invoice email — subject line', () => {
  it('carries issuer, number, amount and due date', () => {
    const { subject } = buildInvoiceEmail(doc(), PAY_URL);
    expect(subject).toContain('INV-2026-0042');
    expect(subject).toContain('Northwind Construction');
    expect(subject).toContain('$2,500.00');
    expect(subject).toContain('July 31, 2026');
  });
});

describe('invoice email — the payment path', () => {
  it('links to the hosted pay page', () => {
    const { html, text } = buildInvoiceEmail(doc(), PAY_URL);
    expect(html).toContain(PAY_URL);
    expect(text).toContain(PAY_URL);
  });

  it('renders the pay button as a real anchor, not a script-driven control', () => {
    // Email clients do not run JavaScript. The CTA must be an <a href>.
    const { html } = buildInvoiceEmail(doc(), PAY_URL);
    expect(html).toMatch(/<a href="https:\/\/[^"]+"[^>]*>Pay this invoice<\/a>/);
  });

  it('always includes a plain-text alternative', () => {
    const { text } = buildInvoiceEmail(doc(), PAY_URL);
    expect(text.length).toBeGreaterThan(50);
  });
});

describe('invoice email — figures agree with the invoice', () => {
  it('shows the balance due, not the total, on a partly paid invoice', () => {
    const { subject, html } = buildInvoiceEmail(
      doc({ total_cents: 250_000, amount_paid_cents: 100_000, balance_cents: 150_000 }),
      PAY_URL,
    );
    expect(subject).toContain('$1,500.00');
    expect(html).toContain('$1,500.00');
  });

  it('falls back to the total when there is no balance recorded', () => {
    const { subject } = buildInvoiceEmail(doc({ balance_cents: 0 }), PAY_URL);
    expect(subject).toContain('$2,500.00');
  });

  it('renders every line item', () => {
    const { html } = buildInvoiceEmail(
      doc({
        lines: [
          { line_number: 1, description: 'Framing', quantity: 1, unit_price_cents: 100_000, amount_cents: 100_000 },
          { line_number: 2, description: 'Drywall', quantity: 1, unit_price_cents: 150_000, amount_cents: 150_000 },
        ],
      }),
      PAY_URL,
    );
    expect(html).toContain('Framing');
    expect(html).toContain('Drywall');
    expect(html).toContain('$1,000.00');
    expect(html).toContain('$1,500.00');
  });
});

describe('invoice email — injection safety', () => {
  it('escapes HTML in customer-controlled text', () => {
    const { html } = buildInvoiceEmail(
      doc({ customer_message: '<script>alert(1)</script>', entity: { id: null, name: 'A & B <Co>', short_code: null } }),
      PAY_URL,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B &lt;Co&gt;');
  });

  it('escapes line descriptions', () => {
    const { html } = buildInvoiceEmail(
      doc({ lines: [{ line_number: 1, description: '"><img src=x>', quantity: 1, unit_price_cents: 1, amount_cents: 1 }] }),
      PAY_URL,
    );
    expect(html).not.toContain('<img src=x>');
  });
});

describe('invoice email — accent contrast (WCAG, lib/branding/color)', () => {
  it('uses white text on a dark accent', () => {
    expect(readableOn('#0f172a')).toBe('#ffffff');
    expect(readableOn('#2563eb')).toBe('#ffffff');
  });

  it('uses Midnight ink on a light accent — including mid-tones white fails on (emerald: 2.5:1)', () => {
    expect(readableOn('#ffffff')).toBe('#0a1628');
    expect(readableOn('#fde047')).toBe('#0a1628');
    expect(readableOn('#10b981')).toBe('#0a1628');
  });

  it('handles 3-digit hex', () => {
    expect(readableOn('#fff')).toBe('#0a1628');
    expect(readableOn('#000')).toBe('#ffffff');
  });
});

describe('invoice email — overdue framing', () => {
  it('says Overdue when past due', () => {
    const { html } = buildInvoiceEmail(doc({ due_date: '2020-01-01' }), PAY_URL);
    expect(html).toContain('Overdue');
  });

  it('says Amount due when not yet due', () => {
    const { html } = buildInvoiceEmail(doc({ due_date: '2099-01-01' }), PAY_URL);
    expect(html).toContain('Amount due');
    expect(html).not.toContain('>Overdue');
  });
});

describe('invoice email — Slice 1B (pay button only when payable, brand, no GL, no banned fonts)', () => {
  it('no Pay button when the invoice cannot be paid online — View invoice + payment instructions instead', () => {
    const d = doc({
      pay: { url: PAY_URL, payable: false, mode: null, methods: [], reason: 'not set up', code: 'NO_CONNECTION', cardPassThrough: true, cardFeePct: 3 },
    });
    d.template = { ...d.template, payment_instructions: 'Wire to First Bank, ABA 073000228.' };
    const { html, text, hasPayButton } = buildInvoiceEmail(d);
    expect(hasPayButton).toBe(false);
    expect(html).not.toContain('Pay this invoice');
    expect(html).toContain('View invoice');
    expect(html).toContain('How to pay');
    expect(text).toContain('View invoice:');
    expect(text).not.toContain('Pay online:');
  });

  it('the template can switch the Pay button off', () => {
    const d = doc();
    d.template = { ...d.template, show_pay_button: false };
    expect(buildInvoiceEmail(d).hasPayButton).toBe(false);
  });

  it('uses the brand colour, DM Sans, square corners — never the banned fonts or emerald', () => {
    const d = doc();
    d.template = { ...d.template, accent_color: '#8A2D3B' };
    const { html } = buildInvoiceEmail(d);
    expect(html).toContain('#8A2D3B');
    expect(html).toContain('DM Sans');
    expect(html).not.toMatch(/Plus Jakarta|JetBrains|#10b981|border-radius/i);
  });

  it('prints terms, lists extra attachments, and a per-send message replaces the default', () => {
    const d = doc({ customer_message: 'Default thanks' });
    d.template = { ...d.template, terms_text: 'Net 30. 1.5% late fee.' };
    const { html } = buildInvoiceEmail(d, null, { message: 'Draw 2 per the schedule.', attachmentNames: ['lien-waiver.pdf'] });
    expect(html).toContain('1.5% late fee');
    expect(html).toContain('lien-waiver.pdf');
    expect(html).toContain('Draw 2 per the schedule.');
    expect(html).not.toContain('Default thanks');
  });
});
