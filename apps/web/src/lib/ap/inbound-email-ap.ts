/**
 * The AP purpose handler: an email that reached a company's ap-… address becomes
 * draft bill(s) in that company's intake queue.
 *
 *   • each PDF / image attachment (inline signature logos ignored) → kept in the
 *     documents bucket → AI read (degrades to PENDING_PARSE "needs manual entry"
 *     when AI is down) → a PROPOSED draft on alias.locationId, vendor matched from
 *     the AI name or, failing that, the sender's email/domain;
 *   • an HTML/text-only invoice email → rendered to PDF → same path;
 *   • the SAME FILE twice (sha256) in one tenant → no second draft
 *     (core.inbound_attachment_fingerprints UNIQUE is the guarantor; a REJECTED
 *     earlier draft releases its fingerprint so a resend works).
 *
 * Never posts to the GL or creates a payable: approving a draft goes through the
 * gated /api/bills/create (canon §3). Session-less: every write is org-stamped with
 * ctx.alias.orgId and company-stamped with ctx.alias.locationId.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  InboundEmail,
  InboundEmailAttachment,
  InboundHandlerContext,
  InboundHandlerResult,
  InboundPurposeHandler,
} from '@/lib/email/inbound-types';
import type { AttachmentLog } from '@/lib/email/inbound-log';
import { vendorForSender } from '@/lib/email/inbound-aliases';
import { looksLikeInvoiceBody } from '@/lib/email/inbound-rules';
import { bodyTextForRender, subjectStem } from '@/lib/email/inbound-eml';
import { sha256Hex } from '@/lib/email/inbound-normalize';
import { storeSourceDocument } from '@/lib/documents/store-source';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  AP_DOC_INTAKE_FEATURE,
  createInboundIntakeDraft,
  type DocIntelligenceProvider,
  type DocProviderDeps,
} from '@/lib/ap/doc-intelligence';

/** What the AP reader accepts (mirrors /api/bills/intake-queue). */
export const AP_ACCEPTED_MEDIA: ReadonlySet<string> = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const AP_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Inline images smaller than this are signature logos / tracking pixels, not bills. */
export const INLINE_IMAGE_IGNORE_BYTES = 30 * 1024;

export interface ApHandlerDeps {
  /** Store a file in the documents bucket. Default: storeSourceDocument. */
  storeDocument?: (args: {
    admin: SupabaseClient; orgId: string; base64: string; fileName: string; mimeType: string; notes: string;
  }) => Promise<{ documentId: string } | null>;
  /** AI deps; default from the gateway key (null → PENDING_PARSE). */
  docDeps?: DocProviderDeps | null;
  /** Explicit extraction engine (tests). */
  provider?: DocIntelligenceProvider;
  /** HTML-only body → PDF bytes. Default: @react-pdf render. */
  renderBodyPdf?: (email: InboundEmail) => Promise<Buffer | null>;
}

type Candidate = { att: InboundEmailAttachment; dedupeKey: string; rendered: boolean };

/** Sort each attachment into accept / skip, with the reason. Pure. */
export function classifyAttachments(email: InboundEmail): { candidates: Candidate[]; skipped: AttachmentLog[] } {
  const candidates: Candidate[] = [];
  const skipped: AttachmentLog[] = [];
  for (const att of email.attachments) {
    const base = { fileName: att.fileName, contentType: att.contentType, sizeBytes: att.sizeBytes, sha256: att.sha256 };
    if (att.contentType.startsWith('image/') && att.inline && att.sizeBytes < INLINE_IMAGE_IGNORE_BYTES) {
      skipped.push({ ...base, result: 'inline_ignored', reason: 'Inline image (logo or signature).' });
    } else if (!AP_ACCEPTED_MEDIA.has(att.contentType)) {
      skipped.push({ ...base, result: 'skipped_type', reason: `Not a PDF or image (${att.contentType}).` });
    } else if (att.sizeBytes > AP_MAX_ATTACHMENT_BYTES) {
      skipped.push({ ...base, result: 'too_large', reason: 'Larger than 15 MB.' });
    } else if (att.sizeBytes === 0) {
      skipped.push({ ...base, result: 'skipped_type', reason: 'Empty file.' });
    } else {
      candidates.push({ att, dedupeKey: att.sha256, rendered: false });
    }
  }
  return { candidates, skipped };
}

interface Fingerprint { id: string; intake_draft_id: string | null }

async function findFingerprint(admin: SupabaseClient, orgId: string, sha: string): Promise<Fingerprint | null> {
  const { data } = await admin.schema('core').from('inbound_attachment_fingerprints').select('id, intake_draft_id').eq('org_id', orgId).eq('sha256', sha).maybeSingle();
  return (data as Fingerprint | null) ?? null;
}

