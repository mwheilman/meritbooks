/**
 * The payables / receipts email inbox end to end (FPB-ap-intake §6) against a REAL
 * Postgres: Postmark JSON → adapter → alias routing → claim/dedupe → sender rules →
 * AP handler → PROPOSED draft bill on the right company, with the message log.
 * The AI read, the document bucket and the PDF render are injected fakes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { parsePostmark } from '@/lib/email/inbound-adapters';
import { readInboundConfig } from '@/lib/email/inbound-config';
import { processInboundEmail, type ProcessResult } from '@/lib/email/inbound-process';
import { makeApHandler } from '@/lib/ap/inbound-email-ap';
import type { DocIntelligenceProvider, ExtractedBill } from '@/lib/ap/doc-intelligence';
import type { InboundEmail, InboundPurposeHandler } from '@/lib/email/inbound-types';
import { listMessages } from '@/lib/email/inbound-log';

const ORG = '18310000-0000-0000-0000-00000000000a';
const ORG_B = '18310000-0000-0000-0000-00000000000b';
const VENDOR = '18310000-0000-0000-0000-0000000000a1';
const VENDOR_2 = '18310000-0000-0000-0000-0000000000a2';

const cfg = readInboundConfig({
  INBOUND_EMAIL_PROVIDER: 'postmark',
  INBOUND_EMAIL_DOMAIN: 'inbound.test',
  INBOUND_EMAIL_SECRET: 'x'.repeat(24),
  INBOUND_EMAIL_PROVIDER_ADDRESS: 'abc123hash@inbound.postmarkapp.com',
});

let db: PGlite;
let svc: SupabaseClient;
let heritage = '';
let clive = '';

// ── fakes ────────────────────────────────────────────────────────────────────
const stored: Array<{ fileName: string; mimeType: string }> = [];
let aiMode: 'ok' | 'down' = 'ok';
let aiVendorName = 'Prairie Drywall';
const receiptsCalls: InboundEmail[] = [];

function bill(over: Partial<ExtractedBill> = {}): ExtractedBill {
  return {
    vendorName: aiVendorName, vendorNameConfidence: 0.95, invoiceNumber: 'INV-1042', invoiceNumberConfidence: 0.9,
    invoiceDate: '2026-10-20', invoiceDateConfidence: 0.9, dueDate: '2026-11-19', dueDateConfidence: 0.9,
    subtotalCents: 125_000, taxCents: 0, totalCents: 125_000, totalConfidence: 0.93, currency: 'USD', lines: [],
    notes: '', providerName: 'fake', engineVersion: 'fake-1', extractionMs: 5, ...over,
  };
}
const provider: DocIntelligenceProvider = {
  name: 'fake',
  isConfigured: () => true,
  async extractBill() {
    return aiMode === 'down' ? { ok: false, error: 'AI gateway unavailable' } : { ok: true, bill: bill() };
  },
};
const ap = makeApHandler({
  provider,
  docDeps: null,
  storeDocument: async (a) => {
    stored.push({ fileName: a.fileName, mimeType: a.mimeType });
    return { documentId: randomUUID() };
  },
  renderBodyPdf: async () => Buffer.from('%PDF-1.4 rendered email body'),
});
const receipts: InboundPurposeHandler = async (email) => {
  receiptsCalls.push(email);
  return { outcome: 'receipt_attached', detail: 'Matched to a card charge.', linked: { receiptIds: [randomUUID()] } };
};
let emailDocs = 0;
const deps = () => ({
  admin: svc,
  cfg,
  handlers: { ap, receipts },
  storeEmail: async () => {
    emailDocs++;
    return randomUUID();
  },
});

// ── payloads ─────────────────────────────────────────────────────────────────
const PDF_A = Buffer.from('%PDF-1.4 invoice 1042 from prairie drywall').toString('base64');
const PDF_B = Buffer.from('%PDF-1.4 invoice 2001 from cedar electric').toString('base64');

interface PmOpts {
  to: string | string[];
  from?: string;
  fromName?: string;
  messageId?: string;
  subject?: string;
  attachments?: Array<{ Name: string; Content: string; ContentType: string; ContentID?: string }>;
  text?: string;
  html?: string;
  headers?: Array<{ Name: string; Value: string }>;
  /** 'verified' (default): Postmark's Received-SPF passes for the From domain. 'none': no evidence (spoofable). */
  auth?: 'verified' | 'none';
}
function postmark(o: PmOpts): InboundEmail {
  const to = Array.isArray(o.to) ? o.to : [o.to];
  const fromAddr = (o.from ?? 'billing@prairie.test').replace(/^.*<|>.*$/g, '');
  const authHeaders = o.auth === 'none' ? [] : [{ Name: 'Received-SPF', Value: `Pass (sender SPF authorized) identity=mailfrom; client-ip=192.0.2.1; envelope-from=${fromAddr}` }];
  const body = {
    From: o.from ?? 'billing@prairie.test',
    FromName: o.fromName ?? 'Prairie Drywall',
    FromFull: { Email: o.from ?? 'billing@prairie.test', Name: o.fromName ?? 'Prairie Drywall', MailboxHash: '' },
    To: to.join(', '),
    ToFull: to.map((e) => ({ Email: e, Name: '', MailboxHash: '' })),
    OriginalRecipient: to[0],
    Subject: o.subject ?? 'Invoice 1042',
    MessageID: o.messageId ?? randomUUID(),
    Date: 'Thu, 22 Oct 2026 16:33:54 -0500',
    TextBody: o.text ?? 'Please find invoice attached.',
    HtmlBody: o.html ?? '',
    Headers: [...authHeaders, ...(o.headers ?? [{ Name: 'X-Spam-Status', Value: 'No' }, { Name: 'X-Spam-Score', Value: '-0.1' }])],
    Attachments: o.attachments ?? [{ Name: 'invoice-1042.pdf', Content: PDF_A, ContentType: 'application/pdf' }],
  };
  const r = parsePostmark(Buffer.from(JSON.stringify(body)));
  if (!r.ok) throw new Error(r.error);
  return r.email;
}

