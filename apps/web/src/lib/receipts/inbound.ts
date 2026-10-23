/**
 * Forwarded receipts by email — the `receipts` purpose handler for Wave 2D's inbound route
 * (`lib/email/inbound-types.ts`, alias `receipts-<company>@…`).
 *
 * 2D verifies the provider signature, logs the delivery, resolves the alias to
 * (org, company, purpose = 'receipts') and calls `handleInboundReceiptEmail(parsed, ctx)`.
 * Here:
 *   1. sender → cardholder: an ACTIVE card assignment in THAT company whose email is the
 *      From address. An unknown sender is REJECTED (anyone can email an address; only
 *      known cardholders may attach receipts to the books). The bookkeeper adds the person
 *      as a cardholder and asks them to forward again.
 *   2. every real attachment (image / PDF; inline logos and tiny images skipped) becomes a
 *      receipt through the one capture pipeline; with no attachment, an HTML / text body
 *      that reads like a receipt (has a total) becomes one (e-receipts: Uber, Amazon …).
 *   3. duplicates (same file sha256 already captured) are ignored.
 *   4. each receipt auto-matches; a match closes that charge's chase.
 *
 * Session-less: `ctx.admin` is the service role; every write is stamped with the alias's
 * org and company.
 */

import type { InboundEmail, InboundHandlerContext, InboundHandlerResult } from '@/lib/email/inbound-types';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { captureReceipt, CaptureError, checkReceiptFile, type CaptureDeps, type CaptureFile } from './capture';
import { ASSIGNMENT_COLUMNS } from './chase';
import { findTotal, htmlToText } from './extract';
import type { CardAssignmentRow } from './types';

/** Inline images under this size are signatures / tracking pixels, not receipts. */
const MIN_IMAGE_BYTES = 8 * 1024;
const MAX_ATTACHMENTS = 10;

export interface InboundReceiptOptions {
  /** Test seam (capture deps override: storage, AI reader, clock). */
  deps?: Partial<CaptureDeps>;
  /** Test seam: the body → PDF renderer. */
  renderBodyPdf?: (email: InboundEmail) => Promise<Buffer | null>;
}

async function defaultRenderBodyPdf(email: InboundEmail): Promise<Buffer | null> {
  const { renderEmailBodyPdf } = await import('@/lib/email/inbound-body-pdf');
  return renderEmailBodyPdf(email);
}

