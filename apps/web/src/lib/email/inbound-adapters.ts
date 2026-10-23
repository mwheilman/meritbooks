/**
 * Provider adapters: raw webhook body → the typed `InboundEmail`.
 *
 *   postmark  JSON (FromFull / ToFull / CcFull / BccFull / OriginalRecipient / MessageID /
 *             Date / TextBody / HtmlBody / Headers[] / Attachments[{Name, Content,
 *             ContentType, ContentLength, ContentID}]) — Postmark inbound webhook format.
 *   sendgrid  multipart/form-data Inbound Parse ("Send Raw" OFF): from, to, cc, subject,
 *             text, html, headers, envelope (JSON), attachment-info (JSON) + attachmentN
 *             file parts, spam_score.
 *   generic   provider-neutral JSON: from|sender, to|recipient(s), cc, subject,
 *             messageId, text, html, headers{}, envelope.to, attachments[{filename,
 *             contentType, content(base64)}] — the pre-2D contract, still accepted.
 *
 * Adapters never throw on content: a malformed body returns { ok: false }. Everything
 * here is pure (no I/O) and unit-tested with fixture payloads.
 */

import type { InboundAddress, InboundEmail, InboundEmailAttachment, InboundProviderId, SenderAuthentication } from './inbound-types';
import { senderAuthentication, type SenderAuthInput } from './inbound-sender-auth';
import {
  cleanBase64,
  headerValues,
  sha256Hex,
  firstString,
  makeAttachment,
  normalizeAddress,
  parseAddress,
  parseAddressList,
  parseHeaderBlock,
  spamFromHeaders,
  syntheticMessageId,
  toIsoDate,
  uniqueAddresses,
} from './inbound-normalize';

export type AdapterResult = { ok: true; email: InboundEmail } | { ok: false; error: string };

/** Hard cap on attachments per message (a mailing-list blast is not a bill). */
export const MAX_ATTACHMENTS = 25;

/** HTML bodies are truncated past this (a receipt / invoice body is never this big). */
export const MAX_HTML_CHARS = 512 * 1024;

export interface AdapterOptions {
  /** Extra Authentication-Results authserv-ids to trust (INBOUND_EMAIL_AUTHSERV_IDS). */
  trustedAuthservIds?: string[];
}

/**
 * The redelivery key when the provider has no delivery id of its own: the Message-ID
 * header PLUS a hash of the content. A Message-ID alone is sender-chosen — reusing a real
 * message's id must not make a different message read as "already received".
 */
