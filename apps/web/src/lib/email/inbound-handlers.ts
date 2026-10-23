/**
 * Purpose → handler registry for inbound email.
 *
 *   ap        lib/ap/inbound-email-ap.ts — draft bills in the company's intake queue
 *   receipts  slice 2B's `handleInboundReceiptEmail(parsed, ctx)` (lib/receipts/inbound.ts):
 *             sender → cardholder, capture, auto-match to the card charge
 *
 * `receiptsNotWired` is the fallback if the receipts module is ever unavailable: the
 * message is logged 'not_handled' and the email + files are kept as documents, so a
 * receipt is never dropped. Swap one line below to use it.
 */

import type { InboundAliasPurpose, InboundPurposeHandler } from './inbound-types';
import { handleInboundApEmail } from '@/lib/ap/inbound-email-ap';
import { handleInboundReceiptEmail } from '@/lib/receipts/inbound';
import { storeSourceDocument } from '@/lib/documents/store-source';

/** Fallback receipts handler: keep every file, report not_handled. */
export const receiptsNotWired: InboundPurposeHandler = async (email, ctx) => {
  const documentIds: string[] = ctx.emailDocumentId ? [ctx.emailDocumentId] : [];
  for (const att of email.attachments) {
    if (att.inline && att.sizeBytes < 30 * 1024) continue;
    const stored = await storeSourceDocument({
      supabase: ctx.admin, orgId: ctx.alias.orgId, userId: null, base64: att.base64, fileName: att.fileName,
      mimeType: att.contentType, docType: 'RECEIPT', entityType: 'receipt',
      notes: `Receipt received by email from ${email.from.address} at ${ctx.alias.address}`,
    });
    if (stored) documentIds.push(stored.documentId);
  }
  return {
    outcome: 'not_handled',
    detail: 'Receipt matching by email is not switched on yet. The email and its files are kept in Documents.',
    linked: { documentIds },
  };
};

export type InboundHandlerRegistry = Record<InboundAliasPurpose, InboundPurposeHandler>;

export const INBOUND_HANDLERS: InboundHandlerRegistry = {
  ap: handleInboundApEmail,
  receipts: (parsed, ctx) => handleInboundReceiptEmail(parsed, ctx),
};
