/**
 * Where each queued command goes, and how it looks on the wire. One queue, three endpoints:
 *   POST /api/field/sync         v1 field commands + the v2 phone commands (batch, deduped by id)
 *   POST /api/field/fs-commands  field-service tools: forms, notes, equipment, will-call (batch, deduped by id)
 *   POST /api/field/fs-commands  … and the field-service sale (with the customer's signed time)
 *   POST /api/field/flooring     installer on-my-way, sign-off, on-site change (one call each; replays are safe)
 *   POST /api/field/receipts     a receipt behind its photo (clientId = command id, deduped in the database)
 *   POST /api/field/ro/story     the 3C story on an RO line (commandId, deduped in the database)
 * A command that names a queued photo by its command id (docRefs) waits for that photo, and the
 * photo's server document id is filled in at send time. Pure (unit-tested).
 */
import type { CommandResult, DocRef, FlooringCommand, JsonCommand, ResReceiptCommand, RoLineStoryCommand } from './contract';
import type { QueuedCommand } from './queue';

export type Endpoint = 'sync' | 'fs' | 'flooring' | 'receipt' | 'story';

const FS_KINDS = new Set(['fs.sell', 'fs.form.submit', 'fs.note.save', 'fs.equipment.upsert', 'fs.willcall.pickup', 'fs.paylink.send', 'fs.message.send']);
const FLOORING_KINDS = new Set(['flr.omw', 'flr.signoff', 'flr.change']);

export function endpointOf(c: Pick<JsonCommand, 'kind'>): Endpoint {
  if (FS_KINDS.has(c.kind)) return 'fs';
  if (FLOORING_KINDS.has(c.kind)) return 'flooring';
  if (c.kind === 'res.receipt') return 'receipt';
  if (c.kind === 'ro.line.story') return 'story';
  return 'sync';
}

export function docRefsOf(c: JsonCommand): DocRef[] {
  return 'docRefs' in c && Array.isArray(c.docRefs) ? c.docRefs : [];
}

/** Still waiting on a photo it needs (queued or sending)? */
export function waitsForPhotos(c: JsonCommand, open: ReadonlySet<string>): boolean {
  return docRefsOf(c).some((r) => open.has(r.photoId));
}

/** Fill the document ids from photos the server accepted; a photo that never made it is left out. */
export function resolveDocs<C extends JsonCommand>(c: C, rows: ReadonlyArray<QueuedCommand>): C {
  const refs = docRefsOf(c);
  if (!refs.length) return c;
  const docOf = new Map<string, string>();
  for (const r of rows) if (r.kind === 'photo.upload' && r.status === 'done' && r.result?.serverId) docOf.set(r.id, r.result.serverId);
  const out = { ...c } as C & { signatureDocumentId?: string | null; photoDocumentIds?: string[] };
  for (const ref of refs) {
    const doc = docOf.get(ref.photoId);
    if (!doc) continue;
    if (ref.field === 'signatureDocumentId') out.signatureDocumentId = doc;
    else out.photoDocumentIds = [...new Set([...(out.photoDocumentIds ?? []), doc])];
  }
  return out;
}

/** What actually goes over the wire: no phone-only fields. */
export function wire<C extends JsonCommand>(c: C): Omit<C, 'docRefs'> {
  // a sale queued before the signed time existed: the customer signed when the phone saved it
  if (c.kind === 'fs.sell' && !c.signedAt) return { ...c, signedAt: c.at };
  if (!('docRefs' in c)) return c;
  const { docRefs: _drop, ...rest } = c as C & { docRefs?: unknown };
  return rest as Omit<C, 'docRefs'>;
}

export function flooringBody(c: FlooringCommand): Record<string, unknown> {
  if (c.kind === 'flr.omw') return { op: 'on_my_way', bookingId: c.bookingId };
  if (c.kind === 'flr.change') {
    return {
      op: 'field_change', commandId: c.id, jobId: c.jobId, lines: c.lines, signerName: c.signerName ?? null,
      signatureDocumentId: c.signatureDocumentId ?? null, note: c.note ?? null,
    };
  }
  return {
    op: 'signoff', bookingId: c.bookingId, signerName: c.signerName, signatureDocumentId: c.signatureDocumentId ?? null,
    photoDocumentIds: c.photoDocumentIds ?? [], leftover: c.leftover ?? [], notes: c.notes ?? null,
  };
}

/** The flooring route answers plain JSON; turn it into the queue's CommandResult. */
export function flooringResult(c: FlooringCommand, status: number, body: unknown): CommandResult {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const error = typeof b.error === 'string' ? b.error : null;
  if (status === 200) {
    const serverId = typeof b.signoff_id === 'string' ? b.signoff_id : typeof b.change_order_id === 'string' ? b.change_order_id : typeof b.booking_id === 'string' ? b.booking_id : null;
    return { id: c.id, kind: c.kind, outcome: b.replayed === true ? 'duplicate' : 'applied', serverId };
  }
  if (status >= 500 || status === 429) return { id: c.id, kind: c.kind, outcome: 'retry', reason: error ?? `The server is busy (${status}).` };
  // a closed booking: our own earlier sign-off (answer lost) or someone else's — either way it is signed off
  if (c.kind === 'flr.signoff' && error && /booking is done/i.test(error)) {
    return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'This install was already signed off.' };
  }
  if (c.kind === 'flr.omw' && error && /booking is (done|cancelled)/i.test(error)) {
    return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'This install is already closed.' };
  }
  return { id: c.id, kind: c.kind, outcome: 'rejected', code: typeof b.code === 'string' ? b.code : 'REFUSED', reason: error ?? `The office refused this (${status}).` };
}

export function receiptBody(c: ResReceiptCommand): Record<string, unknown> {
  return {
    clientId: c.id, jobId: c.jobId, photoCommandId: c.photoCommandId, vendorName: c.vendorName ?? null, amountCents: c.amountCents ?? null,
    purchasedOn: c.purchasedOn ?? null, memo: c.memo ?? null,
  };
}

export function storyBody(c: RoLineStoryCommand): Record<string, unknown> {
  return { commandId: c.id, lineId: c.lineId, complaint: c.complaint ?? null, cause: c.cause ?? null, correction: c.correction ?? null };
}

/** The receipt and RO-story routes answer plain JSON with a replay flag. */
export function singleResult(c: ResReceiptCommand | RoLineStoryCommand, status: number, body: unknown): CommandResult {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const error = typeof b.error === 'string' ? b.error : null;
  if (status === 200) {
    const replay = b.duplicate === true || b.replayed === true;
    const serverId = typeof b.receiptId === 'string' ? b.receiptId : typeof b.storyId === 'string' ? b.storyId : null;
    const note = b.photoPending === true ? 'The receipt waits for its photo; it links when the photo arrives.' : undefined;
    return { id: c.id, kind: c.kind, outcome: replay ? 'duplicate' : 'applied', serverId, note };
  }
  if (status >= 500 || status === 429) return { id: c.id, kind: c.kind, outcome: 'retry', reason: error ?? `The server is busy (${status}).` };
  return { id: c.id, kind: c.kind, outcome: 'rejected', code: typeof b.code === 'string' ? b.code : 'REFUSED', reason: error ?? `The office refused this (${status}).` };
}
