import 'server-only';
/** The frame data every company page needs: language, brand, audiences, phone hint (portal.me). */
import { notFound, redirect } from 'next/navigation';
import { loadPortal } from './load';
import { portalLocale } from './session';
import { isUuid } from './tokens';
import type { Audience, Brand, Locale, PortalMe } from './types';

export interface OrgFrame {
  orgId: string;
  locale: Locale;
  brand: Brand | null;
  audiences: Audience[];
  multiOrg: boolean;
  phoneHint: string | null;
  verified: PortalMe['person']['verified'];
  company: string;
}

export async function orgFrame(orgId: string): Promise<OrgFrame> {
  if (!isUuid(orgId)) notFound();
  const me = await loadPortal<PortalMe>('me');
  if (!me.ok) notFound();
  const org = me.data.orgs.find((o) => o.org_id === orgId);
  // another of the person's companies: it needs its own code (portal.auth_switch)
  if (!org && (me.data.other_orgs ?? []).some((o) => o.org_id === orgId)) redirect('/portal?choose=1');
  if (!org) notFound();
  return {
    orgId,
    locale: me.data.person.locale ?? portalLocale(),
    brand: org.brand,
    audiences: org.audiences ?? [],
    multiOrg: (me.data.other_orgs ?? []).length > 0,
    phoneHint: org.phone_hint ?? me.data.person.phone_hint,
    verified: me.data.person.verified,
    company: org.brand?.company_name ?? org.org_name,
  };
}
