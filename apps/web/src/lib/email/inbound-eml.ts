/**
 * The ORIGINAL email, kept as a document. Providers hand us parsed JSON (not the raw
 * MIME), so we rebuild a faithful RFC 5322 message — headers + the text and HTML
 * bodies as multipart/alternative — that opens in Outlook / Apple Mail. Attachments
 * are stored as their own documents (and linked from the log), not duplicated here.
 *
 * Also: a conservative HTML → plain-text conversion used for the body-to-PDF render
 * and the AI read of HTML-only invoice emails. Pure.
 */

import type { InboundAddress, InboundEmail } from './inbound-types';

function encodeHeader(v: string): string {
  // RFC 2047 for anything non-ASCII; strip CR/LF (header injection).
  const s = v.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function fmtAddr(a: InboundAddress): string {
  return a.name ? `${encodeHeader(`"${a.name.replace(/"/g, "'")}"`)} <${a.address}>` : `<${a.address}>`;
}

function b64Lines(s: string): string {
  return (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Build the .eml bytes for an inbound message. */
export function buildEml(email: InboundEmail): Buffer {
  const boundary = `mb-${email.providerMessageId ? Buffer.from(email.providerMessageId).toString('hex').slice(0, 24) : 'x'}-${email.attachments.length}`;
  const lines: string[] = [
    `From: ${fmtAddr(email.from)}`,
    `To: ${(email.to.length ? email.to : email.recipients.map((address) => ({ address, name: null }))).map(fmtAddr).join(', ')}`,
  ];
  if (email.cc.length) lines.push(`Cc: ${email.cc.map(fmtAddr).join(', ')}`);
  lines.push(`Subject: ${encodeHeader(email.subject ?? '(no subject)')}`);
  lines.push(`Date: ${new Date(email.receivedAt).toUTCString()}`);
  if (email.messageIdHeader) lines.push(`Message-ID: <${email.messageIdHeader.replace(/[<>\r\n]/g, '')}>`);
  lines.push(`X-MeritBooks-Inbound-Provider: ${email.provider}`);
  if (email.attachments.length) {
    lines.push(`X-MeritBooks-Attachments: ${encodeHeader(email.attachments.map((a) => a.fileName).join(', '))} (stored as separate documents)`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push('');
  const text = email.textBody ?? (email.htmlBody ? htmlToText(email.htmlBody) : '');
  lines.push(`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64Lines(text));
  if (email.htmlBody) {
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64Lines(email.htmlBody));
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', copy: '©', reg: '®', hellip: '…' };

/** HTML → readable text: drops script/style/head, keeps rows/paragraph breaks, tabs between cells. */
/** Input past this is ignored by htmlToText (a pathological body must not stall a request). */
export const HTML_TO_TEXT_MAX_CHARS = 512 * 1024;

/** A numeric entity → its character; bad / out-of-range / control code points → a space. */
function codePointChar(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' ';
  if (n < 32 && n !== 9 && n !== 10 && n !== 13) return ' ';
  return String.fromCodePoint(n);
}

export function htmlToText(html: string): string {
  let s = (html.length > HTML_TO_TEXT_MAX_CHARS ? html.slice(0, HTML_TO_TEXT_MAX_CHARS) : html)
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|section|header|footer)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return codePointChar(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return codePointChar(parseInt(k.slice(1), 10));
    return ENTITIES[k] ?? m;
  });
  return s
    .split('\n')
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/\t +| +\t/g, '\t').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

/** The text an HTML-only invoice is rendered from (subject/sender header + body). */
export function bodyTextForRender(email: InboundEmail): string {
  return email.textBody?.trim() || (email.htmlBody ? htmlToText(email.htmlBody) : '');
}

/** A filename-safe stem from the subject. */
export function subjectStem(email: InboundEmail): string {
  return (email.subject ?? 'email').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'email';
}
