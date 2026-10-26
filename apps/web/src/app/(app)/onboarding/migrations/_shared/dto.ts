/**
 * Response shapes of /api/onboarding/migrations/* as the screens read them. Type-only
 * imports of the server modules (erased at build — no server code reaches the client).
 */

import type { TowerData, TowerRow, TowerWave } from '@/lib/onboarding/migration/server/tower';
import type { ProjectRow, PersonRef } from '@/lib/onboarding/migration/server/store';
import type { SourceView, QboState } from '@/lib/onboarding/migration/server/projects';
import type { FindingRow } from '@/lib/onboarding/migration/server/preflight';
import type { MappingRow, RuleView } from '@/lib/onboarding/migration/server/mapping';
import type { MasterView } from '@/lib/onboarding/migration/server/masters';
import type { CertificateView } from '@/lib/onboarding/migration/server/certificate';
import type { OpenItemsPayload } from '@/lib/onboarding/migration/server/load';
import type { BuyInView } from '@/lib/onboarding/migration/server/buyin';
import type { BlockerSummary, NextAction, StageFacts, StageState } from '@/lib/onboarding/migration/stages';
import type { MappingTarget, Stage } from '@/lib/onboarding/migration/types';
import type { BandTotals } from '@/lib/onboarding/migration/mapping/cascade';

export type { TowerData, TowerRow, TowerWave, FindingRow, MappingRow, RuleView, MasterView, CertificateView, OpenItemsPayload, BuyInView, PersonRef };

export type WorkspaceSource = Omit<SourceView, 'system'> & { systemName: string; bridgeViaQuickBooks: boolean; ongoingFeed: boolean };

export interface WorkspaceData {
  project: ProjectRow;
  client: { id: string; name: string; short_code: string } | null;
  wave: { id: string; name: string; cutover_date: string; purpose: string | null } | null;
  stages: StageState[];
  current: Stage;
  next: NextAction;
  blockers: BlockerSummary;
  facts: StageFacts;
  sources: WorkspaceSource[];
  people: PersonRef[];
  names: { lead: string | null; preparer: string | null; reviewer: string | null };
  events: Array<{ id: string; kind: string; actor: string | null; actor_kind: string; summary: string; created_at: string; actorName: string | null }>;
  qbo: QboState;
  session: { id: string; posted: boolean; postedEntryId: string | null } | null;
  certificate: { id: string; status: 'prepared' | 'issued' | 'voided'; number: string; preparedBy: string; approvedBy: string | null } | null;
  me: string;
}

export interface PreflightData {
  checks: ReadonlyArray<{ id: string; name: string; blocking: boolean }>;
  findings: FindingRow[];
  report: { fixInSource: FindingRow[]; handled: FindingRow[]; passed: number };
}

export interface MappingData {
  rows: MappingRow[];
  targets: MappingTarget[];
  set: { id: string; name: string } | null;
  totals: BandTotals;
  accepted: { count: number; cents: number };
  aiConfigured: boolean;
}

export interface RulesData {
  sets: Array<{ id: string; name: string; family: string; rules: number; conflicts: number }>;
  rules: RuleView[];
  targets: MappingTarget[];
}
