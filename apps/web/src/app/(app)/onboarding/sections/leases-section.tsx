'use client';

/**
 * Leases onboarding SECTION — the Setup-Home board card + its ReviewComponent.
 *
 * WRAPS the existing lease engine VERBATIM via the proven `LeaseParseReview` modal
 * (DropZone → `POST /api/leases/parse` → confirm the ProposedLease → `POST /api/leases`,
 * which computes the ROU asset + lease liability at present value and the full ASC 842
 * schedule). We add NO posting and NO schema — only the section idiom around it.
 *
 * The client shell renders this keyed on `leasesSection.reviewComponentKey` ('leases').
 */

import { useState } from 'react';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import { domainBoardStatus } from '@/lib/onboarding/import/domain-detection';
import { DomainSectionShell, type SectionDisposition } from '@/components/onboarding/sections/domain-section-shell';
import { LeaseParseReview } from '../../leases/lease-parse-review';

export interface LeasesSectionProps {
  status: OnboardingStatus | null;
  aiAvailable?: boolean;
  onCommitted?: () => void;
}

export function LeasesSection({ status, aiAvailable = true, onCommitted }: LeasesSectionProps) {
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState<SectionDisposition>('none');

  const boardStatus = domainBoardStatus(status, 'leases');

  return (
    <DomainSectionShell
      title="Leases"
      description="Drop a lease PDF for the ROU asset and lease liability (ASC 842)."
      tone="optional"
      boardStatus={boardStatus}
      aiAvailable={aiAvailable}
      manualHref="/leases"
      manualLabel="Set up a lease by hand"
      primaryLabel="Drop a lease agreement"
      primaryHint="PDF or image · we propose the terms and classification, you confirm"
      onPrimary={() => setOpen(true)}
      disposition={disposition}
      onNotApplicable={() => setDisposition('n_a')}
      onSkip={() => setDisposition('skipped')}
      onReset={() => setDisposition('none')}
    >
      {open && (
        <LeaseParseReview
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); setDisposition('done'); onCommitted?.(); }}
        />
      )}
    </DomainSectionShell>
  );
}
