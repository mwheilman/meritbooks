/**
 * core.inbound_messages — the per-(message, address) log. CLAIM-BEFORE-PROCESS:
 * the row is inserted as 'processing' first, and the UNIQUE (org, to_address,
 * provider, provider_message_id) index turns a provider redelivery into a no-op:
 *
 *   claimed    first delivery → process it
 *   duplicate  already processed → bump duplicate_deliveries, ACK
 *   in_flight  another delivery is processing right now (< 10 min) → ACK
 *   retry      the earlier attempt FAILED (or stalled > 10 min) → process again
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InboundAttachmentLog, InboundEmail, InboundOutcome } from './inbound-types';
import type { RoutedAddress } from './inbound-aliases';

export const STALE_PROCESSING_MS = 10 * 60 * 1000;

export type ClaimResult =
  | { state: 'claimed' | 'retry'; id: string }
  | { state: 'duplicate' | 'in_flight'; id: string; outcome: InboundOutcome };

/** Per-attachment result recorded on the log row. */
export type AttachmentLog = InboundAttachmentLog;

interface LogRowLite {
  id: string;
  outcome: InboundOutcome;
  processing_started_at: string;
  duplicate_deliveries: number;
}

function isUniqueViolation(err: { code?: string; message?: string } | null): boolean {
  return Boolean(err && (err.code === '23505' || /duplicate key|unique/i.test(err.message ?? '')));
}

export async function claimDelivery(
  admin: SupabaseClient,
  email: InboundEmail,
  routed: RoutedAddress,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const toAddress = routed.resolved.address.toLowerCase();
  const providerMessageId = email.providerMessageId ?? 'unknown';
  const row = {
    org_id: routed.resolved.orgId,
    location_id: routed.resolved.locationId,
    alias_id: routed.resolved.aliasId,
    purpose: routed.resolved.purpose,
    provider: email.provider,
    provider_message_id: providerMessageId,
    message_id_header: email.messageIdHeader,
    from_address: email.from.address.slice(0, 320),
    from_name: email.from.name?.slice(0, 200) ?? null,
    to_address: toAddress,
    subject: email.subject?.slice(0, 998) ?? null,
    received_at: email.receivedAt,
    attachments_count: email.attachments.length,
    outcome: 'processing',
    spam_score: email.spam?.score ?? null,
    sender_verified: email.auth?.verified === true,
    sender_auth: (email.auth?.summary ?? 'Sender not verified (no authentication evidence)').slice(0, 300),
    processing_started_at: now.toISOString(),
  };
  const { data, error } = await admin.schema('core').from('inbound_messages').insert(row).select('id').single();
  if (!error && data) return { state: 'claimed', id: (data as { id: string }).id };
  if (!isUniqueViolation(error)) throw new Error(`Could not log the inbound message: ${error?.message ?? 'unknown'}`);

  const { data: existing } = await admin
    .schema('core').from('inbound_messages')
    .select('id, outcome, processing_started_at, duplicate_deliveries')
    .eq('org_id', routed.resolved.orgId)
    .eq('to_address', toAddress)
    .eq('provider', email.provider)
    .eq('provider_message_id', providerMessageId)
    .maybeSingle();
  const ex = existing as LogRowLite | null;
  if (!ex) throw new Error('Inbound message log conflict could not be resolved.');

  const stale = ex.outcome === 'processing' && now.getTime() - new Date(ex.processing_started_at).getTime() > STALE_PROCESSING_MS;
  if (ex.outcome === 'failed' || stale) {
    const { data: re } = await admin
      .schema('core').from('inbound_messages')
      .update({ outcome: 'processing', processing_started_at: now.toISOString(), detail: 'Retrying after an earlier failure.' })
      .eq('id', ex.id)
      .eq('outcome', ex.outcome)
      .select('id');
    // someone else re-claimed it between our read and write → treat as in flight
    if (((re ?? []) as unknown[]).length === 0) return { state: 'in_flight', id: ex.id, outcome: 'processing' };
    return { state: 'retry', id: ex.id };
  }
  if (ex.outcome === 'processing') return { state: 'in_flight', id: ex.id, outcome: ex.outcome };
  await admin
    .schema('core').from('inbound_messages')
    .update({ duplicate_deliveries: (ex.duplicate_deliveries ?? 0) + 1, last_duplicate_at: now.toISOString() })
    .eq('id', ex.id);
  return { state: 'duplicate', id: ex.id, outcome: ex.outcome };
}

