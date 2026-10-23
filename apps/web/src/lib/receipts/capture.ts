/**
 * Capture one receipt — the single pipeline behind every path (FPB-workforce-app §15.2):
 * Merit Workforce (signed in or magic link), forwarded email, desk drag-drop.
 *
 *   1. dedupe     the same file (sha256) already captured for this tenant → return it
 *   2. charge     (optional) the person picked the charge — it must be in the same
 *                 company, have no receipt yet, and (holder paths) belong to that holder
 *   3. store      bytes → private `documents` bucket, metadata row linked to the receipt
 *   4. record     public.receipts row (service role; the table is member-locked, 172)
 *   5. read       AI (Core gateway, RECEIPT_EXTRACT) → else deterministic rules
 *   6. match      picked charge → linked (flags if the amount differs), else auto-match
 *                 (match.ts bands); a match closes the chase for that charge
 *
 * The caller has ALREADY authorized the action and resolved org / company / holder from a
 * trusted source (the session, the magic-link row, the inbound alias). Nothing here posts
 * to the GL: a card charge books through the card feed; the receipt is its evidence.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { storeSourceDocument, linkSourceDocument } from '@/lib/documents/store-source';
import { extractReceiptWithAi, htmlToText, parseReceiptText, type ReceiptFacts } from './extract';
import { attachFlags, autoMatchReceipt, linkReceiptToCharge, MatchError, type AutoMatchOutcome } from './match';
import { loadReceiptPolicyContext, memoRequired, mergeReceiptPolicy } from './policy';
import type { CardAssignmentRow, ReceiptSource } from './types';

export const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;
export const RECEIPT_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'text/html', 'text/plain'] as const;
const EXT_FOR: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/heic': ['heic'],
  'image/heif': ['heif', 'heic'],
  'text/html': ['html', 'htm'],
  'text/plain': ['txt'],
};
const AI_READABLE = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export class CaptureError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'CaptureError';
  }
}

/** File guard (type + extension + size). Pure. */
export function checkReceiptFile(f: { fileName: string; mimeType: string; sizeBytes: number }): string | null {
  if (!f.fileName?.trim()) return 'A file is required.';
  if (!(f.sizeBytes > 0)) return 'The file is empty.';
  if (f.sizeBytes > RECEIPT_MAX_BYTES) return 'The file is too large (15 MB at most).';
  const mime = f.mimeType.toLowerCase().split(';')[0].trim();
  const ext = f.fileName.toLowerCase().split('.').pop() ?? '';
  if (!(RECEIPT_ALLOWED_MIME as readonly string[]).includes(mime)) return 'Upload a photo (JPG, PNG, HEIC) or a PDF.';
  if (!EXT_FOR[mime]?.includes(ext)) return 'The file name does not match its type. Upload a photo (JPG, PNG, HEIC) or a PDF.';
  return null;
}

const startsWith = (b: Uint8Array, sig: ReadonlyArray<number>, at = 0): boolean => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString('latin1');

/**
 * Do the bytes really hold the declared type? (A renamed .exe / .html is not a JPG.) Pure.
 * Returns an error sentence or null.
 */
export function checkReceiptBytes(mimeType: string, bytes: Uint8Array): string | null {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  const bad = 'The file content does not match its type. Upload a photo (JPG, PNG, HEIC) or a PDF.';
  switch (mime) {
    case 'application/pdf': {
      // %PDF within the first KB (some generators prepend junk)
      const head = ascii(bytes, 0, Math.min(bytes.length, 1024));
      return head.includes('%PDF-') ? null : bad;
    }
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? null : bad;
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : bad;
    case 'image/gif':
      return ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a' ? null : bad;
    case 'image/webp':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP' ? null : bad;
    case 'image/heic':
    case 'image/heif': {
      if (ascii(bytes, 4, 8) !== 'ftyp') return bad;
      return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|heif|avif)$/.test(ascii(bytes, 8, 12)) ? null : bad;
    }
    case 'text/plain':
    case 'text/html': {
      const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
      return sample.includes(0) ? bad : null; // binary masquerading as text
    }
    default:
      return bad;
  }
}

