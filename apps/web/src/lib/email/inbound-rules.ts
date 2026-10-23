/**
 * Pure inbound policies: who may send to an address, and recognising a mailbox
 * provider's forwarding-confirmation email. No I/O — the caller loads the facts.
 */

import type { InboundAliasPurpose, InboundEmail } from './inbound-types';
import { domainOf, normalizeAddress } from './inbound-normalize';
import { googleDkimVerified } from './inbound-sender-auth';

export type SenderRule = 'any' | 'known_vendors' | 'listed_domains';

export const SENDER_RULE_LABEL: Record<SenderRule, string> = {
  any: 'Anyone',
  known_vendors: 'Known vendors and your team',
  listed_domains: 'Only listed domains and senders (plus your team)',
};

/**
 * Free-mail domains: a vendor whose email is @gmail.com must NOT make every Gmail
 * user a "known vendor". Domain matching is skipped for these (exact address only).
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'mediacombb.net', 'q.com', 'centurylink.net',
]);

export interface SenderFacts {
  /** Active team members' emails in this org (always allowed — they forward bills). */
  memberEmails: ReadonlySet<string>;
  /** Vendor emails on file in this org. */
  vendorEmails: ReadonlySet<string>;
  /** Active cardholders' emails (they forward receipts to receipts- addresses). */
  cardholderEmails?: ReadonlySet<string>;
}

export interface SenderContext {
  /**
   * The receiving provider verified the From domain (SPF/DKIM/DMARC — email.auth.verified).
   * When false the sender is UNKNOWN: only an "Anyone" address accepts it.
   */
  verified: boolean;
  /** The alias's purpose — cardholders count as known senders on receipts addresses. */
  purpose?: InboundAliasPurpose;
}

export interface AliasSenderPolicy {
  sender_rule: SenderRule;
  allowed_domains: string[];
  allowed_senders: string[];
}

export type SenderDecision = { allowed: true; basis: string } | { allowed: false; reason: string };

/** Normalise a user-typed domain ("@Acme.com " → "acme.com"); '' when invalid. */
export function normalizeDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : '';
}

/** Does `domain` equal `allowed` or sit under it (billing.acme.com under acme.com)? */
function domainMatches(domain: string, allowed: string): boolean {
  return domain === allowed || domain.endsWith(`.${allowed}`);
}

/**
 * Who may send to this address. Fails closed on an UNVERIFIED sender: a From header is
 * just text, so without the provider's SPF/DKIM/DMARC pass nobody is a "team member",
 * "allowed sender" or "known vendor" — only an "Anyone" address accepts the mail.
 */
export function evaluateSender(fromAddress: string, policy: AliasSenderPolicy, facts: SenderFacts, ctx: SenderContext = { verified: false }): SenderDecision {
  const from = normalizeAddress(fromAddress);
  if (!from) return { allowed: false, reason: 'The sender address could not be read.' };
  const domain = domainOf(from);

  if (policy.sender_rule === 'any') return { allowed: true, basis: ctx.verified ? 'anyone' : 'anyone (sender not verified)' };
  if (!ctx.verified) {
    return {
      allowed: false,
      reason: `${from} could not be verified — the sending mail server did not pass SPF, DKIM or DMARC for ${domain || 'that domain'}, so it may be forged. This address only accepts verified senders.`,
    };
  }
  if (facts.memberEmails.has(from)) return { allowed: true, basis: 'team member' };
  if (ctx.purpose === 'receipts' && facts.cardholderEmails?.has(from)) return { allowed: true, basis: 'cardholder' };
  if (policy.allowed_senders.some((s) => normalizeAddress(s) === from)) return { allowed: true, basis: 'allowed sender' };

  if (policy.sender_rule === 'listed_domains') {
    const hit = policy.allowed_domains.map(normalizeDomain).find((d) => d && domainMatches(domain, d));
    return hit
      ? { allowed: true, basis: `allowed domain ${hit}` }
      : { allowed: false, reason: `${from} is not on this address's list of allowed domains or senders.` };
  }

  // known_vendors
  if (facts.vendorEmails.has(from)) return { allowed: true, basis: 'vendor email on file' };
  if (!FREEMAIL_DOMAINS.has(domain)) {
    for (const v of Array.from(facts.vendorEmails)) {
      const vd = domainOf(v);
      if (vd && !FREEMAIL_DOMAINS.has(vd) && domainMatches(domain, vd)) return { allowed: true, basis: `vendor domain ${vd}` };
    }
  }
  return { allowed: false, reason: `${from} is not a vendor on file or a member of your team.` };
}

