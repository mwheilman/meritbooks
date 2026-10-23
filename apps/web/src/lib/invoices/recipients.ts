/**
 * Who an invoice email goes to. Pure + unit-tested.
 *
 *   To   the address typed for this send, else the customer's email on file.
 *   Cc   the list typed for this send when given (even empty = "no CC this time"),
 *        else the invoice's saved CC list (chosen by a sender for this invoice), else
 *        the customer's default CC list.
 *   Bcc  "send me a copy" → the sender's own address (hidden from the customer).
 * Addresses are trimmed, lower-cased for comparison, de-duplicated across To/Cc/Bcc
 * and validated; at most MAX_CC copies.
 */

export const MAX_CC = 10;

const EMAIL = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;

export function isEmail(v: string): boolean {
  return EMAIL.test(v.trim());
}

/** Split a free-typed list ("a@x.com, b@y.com; c@z.com") into addresses. */
export function parseEmailList(raw: string | readonly string[] | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [];
  return (parts as readonly string[]).map((p) => p.trim()).filter(Boolean);
}

export interface RecipientInput {
  explicitTo?: string | null;
  customerEmail?: string | null;
  /** undefined = not specified for this send (use saved lists); [] = explicitly none. */
  explicitCc?: readonly string[];
  invoiceCc?: readonly string[];
  customerCc?: readonly string[];
  copyToSelf?: string | null;
}

export type RecipientResult =
  | { ok: true; to: string; cc: string[]; bcc: string[] }
  | { ok: false; code: 'CUSTOMER_EMAIL_MISSING' | 'INVALID_EMAIL' | 'TOO_MANY_CC'; error: string };

export function resolveRecipients(i: RecipientInput): RecipientResult {
  const to = (i.explicitTo?.trim() || i.customerEmail?.trim() || '');
  if (!to) return { ok: false, code: 'CUSTOMER_EMAIL_MISSING', error: 'There is no email address to send to.' };
  if (!isEmail(to)) return { ok: false, code: 'INVALID_EMAIL', error: `"${to}" is not a valid email address.` };

  const ccSource = i.explicitCc !== undefined
    ? [...i.explicitCc]
    : (i.invoiceCc?.length ? [...i.invoiceCc] : [...(i.customerCc ?? [])]);
  const bad = ccSource.map((x) => x.trim()).filter((x) => x && !isEmail(x));
  if (bad.length) return { ok: false, code: 'INVALID_EMAIL', error: `Not a valid email address: ${bad.join(', ')}` };

  const seen = new Set<string>([to.toLowerCase()]);
  const cc: string[] = [];
  for (const raw of ccSource) {
    const e = raw.trim();
    if (!e || seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    cc.push(e);
  }
  if (cc.length > MAX_CC) return { ok: false, code: 'TOO_MANY_CC', error: `Copy at most ${MAX_CC} people on one invoice.` };

  const bcc: string[] = [];
  const self = i.copyToSelf?.trim();
  if (self && isEmail(self) && !seen.has(self.toLowerCase())) bcc.push(self);
  return { ok: true, to, cc, bcc };
}
