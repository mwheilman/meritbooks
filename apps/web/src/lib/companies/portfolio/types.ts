/**
 * Shared response/row types for portfolio onboarding (bulk companies, multi-TB drop,
 * Control Tower). Type-only + constants — safe to import from client components.
 */

export const TOWER_STAGES = ['created', 'uploaded', 'matched', 'checked', 'live'] as const;
export type TowerStage = (typeof TOWER_STAGES)[number];

export const TOWER_STAGE_LABEL: Record<TowerStage, string> = {
  created: 'Created',
  uploaded: 'Balances uploaded',
  matched: 'Matched',
  checked: 'Checked',
  live: 'Live',
};

export type OnboardingStatus = 'not_started' | 'in_progress' | 'complete';

export interface TowerSession {
  id: string;
  status: string;
  asOfDate: string | null;
  unmappedCount: number;
  unknownTargetCount: number;
  balanced: boolean;
  tiedOut: boolean;
  posted: boolean;
  postedEntryId: string | null;
  createdAt: string;
}

export interface NextAction {
  kind: 'link' | 'upload' | 'repair_periods';
  label: string;
  href: string | null;
}

export interface TowerRow {
  locationId: string;
  name: string;
  shortCode: string;
  createdAt: string;
  stage: TowerStage;
  stageIndex: number;
  session: TowerSession | null;
  sessionCount: number;
  periodsMissing: boolean;
  openingEntryId: string | null;
  cutoverDate: string | null;
  storedStatus: OnboardingStatus;
  derivedStatus: OnboardingStatus;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  nextAction: NextAction;
}

export interface ControlTowerData {
  rows: TowerRow[];
  counts: Record<TowerStage, number>;
  statusAvailable: boolean;
  ownershipAvailable: boolean;
  /** Companies whose stored onboarding_status lags what their data shows. */
  statusDrift: number;
  generatedAt: string;
}

export interface BulkCreateRowResult {
  index: number;
  name: string;
  ok: boolean;
  locationId?: string;
  shortCode?: string;
  periodsCreated?: number;
  error?: string;
  status?: number;
}

export interface BulkCreateResponse {
  results: BulkCreateRowResult[];
  created: number;
  failed: number;
  accountCount: number | null;
}

export interface TbReadResponse {
  fileName: string;
  titleLines: string[];
  detectedAsOf: string | null;
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  excludedCount: number;
  excluded: { row: number; reason: string }[];
  zeroRows: number;
}