async function drafts(location?: string): Promise<Array<{ id: string; status: string; location_id: string; proposed_output: Record<string, unknown> }>> {
  const r = await db.query<{ id: string; status: string; location_id: string; proposed_output: Record<string, unknown> }>(
    `select id, status, location_id, proposed_output from public.ai_decisions where feature = 'AP_DOC_INTAKE' ${location ? 'and location_id = $1' : ''} order by created_at`,
    location ? [location] : [],
  );
  return r.rows;
}
async function logRows(): Promise<Array<{ outcome: string; to_address: string; duplicate_deliveries: number; detail: string | null; intake_draft_ids: string[] }>> {
  return (await db.query<{ outcome: string; to_address: string; duplicate_deliveries: number; detail: string | null; intake_draft_ids: string[] }>(
    `select outcome, to_address, duplicate_deliveries, detail, intake_draft_ids from core.inbound_messages order by created_at`,
  )).rows;
}
async function setRule(location: string, rule: string, domains: string[] = [], senders: string[] = []) {
  await db.query(
    `update core.inbound_aliases set sender_rule = $2, allowed_domains = $3, allowed_senders = $4 where location_id = $1 and purpose = 'ap'`,
    [location, rule, domains, senders],
  );
}
function outcomeOf(r: ProcessResult, i = 0): string {
  return r.body.addresses[i]?.outcome ?? 'none';
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  svc = pgSupabase(db);
  await db.exec(`
    insert into core.organizations (id, name, slug) values ('${ORG}', 'Merit Group', 'merit-group'), ('${ORG_B}', 'Legacy Tenant', 'legacy-tenant');
    update core.organizations set inbound_ap_address = 'ap-legacy-tenant@inbound.test' where id = '${ORG_B}';
    insert into core.vendors (id, org_id, name, email) values
      ('${VENDOR}', '${ORG}', 'Prairie Drywall', 'billing@prairie.test'),
      ('${VENDOR_2}', '${ORG}', 'Cedar Electric', 'ar@cedarelectric.test');
    insert into core.users (clerk_user_id, email) values ('user_staff', 'staff@merit.test');
    insert into core.memberships (user_id, org_id, role, status) select id, '${ORG}', 'accounting_specialist', 'active' from core.users where clerk_user_id = 'user_staff';
  `);
  heritage = (await db.query<{ id: string }>(`insert into core.locations (org_id, name, short_code) values ($1, 'Heritage Interiors', 'HI') returning id`, [ORG])).rows[0].id;
  clive = (await db.query<{ id: string }>(`insert into core.locations (org_id, name, short_code) values ($1, 'Clive Power Equipment', 'CP') returning id`, [ORG])).rows[0].id;
  await db.query(`insert into core.locations (org_id, name, short_code) values ($1, 'Legacy Ops', 'LO')`, [ORG_B]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  aiMode = 'ok';
  aiVendorName = 'Prairie Drywall';
  await setRule(heritage, 'any');
  await setRule(clive, 'any');
});

