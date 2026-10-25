import { HttpError, mapPgError, splitToken, type PgErrorLike } from '@/lib/api-errors';

/** Plain sentences for the 1115 tokens (everything else falls back to the shared mapping). */
const WORDS: Record<string, [number, string]> = {
  PM_DOC_LEGAL_HOLD: [422, 'This document is on legal hold. Release the hold first.'],
  PM_DOC_RETAINED: [422, 'This record is inside its retention period and cannot be removed yet.'],
  PM_DOC_LOCKED: [422, 'This document is signed. Signed records cannot be replaced or removed; add a new document instead.'],
  PM_DOC_OUT_FOR_SIGNATURE: [422, 'This document is out for signature. Void the request before changing it.'],
  PM_DOC_DELETED: [422, 'This document was removed.'],
  PM_DOC_FILE_IN_USE: [409, 'That file is already part of another document.'],
  PM_DRAWING_DUPLICATE_SHEET: [409, 'That sheet number appears twice in this set. Give each page its own number.'],
  PM_ESIGN_OPEN: [409, 'This document already has an open signature request. Void it to send a new one.'],
  PM_ESIGN_STATE: [422, 'The signature request is no longer open.'],
  PM_ESIGN_EXPIRED: [422, 'The signature request expired. Send a new one.'],
  PM_ESIGN_STALE: [422, 'The document changed after it was sent for signature.'],
  PM_NOT_FOUND: [404, 'That was not found.'],
};

export function documentsError(err: PgErrorLike): HttpError {
  const { token, detail } = splitToken(err.message);
  if (token === 'PM_FORBIDDEN' && /money document/.test(detail)) {
    return new HttpError(403, 'This is a money document. You need access to job dollars to add it.', token);
  }
  if (token && WORDS[token]) {
    const [status, msg] = WORDS[token];
    return new HttpError(status, token === 'PM_DOC_RETAINED' && detail ? `This record must be kept until ${detail.replace(/^.*until\s*/, '')}.` : msg, token);
  }
  const m = mapPgError(err);
  return new HttpError(m.status, m.body.error, m.body.code);
}

export function unwrap<T>(res: { data: unknown; error: PgErrorLike | null }): T {
  if (res.error) throw documentsError(res.error);
  return res.data as T;
}
