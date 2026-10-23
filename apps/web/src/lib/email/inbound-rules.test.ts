import { describe, it, expect } from 'vitest';
import { detectForwardingConfirmation, evaluateSender, looksLikeInvoiceBody, normalizeDomain, type AliasSenderPolicy, type SenderFacts } from './inbound-rules';
import { buildEml, htmlToText } from './inbound-eml';
import { classifyAttachments } from '@/lib/ap/inbound-email-ap';
import type { InboundEmail } from './inbound-types';
import { makeAttachment } from './inbound-normalize';
import { senderAuthentication } from './inbound-sender-auth';

function email(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: 'postmark', providerMessageId: 'm1', messageIdHeader: null,
    from: { address: 'billing@prairie.test', name: 'Prairie' }, to: [{ address: 'ap-x@inbound.test', name: null }], cc: [],
    recipients: ['ap-x@inbound.test'], subject: 'Invoice', textBody: null, htmlBody: null,
    receivedAt: '2026-10-23T12:00:00.000Z', headers: {}, attachments: [], spam: null, ...over,
  };
}

const facts: SenderFacts = {
  memberEmails: new Set(['staff@merit.test']),
  vendorEmails: new Set(['billing@prairie.test', 'someone@gmail.com', 'ar@cedar.test']),
};
const V = { verified: true } as const;
const rule = (sender_rule: AliasSenderPolicy['sender_rule'], allowed_domains: string[] = [], allowed_senders: string[] = []): AliasSenderPolicy => ({ sender_rule, allowed_domains, allowed_senders });

