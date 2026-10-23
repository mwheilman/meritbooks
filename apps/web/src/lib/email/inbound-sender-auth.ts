/**
 * Sender authentication for inbound email — is the From address REALLY that sender?
 *
 * Anyone can type any From header. What we can trust is the verdict the RECEIVING mail
 * provider computed when it accepted the message (SPF on the envelope sender, DKIM
 * signatures, DMARC). Each provider reports it differently; this module normalizes all
 * of them onto one `SenderAuthentication` that downstream code reads as
 * `email.auth.verified`:
 *
 *   postmark  the provider's own topmost `Received-SPF` header (envelope-from + result)
 *             and its SpamAssassin `X-Spam-Tests` (DKIM_VALID_AU = a valid DKIM signature
 *             from the author's domain; SPF_PASS; DMARC_PASS / DMARC_REJECT / …)
 *   sendgrid  the Inbound Parse `SPF` field (envelope sender) and `dkim` field
 *             ("{@acme.com : pass}")
 *   generic   the relay's `authentication: { spf, dkim, dmarc, spfDomain, dkimDomains }`
 *             (the relay itself is HMAC-authenticated)
 *   any       an `Authentication-Results` header — ONLY when its authserv-id is a host we
 *             trust (the provider's, or INBOUND_EMAIL_AUTHSERV_IDS). A sender can forge
 *             their own Authentication-Results line; they cannot forge our provider's.
 *
 * verified = DMARC did not fail AND (DMARC passed, OR a DKIM signature passed for a domain
 * aligned with the From domain, OR SPF passed for an envelope domain aligned with it).
 * Relaxed alignment: same domain, or one is a subdomain of the other.
 *
 * Unverified ≠ rejected: it means "treat the sender as unknown" — no vendor auto-match,
 * no cardholder trust, no "known vendors" pass. Pure; no I/O.
 */

import type { AuthResult, InboundProviderId, SenderAuthentication } from './inbound-types';
import { domainOf } from './inbound-normalize';

const RESULTS: ReadonlyArray<AuthResult> = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'];

export function toAuthResult(raw: string | null | undefined): AuthResult {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'hardfail') return 'fail';
  const hit = RESULTS.find((r) => s === r || s.startsWith(`${r} `) || s.startsWith(`${r};`) || s.startsWith(`${r}(`));
  return hit ?? 'unknown';
}

