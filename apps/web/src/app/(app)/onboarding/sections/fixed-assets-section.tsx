'use client';

/**
 * Fixed-assets onboarding SECTION — the Setup-Home board card + its ReviewComponent.
 *
 * WRAPS the existing capex engine VERBATIM via the proven `ImportFromInvoice` modal
 * (DropZone → `POST /api/fixed-assets/parse-invoice` → confirm each ProposedAsset +
 * pick the GL accounts → `POST /api/fixed-assets/parse-invoice/confirm`, which posts
 * the acquisition GL and starts depreciation). We add NO posting and NO schema — only
 * the section idiom. Manual registry entry / a CSV register remain the fallback on the
 * existing `/fixed-assets` surface (degrade-safe when AI is off).
 *
 * The client shell renders this keyed on `fixedAssetsSection.reviewComponentKey`
 * ('fixed_assets').
 */

import { useState } from 'react';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import { domainBoardStatus } from '@/lib/onboarding/import/domain-detection';
import { DomainSectionShell, type SectionDisposition } from '@/components/onboarding/sections/domain-section-shell';
import { ImportFromInvoice } from '../../fixed-assets/import-from-invoice';

export interface FixedAssetsSectionProps {
  status: OnboardingStatus | null;
  aiAvailable?: boolean;
  onCommitted?: () => void;
}

export function FixedAssetsSection({ status, aiAvailable = true, onCommitted }: FixedAssetsSectionProps) {
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState<SectionDisposition>('none');

  const boardStatus = domainBoardStatus(status, 'fixed_assets');

  return (
    <DomainSectionShell
      title="Fixed assets"
      description="Drop a register or capex invoices to build depreciation."
      tone="optional"
      boardStatus={boardStatus}
      aiAvailable={aiAvailable}
      manualHref="/fixed-assets"
      manualLabel="Add an asset by hand"
      primaryLabel="Drop a capex invoice"
      primaryHint="PDF or image · we propose the class, useful life, and method, you confirm"
      onPrimary={() => setOpen(true)}
      disposition={disposition}
      onNotApplicable={() => setDisposition('n_a')}
      onSkip={() => setDisposition('skipped')}
      onReset={() => setDisposition('none')}
    >
      <ImportFromInvoice
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => { setDisposition('done'); onCommitted?.(); }}
      />
    </DomainSectionShell>
  );
}
