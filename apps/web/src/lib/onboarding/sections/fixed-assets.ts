/**
 * Onboarding SECTION — Fixed assets (Setup Home board, design spec §3).
 *
 * WRAPS the existing capex drop-and-parse + deterministic commit engine VERBATIM:
 *   DropZone (capex invoice) → `POST /api/fixed-assets/parse-invoice`
 *   (`lib/fixed-assets/asset-parse`) → human confirms each ProposedAsset (class,
 *   useful life, method, cost) and picks the GL accounts (the engine never guesses)
 *   → `POST /api/fixed-assets/parse-invoice/confirm`, which posts the acquisition GL
 *   and starts depreciation. Manual registry entry / a CSV register stay the fallback
 *   (the existing `/fixed-assets` surface owns them). This module changes NO posting,
 *   NO schema.
 *
 * PURE + isomorphic (no React): the ReviewComponent is supplied by the client shell
 * keyed on `reviewComponentKey` (see app/(app)/onboarding/sections/fixed-assets-section.tsx).
 */

import { Package } from 'lucide-react';
import type { SetupHomeDomain } from './setup-home';
import {
  type DomainSectionMeta,
  deriveDomainBoardStatus,
  domainSectionStatus,
  readDomainHint,
} from '@/lib/onboarding/import/domain-detection';

const DESCRIPTION = 'Drop a register or capex invoices to build depreciation.';

/** SectionDefinition-shaped metadata (string-keyed superset — see DomainSectionMeta). */
export const fixedAssetsSection: DomainSectionMeta = {
  key: 'fixed_assets',
  label: 'Fixed assets',
  icon: Package,
  tone: 'optional',
  domainKind: 'fixed_assets',
  importSources: ['document', 'csv', 'manual'],
  skippable: true,
  notApplicable: true, // "No fixed assets" is a valid answer
  href: '/fixed-assets',
  reviewComponentKey: 'fixed_assets',
  deriveStatus: (status) => domainSectionStatus(status, 'fixed_assets'),
};

/** Setup Home board descriptor — drop-in replacement for the `fixed_assets` entry in SETUP_HOME_DOMAINS. */
export const fixedAssetsBoardDescriptor: SetupHomeDomain = {
  key: 'fixed_assets',
  title: 'Fixed assets',
  description: DESCRIPTION,
  // Onboarding section host mounts FixedAssetsSection (deep-links to /fixed-assets for manual).
  href: '/onboarding/sections/fixed-assets',
  deriveStatus: (status) => deriveDomainBoardStatus(readDomainHint(status, 'fixed_assets')),
};
