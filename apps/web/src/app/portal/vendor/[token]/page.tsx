export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { headers } from 'next/headers';
import { createAdminSupabase } from '@/lib/supabase/server';
import { validatePortalToken } from '@/lib/portal/vendor/tokens';
import { sharedRateLimiter } from '@/lib/security/rate-limit';
import { buildPortalView } from '@/lib/vendor-compliance/portal';
import { W9_CERTIFICATION_TEXT } from '@/lib/vendor-compliance/w9-form';
import { PublicRequestFrame, PublicRequestNotice } from '@/app/r/[token]/frame';
import { VendorPortalClient } from './upload-portal';
import { loadBrand } from '@/lib/branding/resolve';

export const metadata = { title: { absolute: 'Documents requested' }, robots: { index: false, follow: false } };

const PER_TOKEN = { windowMs: 60_000, max: 30 };
const PER_IP = { windowMs: 60_000, max: 90 };

/**
 * Vendor portal — PUBLIC, tokenized, no login, 390-first (FPB §5.3, §19.2). Shows exactly
 * what the asking company needs and why, where each item stands (received · checked ·
 * accepted · rejected with the reason), the fill-here W-9, uploads with the AI read-back,
 * and the renewal date. The token is validated server-side (service role); org + vendor
 * come from the token row. A bad, revoked or expired link reveals nothing about the tenant.
 */
export default async function VendorPortalPage({ params }: { params: { token: string } }) {
  const h = headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
  const throttle = sharedRateLimiter.checkAll([
    { key: `vendor-portal:token:${params.token.slice(0, 64)}`, rule: PER_TOKEN },
    { key: `vendor-portal:ip:${ip}`, rule: PER_IP },
  ]);
  if (!throttle.allowed) return <PublicRequestNotice heading="Too many tries" body="Please wait a minute and open the link again." />;

  const admin = createAdminSupabase();
  const result = await validatePortalToken(admin, params.token);
  if (!result.ok) {
    const heading = result.state === 'expired' ? 'This link has expired' : result.state === 'revoked' ? 'Nothing more is needed on this link' : 'Link not found';
    return (
      <PublicRequestNotice
        heading={heading}
        body={result.state === 'revoked' ? 'Everything asked for on this link has been taken care of, or the link was replaced. If you still need to send something, reply to the email you received.' : 'Please contact the company that sent it, or reply to their email, for a new link.'}
      />
    );
  }

  // Vendor compliance is tenant-level (core.vendors): the vendor sees the TENANT brand.
  const [view, brand] = await Promise.all([buildPortalView(admin, result.token), loadBrand(admin, result.token.orgId, null)]);
  return (
    <PublicRequestFrame eyebrow="Documents requested" sender={view.companyName} brand={brand}>
      <VendorPortalClient token={params.token} view={view} certification={W9_CERTIFICATION_TEXT} />
    </PublicRequestFrame>
  );
}
