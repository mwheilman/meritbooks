/**
 * INBOUND EMAIL — the provider-agnostic, typed shape of one received email.
 *
 * Every provider adapter (Postmark inbound JSON, SendGrid Inbound Parse / generic
 * JSON) normalizes its payload into `InboundEmail`. Everything downstream — alias
 * routing, the AP bill intake, the receipts handler (slice 2B,
 * `handleInboundReceiptEmail(parsed, ctx)` in lib/receipts/inbound.ts) — consumes
 * ONLY this interface, never a raw provider body. Adding a provider = one adapter.
 *
 * This file is intentionally dependency-free (types only) so any module can
 * import it without pulling in Supabase, crypto, or Next.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Which adapter produced the message. */
export type InboundProviderId = 'postmark' | 'sendgrid' | 'generic';

/** What an inbound alias is for. One alias = one company + one purpose. */
export type InboundAliasPurpose = 'ap' | 'receipts';

/** A parsed email address. `address` is always trimmed + lowercased. */
export interface InboundAddress {
  address: string;
  name: string | null;
}

export interface InboundEmailAttachment {
  fileName: string;
  /** MIME type as declared by the sender (lowercased, parameters stripped). */
  contentType: string;
  /** Raw bytes, base64 (no data: prefix, no whitespace). */
  base64: string;
  /** Decoded byte length. */
  sizeBytes: number;
  /** Lowercase hex sha256 of the decoded bytes — the cross-message dedupe key. */
  sha256: string;
  /** Content-ID for inline parts (e.g. signature logos); null for real attachments. */
  contentId: string | null;
  /** True when the part is inline (cid-referenced) rather than attached. */
  inline: boolean;
}

export interface InboundEmail {
  provider: InboundProviderId;
  /**
   * The provider's unique id for this delivery (Postmark `MessageID`), or the
   * RFC 5322 Message-ID header when the provider has none. The idempotency key:
   * a redelivery of the same id is logged once and ignored.
   */
  providerMessageId: string | null;
  /** RFC 5322 Message-ID header, if present. */
  messageIdHeader: string | null;
  from: InboundAddress;
  /** Visible To recipients. */
  to: InboundAddress[];
  cc: InboundAddress[];
  /**
   * Every address this message was delivered to (envelope recipients +
   * OriginalRecipient + To + Cc), normalized + de-duplicated. Alias routing
   * looks here — a forwarded mail often has the alias ONLY in the envelope.
   */
  recipients: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  /** ISO-8601; the provider's Date when parseable, else time of receipt. */
  receivedAt: string;
  /** Header name (lowercased) → value. Multi-valued headers keep the first. */
  headers: Record<string, string>;
  attachments: InboundEmailAttachment[];
  /** Provider spam verdict, when supplied (Postmark X-Spam-* headers). */
  spam: { score: number | null; flagged: boolean } | null;
  /**
   * The receiving provider's SPF / DKIM / DMARC verdict on the From address
   * (lib/email/inbound-sender-auth). Absent = unverified: the sender is treated as
   * unknown (no vendor match, no cardholder trust, no "known vendors" pass).
   */
  auth?: SenderAuthentication | null;
}

export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'unknown';

export interface SenderAuthentication {
  spf: AuthResult;
  /** The envelope (MAIL FROM) domain SPF was evaluated for. */
  spfDomain: string | null;
  dkim: AuthResult;
  /** Domains (d=) of DKIM signatures that PASSED. */
  dkimPassDomains: string[];
  dmarc: AuthResult;
  /** DMARC did not fail and the From domain is authenticated by DMARC / aligned DKIM / aligned SPF. */
  verified: boolean;
  source: 'authentication_results' | 'provider_headers' | 'provider_fields' | 'relay' | 'none';
  /** One line for the log / badge tooltip. */
  summary: string;
}

/** The alias an inbound message was routed through. */
export interface ResolvedInboundAlias {
  /** null = the legacy per-organization address (migration 135), routed to the org's default company. */
  aliasId: string | null;
  orgId: string;
  /** The company (core.locations.id) the alias belongs to. */
  locationId: string;
  purpose: InboundAliasPurpose;
  address: string;
}

/**
 * The context handed to a purpose handler (AP intake or receipts). Session-less:
 * `admin` is the service-role client — every write MUST be stamped with
 * `alias.orgId` (and `alias.locationId` where the table is company-scoped).
 */
export interface InboundHandlerContext {
  admin: SupabaseClient;
  alias: ResolvedInboundAlias;
  /** The inbound_messages log row for this delivery (to link outcomes back). */
  messageLogId: string | null;
  /** True when an Anthropic key is available; false → degrade to manual entry. */
  aiAvailable: boolean;
  /** The original email already kept as a document (.eml), when storage succeeded. */
  emailDocumentId?: string | null;
}

/**
 * Final disposition of one inbound message — mirrors the inbound_messages.outcome
 * CHECK (migration 183). 'processing' is the transient claim state; a handler
 * never returns it.
 */
export type InboundOutcome =
  | 'processing'
  | 'bill_drafted'
  | 'receipt_attached'
  | 'ignored_duplicate'
  | 'rejected_sender'
  | 'rejected_spam'
  | 'alias_inactive'
  | 'no_attachment'
  | 'forwarding_confirmation'
  | 'not_handled'
  | 'failed';

/** Outcomes a purpose handler may return. */
export type InboundHandlerOutcome = Exclude<InboundOutcome, 'processing'>;

/** Per-attachment result recorded on the inbound log row (and shown in the UI). */
export interface InboundAttachmentLog {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  result: 'drafted' | 'duplicate' | 'skipped_type' | 'too_large' | 'inline_ignored' | 'failed' | 'stored' | 'attached' | 'not_handled';
  reason?: string;
  draftId?: string;
  documentId?: string;
  receiptId?: string;
  duplicateOfDraftId?: string | null;
  parseState?: 'PARSED' | 'PENDING_PARSE';
}

/** What a purpose handler returns. `linked` ids are stored on the log row. */
export interface InboundHandlerResult {
  outcome: InboundHandlerOutcome;
  /** Human-readable one-liner shown in the inbound log. */
  detail: string;
  /** Optional per-attachment detail for the log. */
  attachments?: InboundAttachmentLog[];
  linked?: {
    billIds?: string[];
    intakeDraftIds?: string[];
    documentIds?: string[];
    receiptIds?: string[];
  };
}

/** Signature of a purpose handler (2B's receipts handler conforms to this). */
export type InboundPurposeHandler = (
  parsed: InboundEmail,
  ctx: InboundHandlerContext,
) => Promise<InboundHandlerResult>;