export function contentDedupeKey(parts: {
  messageIdHeader: string | null;
  from: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachmentHashes: string[];
}): string | null {
  if (!parts.messageIdHeader) return null;
  const content = sha256Hex([parts.from, parts.subject ?? '', parts.textBody ?? '', parts.htmlBody ?? '', parts.attachmentHashes.join(',')].join('\n'));
  return `mid:${sha256Hex(`${parts.messageIdHeader}\n${content}`)}`;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function fullList(v: unknown): InboundAddress[] {
  if (!Array.isArray(v)) return [];
  const out: InboundAddress[] = [];
  for (const item of v) {
    const o = asObject(item);
    if (!o) continue;
    const a = parseAddress(String(o.Email ?? o.email ?? ''), firstString(o.Name, o.name));
    if (a) out.push(a);
  }
  return out;
}

function stripAngle(v: string | null): string | null {
  return v ? v.replace(/^<|>$/g, '').trim() || null : null;
}

function finish(args: {
  provider: InboundProviderId;
  providerMessageId: string | null;
  headers: Record<string, string>;
  from: InboundAddress | null;
  to: InboundAddress[];
  cc: InboundAddress[];
  extraRecipients: Array<string | null | undefined>;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  date: string | null;
  attachments: InboundEmailAttachment[];
  spamScore?: string | null;
  now: Date;
  auth: Omit<SenderAuthInput, 'provider' | 'fromAddress' | 'headers'>;
}): AdapterResult {
  if (!args.from) return { ok: false, error: 'The message has no sender address.' };
  const recipients = uniqueAddresses([
    ...args.extraRecipients,
    ...args.to.map((a) => a.address),
    ...args.cc.map((a) => a.address),
  ]);
  if (recipients.length === 0) return { ok: false, error: 'The message has no recipient address.' };
  const messageIdHeader = stripAngle(args.headers['message-id'] ?? null);
  const htmlBody = args.htmlBody && args.htmlBody.length > MAX_HTML_CHARS ? args.htmlBody.slice(0, MAX_HTML_CHARS) : args.htmlBody;
  const providerMessageId =
    args.providerMessageId ??
    contentDedupeKey({
      messageIdHeader,
      from: args.from.address,
      subject: args.subject,
      textBody: args.textBody,
      htmlBody,
      attachmentHashes: args.attachments.map((a) => a.sha256),
    }) ??
    syntheticMessageId({
      from: args.from.address,
      subject: args.subject,
      date: args.date,
      attachmentHashes: args.attachments.map((a) => a.sha256),
      textBody: args.textBody,
    });
  return {
    ok: true,
    email: {
      provider: args.provider,
      providerMessageId: providerMessageId.slice(0, 500),
      messageIdHeader,
      from: args.from,
      to: args.to,
      cc: args.cc,
      recipients,
      subject: args.subject ? args.subject.slice(0, 998) : null,
      textBody: args.textBody,
      htmlBody,
      receivedAt: toIsoDate(args.date, args.now),
      headers: args.headers,
      attachments: args.attachments.slice(0, MAX_ATTACHMENTS),
      spam: spamFromHeaders(args.headers, args.spamScore),
      auth: authFor(args.provider, args.from.address, args.headers, args.auth),
    },
  };
}

function authFor(
  provider: InboundProviderId,
  fromAddress: string,
  headers: Record<string, string>,
  extra: Omit<SenderAuthInput, 'provider' | 'fromAddress' | 'headers'>,
): SenderAuthentication {
  return senderAuthentication({ provider, fromAddress, headers, ...extra });
}

// ── Postmark ─────────────────────────────────────────────────────────────────
export function parsePostmark(rawBody: Uint8Array, now: Date = new Date(), opts: AdapterOptions = {}): AdapterResult {
  let body: Json | null;
  try {
    body = asObject(JSON.parse(Buffer.from(rawBody).toString('utf8')));
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  if (!body) return { ok: false, error: 'Invalid JSON body.' };

  const headers: Record<string, string> = {};
  const authResults: string[] = [];
  if (Array.isArray(body.Headers)) {
    for (const h of body.Headers) {
      const o = asObject(h);
      const name = typeof o?.Name === 'string' ? o.Name.trim().toLowerCase() : '';
      if (name === 'authentication-results' && typeof o?.Value === 'string') authResults.push(o.Value);
      if (name && !(name in headers) && typeof o?.Value === 'string') headers[name] = o.Value;
    }
  }
  // Postmark's MessageID is its own delivery id (the idempotency key); the RFC
  // Message-ID header, when present, is kept separately in messageIdHeader.
  const fromFull = asObject(body.FromFull);
  const from =
    (fromFull ? parseAddress(String(fromFull.Email ?? ''), firstString(fromFull.Name, body.FromName)) : null) ??
    parseAddress(String(body.From ?? ''), firstString(body.FromName));

  const to = fullList(body.ToFull).length ? fullList(body.ToFull) : parseAddressList(firstString(body.To));
  const cc = fullList(body.CcFull).length ? fullList(body.CcFull) : parseAddressList(firstString(body.Cc));
  const bcc = fullList(body.BccFull).length ? fullList(body.BccFull) : parseAddressList(firstString(body.Bcc));

  const attachments: InboundEmailAttachment[] = [];
  if (Array.isArray(body.Attachments)) {
    for (const raw of body.Attachments) {
      const a = asObject(raw);
      const b64 = cleanBase64(typeof a?.Content === 'string' ? a.Content : null);
      if (!a || !b64) continue;
      attachments.push(
        makeAttachment({
          fileName: firstString(a.Name),
          contentType: firstString(a.ContentType),
          bytes: Buffer.from(b64, 'base64'),
          contentId: firstString(a.ContentID),
        }),
      );
    }
  }

  return finish({
    provider: 'postmark',
    providerMessageId: firstString(body.MessageID),
    headers,
    from,
    to,
    cc,
    extraRecipients: [firstString(body.OriginalRecipient), ...bcc.map((b) => b.address)],
    subject: firstString(body.Subject),
    textBody: typeof body.TextBody === 'string' ? body.TextBody : null,
    htmlBody: typeof body.HtmlBody === 'string' ? body.HtmlBody : null,
    date: firstString(body.Date),
    attachments,
    now,
    auth: { authenticationResults: authResults, trustedAuthservIds: opts.trustedAuthservIds },
  });
}

// ── SendGrid Inbound Parse (multipart) ───────────────────────────────────────
export async function parseSendgrid(rawBody: Uint8Array, contentType: string, now: Date = new Date(), opts: AdapterOptions = {}): Promise<AdapterResult> {
  if (!/multipart\/form-data/i.test(contentType)) return { ok: false, error: 'Expected multipart/form-data.' };
  let form: FormData;
  try {
    form = await new Response(Buffer.from(rawBody), { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { ok: false, error: 'Unreadable multipart body.' };
  }
  const str = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  };
  if (str('email')) return { ok: false, error: 'SendGrid "Send Raw" is on — turn it off in the Inbound Parse settings.' };

  const headers = parseHeaderBlock(str('headers'));
  let envelopeTo: string[] = [];
  let envelopeFrom: string | null = null;
  try {
    const env = asObject(JSON.parse(str('envelope') ?? '{}'));
    if (env && Array.isArray(env.to)) envelopeTo = env.to.filter((x): x is string => typeof x === 'string');
    envelopeFrom = env && typeof env.from === 'string' ? env.from : null;
  } catch {
    /* envelope optional */
  }
  let info: Json = {};
  try {
    info = asObject(JSON.parse(str('attachment-info') ?? '{}')) ?? {};
  } catch {
    info = {};
  }

  const attachments: InboundEmailAttachment[] = [];
  const count = Math.min(Number(str('attachments') ?? '0') || 0, MAX_ATTACHMENTS);
  for (let i = 1; i <= count; i++) {
    const part = form.get(`attachment${i}`);
    if (!part || typeof part === 'string') continue;
    const meta = asObject(info[`attachment${i}`]) ?? {};
    const bytes = new Uint8Array(await part.arrayBuffer());
    attachments.push(
      makeAttachment({
        fileName: firstString(meta.filename, meta.name, part.name),
        contentType: firstString(meta.type, part.type),
        bytes,
        contentId: firstString(meta['content-id']),
      }),
    );
  }

  const from = parseAddressList(str('from'))[0] ?? (envelopeFrom ? parseAddress(envelopeFrom) : null);
  return finish({
    provider: 'sendgrid',
    providerMessageId: null,
    headers,
    from,
    to: parseAddressList(str('to')),
    cc: parseAddressList(str('cc')),
    extraRecipients: envelopeTo,
    subject: str('subject'),
    textBody: str('text'),
    htmlBody: str('html'),
    date: headers['date'] ?? null,
    attachments,
    spamScore: str('spam_score'),
    now,
    auth: {
      authenticationResults: headerValues(str('headers'), 'authentication-results'),
      trustedAuthservIds: opts.trustedAuthservIds,
      sendgrid: { spf: str('SPF') ?? str('spf'), dkim: str('dkim') ?? str('DKIM'), envelopeFrom },
    },
  });
}

// ── Generic JSON ─────────────────────────────────────────────────────────────
function addrValues(v: unknown): string[] {
  if (typeof v === 'string') return parseAddressList(v).map((a) => a.address);
  if (Array.isArray(v)) return v.flatMap(addrValues);
  const o = asObject(v);
  if (o) {
    const a = normalizeAddress(String(o.address ?? o.email ?? o.Email ?? ''));
    return a ? [a] : [];
  }
  return [];
}

export function parseGeneric(rawBody: Uint8Array, now: Date = new Date(), opts: AdapterOptions = {}): AdapterResult {
  let body: Json | null;
  try {
    body = asObject(JSON.parse(Buffer.from(rawBody).toString('utf8')));
  } catch {
    return { ok: false, error: 'Invalid JSON body.' };
  }
  if (!body) return { ok: false, error: 'Invalid JSON body.' };

  const headers: Record<string, string> = {};
  const h = asObject(body.headers);
  if (h) for (const [k, v] of Object.entries(h)) if (typeof v === 'string') headers[k.toLowerCase()] = v;

  const fromRaw = firstString(body.from, body.sender, body.From);
  const from = fromRaw ? parseAddressList(fromRaw)[0] ?? null : null;
  const toAddrs = [...addrValues(body.to), ...addrValues(body.To)];
  const envelope = asObject(body.envelope);
  const extra = [...addrValues(body.recipient), ...addrValues(body.recipients), ...addrValues(envelope?.to)];

  const attachments: InboundEmailAttachment[] = [];
  if (Array.isArray(body.attachments)) {
    for (const raw of body.attachments) {
      const a = asObject(raw);
      const b64 = cleanBase64(a ? firstString(a.content, a.base64, a.data, a.contentBytes) : null);
      if (!a || !b64) continue;
      attachments.push(
        makeAttachment({
          fileName: firstString(a.filename, a.fileName, a.name),
          contentType: firstString(a.contentType, a.content_type, a.type, a.mimeType, a.mime_type),
          bytes: Buffer.from(b64, 'base64'),
          contentId: firstString(a.contentId, a.content_id, a.cid),
          inline: a.inline === true,
        }),
      );
    }
  }

  return finish({
    provider: 'generic',
    providerMessageId: firstString(body.messageId, body.message_id, body['Message-Id'], body['message-id']),
    headers,
    from,
    to: toAddrs.map((address) => ({ address, name: null })),
    cc: addrValues(body.cc).map((address) => ({ address, name: null })),
    extraRecipients: extra,
    subject: firstString(body.subject, body.Subject),
    textBody: firstString(body.text, body.textBody, body.TextBody),
    htmlBody: firstString(body.html, body.htmlBody, body.HtmlBody),
    date: firstString(body.date, body.Date, headers['date']),
    attachments,
    now,
    auth: {
      authenticationResults: [],
      trustedAuthservIds: opts.trustedAuthservIds,
      relay: relayAuth(asObject(body.authentication) ?? asObject(body.auth)),
    },
  });
}

/** A generic relay's own SPF/DKIM/DMARC verdict: { spf, dkim, dmarc, spfDomain, dkimDomains }. */
function relayAuth(o: Json | null): SenderAuthInput['relay'] {
  if (!o) return null;
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    spf: s(o.spf),
    dkim: s(o.dkim),
    dmarc: s(o.dmarc),
    spfDomain: s(o.spfDomain ?? o.spf_domain),
    dkimDomains: Array.isArray(o.dkimDomains ?? o.dkim_domains) ? ((o.dkimDomains ?? o.dkim_domains) as unknown[]).filter((x): x is string => typeof x === 'string') : null,
  };
}

/** Dispatch on the configured provider. */
export async function parseInbound(
  provider: InboundProviderId,
  rawBody: Uint8Array,
  contentType: string,
  now: Date = new Date(),
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  if (provider === 'postmark') return parsePostmark(rawBody, now, opts);
  if (provider === 'sendgrid') return parseSendgrid(rawBody, contentType, now, opts);
  return parseGeneric(rawBody, now, opts);
}
