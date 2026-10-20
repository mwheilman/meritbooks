import type { Metadata } from 'next';
import { currentUser } from '@clerk/nextjs/server';
import { getTenant } from '@/lib/tenant';
import { OnboardingShell } from './_components/shell';
import './onboarding.css';

export const metadata: Metadata = { title: 'Set up' };
export const dynamic = 'force-dynamic';

/** Onboarding lives outside (app): its own frame, no workspace nav until a pack is installed. */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const [tenant, user] = await Promise.all([getTenant(), currentUser().catch(() => null)]);
  const name = user?.fullName || user?.primaryEmailAddress?.emailAddress || '';
  const initials = name
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || 'MP';
  return (
    <OnboardingShell orgName={tenant.orgName ?? 'Your workspace'} initials={initials}>
      {children}
    </OnboardingShell>
  );
}
