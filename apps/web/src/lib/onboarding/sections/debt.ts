/**
 * Onboarding SECTION — Debt & loans (Setup Home board, design spec §3).
 *
 * WRAPS the existing debt drop-and-parse + deterministic commit engine VERBATIM:
 *   DropZone → `POST /api/debt/parse` (feature DEBT_EXTRACT, `lib/debt/parse-loan`)
 *   → human confirms the ProposedLoan (principal, rate, term, maturity, payment) with
 *     `lowConfidenceFields` flagged → `POST /api/debt` (the gated create path, which
 *     now posts the origination JE and builds the amortization schedule deterministically).
 * Covenants: drop a credit agreement → `POST /api/covenants/parse` → confirm →
 *   `POST /api/covenants`. This module changes NO posting, NO schema — it only
 *   describes the section + derives its board/section status.
 *
 * PURE + isomorphic (no React): the ReviewComponent is supplied by the client shell
 * keyed on `reviewComponentKey` (see app/(app)/onboarding/sections/debt-section.tsx),
 * matching the Wave-0 convention that the shell owns the per-section UI.
 */

import { Landmark } from 'lucide-react';
import type { SetupHomeDomain } from './setup-home';
import {
  type DomainSectionMeta,
  deriveDomainBoardStatus,
  domainSectionStatus,
  readDomainHint,
} from '@/lib/onboarding/import/domain-detection';

const DESCRIPTION = 'Drop a loan agreement and we build the amortization schedule + covenants.';

/** SectionDefinition-shaped metadata (string-keyed superset — see DomainSectionMeta). */
export const debtSection: DomainSectionMeta = {
  key: 'debt',
  label: 'Debt & loans',
  icon: Landmark,
  tone: 'recommended', // debt is common enough to nudge, never to gate
  domainKind: 'debt',
  importSources: ['document', 'manual'],
  skippable: true,
  notApplicable: true, // "No debt" is a valid, common answer
  href: '/debt',
  reviewComponentKey: 'debt',
  deriveStatus: (status) => domainSectionStatus(status, 'debt'),
};

/** Setup Home board descriptor — drop-in replacement for the `debt` entry in SETUP_HOME_DOMAINS. */
export const debtBoardDescriptor: SetupHomeDomain = {
  key: 'debt',
  title: 'Debt & loans',
  description: DESCRIPTION,
  // Onboarding section host mounts DebtSection (which deep-links to /debt for manual).
  href: '/onboarding/sections/debt',
  deriveStatus: (status) => deriveDomainBoardStatus(readDomainHint(status, 'debt')),
};
