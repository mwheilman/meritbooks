'use client';

/**
 * SetupHomeBoard — the optional "Setup Home" board (design spec §3): once the books
 * are live and tied out, EVERYTHING else lives here as a card, never as a gate.
 *
 * It composes the kit: a `ReadinessMeter` header (books health) over a grid of
 * `SetupHomeCard`s. Cards come from two sources, all deriving status the same way:
 *   • the registry's OPTIONAL sections (bank, connect-systems, team) — real
 *     live-count `done` signals; and
 *   • the long-tail `SETUP_HOME_DOMAINS` (AR/AP, jobs/WIP, debt, leases, fixed
 *     assets, sales tax, insurance) — deep-linking to their existing surfaces.
 *
 * Presentational: the caller supplies a loaded `OnboardingStatus`. Optional domains
 * are neutral ("add later") and never nag.
 */

import type { OnboardingStatus } from '@/lib/onboarding/status';
import { ONBOARDING_SECTIONS } from '@/lib/onboarding/sections/registry';
import { SETUP_HOME_DOMAINS } from '@/lib/onboarding/sections/setup-home';
import { SetupHomeCard } from './setup-home-card';
import { ReadinessMeter } from './readiness-meter';
import { deriveBoardCardStatus } from './helpers';

/** Registry optional sections get a short board description keyed by section key. */
const SECTION_BOARD_COPY: Record<string, string> = {
  bank: 'Link a bank so transactions flow in automatically, ready to categorize.',
  erp: 'Connect the operational system your team already uses so data flows in.',
  team: 'Invite teammates with a role and company access — or stay solo for now.',
};

export interface SetupHomeBoardProps {
  status: OnboardingStatus;
  className?: string;
}

export function SetupHomeBoard({ status, className }: SetupHomeBoardProps) {
  const optionalSections = ONBOARDING_SECTIONS.filter((s) => s.tone !== 'required');

  return (
    <div className={className}>
      <ReadinessMeter status={status} className="mb-5" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Registry optional domains — real live-count status. */}
        {optionalSections.map((s) => (
          <SetupHomeCard
            key={s.key}
            title={s.label}
            status={deriveBoardCardStatus({ done: s.deriveStatus(status) === 'done' })}
            description={SECTION_BOARD_COPY[s.key] ?? 'Set this up whenever you like.'}
            href={s.href}
          />
        ))}

        {/* Long-tail optional domains — deep-link to their existing surfaces. */}
        {SETUP_HOME_DOMAINS.map((d) => (
          <SetupHomeCard
            key={d.key}
            title={d.title}
            status={d.deriveStatus(status)}
            description={d.description}
            href={d.href}
          />
        ))}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Nothing here blocks you. Add each domain when you&apos;re ready — or never, if it doesn&apos;t apply.
      </p>
    </div>
  );
}