describe('routing', () => {
  it('a PDF to ap-heritage-interiors@ lands ONE draft bill on Heritage, vendor matched, sender shown', async () => {
    const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', messageId: 'pm-1' }), deps());
    expect(r.status).toBe(200);
    expect(outcomeOf(r)).toBe('bill_drafted');
    const d = await drafts(heritage);
    expect(d).toHaveLength(1);
    const p = d[0].proposed_output as { source: string; locationId: string; suggestedVendorId: string; parseState: string; inbound: { from: string; fromName: string; toAddress: string; messageLogId: string } };
    expect(d[0].status).toBe('PROPOSED');
    expect(p.source).toBe('email');
    expect(p.locationId).toBe(heritage);
    expect(p.parseState).toBe('PARSED');
    expect(p.suggestedVendorId).toBe(VENDOR);
    expect(p.inbound.from).toBe('billing@prairie.test');
    expect(p.inbound.fromName).toBe('Prairie Drywall');
    expect(p.inbound.toAddress).toBe('ap-heritage-interiors@inbound.test');
    const log = await logRows();
    expect(log.at(-1)).toMatchObject({ outcome: 'bill_drafted', to_address: 'ap-heritage-interiors@inbound.test' });
    expect(log.at(-1)!.intake_draft_ids).toEqual([d[0].id]);
    expect(p.inbound.messageLogId).toBeTruthy();
    expect(emailDocs).toBeGreaterThan(0); // the original .eml kept
  });

  it('receipts-… goes to the receipts handler, not AP', async () => {
    const before = (await drafts()).length;
    const r = await processInboundEmail(postmark({ to: 'receipts-heritage-interiors@inbound.test', attachments: [{ Name: 'r.jpg', Content: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64'), ContentType: 'image/jpeg' }] }), deps());
    expect(outcomeOf(r)).toBe('receipt_attached');
    expect(receiptsCalls).toHaveLength(1);
    expect((await drafts()).length).toBe(before);
  });

  it('an unknown address → 403 and nothing is stored', async () => {
    const before = (await logRows()).length;
    const r = await processInboundEmail(postmark({ to: 'ap-nobody@inbound.test', messageId: 'pm-unknown' }), deps());
    expect(r.status).toBe(403);
    expect((await logRows()).length).toBe(before);
  });

  it('routes <provider-address>+<alias> (test before DNS) and the legacy org address', async () => {
    const r1 = await processInboundEmail(postmark({ to: 'abc123hash+ap-clive-power-equipment@inbound.postmarkapp.com', attachments: [{ Name: 'b.pdf', Content: PDF_B, ContentType: 'application/pdf' }] }), deps());
    expect(outcomeOf(r1)).toBe('bill_drafted');
    expect((await drafts(clive)).length).toBe(1);
    const r2 = await processInboundEmail(postmark({ to: 'ap-legacy-tenant@inbound.test', from: 'x@y.test', attachments: [{ Name: 'c.pdf', Content: Buffer.from('%PDF legacy').toString('base64'), ContentType: 'application/pdf' }] }), deps());
    expect(outcomeOf(r2)).toBe('bill_drafted');
    expect(r2.body.addresses[0].orgId).toBe(ORG_B);
    expect(r2.body.addresses[0].detail).toMatch(/organization address/);
  });
});

describe('dedupe', () => {
  it('a redelivery of the same MessageID creates no second draft and no second log row', async () => {
    const before = (await drafts()).length;
    const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', messageId: 'pm-1' }), deps());
    expect(r.status).toBe(200);
    expect(r.body.addresses[0].state).toBe('duplicate');
    expect((await drafts()).length).toBe(before);
    const rows = (await logRows()).filter((l) => l.to_address === 'ap-heritage-interiors@inbound.test' && l.duplicate_deliveries > 0);
    expect(rows).toHaveLength(1);
  });

  it('the same PDF in a NEW message → ignored_duplicate; after the first draft is rejected, a resend drafts again', async () => {
    const before = (await drafts(heritage)).length;
    const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', messageId: 'pm-resend-1' }), deps());
    expect(outcomeOf(r)).toBe('ignored_duplicate');
    expect((await drafts(heritage)).length).toBe(before);

    await db.query(`update public.ai_decisions set status = 'REJECTED' where feature = 'AP_DOC_INTAKE' and location_id = $1`, [heritage]);
    const r2 = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', messageId: 'pm-resend-2' }), deps());
    expect(outcomeOf(r2)).toBe('bill_drafted');
    expect((await drafts(heritage)).filter((d) => d.status === 'PROPOSED')).toHaveLength(1);
  });

  it('one email cc’d to two companies of the same tenant drafts once, the copy is a duplicate', async () => {
    const pdf = Buffer.from('%PDF-1.4 shared invoice').toString('base64');
    const r = await processInboundEmail(postmark({ to: ['ap-heritage-interiors@inbound.test', 'ap-clive-power-equipment@inbound.test'], attachments: [{ Name: 's.pdf', Content: pdf, ContentType: 'application/pdf' }] }), deps());
    expect(r.body.addresses.map((a) => a.outcome).sort()).toEqual(['bill_drafted', 'ignored_duplicate']);
  });

  it('a failed attempt is retried (500 → the provider redelivers → processed)', async () => {
    let calls = 0;
    const flaky: InboundPurposeHandler = async (email, ctx) => {
      calls++;
      if (calls === 1) throw new Error('database blip');
      return ap(email, ctx);
    };
    const pdf = Buffer.from('%PDF-1.4 flaky').toString('base64');
    const email = postmark({ to: 'ap-clive-power-equipment@inbound.test', messageId: 'pm-flaky', attachments: [{ Name: 'f.pdf', Content: pdf, ContentType: 'application/pdf' }] });
    const r1 = await processInboundEmail(email, { ...deps(), handlers: { ap: flaky, receipts } });
    expect(r1.status).toBe(500);
    const r2 = await processInboundEmail(email, { ...deps(), handlers: { ap: flaky, receipts } });
    expect(r2.status).toBe(200);
    expect(outcomeOf(r2)).toBe('bill_drafted');
  });
});

describe('sender rules', () => {
  const pdf = (s: string) => [{ Name: `${s}.pdf`, Content: Buffer.from(`%PDF-1.4 ${s}`).toString('base64'), ContentType: 'application/pdf' }];

  it('known_vendors: a stranger is rejected and nothing is stored; vendor email, vendor domain and team are accepted', async () => {
    await setRule(heritage, 'known_vendors');
    const storedBefore = stored.length;
    const docsBefore = emailDocs;
    const bad = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'scam@phish.test', attachments: pdf('scam') }), deps());
    expect(outcomeOf(bad)).toBe('rejected_sender');
    expect(stored.length).toBe(storedBefore);
    expect(emailDocs).toBe(docsBefore);

    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'ar@cedarelectric.test', attachments: pdf('v1') }), deps()))).toBe('bill_drafted');
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'jane@cedarelectric.test', attachments: pdf('v2') }), deps()))).toBe('bill_drafted');
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'Staff <STAFF@merit.test>', attachments: pdf('v3') }), deps()))).toBe('bill_drafted');
  });

  it('listed_domains: only listed domains / senders (and the team)', async () => {
    await setRule(heritage, 'listed_domains', ['acmesupply.test'], ['one@gmail.com']);
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'ar@billing.acmesupply.test', attachments: pdf('l1') }), deps()))).toBe('bill_drafted');
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'one@gmail.com', attachments: pdf('l2') }), deps()))).toBe('bill_drafted');
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'billing@prairie.test', attachments: pdf('l3') }), deps()))).toBe('rejected_sender');
  });

  it('a switched-off address and a spam-flagged stranger are refused', async () => {
    await db.query(`update core.inbound_aliases set is_active = false where location_id = $1 and purpose = 'ap'`, [clive]);
    expect(outcomeOf(await processInboundEmail(postmark({ to: 'ap-clive-power-equipment@inbound.test', attachments: pdf('off') }), deps()))).toBe('alias_inactive');
    await db.query(`update core.inbound_aliases set is_active = true where location_id = $1 and purpose = 'ap'`, [clive]);
    const spam = postmark({ to: 'ap-clive-power-equipment@inbound.test', from: 'promo@spam.test', attachments: pdf('spam'), headers: [{ Name: 'X-Spam-Status', Value: 'Yes, score=9.1' }, { Name: 'X-Spam-Score', Value: '9.1' }] });
    expect(outcomeOf(await processInboundEmail(spam, deps()))).toBe('rejected_spam');
    // a known vendor flagged as spam is still accepted
    const vendorSpam = postmark({ to: 'ap-clive-power-equipment@inbound.test', from: 'billing@prairie.test', attachments: pdf('vspam'), headers: [{ Name: 'X-Spam-Status', Value: 'Yes' }] });
    expect(outcomeOf(await processInboundEmail(vendorSpam, deps()))).toBe('bill_drafted');
  });
});