describe('sender rules', () => {
  it('any: everyone', () => {
    expect(evaluateSender('who@ever.test', rule('any'), facts).allowed).toBe(true);
  });
  it('known_vendors: vendor email, vendor domain (and subdomain), team, allowed sender — not strangers or freemail lookalikes', () => {
    const r = rule('known_vendors', [], ['friend@outside.test']);
    expect(evaluateSender('Billing <BILLING@prairie.test>', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('jane@cedar.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('ap@billing.cedar.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('staff@merit.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('friend@outside.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('stranger@phish.test', r, facts, V).allowed).toBe(false);
    // a vendor on gmail.com must not make every gmail user a vendor
    expect(evaluateSender('someone@gmail.com', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('anyone-else@gmail.com', r, facts, V).allowed).toBe(false);
    // cedar.test.evil.test is not under cedar.test
    expect(evaluateSender('x@cedar.test.evil.test', r, facts, V).allowed).toBe(false);
  });
  it('listed_domains: listed domains/subdomains and senders + team only', () => {
    const r = rule('listed_domains', ['@AcmeSupply.test'], []);
    expect(evaluateSender('a@acmesupply.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('a@ar.acmesupply.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('staff@merit.test', r, facts, V).allowed).toBe(true);
    expect(evaluateSender('billing@prairie.test', r, facts, V).allowed).toBe(false);
  });
  it('M6: an UNVERIFIED sender is unknown — only an "Anyone" address accepts it', () => {
    const kv = rule('known_vendors', [], ['friend@outside.test']);
    for (const who of ['billing@prairie.test', 'staff@merit.test', 'friend@outside.test', 'jane@cedar.test']) {
      const d = evaluateSender(who, kv, facts, { verified: false });
      expect(d.allowed).toBe(false);
      expect(!d.allowed && d.reason).toMatch(/could not be verified/);
    }
    expect(evaluateSender('billing@prairie.test', rule('listed_domains', ['prairie.test']), facts).allowed).toBe(false); // default = unverified
    expect(evaluateSender('who@ever.test', rule('any'), facts, { verified: false })).toEqual({ allowed: true, basis: 'anyone (sender not verified)' });
  });
  it('cardholders are known senders on RECEIPTS addresses only', () => {
    const f: SenderFacts = { ...facts, cardholderEmails: new Set(['andre@example.com']) };
    expect(evaluateSender('andre@example.com', rule('known_vendors'), f, { verified: true, purpose: 'receipts' }).allowed).toBe(true);
    expect(evaluateSender('andre@example.com', rule('known_vendors'), f, { verified: true, purpose: 'ap' }).allowed).toBe(false);
  });
  it('normalizes typed domains', () => {
    expect(normalizeDomain(' @Acme.com ')).toBe('acme.com');
    expect(normalizeDomain('https://acme.com/path')).toBe('acme.com');
    expect(normalizeDomain('not a domain')).toBe('');
  });
});

describe('Gmail forwarding confirmation', () => {
  const gmail = email({
    from: { address: 'forwarding-noreply@google.com', name: 'Gmail Team' },
    subject: '(#612345789) Gmail Forwarding Confirmation - Receive Mail from bills@heritage.test',
    textBody: 'bills@heritage.test has requested to automatically forward mail to your email address ap-heritage@inbound.test.\nConfirmation code: 612345789\n\nTo allow bills@heritage.test to automatically forward mail to your address, please click the link below to confirm the request:\n\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ8w%5D-abcdef\n\nIf you click the link and it appears to be broken, please copy and paste it into a new browser window.',
    headers: { 'x-spam-tests': 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS' },
    auth: senderAuthentication({ provider: 'postmark', fromAddress: 'forwarding-noreply@google.com', headers: { 'x-spam-tests': 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS' } }),
  });

  it('extracts the requester, code and the google.com link', () => {
    expect(detectForwardingConfirmation(gmail)).toEqual({
      provider: 'gmail', requestedBy: 'bills@heritage.test', code: '612345789',
      url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8w%5D-abcdef', authenticated: true,
    });
  });
  it('never returns a non-google link, and ignores look-alikes from other senders', () => {
    const spoofLink = detectForwardingConfirmation({ ...gmail, textBody: 'Confirmation code: 1234\nhttps://evil.test/mail-settings.google.com/x' });
    expect(spoofLink?.url).toBeNull();
    expect(detectForwardingConfirmation({ ...gmail, from: { address: 'forwarding-noreply@g00gle.test', name: null } })).toBeNull();
    expect(detectForwardingConfirmation(email({ subject: 'Invoice 7' }))).toBeNull();
  });
  it('authenticated only with a verified google.com DKIM pass (an SPF pass or no evidence is not enough)', () => {
    expect(detectForwardingConfirmation({ ...gmail, auth: undefined })?.authenticated).toBe(false);
    const spfOnly = senderAuthentication({ provider: 'postmark', fromAddress: 'forwarding-noreply@google.com', headers: { 'received-spf': 'Pass envelope-from=x@google.com' } });
    expect(spfOnly.verified).toBe(true);
    expect(detectForwardingConfirmation({ ...gmail, auth: spfOnly })?.authenticated).toBe(false);
  });
});

describe('HTML-only invoices and the original email', () => {
  it('looksLikeInvoiceBody needs invoice words AND an amount', () => {
    expect(looksLikeInvoiceBody(email({ htmlBody: '<td>Amount due</td><td>$1,250.00</td>' }))).toBe(true);
    expect(looksLikeInvoiceBody(email({ subject: 'Hi', textBody: 'Lunch at 12?' }))).toBe(false);
    expect(looksLikeInvoiceBody(email({ subject: 'Invoice', textBody: 'see portal' }))).toBe(false);
  });
  it('htmlToText keeps rows and cells, drops scripts/styles, decodes entities', () => {
    const t = htmlToText('<style>p{}</style><script>x()</script><h1>Invoice&nbsp;#77</h1><table><tr><td>Total</td><td>$412.50</td></tr></table><p>A &amp; B</p>');
    expect(t).toBe('Invoice #77\nTotal\t$412.50\n\nA & B'); // one blank line between blocks, never more
  });
  it('htmlToText survives out-of-range / surrogate / control char codes', () => {
    expect(() => htmlToText('a&#x110000;b&#55296;c&#99999999999;d&#0;e')).not.toThrow();
    expect(htmlToText('Total&#36;5')).toBe('Total$5');
  });
  it('buildEml produces a readable RFC 5322 message, header-injection safe', () => {
    const eml = buildEml(email({ subject: 'Café invoice\r\nBcc: evil@x.test', textBody: 'Hello', htmlBody: '<p>Hello</p>', messageIdHeader: 'abc@x' })).toString('utf8');
    expect(eml).toMatch(/^From: "Prairie" <billing@prairie\.test>\r\n/);
    expect(eml).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(eml).not.toMatch(/\r\nBcc:/);
    expect(eml).toMatch(/Message-ID: <abc@x>/);
    expect(eml).toMatch(/Content-Type: multipart\/alternative/);
    expect(eml).toMatch(/Content-Type: text\/html/);
  });
});

describe('attachment classification', () => {
  it('drafts PDFs/images, ignores small inline logos, skips other types and huge files', () => {
    const pdf = makeAttachment({ fileName: 'inv.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') });
    const logo = makeAttachment({ fileName: 'logo.png', contentType: 'image/png', bytes: Buffer.alloc(1000), contentId: 'cid1' });
    const bigInline = makeAttachment({ fileName: 'receipt.jpg', contentType: 'image/jpeg', bytes: Buffer.alloc(40 * 1024), contentId: 'cid2' });
    const xlsx = makeAttachment({ fileName: 'a.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from('PK') });
    const { candidates, skipped } = classifyAttachments(email({ attachments: [pdf, logo, bigInline, xlsx] }));
    expect(candidates.map((c) => c.att.fileName)).toEqual(['inv.pdf', 'receipt.jpg']);
    expect(skipped.map((s) => s.result)).toEqual(['inline_ignored', 'skipped_type']);
  });
});
