'use client';

import type { ReactNode } from 'react';
import { AppShell, Bar, Crumbs, Lockup, Rail, RailLink, SyncStatus } from '@meritbooks/merit-ui';

/**
 * The onboarding frame: AppShell in the mini-rail variant (O-* boards), the Merit
 * Projects lockup, and nothing to navigate away to yet — one job on this screen.
 */
export function OnboardingShell({ orgName, initials, children }: { orgName: string; initials: string; children: ReactNode }) {
  return (
    <AppShell
      context="workspace"
      density="cockpit"
      mini
      rail={
        <Rail
          module="projects"
          mini
          homeHref="/onboarding"
          aria-label="Set up"
          foot={
            <div className="rail-foot" style={{ padding: '16px 0', display: 'grid', placeItems: 'center' }}>
              <span className="avatar" aria-hidden="true">{initials}</span>
            </div>
          }
        >
          <RailLink href="/onboarding" icon="clipboard" active>Set up</RailLink>
        </Rail>
      }
      bar={
        <Bar>
          <Lockup module="projects" variant="on-dark" height={24} />
          <Crumbs items={[{ label: orgName }, { label: 'Set up Merit Projects' }]} />
          <span style={{ marginLeft: 'auto' }} />
          <SyncStatus>Saved as you go</SyncStatus>
        </Bar>
      }
    >
      {children}
    </AppShell>
  );
}
