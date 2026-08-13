/**
 * Onboarding SECTION — Leases (Setup Home board, design spec §3).
 *
 * WRAPS the existing lease drop-and-parse + deterministic commit engine VERBATIM:
 *   DropZone → `POST /api/leases/parse` (`lib/leases/parse-lease`) → human confirms
 *   the ProposedLease (lessor, classification, dates, payment, term, discount rate)
 *   with `lowConfidenceFields` flagged → `POST /api/leases`, the gated create path
 *   that computes the ROU asset + lease liability at present value and the full ASC 842
 *   schedule. This module changes NO posting, NO schema.
 *
 * PURE + isomorphic (no React): the ReviewComponent is supplied by the client shell
 * keyed on `reviewComponentKey` (see app/(app)/onboarding/sections/leases-section.tsx).
 */

import { Building2 } from 'lucide-react';
import type { SetupHomeDomain } from './setup-home';
import {
  type DomainSectionMeta,
  deriveDomainBoardStatus,
  domainSectionStatus,
  readDomainHint,
} from '@/lib/onboarding/import/domain-detection';

const DESCRIPTION = 'Drop a lease PDF for the ROU asset and lease liability (ASC 842).';

/** SectionDefinition-shaped metadata (string-keyed superset — see DomainSectionMeta). */
export const leasesSection: DomainSectionMeta = {
  key: 'leases',
  label: 'Leases',
  icon: Building2,
  tone: 'optional',
  domainKind: 'leases',
  importSources: ['document', 'manual'],
  skippable: true,
  notApplicable: true, // "No leases" is a valid answer
  href: '/leases',
  reviewComponentKey: 'leases',
  deriveStatus: (status) => domainSectionStatus(status, 'leases'),
};

/** Setup Home board descriptor — drop-in replacement for the `leases` entry in SETUP_HOME_DOMAINS. */
export const leasesBoardDescriptor: SetupHomeDomain = {
  key: 'leases',
  title: 'Leases',
  description: DESCRIPTION,
  // Onboarding section host mounts LeasesSection (which deep-links to /leases for manual).
  href: '/onboarding/sections/leases',
  deriveStatus: (status) => deriveDomainBoardStatus(readDomainHint(status, 'leases')),
};
