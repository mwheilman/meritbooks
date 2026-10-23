/**
 * Fill-here W-9 (FPB §5.3 step 2a, §19 A6): the vendor types the W-9 into the portal and
 * e-signs it under the IRS penalties-of-perjury certification. No image, no AI. The TIN is
 * checked for plausibility, encrypted (AES-256-GCM, TIN_ENCRYPTION_KEY) into a member-
 * unreadable column, and reduced to its last four everywhere else. Nothing here returns,
 * logs or stores the TIN in clear.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptTin, normaliseTin, tinLooksValid } from '@/lib/vendors/tin-crypto';
import type { W9FormBody } from '@/lib/validations/vendor-compliance';
import { recordSubmission, type SubmissionRow, type W9FormData } from './review';

/** The certification text version the signer agreed to (shown verbatim in the portal). */
export const W9_CERTIFICATION_VERSION = 'irs-w9-rev-march-2024';

export const W9_CERTIFICATION_TEXT = [
  'Under penalties of perjury, I certify that:',
  '1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and',
  '2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and',
  '3. I am a U.S. citizen or other U.S. person; and',
  '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.',
  'The Internal Revenue Service does not require your consent to any provision of this document other than the certifications required to avoid backup withholding.',
];

export class W9FormError extends Error {
  constructor(message: string, readonly field: string | null = null) {
    super(message);
    this.name = 'W9FormError';
  }
}

/** Corporations (incl. LLC taxed as C/S) are generally 1099-exempt; individuals, partnerships, LLC-P are not. */
export function signal1099(entity: W9FormBody['entity_type'], llc: W9FormBody['llc_tax_class']): boolean | null {
  if (entity === 'C_CORP' || entity === 'S_CORP') return false;
  if (entity === 'INDIVIDUAL_SOLE_PROP' || entity === 'PARTNERSHIP') return true;
  if (entity === 'LLC') return llc === 'P' ? true : llc === 'C' || llc === 'S' ? false : null;
  return null;
}

/** Pure: validate the TIN pair and build the stored form (last 4 only). */
export function buildW9Form(body: W9FormBody, meta: { now: Date; ip: string | null; userAgent: string | null }, tinStored: boolean): { form: W9FormData; digits: string } {
  const digits = normaliseTin(body.tin);
  if (!digits) throw new W9FormError('Enter the 9-digit taxpayer ID.', 'tin');
  if (normaliseTin(body.tin_confirm) !== digits) throw new W9FormError('The two taxpayer ID entries do not match.', 'tin_confirm');
  if (!tinLooksValid(digits, body.tin_type)) throw new W9FormError(`That does not look like a valid ${body.tin_type === 'SSN' ? 'Social Security number' : 'EIN'}. Check it and try again.`, 'tin');
  const form: W9FormData = {
    legal_name: body.legal_name.trim(),
    business_name: body.business_name?.trim() || null,
    entity_type: body.entity_type,
    llc_tax_class: body.entity_type === 'LLC' ? body.llc_tax_class ?? null : null,
    exempt_payee_code: body.exempt_payee_code?.trim() || null,
    address_line1: body.address_line1.trim(),
    address_line2: body.address_line2?.trim() || null,
    city: body.city.trim(),
    state: body.state.trim().toUpperCase(),
    zip: body.zip.trim(),
    tin_type: body.tin_type,
    tin_last4: digits.slice(-4),
    tin_stored: tinStored,
    signer_name: body.signer_name.trim(),
    signed_at: meta.now.toISOString(),
    signer_ip: meta.ip,
    user_agent: meta.userAgent?.slice(0, 300) ?? null,
    certification_version: W9_CERTIFICATION_VERSION,
    is_1099_eligible_signal: signal1099(body.entity_type, body.llc_tax_class ?? null),
  };
  return { form, digits };
}

export async function submitW9Form(
  admin: SupabaseClient,
  token: { tokenId: string | null; orgId: string; vendorId: string },
  body: W9FormBody,
  meta: { now?: Date; ip: string | null; userAgent: string | null },
): Promise<{ submission: SubmissionRow; tinStored: boolean }> {
  const now = meta.now ?? new Date();
  const probe = buildW9Form(body, { now, ip: meta.ip, userAgent: meta.userAgent }, false);
  const sealed = encryptTin(probe.digits);
  const { form } = buildW9Form(body, { now, ip: meta.ip, userAgent: meta.userAgent }, sealed !== null);
  const submission = await recordSubmission(
    admin,
    { orgId: token.orgId, vendorId: token.vendorId, docKind: 'W9', source: 'portal_w9_form', portalTokenId: token.tokenId, w9Form: form, tinCiphertext: sealed, actor: token.tokenId ? `vendor_token:${token.tokenId}` : 'system:w9_form' },
    now,
  );
  return { submission, tinStored: sealed !== null };
}
