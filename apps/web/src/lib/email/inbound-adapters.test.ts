import { describe, it, expect } from 'vitest';
import { parseGeneric, parsePostmark, parseSendgrid } from './inbound-adapters';
import { normalizeAddress, parseAddressList, sha256Hex, sniffContentType } from './inbound-normalize';

const PDF = Buffer.from('%PDF-1.4 test invoice');
const NOW = new Date('2026-10-23T12:00:00Z');

/** Postmark's documented example payload, plus a PDF attachment. */
const POSTMARK_DOC = {
  FromName: 'Alan Turing',
  MessageStream: 'inbound',
  From: 'alanturing@computers.com',
  FromFull: { Email: 'AlanTuring@Computers.com', Name: 'Alan Turing', MailboxHash: '' },
  To: '"Margaret Hamilton" <yourhash+SampleHash@inbound.postmarkapp.com>',
  ToFull: [{ Email: 'yourhash+SampleHash@inbound.postmarkapp.com', Name: 'Margaret Hamilton', MailboxHash: 'SampleHash' }],
  Cc: '"Katherine Johnson" <katherine@nasa.com>, <dorothy@nasa.com>',
  CcFull: [
    { Email: 'katherine@nasa.com', Name: 'Katherine Johnson', MailboxHash: '' },
    { Email: 'dorothy@nasa.com', Name: '', MailboxHash: '' },
  ],
  BccFull: [{ Email: 'ap-heritage@inbound.meritbooks.app', Name: '', MailboxHash: '' }],
  OriginalRecipient: 'yourhash+SampleHash@inbound.postmarkapp.com',
  Subject: 'Saying Hello!',
  MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
  Date: 'Thu, 5 Nov 2026 16:33:54 -0500',
  TextBody: 'This is a test text body.',
  HtmlBody: '<html><body><p>This is a test html body.</p></body></html>',
  Headers: [
    { Name: 'X-Spam-Status', Value: 'No' },
    { Name: 'X-Spam-Score', Value: '-0.1' },
    { Name: 'Message-ID', Value: '<CAF=abc@mail.gmail.com>' },
  ],
  Attachments: [
    { Name: 'invoice.pdf', Content: PDF.toString('base64'), ContentType: 'application/pdf', ContentLength: PDF.length },
    { Name: 'logo.png', Content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), ContentType: 'image/png', ContentLength: 4, ContentID: 'logo@01' },
  ],
};

describe('postmark adapter', () => {
  it('normalizes the documented payload', () => {
    const r = parsePostmark(Buffer.from(JSON.stringify(POSTMARK_DOC)), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.email;
    expect(e.provider).toBe('postmark');
    expect(e.providerMessageId).toBe('883953f4-6105-42a2-a16a-77a8eac79483');
    expect(e.messageIdHeader).toBe('CAF=abc@mail.gmail.com');
    expect(e.from).toEqual({ address: 'alanturing@computers.com', name: 'Alan Turing' });
    expect(e.recipients).toEqual([
      'yourhash+samplehash@inbound.postmarkapp.com',
      'ap-heritage@inbound.meritbooks.app',
      'katherine@nasa.com',
      'dorothy@nasa.com',
    ]);
    expect(e.receivedAt).toBe('2026-11-05T21:33:54.000Z');
    expect(e.spam).toEqual({ score: -0.1, flagged: false });
    expect(e.attachments).toHaveLength(2);
    expect(e.attachments[0]).toMatchObject({ fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: sha256Hex(PDF), inline: false });
    expect(e.attachments[1]).toMatchObject({ contentId: 'logo@01', inline: true });
  });
  it('rejects bad JSON and a message without a sender', () => {
    expect(parsePostmark(Buffer.from('{nope')).ok).toBe(false);
    expect(parsePostmark(Buffer.from(JSON.stringify({ ...POSTMARK_DOC, From: '', FromFull: {} }))).ok).toBe(false);
  });
});

describe('sendgrid adapter (multipart Inbound Parse)', () => {
  async function multipart(fields: Record<string, string>, files: Array<{ name: string; file: File }>): Promise<{ raw: Uint8Array; ct: string }> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append(f.name, f.file);
    const req = new Request('http://x.test', { method: 'POST', body: fd });
    return { raw: new Uint8Array(await req.arrayBuffer()), ct: req.headers.get('content-type') ?? '' };
  }

  it('reads fields, envelope, attachment-info and file parts', async () => {
    const { raw, ct } = await multipart(
      {
        from: 'Cedar Electric <AR@CedarElectric.test>',
        to: 'ap-heritage@inbound.meritbooks.app',
        cc: '',
        subject: 'Invoice 2001',
        text: 'Attached.',
        html: '<p>Attached.</p>',
        headers: 'Message-ID: <sg-1@cedar.test>\r\nDate: Fri, 23 Oct 2026 09:00:00 -0500\r\nX-Spam-Status: No',
        envelope: JSON.stringify({ to: ['ap-heritage@inbound.meritbooks.app'], from: 'bounce@cedar.test' }),
        attachments: '1',
        'attachment-info': JSON.stringify({ attachment1: { filename: 'inv-2001.pdf', name: 'inv-2001.pdf', type: 'application/pdf' } }),
        spam_score: '0.3',
      },
      [{ name: 'attachment1', file: new File([PDF], 'inv-2001.pdf', { type: 'application/pdf' }) }],
    );
    const r = await parseSendgrid(raw, ct, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email.provider).toBe('sendgrid');
    // no SendGrid delivery id: Message-ID + a content hash (a reused Message-ID with
    // different content is NOT a duplicate)
    expect(r.email.providerMessageId).toMatch(/^mid:[0-9a-f]{64}$/);
    expect(r.email.messageIdHeader).toBe('sg-1@cedar.test');
    expect(r.email.from.address).toBe('ar@cedarelectric.test');
    expect(r.email.from.name).toBe('Cedar Electric');
    expect(r.email.recipients).toEqual(['ap-heritage@inbound.meritbooks.app']);
    expect(r.email.attachments[0]).toMatchObject({ fileName: 'inv-2001.pdf', contentType: 'application/pdf', sha256: sha256Hex(PDF) });
    expect(r.email.spam).toEqual({ score: 0.3, flagged: false });
    expect(r.email.receivedAt).toBe('2026-10-23T14:00:00.000Z');
  });
  it('refuses "Send Raw" mode and non-multipart bodies', async () => {
    const { raw, ct } = await multipart({ email: 'From: a@b\r\n\r\nraw' }, []);
    const r = await parseSendgrid(raw, ct);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Send Raw/);
    expect((await parseSendgrid(Buffer.from('{}'), 'application/json')).ok).toBe(false);
  });
});