/** Relaxed DMARC-style alignment: equal, or one sits under the other. */
export function domainsAligned(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  const y = (b ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!x || !y || !x.includes('.') || !y.includes('.')) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/** The provider's own authserv-ids (Authentication-Results first token). Suffix match. */
export const DEFAULT_AUTHSERV_IDS: Record<InboundProviderId, string[]> = {
  postmark: ['postmarkapp.com'],
  sendgrid: ['sendgrid.net'],
  generic: [],
};

function authservTrusted(id: string, trusted: ReadonlyArray<string>): boolean {
  const s = id.trim().toLowerCase();
  return trusted.some((t) => {
    const tt = t.trim().toLowerCase();
    return Boolean(tt) && (s === tt || s.endsWith(`.${tt}`));
  });
}

interface Partial3 {
  spf: AuthResult;
  spfDomain: string | null;
  dkim: AuthResult;
  dkimPassDomains: string[];
  dmarc: AuthResult;
}

const EMPTY: Partial3 = { spf: 'unknown', spfDomain: null, dkim: 'unknown', dkimPassDomains: [], dmarc: 'unknown' };

/**
 * Parse ONE Authentication-Results value ("mx.sendgrid.net; spf=pass smtp.mailfrom=a@b.com;
 * dkim=pass header.d=b.com; dmarc=pass header.from=b.com"). Null when the authserv-id is
 * not trusted.
 */
export function parseAuthenticationResults(value: string, trusted: ReadonlyArray<string>): Partial3 | null {
  const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const authserv = parts[0].split(/\s+/)[0] ?? '';
  if (!authservTrusted(authserv, trusted)) return null;
  const out: Partial3 = { ...EMPTY, dkimPassDomains: [] };
  for (const p of parts.slice(1)) {
    const m = p.match(/^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = toAuthResult(m[2]);
    if (method === 'spf') {
      out.spf = result;
      const d = p.match(/smtp\.mailfrom=("?)([^\s;"]+)\1/i)?.[2] ?? null;
      out.spfDomain = d ? (d.includes('@') ? domainOf(d) : d.toLowerCase()) || null : null;
    } else if (method === 'dkim') {
      if (out.dkim !== 'pass') out.dkim = result;
      const d = p.match(/header\.(?:d|i)=@?([^\s;]+)/i)?.[1] ?? null;
      if (result === 'pass' && d) out.dkimPassDomains.push(d.toLowerCase().replace(/^.*@/, ''));
    } else if (method === 'dmarc') {
      out.dmarc = result;
    }
  }
  return out;
}

/** Received-SPF: "Pass (sender SPF authorized) identity=mailfrom; envelope-from=a@b.com; …". */
export function parseReceivedSpf(value: string | null | undefined): Pick<Partial3, 'spf' | 'spfDomain'> {
  if (!value) return { spf: 'unknown', spfDomain: null };
  const spf = toAuthResult(value.split(/[\s(;]/)[0]);
  const env = value.match(/envelope-from=("?)<?([^\s;"<>]+)>?\1/i)?.[2] ?? null;
  return { spf, spfDomain: env ? domainOf(env) || null : null };
}

/** SpamAssassin X-Spam-Tests tokens → DKIM / SPF / DMARC. */
export function parseSpamTests(value: string | null | undefined, fromDomain: string): Partial3 {
  const out: Partial3 = { ...EMPTY, dkimPassDomains: [] };
  if (!value) return out;
  const tokens = new Set(value.toUpperCase().split(/[\s,]+/).map((t) => t.replace(/=.*$/, '')).filter(Boolean));
  if (tokens.has('DKIM_VALID_AU')) {
    out.dkim = 'pass';
    if (fromDomain) out.dkimPassDomains.push(fromDomain);
  } else if (tokens.has('DKIM_INVALID')) out.dkim = 'fail';
  else if (tokens.has('DKIM_VALID')) out.dkim = 'pass'; // valid, but NOT the author's domain → no aligned domain
  if (tokens.has('SPF_PASS')) out.spf = 'pass';
  else if (tokens.has('SPF_FAIL')) out.spf = 'fail';
  else if (tokens.has('SPF_SOFTFAIL')) out.spf = 'softfail';
  else if (tokens.has('SPF_NEUTRAL')) out.spf = 'neutral';
  if (tokens.has('DMARC_PASS')) out.dmarc = 'pass';
  else if (tokens.has('DMARC_REJECT') || tokens.has('DMARC_QUAR') || tokens.has('DMARC_NONE')) out.dmarc = 'fail';
  return out;
}

/** SendGrid `dkim` field: "{@acme.com : pass}" or "{@a.com : pass, @b.com : fail}" or "none". */
export function parseSendgridDkim(value: string | null | undefined): Pick<Partial3, 'dkim' | 'dkimPassDomains'> {
  const domains: string[] = [];
  let dkim: AuthResult = 'unknown';
  if (!value) return { dkim, dkimPassDomains: domains };
  const re = /@?([a-z0-9.-]+\.[a-z]{2,})\s*:\s*([a-z]+)/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(value)) !== null) {
    any = true;
    const r = toAuthResult(m[2]);
    if (r === 'pass') {
      domains.push(m[1].toLowerCase());
      dkim = 'pass';
    } else if (dkim !== 'pass') dkim = r;
  }
  if (!any) dkim = toAuthResult(value.replace(/[{}]/g, ''));
  return { dkim, dkimPassDomains: domains };
}

export interface SenderAuthInput {
  provider: InboundProviderId;
  fromAddress: string;
  headers: Record<string, string>;
  /** EVERY Authentication-Results value, top (newest) first. */
  authenticationResults?: string[];
  /** Hosts whose Authentication-Results we trust (provider defaults + env). */
  trustedAuthservIds?: string[];
  /** SendGrid Inbound Parse fields. */
  sendgrid?: { spf: string | null; dkim: string | null; envelopeFrom: string | null } | null;
  /** Generic relay's own verdict (the relay is HMAC-authenticated). */
  relay?: { spf?: string | null; dkim?: string | null; dmarc?: string | null; spfDomain?: string | null; dkimDomains?: string[] | null } | null;
}

function merge(base: Partial3, over: Partial<Partial3>): Partial3 {
  return {
    spf: over.spf && over.spf !== 'unknown' ? over.spf : base.spf,
    spfDomain: over.spf && over.spf !== 'unknown' ? over.spfDomain ?? base.spfDomain : base.spfDomain,
    dkim: over.dkim && over.dkim !== 'unknown' ? over.dkim : base.dkim,
    dkimPassDomains: Array.from(new Set([...base.dkimPassDomains, ...(over.dkimPassDomains ?? [])])),
    dmarc: over.dmarc && over.dmarc !== 'unknown' ? over.dmarc : base.dmarc,
  };
}