describe('AI down, HTML-only invoices, forwarding confirmation, inline logos', () => {
  it('AI down → a PENDING_PARSE draft on the right company, vendor suggested from the sender', async () => {
    aiMode = 'down';
    const r = await processInboundEmail(postmark({ to: 'ap-clive-power-equipment@inbound.test', from: 'ar@cedarelectric.test', attachments: [{ Name: 'down.pdf', Content: Buffer.from('%PDF-1.4 ai down').toString('base64'), ContentType: 'application/pdf' }] }), deps());
    expect(outcomeOf(r)).toBe('bill_drafted');
    expect(r.body.addresses[0].detail).toMatch(/manual entry/);
    const d = (await drafts(clive)).at(-1)!;
    const p = d.proposed_output as { parseState: string; suggestedVendorId: string; locationId: string };
    expect(p.parseState).toBe('PENDING_PARSE');
    expect(p.suggestedVendorId).toBe(VENDOR_2);
    expect(p.locationId).toBe(clive);
  });

  it('an HTML-only invoice email is rendered to PDF and drafted; a plain note is no_attachment', async () => {
    const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', attachments: [], subject: 'Invoice #77', html: '<table><tr><td>Amount due</td><td>$412.50</td></tr></table>', text: '' }), deps());
    expect(outcomeOf(r)).toBe('bill_drafted');
    expect(stored.at(-1)!.fileName).toMatch(/email body\)\.pdf$/);
    const r2 = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', attachments: [], subject: 'Lunch?', text: 'Are you free Friday?' }), deps());
    expect(outcomeOf(r2)).toBe('no_attachment');
  });

  it('a Gmail forwarding confirmation is captured on the address, not turned into a bill', async () => {
    const before = (await drafts()).length;
    const r = await processInboundEmail(postmark({
      to: 'ap-heritage-interiors@inbound.test', from: 'forwarding-noreply@google.com', fromName: 'Gmail Team', attachments: [],
      subject: '(#612345789) Gmail Forwarding Confirmation - Receive Mail from bills@heritage.test',
      text: 'bills@heritage.test has requested to automatically forward mail to your email address.\nConfirmation code: 612345789\nTo allow, click: https://mail-settings.google.com/mail/vf-%5BANGjdJ8%5D-abc\n',
      headers: [{ Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS' }],
    }), deps());
    expect(outcomeOf(r)).toBe('forwarding_confirmation');
    expect((await drafts()).length).toBe(before);
    const a = (await db.query<{ fwd_confirm_from: string; fwd_confirm_code: string; fwd_confirm_url: string; fwd_confirm_verified: boolean }>(
      `select fwd_confirm_from, fwd_confirm_code, fwd_confirm_url, fwd_confirm_verified from core.inbound_aliases where location_id = $1 and purpose = 'ap'`, [heritage],
    )).rows[0];
    expect(a).toEqual({ fwd_confirm_from: 'bills@heritage.test', fwd_confirm_code: '612345789', fwd_confirm_url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8%5D-abc', fwd_confirm_verified: true });
  });

  it('a "Gmail forwarding confirmation" without Google’s DKIM signature is ignored, nothing captured', async () => {
    await db.query(`update core.inbound_aliases set fwd_confirm_from = null, fwd_confirm_code = null, fwd_confirm_url = null, fwd_confirm_at = null where location_id = $1 and purpose = 'ap'`, [clive]);
    const r = await processInboundEmail(postmark({
      to: 'ap-clive-power-equipment@inbound.test', from: 'forwarding-noreply@google.com', fromName: 'Gmail Team', attachments: [], auth: 'none',
      subject: '(#999999999) Gmail Forwarding Confirmation - Receive Mail from evil@attacker.test',
      text: 'Confirmation code: 999999999\nhttps://mail-settings.google.com/mail/vf-%5Bx%5D-planted\n',
      headers: [{ Name: 'X-Spam-Tests', Value: 'SPF_PASS' }],
    }), deps());
    expect(outcomeOf(r)).toBe('rejected_sender');
    const a = (await db.query<{ fwd_confirm_code: string | null }>(`select fwd_confirm_code from core.inbound_aliases where location_id = $1 and purpose = 'ap'`, [clive])).rows[0];
    expect(a.fwd_confirm_code).toBeNull();
  });

  it('inline signature logos are ignored; the real PDF is drafted', async () => {
    const logo = Buffer.alloc(2048, 7).toString('base64');
    const r = await processInboundEmail(postmark({
      to: 'ap-clive-power-equipment@inbound.test',
      attachments: [
        { Name: 'logo.png', Content: logo, ContentType: 'image/png', ContentID: 'logo@sig' },
        { Name: 'inv.pdf', Content: Buffer.from('%PDF-1.4 with logo').toString('base64'), ContentType: 'application/pdf' },
      ],
    }), deps());
    expect(outcomeOf(r)).toBe('bill_drafted');
    const msg = (await listMessages(svc, { orgId: ORG, locationId: clive, perPage: 1 })).messages[0];
    expect(msg.attachments.map((a) => a.result).sort()).toEqual(['drafted', 'inline_ignored']);
    expect(msg.acceptedCount).toBe(1);
  });
});

describe('M6 — spoofed From (no SPF/DKIM/DMARC pass)', () => {
  const pdf = (s: string) => [{ Name: `${s}.pdf`, Content: Buffer.from(`%PDF-1.4 ${s}`).toString('base64'), ContentType: 'application/pdf' }];

  it('known_vendors: a forged vendor / team address is rejected and nothing is stored', async () => {
    await setRule(heritage, 'known_vendors');
    const storedBefore = stored.length;
    for (const from of ['billing@prairie.test', 'staff@merit.test']) {
      const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from, auth: 'none', attachments: pdf(`forged-${from}`) }), deps());
      expect(outcomeOf(r)).toBe('rejected_sender');
      expect(r.body.addresses[0].detail).toMatch(/could not be verified/);
    }
    expect(stored.length).toBe(storedBefore);
  });

  it('an "Anyone" address drafts it, but with NO vendor matched from the sender and a "Sender not verified" flag', async () => {
    aiMode = 'down'; // no AI vendor read: only the sender could have picked the vendor
    const r = await processInboundEmail(postmark({ to: 'ap-heritage-interiors@inbound.test', from: 'billing@prairie.test', auth: 'none', attachments: pdf('forged-any') }), deps());
    expect(outcomeOf(r)).toBe('bill_drafted');
    expect(r.body.addresses[0].detail).toMatch(/sender not verified/);
    const d = (await drafts(heritage)).at(-1)!;
    const p = d.proposed_output as { suggestedVendorId: string | null; inbound: { senderVerified: boolean } };
    expect(p.suggestedVendorId ?? null).toBeNull();
    expect(p.inbound.senderVerified).toBe(false);
    const msg = (await listMessages(svc, { orgId: ORG, locationId: heritage, perPage: 1 })).messages[0];
    expect(msg.senderVerified).toBe(false);
    expect(msg.senderAuth).toMatch(/not verified/i);
  });

  it('a spam-flagged FORGED vendor is not waved through as "trusted"', async () => {
    const r = await processInboundEmail(postmark({ to: 'ap-clive-power-equipment@inbound.test', from: 'billing@prairie.test', auth: 'none', attachments: pdf('forged-spam'), headers: [{ Name: 'X-Spam-Status', Value: 'Yes' }] }), deps());
    expect(outcomeOf(r)).toBe('rejected_spam');
  });

  it('a NEW company’s addresses default to known_vendors', async () => {
    const loc = (await db.query<{ id: string }>(`insert into core.locations (org_id, name, short_code) values ($1, 'Swan Creek', 'SC') returning id`, [ORG])).rows[0].id;
    const rules = (await db.query<{ sender_rule: string }>(`select sender_rule from core.inbound_aliases where location_id = $1`, [loc])).rows;
    expect(rules).toHaveLength(2);
    expect(rules.every((x) => x.sender_rule === 'known_vendors')).toBe(true);
  });
});