describe('sender authentication (M6)', () => {
  const pm = (headers: Array<{ Name: string; Value: string }>, from = 'billing@prairie.test') =>
    parsePostmark(Buffer.from(JSON.stringify({ ...POSTMARK_DOC, From: from, FromFull: { Email: from, Name: 'X' }, Headers: headers })), NOW);

  it('postmark: an aligned DKIM pass (DKIM_VALID_AU) or aligned SPF pass verifies', () => {
    const dkim = pm([{ Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_HELO_NONE' }]);
    expect(dkim.ok && dkim.email.auth?.verified).toBe(true);
    const spf = pm([{ Name: 'Received-SPF', Value: 'Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; envelope-from=bounce@mail.prairie.test; receiver=x' }]);
    expect(spf.ok && spf.email.auth).toMatchObject({ verified: true, spf: 'pass', spfDomain: 'mail.prairie.test' });
  });
  it('postmark: no evidence, SPF for ANOTHER domain, a non-author DKIM, or a DMARC fail → not verified', () => {
    expect((pm([{ Name: 'X-Spam-Status', Value: 'No' }]) as { ok: true; email: { auth: { verified: boolean } } }).email.auth.verified).toBe(false);
    const other = pm([{ Name: 'Received-SPF', Value: 'Pass identity=mailfrom; envelope-from=x@attacker.test' }]);
    expect(other.ok && other.email.auth?.verified).toBe(false);
    const notAuthor = pm([{ Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,SPF_PASS' }]);
    expect(notAuthor.ok && notAuthor.email.auth?.verified).toBe(false);
    const dmarcFail = pm([{ Name: 'X-Spam-Tests', Value: 'DKIM_VALID_AU,DMARC_REJECT' }]);
    expect(dmarcFail.ok && dmarcFail.email.auth?.verified).toBe(false);
  });
  it('a forged Authentication-Results from a foreign host is ignored; the provider’s own is trusted', () => {
    const forged = pm([{ Name: 'Authentication-Results', Value: 'mx.attacker.test; dmarc=pass header.from=prairie.test; dkim=pass header.d=prairie.test' }]);
    expect(forged.ok && forged.email.auth?.verified).toBe(false);
    const real = pm([
      { Name: 'Authentication-Results', Value: 'pm-inbound-1.postmarkapp.com; spf=pass smtp.mailfrom=b@prairie.test; dkim=pass header.d=prairie.test; dmarc=pass header.from=prairie.test' },
    ]);
    expect(real.ok && real.email.auth).toMatchObject({ verified: true, dmarc: 'pass', source: 'authentication_results' });
  });

  async function sgMultipart(fields: Record<string, string>): Promise<{ raw: Uint8Array; ct: string }> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const req = new Request('http://x.test', { method: 'POST', body: fd });
    return { raw: new Uint8Array(await req.arrayBuffer()), ct: req.headers.get('content-type') ?? '' };
  }
  const sgBase = { from: 'AR <ar@cedar.test>', to: 'ap-h@inbound.meritbooks.app', subject: 'Inv', text: 'x', headers: 'Message-ID: <a@cedar.test>' };

  it('sendgrid: the SPF / dkim fields verify only when aligned with the From domain', async () => {
    const ok = await sgMultipart({ ...sgBase, dkim: '{@cedar.test : pass}', SPF: 'pass', envelope: JSON.stringify({ from: 'bounce@cedar.test', to: ['ap-h@inbound.meritbooks.app'] }) });
    const a = await parseSendgrid(ok.raw, ok.ct, NOW);
    expect(a.ok && a.email.auth).toMatchObject({ verified: true, dkim: 'pass', dkimPassDomains: ['cedar.test'], source: 'provider_fields' });
    const spfOnly = await sgMultipart({ ...sgBase, dkim: 'none', SPF: 'pass', envelope: JSON.stringify({ from: 'bounce@cedar.test', to: ['ap-h@inbound.meritbooks.app'] }) });
    const b = await parseSendgrid(spfOnly.raw, spfOnly.ct, NOW);
    expect(b.ok && b.email.auth?.verified).toBe(true);
    const foreign = await sgMultipart({ ...sgBase, dkim: '{@sendgrid-customer.test : pass}', SPF: 'pass', envelope: JSON.stringify({ from: 'x@attacker.test', to: ['ap-h@inbound.meritbooks.app'] }) });
    const c = await parseSendgrid(foreign.raw, foreign.ct, NOW);
    expect(c.ok && c.email.auth?.verified).toBe(false);
    // the ORIGINAL message's Received-SPF header is sender-controlled — never trusted on SendGrid
    const hdr = await sgMultipart({ ...sgBase, headers: 'Message-ID: <a@cedar.test>\r\nReceived-SPF: Pass envelope-from=a@cedar.test\r\nX-Spam-Tests: DKIM_VALID_AU' });
    const d = await parseSendgrid(hdr.raw, hdr.ct, NOW);
    expect(d.ok && d.email.auth?.verified).toBe(false);
  });

  it('caps a huge HTML body', () => {
    const r = parsePostmark(Buffer.from(JSON.stringify({ ...POSTMARK_DOC, HtmlBody: `<p>${'x'.repeat(600 * 1024)}</p>` })), NOW);
    expect(r.ok && r.email.htmlBody?.length).toBe(512 * 1024);
  });
});

describe('generic adapter', () => {
  it('accepts the pre-2D contract and synthesizes a stable id when none is given', () => {
    const payload = {
      from: 'vendor@acme.test',
      to: 'ap-acme@inbound.meritbooks.app',
      subject: 'Invoice 1042',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/octet-stream', content: `data:application/pdf;base64,${PDF.toString('base64')}` }],
    };
    const a = parseGeneric(Buffer.from(JSON.stringify(payload)), NOW);
    const b = parseGeneric(Buffer.from(JSON.stringify(payload)), NOW);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.email.providerMessageId).toMatch(/^synthetic:[0-9a-f]{64}$/);
    expect(a.email.providerMessageId).toBe(b.email.providerMessageId);
    // octet-stream PDF is sniffed to application/pdf (Outlook does this)
    expect(a.email.attachments[0].contentType).toBe('application/pdf');
  });
  it('reads envelope recipients and object addresses', () => {
    const r = parseGeneric(Buffer.from(JSON.stringify({ from: { address: 'x@y.test' }, sender: 'x@y.test', envelope: { to: ['ap-a@d.test'] }, messageId: 'm1' })));
    expect(r.ok && r.email.recipients).toEqual(['ap-a@d.test']);
  });
  it('trusts the (HMAC-authenticated) relay’s verdict, not the forwarded headers', () => {
    const r = parseGeneric(Buffer.from(JSON.stringify({ from: 'ar@acme.test', to: 'ap-a@d.test', messageId: 'm2', authentication: { dkim: 'pass', dkimDomains: ['acme.test'] } })));
    expect(r.ok && r.email.auth?.verified).toBe(true);
    const h = parseGeneric(Buffer.from(JSON.stringify({ from: 'ar@acme.test', to: 'ap-a@d.test', messageId: 'm3', headers: { 'Received-SPF': 'pass envelope-from=ar@acme.test' } })));
    expect(h.ok && h.email.auth?.verified).toBe(false);
  });
});

describe('normalize helpers', () => {
  it('addresses', () => {
    expect(normalizeAddress(' "Smith, Jo" <Jo@Acme.TEST> ')).toBe('jo@acme.test');
    expect(normalizeAddress('mailto:a@b.co')).toBe('a@b.co');
    expect(normalizeAddress('not an email')).toBe('');
    expect(parseAddressList('"Smith, Jo" <jo@a.test>, b@a.test; <c@a.test>').map((a) => a.address)).toEqual(['jo@a.test', 'b@a.test', 'c@a.test']);
  });
  it('sniffs vague content types', () => {
    expect(sniffContentType('application/octet-stream', 'x.bin', PDF)).toBe('application/pdf');
    expect(sniffContentType('application/octet-stream', 'scan.JPG', Buffer.from([1, 2]))).toBe('image/jpeg');
    expect(sniffContentType('image/png; name=a.png', 'a.png', Buffer.from([1]))).toBe('image/png');
  });
});
