import { describe, it, expect } from 'vitest';
import { renderEmailBodyPdf } from './inbound-body-pdf';
import type { InboundEmail } from './inbound-types';

const base: InboundEmail = {
  provider: 'postmark', providerMessageId: 'm', messageIdHeader: null,
  from: { address: 'ar@cedar.test', name: 'Cedar Electric' }, to: [], cc: [], recipients: ['ap-x@inbound.test'],
  subject: 'Invoice #77', textBody: null,
  htmlBody: '<table><tr><td>Invoice</td><td>#77</td></tr><tr><td>Amount due</td><td>$412.50</td></tr></table>',
  receivedAt: '2026-10-23T12:00:00.000Z', headers: {}, attachments: [], spam: null,
};

describe('renderEmailBodyPdf', () => {
  it('renders an HTML-only invoice email to a real PDF', async () => {
    const pdf = await renderEmailBodyPdf(base);
    expect(pdf).not.toBeNull();
    expect(pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf!.length).toBeGreaterThan(500);
  }, 30_000);
  it('returns null when there is no body at all', async () => {
    expect(await renderEmailBodyPdf({ ...base, htmlBody: null, textBody: '   ' })).toBeNull();
  });
});
