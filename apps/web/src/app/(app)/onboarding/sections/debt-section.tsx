'use client';

/**
 * Debt onboarding SECTION — the Setup-Home board card + its ReviewComponent.
 *
 * WRAPS the existing debt engine VERBATIM: the drop-and-parse + confirm flow is the
 * proven `DebtParseReview` modal (DropZone → `POST /api/debt/parse` → confirm the
 * ProposedLoan → `POST /api/debt`, which posts the origination JE and builds the
 * amortization schedule). Covenants reuse the proven `CovenantParseReview` modal
 * (`POST /api/covenants/parse` → confirm → `POST /api/covenants`). We add NO posting
 * and NO schema — only the section idiom (tone, status, n/a, add-later, degrade-safe
 * manual fallback) around those verbatim engines.
 *
 * The client shell renders this keyed on `debtSection.reviewComponentKey` ('debt').
 */

import { useState } from 'react';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import { domainBoardStatus } from '@/lib/onboarding/import/domain-detection';
import { DomainSectionShell, type SectionDisposition } from '@/components/onboarding/sections/domain-section-shell';
import { DebtParseReview } from '../../debt/debt-parse-review';
import { CovenantParseReview } from '../../covenants/covenant-parse-review';

export interface DebtSectionProps {
  /** Loaded onboarding status (drives the Done / Detected / Add-later badge). */
  status: OnboardingStatus | null;
  /** False when the AI seam is off → degrade to the manual fallback. Default true. */
  aiAvailable?: boolean;
  /** Called after a loan or covenant is committed, so the shell can refresh status. */
  onCommitted?: () => void;
}

export function DebtSection({ status, aiAvailable = true, onCommitted }: DebtSectionProps) {
  const [modal, setModal] = useState<null | 'loan' | 'covenant'>(null);
  const [disposition, setDisposition] = useState<SectionDisposition>('none');

  const boardStatus = domainBoardStatus(status, 'debt');

  return (
    <DomainSectionShell
      title="Debt & loans"
      description="Drop a loan agreement and we build the amortization schedule + covenants."
      tone="recommended"
      boardStatus={boardStatus}
      aiAvailable={aiAvailable}
      manualHref="/debt"
      manualLabel="Enter a loan by hand"
      primaryLabel="Drop a loan / promissory note"
      primaryHint="PDF or image · we propose the terms, you confirm"
      onPrimary={() => setModal('loan')}
      secondaryLabel="Have a credit agreement with covenants? Drop it"
      onSecondary={() => setModal('covenant')}
      disposition={disposition}
      onNotApplicable={() => setDisposition('n_a')}
      onSkip={() => setDisposition('skipped')}
      onReset={() => setDisposition('none')}
    >
      {modal === 'loan' && (
        <DebtParseReview
          onClose={() => setModal(null)}
          onConfirmed={() => { setModal(null); setDisposition('done'); onCommitted?.(); }}
        />
      )}
      {modal === 'covenant' && (
        <CovenantParseReview
          onClose={() => setModal(null)}
          onConfirmed={() => { setModal(null); onCommitted?.(); }}
        />
      )}
    </DomainSectionShell>
  );
}
