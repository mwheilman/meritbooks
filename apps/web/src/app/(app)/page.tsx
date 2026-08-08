'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Root router. Sends the user to the right first surface:
 *   - Org not yet provisioned (setup_complete = false) → /setup (org creation).
 *   - Org provisioned but tenant has never gone live (no GL activity / opening
 *     entry and not flagged onboarded) → /onboarding (the unified first-run wizard).
 *   - Otherwise → /dashboard.
 *
 * The first-run signal comes from /api/onboarding/status (firstRun). It is derived
 * from real GL activity, so an established tenant is never bounced back into the
 * wizard. Any lookup failure falls back to /dashboard (never traps the user).
 */
export default function RootPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function route() {
      try {
        const setupRes = await fetch('/api/setup');
        const setup = (await setupRes.json()) as { setupComplete?: boolean };

        if (!setup.setupComplete) {
          if (!cancelled) router.replace('/setup');
          return;
        }

        // Setup done — check whether the tenant still needs first-run onboarding.
        try {
          const statusRes = await fetch('/api/onboarding/status');
          const status = (await statusRes.json()) as { firstRun?: boolean; orgResolved?: boolean };
          if (!cancelled && status.firstRun === true && status.orgResolved !== false) {
            router.replace('/onboarding');
            return;
          }
        } catch {
          /* onboarding status is best-effort; fall through to dashboard */
        }

        if (!cancelled) router.replace('/dashboard');
      } catch {
        if (!cancelled) router.replace('/dashboard');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void route();
    return () => { cancelled = true; };
  }, [router]);

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading MeritBooks...</p>
        </div>
      </div>
    );
  }

  return null;
}