export interface FinalizeArgs {
  outcome: Exclude<InboundOutcome, 'processing'>;
  detail: string;
  attachments?: AttachmentLog[];
  acceptedCount?: number;
  intakeDraftIds?: string[];
  billIds?: string[];
  documentIds?: string[];
  receiptIds?: string[];
  emailDocumentId?: string | null;
}

export async function finalizeDelivery(admin: SupabaseClient, id: string, f: FinalizeArgs, now: Date = new Date()): Promise<void> {
  const { error } = await admin
    .schema('core').from('inbound_messages')
    .update({
      outcome: f.outcome,
      detail: f.detail.slice(0, 2000),
      attachments: f.attachments ?? [],
      accepted_count: f.acceptedCount ?? 0,
      intake_draft_ids: f.intakeDraftIds ?? [],
      bill_ids: f.billIds ?? [],
      document_ids: f.documentIds ?? [],
      receipt_ids: f.receiptIds ?? [],
      email_document_id: f.emailDocumentId ?? null,
      processed_at: now.toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`Could not record the inbound outcome: ${error.message}`);
}

/** messages_count + last_received_at on the alias (best-effort). */
export async function touchAlias(admin: SupabaseClient, aliasId: string | null, now: Date = new Date()): Promise<void> {
  if (!aliasId) return;
  try {
    const { data } = await admin.schema('core').from('inbound_aliases').select('messages_count').eq('id', aliasId).maybeSingle();
    const n = (data as { messages_count: number } | null)?.messages_count ?? 0;
    await admin.schema('core').from('inbound_aliases').update({ messages_count: n + 1, last_received_at: now.toISOString() }).eq('id', aliasId);
  } catch {
    /* counters are cosmetic */
  }
}

// ── reading the log (authenticated routes: the caller's RLS client) ─────────

export interface InboundMessageView {
  id: string;
  locationId: string | null;
  aliasId: string | null;
  purpose: 'ap' | 'receipts';
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  receivedAt: string;
  attachmentsCount: number;
  acceptedCount: number;
  outcome: InboundOutcome;
  detail: string | null;
  attachments: AttachmentLog[];
  intakeDraftIds: string[];
  billIds: string[];
  documentIds: string[];
  receiptIds: string[];
  emailDocumentId: string | null;
  duplicateDeliveries: number;
  /** The provider verified the From domain (SPF/DKIM/DMARC). false → "Sender not verified". */
  senderVerified: boolean;
  senderAuth: string | null;
}

interface MessageRow {
  id: string; location_id: string | null; alias_id: string | null; purpose: 'ap' | 'receipts'; from_address: string;
  from_name: string | null; to_address: string; subject: string | null; received_at: string; attachments_count: number;
  accepted_count: number; outcome: InboundOutcome; detail: string | null; attachments: AttachmentLog[] | null;
  intake_draft_ids: string[] | null; bill_ids: string[] | null; document_ids: string[] | null; receipt_ids: string[] | null;
  email_document_id: string | null; duplicate_deliveries: number; sender_verified: boolean | null; sender_auth: string | null;
}

const MESSAGE_COLS =
  'id, location_id, alias_id, purpose, from_address, from_name, to_address, subject, received_at, attachments_count, accepted_count, ' +
  'outcome, detail, attachments, intake_draft_ids, bill_ids, document_ids, receipt_ids, email_document_id, duplicate_deliveries, ' +
  'sender_verified, sender_auth';

function toView(r: MessageRow): InboundMessageView {
  return {
    id: r.id, locationId: r.location_id, aliasId: r.alias_id, purpose: r.purpose, fromAddress: r.from_address, fromName: r.from_name,
    toAddress: r.to_address, subject: r.subject, receivedAt: r.received_at, attachmentsCount: r.attachments_count,
    acceptedCount: r.accepted_count, outcome: r.outcome, detail: r.detail, attachments: Array.isArray(r.attachments) ? r.attachments : [],
    intakeDraftIds: r.intake_draft_ids ?? [], billIds: r.bill_ids ?? [], documentIds: r.document_ids ?? [], receiptIds: r.receipt_ids ?? [],
    emailDocumentId: r.email_document_id, duplicateDeliveries: r.duplicate_deliveries ?? 0,
    senderVerified: r.sender_verified === true, senderAuth: r.sender_auth ?? null,
  };
}

export interface ListMessagesArgs {
  orgId: string;
  locationId?: string | null;
  outcome?: InboundOutcome | 'problems' | null;
  purpose?: 'ap' | 'receipts' | null;
  page?: number;
  perPage?: number;
  /**
   * Messages with no company (location_id null) are visible to org-level admins only
   * (settings_system:edit). Default false: they are filtered out.
   */
  includeNoCompany?: boolean;
}

const PROBLEM_OUTCOMES: InboundOutcome[] = ['rejected_sender', 'rejected_spam', 'alias_inactive', 'no_attachment', 'not_handled', 'failed'];

export async function listMessages(
  db: SupabaseClient,
  args: ListMessagesArgs,
): Promise<{ messages: InboundMessageView[]; total: number; page: number; perPage: number }> {
  const perPage = Math.min(Math.max(args.perPage ?? 25, 1), 100);
  const page = Math.max(args.page ?? 1, 1);
  let q = db.schema('core').from('inbound_messages').select(MESSAGE_COLS, { count: 'exact' }).eq('org_id', args.orgId);
  if (args.locationId) q = q.eq('location_id', args.locationId);
  else if (!args.includeNoCompany) q = q.not('location_id', 'is', null);
  if (args.purpose) q = q.eq('purpose', args.purpose);
  if (args.outcome === 'problems') q = q.in('outcome', PROBLEM_OUTCOMES);
  else if (args.outcome) q = q.eq('outcome', args.outcome);
  const from = (page - 1) * perPage;
  const { data, error, count } = await q
    .order('received_at', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, from + perPage - 1);
  if (error) throw new Error(error.message);
  return { messages: ((data ?? []) as unknown as MessageRow[]).map(toView), total: count ?? 0, page, perPage };
}

/** Counts for the inbox card: last 7 days by outcome, and the last message time. */
export async function messageStats(
  db: SupabaseClient,
  orgId: string,
  locationId: string | null,
  now: Date = new Date(),
  opts: { includeNoCompany?: boolean } = {},
): Promise<{ last7d: number; drafted7d: number; problems7d: number; lastReceivedAt: string | null }> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  let q = db.schema('core').from('inbound_messages').select('outcome, received_at').eq('org_id', orgId).gte('received_at', since);
  if (locationId) q = q.eq('location_id', locationId);
  else if (!opts.includeNoCompany) q = q.not('location_id', 'is', null);
  const { data } = await q.order('received_at', { ascending: false }).limit(1000);
  const rows = (data ?? []) as Array<{ outcome: InboundOutcome; received_at: string }>;
  let lq = db.schema('core').from('inbound_messages').select('received_at').eq('org_id', orgId);
  if (locationId) lq = lq.eq('location_id', locationId);
  else if (!opts.includeNoCompany) lq = lq.not('location_id', 'is', null);
  const { data: last } = await lq.order('received_at', { ascending: false }).limit(1);
  return {
    last7d: rows.length,
    drafted7d: rows.filter((r) => r.outcome === 'bill_drafted' || r.outcome === 'receipt_attached').length,
    problems7d: rows.filter((r) => PROBLEM_OUTCOMES.includes(r.outcome)).length,
    lastReceivedAt: ((last ?? []) as Array<{ received_at: string }>)[0]?.received_at ?? null,
  };
}
