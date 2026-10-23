/**
 * Client-side shapes for the email-inbox screens — mirrors of the JSON returned by
 * /api/inbound-email and /api/inbound-email/messages. Kept separate from lib/email/*
 * so 'use client' modules never import server code.
 */

export type InboxPurpose = 'ap' | 'receipts';
export type SenderRule = 'any' | 'known_vendors' | 'listed_domains';
export type InboxOutcome =
  | 'processing' | 'bill_drafted' | 'receipt_attached' | 'ignored_duplicate' | 'rejected_sender' | 'rejected_spam'
  | 'alias_inactive' | 'no_attachment' | 'forwarding_confirmation' | 'not_handled' | 'failed';

export interface InboxAlias {
  id: string;
  locationId: string;
  companyName: string;
  companyActive: boolean;
  purpose: InboxPurpose;
  address: string;
  isActive: boolean;
  senderRule: SenderRule;
  allowedDomains: string[];
  allowedSenders: string[];
  lastReceivedAt: string | null;
  messagesCount: number;
  forwardingConfirmation: {
    requestedBy: string | null;
    code: string | null;
    url: string | null;
    receivedAt: string | null;
    authenticated: boolean;
  } | null;
}

export interface InboxStatus {
  state: 'active' | 'not_configured';
  provider: 'postmark' | 'sendgrid' | 'generic';
  providerLabel: string;
  domain: string;
  domainConfigured: boolean;
  credentialConfigured: boolean;
  mxHost: string | null;
  missing: string[];
}

export interface InboxOverview {
  status: InboxStatus;
  mx: { state: 'ok' | 'missing' | 'wrong' | 'unknown'; hosts: string[] } | null;
  aliases: InboxAlias[];
  stats: { last7d: number; drafted7d: number; problems7d: number; lastReceivedAt: string | null };
  can: { manage: boolean };
}

export interface InboxAttachmentLog {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  result: string;
  reason?: string;
  draftId?: string;
  documentId?: string;
  duplicateOfDraftId?: string | null;
  parseState?: 'PARSED' | 'PENDING_PARSE';
}

export interface InboxMessage {
  id: string;
  locationId: string | null;
  aliasId: string | null;
  purpose: InboxPurpose;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  receivedAt: string;
  attachmentsCount: number;
  acceptedCount: number;
  outcome: InboxOutcome;
  detail: string | null;
  attachments: InboxAttachmentLog[];
  intakeDraftIds: string[];
  documentIds: string[];
  emailDocumentId: string | null;
  duplicateDeliveries: number;
  /** false = the provider could not verify the From domain (SPF/DKIM/DMARC). */
  senderVerified?: boolean;
  senderAuth?: string | null;
}

export interface InboxMessagesResponse {
  messages: InboxMessage[];
  total: number;
  page: number;
  perPage: number;
}

export const PURPOSE_LABEL: Record<InboxPurpose, string> = { ap: 'Bills (AP)', receipts: 'Receipts' };

export const RULE_LABEL: Record<SenderRule, string> = {
  any: 'Anyone',
  known_vendors: 'Known vendors + team',
  listed_domains: 'Listed domains + team',
};

export const OUTCOME_LABEL: Record<InboxOutcome, string> = {
  processing: 'Processing',
  bill_drafted: 'Draft bill created',
  receipt_attached: 'Receipt attached',
  ignored_duplicate: 'Duplicate — ignored',
  rejected_sender: 'Sender not allowed',
  rejected_spam: 'Spam — refused',
  alias_inactive: 'Address switched off',
  no_attachment: 'Nothing to read',
  forwarding_confirmation: 'Forwarding confirmation',
  not_handled: 'Kept, not processed',
  failed: 'Failed',
};

export type OutcomeTone = 'pos' | 'warn' | 'neg' | 'default' | 'ai';
export const OUTCOME_TONE: Record<InboxOutcome, OutcomeTone> = {
  processing: 'default',
  bill_drafted: 'pos',
  receipt_attached: 'pos',
  ignored_duplicate: 'default',
  rejected_sender: 'warn',
  rejected_spam: 'warn',
  alias_inactive: 'warn',
  no_attachment: 'warn',
  forwarding_confirmation: 'ai',
  not_handled: 'warn',
  failed: 'neg',
};

/** "3 minutes ago" / "Oct 21, 2:04 PM". */
export function whenText(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso);
  const diff = Date.now() - t.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Open a stored document (original email / attachment) via a short-lived signed URL. */
export async function openDocument(documentId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/documents/${documentId}/signed-url`);
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) return data.error ?? 'Could not open the document.';
    window.open(data.url, '_blank', 'noopener,noreferrer');
    return null;
  } catch {
    return 'Network error opening the document.';
  }
}
