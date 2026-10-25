import { redirect } from 'next/navigation';
import { InlineNotice } from '@meritbooks/merit-ui';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { SwitchOrg } from '@/components/portal/SwitchOrg';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import { portalLocale } from '@/lib/portal/session';
import type { PortalMe } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/**
 * After sign-in: straight into the company that sent the code. Each session belongs to ONE company;
 * the person's other companies are listed here and open with a fresh code from that company.
 */
export default async function PortalIndex({ searchParams }: { searchParams: { choose?: string } }) {
  const me = await loadPortal<PortalMe>('me');
  const locale = me.ok ? me.data.person.locale ?? portalLocale() : portalLocale();
  const others = me.ok ? me.data.other_orgs ?? [] : [];
  if (me.ok && me.data.orgs.length === 1 && (!searchParams.choose || others.length === 0)) redirect(`/portal/o/${me.data.orgs[0].org_id}`);
  return (
    <PortalFrame locale={locale} signedIn>
      {!me.ok ? <InlineNotice tone="neg" title={me.message} /> : me.data.orgs.length === 0 && others.length === 0 ? (
        <p className="pt-empty">{t(locale, 'orgs.none')}</p>
      ) : (
        <>
          <h1>{t(locale, 'orgs.title')}</h1>
          {me.data.orgs.map((o) => (
            <a key={o.org_id} className="pt-card" href={`/portal/o/${o.org_id}`}>
              <span className="pt-cap">{t(locale, 'orgs.current')}</span>
              <div className="ttl">{o.brand?.company_name ?? o.org_name}</div>
              <div className="meta">{(o.companies ?? []).join(' · ')}</div>
            </a>
          ))}
          {others.length > 0 && <h2>{t(locale, 'orgs.others')}</h2>}
          {others.map((o) => <SwitchOrg key={o.org_id} orgId={o.org_id} name={o.org_name} locale={locale} />)}
        </>
      )}
    </PortalFrame>
  );
}