export interface CaptureFile {
  base64: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type StoreFile = (args: { db: SupabaseClient; orgId: string; userId: string | null; file: CaptureFile; notes: string }) => Promise<{ documentId: string } | null>;

const defaultStoreFile: StoreFile = async ({ db, orgId, userId, file, notes }) => {
  const s = await storeSourceDocument({
    supabase: db,
    orgId,
    userId,
    base64: file.base64,
    fileName: file.fileName,
    mimeType: file.mimeType,
    docType: 'RECEIPT',
    entityType: 'receipt',
    notes,
  });
  return s ? { documentId: s.documentId } : null;
};

export interface CaptureDeps {
  /** Service-role client; every write pins org_id. */
  db: SupabaseClient;
  now: () => Date;
  /** Anthropic key for the gateway, or null (AI off → rules). */
  anthropicApiKey: string | null;
  storeFile?: StoreFile;
  /** Test seam: replace the AI read. */
  readWithAi?: typeof extractReceiptWithAi;
}

export interface CaptureInput {
  orgId: string;
  locationId: string;
  source: ReceiptSource;
  file: CaptureFile;
  /** The cardholder this receipt is from (holder paths, matched email sender). */
  holder?: CardAssignmentRow | null;
  /** The charge the person picked ("Receipts needed" → this one). */
  chargeId?: string | null;
  /** Holder paths: refuse a picked charge that isn't this holder's. */
  restrictToHolder?: boolean;
  memo?: string | null;
  jobId?: string | null;
  /** Typed facts (desk / Workforce form); win over the reader where present. */
  typed?: { merchant?: string | null; amountCents?: number | null; date?: string | null };
  /** Extra text for the rules reader (email subject + body). */
  hintText?: string | null;
  hintMerchant?: string | null;
  /** Audit identity: a Clerk user id, `cardholder:<assignment>` or `email:<address>`. */
  submittedBy: string;
  inboundMessageId?: string | null;
}

export interface CaptureResult {
  receiptId: string;
  duplicate: boolean;
  facts: ReceiptFacts;
  match: AutoMatchOutcome | { kind: 'attached'; transactionId: string; flags: string[] };
  chaseCount: number;
}

export function sha256Base64(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

/** Merge reader facts with what the person typed (typed wins). Pure. */
export function mergeFacts(read: ReceiptFacts, typed: CaptureInput['typed']): ReceiptFacts {
  if (!typed) return read;
  return {
    ...read,
    merchant: typed.merchant?.trim() || read.merchant,
    totalCents: typed.amountCents != null && typed.amountCents > 0 ? typed.amountCents : read.totalCents,
    date: typed.date && /^\d{4}-\d{2}-\d{2}$/.test(typed.date) ? typed.date : read.date,
  };
}

async function verifyCharge(db: SupabaseClient, input: CaptureInput): Promise<{ id: string; amountCents: number; date: string; description: string }> {
  const { data, error } = await serviceWriter(db)
    .from('bank_transactions')
    .select('id, location_id, amount_cents, transaction_date, description, matched_receipt_id')
    .eq('org_id', input.orgId)
    .eq('id', input.chargeId as string)
    .maybeSingle();
  if (error) throw new CaptureError(`Could not read the charge: ${error.message}`, 500);
  const t = data as { id: string; location_id: string; amount_cents: number; transaction_date: string; description: string; matched_receipt_id: string | null } | null;
  if (!t || t.location_id !== input.locationId) throw new CaptureError('That charge was not found.', 404);
  if (input.restrictToHolder) {
    const { data: st } = await db.from('receipt_charge_states').select('card_assignment_id').eq('org_id', input.orgId).eq('bank_transaction_id', t.id).maybeSingle();
    const holderId = (st as { card_assignment_id: string | null } | null)?.card_assignment_id ?? null;
    if (!input.holder || holderId !== input.holder.id) throw new CaptureError('That charge was not found.', 404);
  }
  if (t.matched_receipt_id) throw new CaptureError('That charge already has a receipt.', 409);
  return { id: t.id, amountCents: Math.abs(Number(t.amount_cents)), date: t.transaction_date, description: t.description };
}

async function readReceipt(deps: CaptureDeps, input: CaptureInput): Promise<ReceiptFacts> {
  const mime = input.file.mimeType.toLowerCase().split(';')[0].trim();
  const isText = mime === 'text/html' || mime === 'text/plain';
  const text = isText ? (mime === 'text/html' ? htmlToText(Buffer.from(input.file.base64, 'base64').toString('utf8')) : Buffer.from(input.file.base64, 'base64').toString('utf8')) : '';
  const hints = [input.hintText ?? '', text, input.file.fileName].filter(Boolean).join('\n');
  if (deps.anthropicApiKey && (isText || AI_READABLE.includes(mime))) {
    const reader = deps.readWithAi ?? extractReceiptWithAi;
    const res = await reader(
      { supabase: deps.db, anthropicApiKey: deps.anthropicApiKey },
      {
        orgId: input.orgId,
        userId: input.submittedBy.startsWith('user_') ? input.submittedBy : null,
        input: isText ? { kind: 'text', text: [input.hintText ?? '', text].join('\n') } : { kind: 'file', base64: input.file.base64, mediaType: mime },
      },
    );
    if (res.ok && res.facts.confidence > 0) return res.facts;
  }
  return parseReceiptText(hints, { merchant: input.hintMerchant ?? null });
}

/** An HTML receipt is stored as its readable text (text/plain), never as HTML. Pure. */
export function neutralizeHtml(file: CaptureFile): CaptureFile {
  const mime = file.mimeType.toLowerCase().split(';')[0].trim();
  if (mime !== 'text/html') return file;
  const text = htmlToText(Buffer.from(file.base64, 'base64').toString('utf8')) || '(empty)';
  const stem = file.fileName.replace(/\.(html?|htm)$/i, '') || 'e-receipt';
  return { base64: Buffer.from(text, 'utf8').toString('base64'), fileName: `${stem}.txt`, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(text, 'utf8') };
}

export async function captureReceipt(deps: CaptureDeps, input: CaptureInput): Promise<CaptureResult> {
  const db = deps.db;
  const now = deps.now();
  const fileErr = checkReceiptFile(input.file);
  if (fileErr) throw new CaptureError(fileErr);
  if (input.memo && input.memo.length > 1000) throw new CaptureError('Keep the note under 1,000 characters.');
  const bytesErr = checkReceiptBytes(input.file.mimeType, Buffer.from(input.file.base64, 'base64'));
  if (bytesErr) throw new CaptureError(bytesErr, 415);
  // Never keep active HTML: it would be served back to whoever opens the receipt.
  input = { ...input, file: neutralizeHtml(input.file) };

  // 1. dedupe
  const sha = sha256Base64(input.file.base64);
  const { data: dup } = await serviceWriter(db).from('receipts').select('id, bank_transaction_id, chase_reminder_count').eq('org_id', input.orgId).eq('content_sha256', sha).maybeSingle();
  if (dup) {
    const d = dup as { id: string; bank_transaction_id: string | null; chase_reminder_count: number };
    return {
      receiptId: d.id,
      duplicate: true,
      facts: { ...parseReceiptText('') },
      match: d.bank_transaction_id ? { kind: 'matched', transactionId: d.bank_transaction_id, score: 1 } : { kind: 'unmatched' },
      chaseCount: d.chase_reminder_count,
    };
  }

  // 2. charge (picked) + refs
  const charge = input.chargeId ? await verifyCharge(db, input) : null;
  if (input.jobId) {
    const { data: job } = await db.schema('core').from('jobs').select('id').eq('org_id', input.orgId).eq('location_id', input.locationId).eq('id', input.jobId).maybeSingle();
    if (!job) throw new CaptureError('That job was not found.', 404);
  }

  // 3. store the file (never lose the source)
  const stored = await (deps.storeFile ?? defaultStoreFile)({
    db,
    orgId: input.orgId,
    userId: input.submittedBy.startsWith('user_') ? input.submittedBy : null,
    file: input.file,
    notes: `Receipt · ${input.source === 'EMAIL' ? 'forwarded email' : input.source === 'MOBILE_CAPTURE' ? 'Merit Workforce' : 'desk upload'}${input.holder ? ` · ${input.holder.holder_name}` : ''}`,
  });
  if (!stored) throw new CaptureError('We could not store that file. Please try again in a moment.', 502);

  // 4. record
  const iso = now.toISOString();
  const { data: ins, error: insErr } = await serviceWriter(db)
    .from('receipts')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      source: input.source,
      submitted_by: null,
      submitted_by_user: input.submittedBy.slice(0, 200),
      submitted_at: iso,
      card_assignment_id: input.holder?.id ?? null,
      document_id: stored.documentId,
      memo: input.memo?.trim() || null,
      job_id: input.jobId ?? null,
      status: 'PENDING',
      match_status: 'unmatched',
      extraction_status: 'pending',
      content_sha256: sha,
      inbound_message_id: input.inboundMessageId ?? null,
    })
    .select('id')
    .single();
  if (insErr || !ins) {
    if (insErr && /duplicate|unique/i.test(insErr.message)) throw new CaptureError('This receipt was already uploaded.', 409);
    throw new CaptureError(`Could not save the receipt: ${insErr?.message ?? 'unknown error'}`, 500);
  }
  const receiptId = (ins as { id: string }).id;
  await linkSourceDocument(db, stored.documentId, 'receipt', receiptId);