describe('the log reads per company', () => {
  it('lists newest first, filters to a company and to problems', async () => {
    const all = await listMessages(svc, { orgId: ORG, locationId: heritage, perPage: 100 });
    expect(all.messages.length).toBeGreaterThan(3);
    expect(all.messages.every((m) => m.locationId === heritage)).toBe(true);
    const problems = await listMessages(svc, { orgId: ORG, outcome: 'problems', perPage: 100 });
    expect(problems.messages.length).toBeGreaterThan(0);
    expect(problems.messages.every((m) => ['rejected_sender', 'rejected_spam', 'alias_inactive', 'no_attachment', 'not_handled', 'failed'].includes(m.outcome))).toBe(true);
  });
  it('a message with no company is listed for org admins only', async () => {
    const orphan = randomUUID();
    await db.query(
      `insert into core.inbound_messages (id, org_id, location_id, purpose, provider, provider_message_id, from_address, to_address, outcome)
       values ($1, $2, null, 'ap', 'postmark', $3, 'x@y.test', 'ap-gone@inbound.test', 'failed')`,
      [orphan, ORG, `orphan-${orphan}`],
    );
    const member = await listMessages(svc, { orgId: ORG, perPage: 100 });
    expect(member.messages.some((m) => m.id === orphan)).toBe(false);
    const admin = await listMessages(svc, { orgId: ORG, perPage: 100, includeNoCompany: true });
    expect(admin.messages.some((m) => m.id === orphan)).toBe(true);
  });
});