/** A body-only e-receipt as a SAFE file: a rendered PDF, else the plain text. Never HTML. */
export async function bodyReceiptFile(
  parsed: InboundEmail,
  render: ((email: InboundEmail) => Promise<Buffer | null>) | undefined,
): Promise<CaptureFile> {
  try {
    const pdf = await (render ?? defaultRenderBodyPdf)(parsed);
    if (pdf && pdf.length > 0) return { base64: pdf.toString('base64'), fileName: 'e-receipt.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length };
  } catch (e) {
    console.warn('[receipts/inbound] body render failed, keeping text:', e instanceof Error ? e.message : e);
  }
  const text = (parsed.textBody?.trim() || (parsed.htmlBody ? htmlToText(parsed.htmlBody) : '')).slice(0, 200_000) || '(empty)';
  return { base64: Buffer.from(text, 'utf8').toString('base64'), fileName: 'e-receipt.txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(text, 'utf8') };
}

/** Attachments worth reading as receipts. Pure. */
export function receiptAttachments(parsed: Pick<InboundEmail, 'attachments'>): InboundEmail['attachments'] {
  return parsed.attachments
    .filter((a) => {
      const mime = a.contentType.toLowerCase();
      if (a.inline && mime.startsWith('image/') && a.sizeBytes < MIN_IMAGE_BYTES) return false;
      if (mime.startsWith('image/') && a.sizeBytes < 2 * 1024) return false;
      return checkReceiptFile({ fileName: a.fileName, mimeType: mime, sizeBytes: a.sizeBytes }) === null && !mime.startsWith('text/');
    })
    .slice(0, MAX_ATTACHMENTS);
}

/**
 * The merchant a forwarded receipt's subject names: "Fwd: Your Home Depot receipt" →
 * "Home Depot". The From line is the cardholder (they forwarded it), never the merchant. Pure.
 */
export function merchantFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const s = subject
    .replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, '')
    .replace(/\b(your|e-?receipts?|receipts?|order|orders|confirmation|invoice|purchase|trip|ride|with|from|for|thanks|thank you|payment|#\s*\S+)\b/gi, ' ')
    .replace(/[^a-z0-9&' ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 ? s.slice(0, 80) : null;
}

/** Is a body-only email an e-receipt (it states a total)? Pure. */
export function bodyLooksLikeReceipt(parsed: Pick<InboundEmail, 'textBody' | 'htmlBody' | 'subject'>): boolean {
  const text = parsed.textBody?.trim() || (parsed.htmlBody ? htmlToText(parsed.htmlBody) : '');
  if (!text) return false;
  return findTotal(`${parsed.subject ?? ''}\n${text}`) != null;
}

export async function handleInboundReceiptEmail(parsed: InboundEmail, ctx: InboundHandlerContext, opts: InboundReceiptOptions = {}): Promise<InboundHandlerResult> {
  const { admin, alias } = ctx;
  if (alias.purpose !== 'receipts') return { outcome: 'not_handled', detail: 'Not a receipts address.' };
  const from = parsed.from.address.trim().toLowerCase();

  // A From header is just text: without the provider's SPF/DKIM/DMARC pass the sender is
  // unknown, and an unknown sender is never trusted as a cardholder.
  if (parsed.auth?.verified !== true) {
    return {
      outcome: 'rejected_sender',
      detail: `${from} could not be verified (the sending mail server did not pass SPF, DKIM or DMARC), so the receipt was not attached to anyone's card. Upload it in Merit Workforce instead.`,
    };
  }

  const { data: holders, error } = await admin
    .from('card_assignments')
    .select(ASSIGNMENT_COLUMNS)
    .eq('org_id', alias.orgId)
    .eq('location_id', alias.locationId)
    .eq('active', true)
    .eq('holder_email', from);
  if (error) return { outcome: 'failed', detail: `Could not look up the sender: ${error.message}` };
  const holder = ((holders ?? []) as CardAssignmentRow[])[0] ?? null;
  if (!holder) {
    return {
      outcome: 'rejected_sender',
      detail: `${from} is not a cardholder for this company. Add them under Receipts → Cardholders, then forward again.`,
    };
  }

  const deps: CaptureDeps = {
    db: admin,
    now: () => new Date(),
    anthropicApiKey: ctx.aiAvailable ? getAnthropicApiKey() : null,
    ...opts.deps,
  };
  const hintText = [parsed.subject ?? '', parsed.textBody ?? (parsed.htmlBody ? htmlToText(parsed.htmlBody) : '')].join('\n').slice(0, 20_000);
  const base = {
    orgId: alias.orgId,
    locationId: alias.locationId,
    source: 'EMAIL' as const,
    holder,
    hintText,
    hintMerchant: merchantFromSubject(parsed.subject),
    submittedBy: `email:${from}`.slice(0, 200),
    inboundMessageId: parsed.providerMessageId ?? parsed.messageIdHeader ?? null,
  };

  const files = receiptAttachments(parsed);
  const receiptIds: string[] = [];
  let duplicates = 0;
  let matched = 0;
  const problems: string[] = [];

  if (files.length > 0) {
    for (const a of files) {
      try {
        const r = await captureReceipt(deps, {
          ...base,
          file: { base64: a.base64, fileName: a.fileName, mimeType: a.contentType.toLowerCase(), sizeBytes: a.sizeBytes },
        });
        if (r.duplicate) duplicates++;
        else receiptIds.push(r.receiptId);
        if (r.match.kind === 'matched' || r.match.kind === 'attached') matched++;
      } catch (e) {
        problems.push(`${a.fileName}: ${e instanceof CaptureError || e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (bodyLooksLikeReceipt(parsed)) {
    // Never store the sender's HTML (it would be served back to the bookkeeper): render
    // the body to a PDF, falling back to its plain text.
    try {
      const file = await bodyReceiptFile(parsed, opts.renderBodyPdf);
      const r = await captureReceipt(deps, { ...base, file });
      if (r.duplicate) duplicates++;
      else receiptIds.push(r.receiptId);
      if (r.match.kind === 'matched') matched++;
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    return { outcome: 'no_attachment', detail: 'No receipt attached and the email has no total to read.' };
  }

  if (receiptIds.length === 0 && duplicates > 0 && problems.length === 0) {
    return { outcome: 'ignored_duplicate', detail: `Already have ${duplicates === 1 ? 'this receipt' : 'these receipts'}.` };
  }
  if (receiptIds.length === 0) return { outcome: 'failed', detail: problems.join('; ').slice(0, 500) || 'Nothing could be read.' };
  return {
    outcome: 'receipt_attached',
    detail: `${receiptIds.length} receipt${receiptIds.length === 1 ? '' : 's'} from ${holder.holder_name}${matched ? `, ${matched} matched to a charge` : ''}${duplicates ? `, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} ignored` : ''}${problems.length ? `; ${problems.length} could not be read` : ''}.`,
    linked: { receiptIds },
  };
}