// ── Forwarding confirmations ─────────────────────────────────────────────────

export interface ForwardingConfirmation {
  provider: 'gmail';
  /** The mailbox asking to forward (e.g. bills@heritage.com). */
  requestedBy: string | null;
  code: string | null;
  /** Only an https *.google.com URL is ever returned. */
  url: string | null;
  /** Google's DKIM signature passed (email.auth). Only then is the code / link kept. */
  authenticated: boolean;
}

const GOOGLE_URL = /https:\/\/(?:[a-z0-9-]+\.)*google\.com\/[^\s"'<>)\]]+/gi;

/**
 * Gmail (and Google Workspace) send "(#123456789) Gmail Forwarding Confirmation -
 * Receive Mail from x@y.com" from forwarding-noreply@google.com when someone adds a
 * forwarding address. We capture the code + link so an admin can confirm it in-app.
 */
export function detectForwardingConfirmation(email: InboundEmail): ForwardingConfirmation | null {
  const from = email.from.address;
  const subject = email.subject ?? '';
  const isGoogle = from === 'forwarding-noreply@google.com' || (domainOf(from).endsWith('google.com') && /forwarding/i.test(subject));
  if (!isGoogle || !/forwarding confirmation|confirm.*forward/i.test(subject)) return null;

  const text = `${subject}\n${email.textBody ?? ''}\n${(email.htmlBody ?? '').replace(/<[^>]+>/g, ' ')}`;
  const code = (subject.match(/\(#(\d{4,12})\)/) ?? text.match(/confirmation code:?\s*(\d{4,12})/i))?.[1] ?? null;
  const requested = subject.match(/receive mail from\s+([^\s]+@[^\s]+)/i)?.[1] ?? text.match(/([^\s<>"]+@[^\s<>"]+)\s+has requested/i)?.[1] ?? null;
  const urls = Array.from(new Set((email.textBody ?? '').match(GOOGLE_URL) ?? (email.htmlBody ?? '').match(GOOGLE_URL) ?? []));
  const url = urls.find((u) => /mail(?:-settings)?\.google\.com\/mail\/(?:u\/\d+\/)?vf/i.test(u)) ?? urls.find((u) => /mail-settings\.google\.com/i.test(u)) ?? null;

  // Proof, not a hint: the receiving provider saw a valid google.com DKIM signature.
  const authenticated = googleDkimVerified(from, email.auth);

  return {
    provider: 'gmail',
    requestedBy: requested ? normalizeAddress(requested) || null : null,
    code,
    url: url ? url.replace(/&amp;/g, '&').slice(0, 1000) : null,
    authenticated,
  };
}

// ── "Does this body look like an invoice?" (HTML-only invoice emails) ───────

const INVOICE_WORDS = /\b(invoice|bill|statement of account|amount due|balance due|total due|payment due|remit|pay now)\b/i;
const MONEY = /\$\s?\d[\d,]*(\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(usd)?\b/i;

/** True when a body-only email plausibly IS an invoice (worth rendering + reading). */
export function looksLikeInvoiceBody(email: InboundEmail): boolean {
  const text = `${email.subject ?? ''}\n${email.textBody ?? ''}\n${(email.htmlBody ?? '').replace(/<[^>]+>/g, ' ')}`;
  return INVOICE_WORDS.test(text) && MONEY.test(text);
}
