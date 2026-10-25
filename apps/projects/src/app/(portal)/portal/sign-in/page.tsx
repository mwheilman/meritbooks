import { PortalFrame } from '@/components/portal/PortalFrame';
import { SignInForm } from '@/components/portal/SignInForm';
import { portalLocale, sessionToken } from '@/lib/portal/session';
import { isUuid } from '@/lib/portal/tokens';

export const dynamic = 'force-dynamic';

export default function SignInPage({ searchParams }: { searchParams: { reason?: string; org?: string } }) {
  const locale = portalLocale();
  return (
    <PortalFrame locale={locale} signedIn={!!sessionToken() && searchParams.reason !== 'session'}>
      <SignInForm locale={locale} reason={searchParams.reason ?? null} orgId={isUuid(searchParams.org) ? searchParams.org : null} />
    </PortalFrame>
  );
}