  // 5. read
  let facts: ReceiptFacts;
  try {
    facts = mergeFacts(await readReceipt(deps, input), input.typed);
  } catch {
    facts = mergeFacts(parseReceiptText(input.hintText ?? '', { merchant: input.hintMerchant ?? null }), input.typed);
  }
  const ctx = await loadReceiptPolicyContext(db, input.orgId);
  const policy = mergeReceiptPolicy(ctx.rows, input.locationId);
  const flags: string[] = [];
  const amountForMemo = charge?.amountCents ?? facts.totalCents ?? 0;
  if (!input.memo?.trim() && memoRequired(policy, amountForMemo)) flags.push('memo_missing');
  await serviceWriter(db)
    .from('receipts')
    .update({
      vendor_name: facts.merchant,
      amount_cents: facts.totalCents,
      receipt_date: facts.date,
      ai_confidence: facts.source === 'ai' ? facts.confidence : null,
      ai_extracted_data: { extraction: facts },
      extraction_status: facts.source === 'none' ? (deps.anthropicApiKey ? 'failed' : 'skipped') : 'done',
      flags,
      updated_at: iso,
    })
    .eq('org_id', input.orgId)
    .eq('id', receiptId);

  // 6. match
  const actor = input.submittedBy;
  if (charge) {
    const f = attachFlags({ vendorName: facts.merchant, amountCents: facts.totalCents, receiptDate: facts.date }, { id: charge.id, description: charge.description, amountCents: charge.amountCents, chargeDate: charge.date, cardAssignmentId: input.holder?.id ?? null }, policy);
    try {
      const { chaseCount } = await linkReceiptToCharge(db, input.orgId, receiptId, charge.id, { method: 'request', score: 1, actor, flags: [...flags, ...f], now });
      return { receiptId, duplicate: false, facts, match: { kind: 'attached', transactionId: charge.id, flags: f }, chaseCount };
    } catch (e) {
      if (e instanceof MatchError) throw new CaptureError(e.message, e.status);
      throw e;
    }
  }
  const match = await autoMatchReceipt(
    db,
    input.orgId,
    { id: receiptId, location_id: input.locationId, vendor_name: facts.merchant, amount_cents: facts.totalCents, receipt_date: facts.date, card_assignment_id: input.holder?.id ?? null, bank_transaction_id: null },
    policy,
    now,
    actor,
    // Holder paths (Workforce / magic link / forwarded email) auto-match only the holder's
    // own charges; anything else is at most suggested for the bookkeeper.
    { holderOnly: input.source !== 'MANUAL_UPLOAD' },
  );
  let chaseCount = 0;
  if (match.kind === 'matched') {
    const { data: r } = await serviceWriter(db).from('receipts').select('chase_reminder_count').eq('org_id', input.orgId).eq('id', receiptId).maybeSingle();
    chaseCount = (r as { chase_reminder_count?: number } | null)?.chase_reminder_count ?? 0;
  }
  return { receiptId, duplicate: false, facts, match, chaseCount };
}
