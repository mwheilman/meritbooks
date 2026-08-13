/**
 * Onboarding shared component kit — the six primitives that make every setup domain
 * feel identical (design spec §6). Later section builders import from here so the
 * "review, don't enter" experience stays consistent.
 */

export { SourceTile, type SourceTileProps } from './source-tile';
export { ProposalCard, type ProposalCardProps } from './proposal-card';
export { TieOutBanner, type TieOutBannerProps, type TieOutState } from './tie-out-banner';
export { DropZone, type DropZoneProps } from './drop-zone';
export { SetupHomeCard, type SetupHomeCardProps } from './setup-home-card';
export { ReadinessMeter, type ReadinessMeterProps } from './readiness-meter';
export { SetupHomeBoard, type SetupHomeBoardProps } from './setup-home-board';
export {
  confidenceBand,
  confidenceLabel,
  deriveBoardCardStatus,
  type ConfidenceBand,
  type ProposalSource,
  type BoardCardStatus,
} from './helpers';