async function draftStatus(admin: SupabaseClient, orgId: string, draftId: string | null): Promise<string | null> {
  if (!draftId) return null;
  const { data } = await admin.from('ai_decisions').select('status').eq('org_id', orgId).eq('feature', AP_DOC_INTAKE_FEATURE).eq('id', draftId).maybeSingle();
  return (data as { status: string } | null)?.status ?? null;
}

const defaultStore: NonNullable<ApHandlerDeps['storeDocument']> = async (a) => {
  const stored = await storeSourceDocument({
    supabase: a.admin, orgId: a.orgId, userId: null, base64: a.base64, fileName: a.fileName, mimeType: a.mimeType,
    docType: 'BILL', entityType: 'bill', notes: a.notes,
  });
  return stored ? { documentId: stored.documentId } : null;
};

async function defaultRender(email: InboundEmail): Promise<Buffer | null> {
  const { renderEmailBodyPdf } = await import('@/lib/email/inbound-body-pdf');
  return renderEmailBodyPdf(email);
}

export function makeApHandler(deps: ApHandlerDeps = {}): InboundPurposeHandler {
  return async (email: InboundEmail, ctx: InboundHandlerContext): Promise<InboundHandlerResult> => {
    const { admin, alias } = ctx;
    const store = deps.storeDocument ?? defaultStore;
    const { candidates, skipped } = classifyAttachments(email);
    const logs: AttachmentLog[] = [...skipped];

    // HTML / text-only invoice email → render the body to a PDF and read that.
    if (candidates.length === 0 && looksLikeInvoiceBody(email)) {
      try {
        const pdf = await (deps.renderBodyPdf ?? defaultRender)(email);
        if (pdf && pdf.length > 0) {
          const bodyKey = sha256Hex(`body:${email.from.address}\n${bodyTextForRender(email)}`);
          candidates.push({
            att: {
              fileName: `${subjectStem(email)} (email body).pdf`, contentType: 'application/pdf', base64: pdf.toString('base64'),
              sizeBytes: pdf.length, sha256: bodyKey, contentId: null, inline: false,
            },
            dedupeKey: bodyKey,
            rendered: true,
          });
        }
      } catch (e) {
        logs.push({ fileName: 'email body', contentType: 'text/html', sizeBytes: 0, sha256: '0'.repeat(64), result: 'failed', reason: `Could not render the email body (${e instanceof Error ? e.message : 'error'}).` });
      }
    }

    if (candidates.length === 0) {
      return {
        outcome: 'no_attachment',
        detail: skipped.length
          ? `No PDF or image to read (${skipped.length} other file${skipped.length === 1 ? '' : 's'} skipped). The email is kept.`
          : 'No invoice attached and the email body does not look like an invoice. The email is kept.',
        linked: { documentIds: ctx.emailDocumentId ? [ctx.emailDocumentId] : [] },
      };
    }

    // A forged From must never pick the vendor: only a provider-verified sender is matched.
    const senderVerified = email.auth?.verified === true;
    const senderVendor = senderVerified ? await vendorForSender(admin, alias.orgId, email.from.address).catch(() => null) : null;
    const docDeps: DocProviderDeps | null =
      deps.docDeps !== undefined ? deps.docDeps : (() => {
        const key = getAnthropicApiKey();
        return key ? { supabase: admin, anthropicApiKey: key } : null;
      })();

    const draftIds: string[] = [];
    const documentIds: string[] = [];
    let duplicates = 0;
    let pending = 0;
    let failed = 0;

    for (const c of candidates) {
      const { att } = c;
      const base = { fileName: att.fileName, contentType: att.contentType, sizeBytes: att.sizeBytes, sha256: c.dedupeKey };

      // 1. Same file already drafted in this tenant?
      const existing = await findFingerprint(admin, alias.orgId, c.dedupeKey);
      if (existing) {
        const status = await draftStatus(admin, alias.orgId, existing.intake_draft_id);
        if (status !== 'REJECTED') {
          duplicates++;
          logs.push({ ...base, result: 'duplicate', reason: 'This exact file was already received — no second draft.', duplicateOfDraftId: existing.intake_draft_id });
          continue;
        }
      }

      try {
        // 2. Keep the file (never lost, even if the read fails).
        const stored = await store({
          admin, orgId: alias.orgId, base64: att.base64, fileName: att.fileName, mimeType: att.contentType,
          notes: `Received by email from ${email.from.address} at ${alias.address}${email.subject ? ` — “${email.subject}”` : ''}`,
        });
        if (stored) documentIds.push(stored.documentId);

        // 3. The draft bill on THIS company.
        const res = await createInboundIntakeDraft(
          admin,
          docDeps,
          {
            orgId: alias.orgId, userId: null, base64: att.base64, mediaType: att.contentType, fileName: att.fileName,
            locationId: alias.locationId, sourceDocumentId: stored?.documentId ?? null, senderVendor,
            inbound: {
              from: email.from.address, fromName: email.from.name, subject: email.subject, receivedAt: email.receivedAt,
              messageId: email.providerMessageId, toAddress: alias.address, messageLogId: ctx.messageLogId,
              emailDocumentId: ctx.emailDocumentId ?? null,
              senderVerified,
              senderAuth: email.auth?.summary ?? null,
            },
          },
          deps.provider ? { provider: deps.provider } : {},
        );
        if (!res.ok) {
          failed++;
          logs.push({ ...base, result: 'failed', reason: res.error, documentId: stored?.documentId });
          continue;
        }

        // 4. Fingerprint — the DB decides a race between two deliveries of the same file.
        let raced = false;
        if (existing) {
          await admin.schema('core').from('inbound_attachment_fingerprints')
            .update({ intake_draft_id: res.draftId, document_id: stored?.documentId ?? null, inbound_message_id: ctx.messageLogId, location_id: alias.locationId, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        } else {
          const { error } = await admin.schema('core').from('inbound_attachment_fingerprints').insert({
            org_id: alias.orgId, location_id: alias.locationId, sha256: c.dedupeKey, file_name: att.fileName.slice(0, 200),
            size_bytes: att.sizeBytes, inbound_message_id: ctx.messageLogId, intake_draft_id: res.draftId, document_id: stored?.documentId ?? null,
          });
          raced = Boolean(error && (error.code === '23505' || /duplicate key|unique/i.test(error.message)));
          if (error && !raced) console.error('[inbound-email/ap] fingerprint insert failed (non-fatal):', error.message);
        }
        if (raced) {
          // ai_decisions is member SELECT-only (172): the session-less handler holds the service role.
          await serviceWriter(admin).from('ai_decisions')
            .update({ status: 'REJECTED', disposition_at: new Date().toISOString(), disposition_note: 'Duplicate: the same file arrived twice at the same moment.' })
            .eq('org_id', alias.orgId).eq('feature', AP_DOC_INTAKE_FEATURE).eq('id', res.draftId);
          duplicates++;
          logs.push({ ...base, result: 'duplicate', reason: 'The same file arrived twice at the same moment.', documentId: stored?.documentId });
          continue;
        }

        draftIds.push(res.draftId);
        if (res.parseState === 'PENDING_PARSE') pending++;
        logs.push({ ...base, result: 'drafted', draftId: res.draftId, documentId: stored?.documentId, parseState: res.parseState });
      } catch (e) {
        failed++;
        logs.push({ ...base, result: 'failed', reason: e instanceof Error ? e.message : 'Unexpected error.' });
      }
    }

    const bits: string[] = [];
    if (draftIds.length) bits.push(`${draftIds.length} draft bill${draftIds.length === 1 ? '' : 's'} created`);
    if (pending) bits.push(`${pending} need${pending === 1 ? 's' : ''} manual entry (AI could not read ${pending === 1 ? 'it' : 'them'})`);
    if (senderVendor && draftIds.length) bits.push(`vendor suggested from the sender: ${senderVendor.name}`);
    if (!senderVerified && draftIds.length) bits.push('sender not verified — check the vendor before approving');
    if (duplicates) bits.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
    if (failed) bits.push(`${failed} failed`);
    const skippedOther = logs.filter((l) => l.result === 'skipped_type' || l.result === 'too_large').length;
    if (skippedOther) bits.push(`${skippedOther} other file${skippedOther === 1 ? '' : 's'} skipped`);
    const detail = `${bits.join(' · ')}.`.replace(/^./, (ch) => ch.toUpperCase());

    const allDocs = [...(ctx.emailDocumentId ? [ctx.emailDocumentId] : []), ...documentIds];
    if (draftIds.length) return { outcome: 'bill_drafted', detail, linked: { intakeDraftIds: draftIds, documentIds: allDocs }, attachments: logs };
    if (duplicates && !failed) return { outcome: 'ignored_duplicate', detail, linked: { documentIds: allDocs }, attachments: logs };
    return { outcome: 'failed', detail, linked: { documentIds: allDocs }, attachments: logs };
  };
}

/** The production AP handler (gateway key, documents bucket, @react-pdf). */
export const handleInboundApEmail: InboundPurposeHandler = makeApHandler();
