import type { CSSProperties, ReactNode } from 'react';
import { t } from '@/lib/portal/i18n';
import type { Audience, Brand, Locale } from '@/lib/portal/types';
import { LangToggle, SignOutButton } from './PortalControls';

export type PortalTab = 'home' | 'invoices' | 'work';

/** The portal frame: the company's brand bar, a few tabs, the language switch. Sparse on purpose. */
export function PortalFrame({ locale, brand, orgId, audiences, active, signedIn, multiOrg, children }: {
  locale: Locale; brand?: Brand | null; orgId?: string | null; audiences?: readonly Audience[]; active?: PortalTab;
  signedIn: boolean; multiOrg?: boolean; children: ReactNode;
}) {
  const style = brand?.primary_color && /^#[0-9a-fA-F]{6}$/.test(brand.primary_color) ? ({ ['--brand' as string]: brand.primary_color } as CSSProperties) : undefined;
  const tabs: { key: PortalTab; href: string; label: string; show: boolean }[] = orgId ? [
    { key: 'home', href: `/portal/o/${orgId}`, label: t(locale, 'nav.home'), show: true },
    { key: 'invoices', href: `/portal/o/${orgId}/invoices`, label: t(locale, 'nav.invoices'), show: !!audiences?.includes('customer') },
    { key: 'work', href: `/portal/o/${orgId}/work`, label: t(locale, 'nav.work'), show: !!audiences?.includes('vendor') },
  ] : [];
  return (
    <div className="pt" lang={locale} style={style}>
      <header className="pt-bar">
        {brand?.logo_url ? <img src={brand.logo_url} alt="" /> : null}
        <span className="co">{brand?.company_name ?? t(locale, 'app.name')}</span>
        <span className="sp" />
        {multiOrg && orgId ? <a className="pt-cap" href="/portal?choose=1">{t(locale, 'nav.switch_company')}</a> : null}
        <LangToggle locale={locale} />
        {signedIn ? <SignOutButton label={t(locale, 'nav.sign_out')} /> : null}
      </header>
      {tabs.some((x) => x.show) && (
        <nav className="pt-nav" aria-label={t(locale, 'app.name')}>
          {tabs.filter((x) => x.show).map((x) => (
            <a key={x.key} href={x.href} aria-current={active === x.key ? 'page' : undefined}>{x.label}</a>
          ))}
        </nav>
      )}
      <main className="pt-main">{children}</main>
      <footer className="pt-foot">{t(locale, 'app.secure')} · Merit Projects</footer>
    </div>
  );
}