export function decideVerified(fromDomain: string, p: Partial3): boolean {
  if (!fromDomain) return false;
  if (p.dmarc === 'fail') return false;
  if (p.dmarc === 'pass') return true;
  if (p.dkim === 'pass' && p.dkimPassDomains.some((d) => domainsAligned(fromDomain, d))) return true;
  return p.spf === 'pass' && domainsAligned(fromDomain, p.spfDomain);
}

/** Normalize every provider's evidence into one verdict. */
export function senderAuthentication(input: SenderAuthInput): SenderAuthentication {
  const fromDomain = domainOf(input.fromAddress);
  let p: Partial3 = { ...EMPTY, dkimPassDomains: [] };
  let source: SenderAuthentication['source'] = 'none';

  // Postmark prepends its own Received-SPF / X-Spam-* headers (the adapter keeps the
  // FIRST = topmost value). A generic relay / SendGrid hand us the ORIGINAL message
  // headers, which the sender controls — those are never read as a verdict.
  if (input.provider === 'postmark') {
    const rspf = parseReceivedSpf(input.headers['received-spf']);
    const tests = parseSpamTests(input.headers['x-spam-tests'], fromDomain);
    const before = JSON.stringify(p);
    p = merge(p, tests);
    if (rspf.spf !== 'unknown') p = merge(p, { spf: rspf.spf, spfDomain: rspf.spfDomain });
    if (JSON.stringify(p) !== before) source = 'provider_headers';
  }
  if (input.provider === 'sendgrid' && input.sendgrid) {
    const dk = parseSendgridDkim(input.sendgrid.dkim);
    const spf = toAuthResult(input.sendgrid.spf);
    const envFrom = input.sendgrid.envelopeFrom ? domainOf(input.sendgrid.envelopeFrom) || null : null;
    if (spf !== 'unknown' || dk.dkim !== 'unknown') source = 'provider_fields';
    p = merge(p, { spf, spfDomain: envFrom, dkim: dk.dkim, dkimPassDomains: dk.dkimPassDomains });
  }
  if (input.provider === 'generic' && input.relay) {
    const r = input.relay;
    const spf = toAuthResult(r.spf);
    const dkim = toAuthResult(r.dkim);
    const dmarc = toAuthResult(r.dmarc);
    const dkimDomains = (r.dkimDomains ?? []).filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase());
    if (spf !== 'unknown' || dkim !== 'unknown' || dmarc !== 'unknown') source = 'relay';
    p = merge(p, { spf, spfDomain: r.spfDomain ? r.spfDomain.toLowerCase() : null, dkim, dkimPassDomains: dkim === 'pass' ? dkimDomains : [], dmarc });
  }
  const trusted = [...DEFAULT_AUTHSERV_IDS[input.provider], ...(input.trustedAuthservIds ?? [])];
  for (const ar of input.authenticationResults ?? []) {
    const parsed = parseAuthenticationResults(ar, trusted);
    if (!parsed) continue; // forged / foreign line — ignored
    p = merge(p, parsed);
    source = 'authentication_results';
    break; // the topmost trusted line is our provider's verdict
  }

  const verified = decideVerified(fromDomain, p);
  const bits = [`SPF ${p.spf}`, `DKIM ${p.dkim}`, `DMARC ${p.dmarc}`];
  return {
    spf: p.spf,
    spfDomain: p.spfDomain,
    dkim: p.dkim,
    dkimPassDomains: p.dkimPassDomains,
    dmarc: p.dmarc,
    verified,
    source,
    summary: `${verified ? 'Sender verified' : 'Sender not verified'} (${bits.join(', ')})`,
  };
}

/** True when a DKIM signature from google.com passed and the From is a google.com address. */
export function googleDkimVerified(fromAddress: string, auth: SenderAuthentication | null | undefined): boolean {
  if (!auth || !auth.verified || auth.dmarc === 'fail') return false;
  const d = domainOf(fromAddress);
  if (!domainsAligned(d, 'google.com')) return false;
  return auth.dkim === 'pass' && auth.dkimPassDomains.some((x) => domainsAligned(x, 'google.com'));
}

export const UNVERIFIED_AUTH: SenderAuthentication = {
  spf: 'unknown', spfDomain: null, dkim: 'unknown', dkimPassDomains: [], dmarc: 'unknown', verified: false, source: 'none',
  summary: 'Sender not verified (no authentication evidence)',
};
