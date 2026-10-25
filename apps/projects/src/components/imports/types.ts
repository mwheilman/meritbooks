/** Client shapes of the /api/imports responses. */
import type { BatchSummary, CommitResult, Disposition, ImportEntity, OpeningKind, PreviewResult, SourceSystem, StageResult, TieOut } from '@/lib/imports/types';

export interface SourceCard {
  id: SourceSystem;
  name: string;
  family: 'residential' | 'field_service' | 'dealer' | 'commercial' | 'accounting' | 'generic';
  viaBooks: boolean;
  howToExport: readonly string[];
  files: { entity: ImportEntity; label: string; effect: string; disposition: Disposition }[];
}

export interface HandoffSummary {
  id: string;
  kind: OpeningKind;
  as_of_date: string;
  status: string;
  totals: Record<string, number>;
  blockers: { ref: string | null; message: string }[];
  tieSummary: TieOut['summary'] | null;
  books_ref: string | null;
  books_reason: string | null;
}

export interface CatalogResponse {
  sources: SourceCard[];
  batches: BatchSummary[];
  handoffs: HandoffSummary[];
}

export interface PreviewResponse {
  batchId: string;
  staged: StageResult;
  preview: PreviewResult & { rowsShown: number };
  entityReport: (Record<string, unknown> & { kind: 'agreements' | 'units' | 'wip' | 'open_ar' }) | null;
  importerReport: Record<string, unknown> | null;
}

export interface CommitResponse {
  result: CommitResult;
  openingKind: OpeningKind | null;
}

export interface OpeningResponse {
  handoff: { handoff_id: string; status: string; totals: Record<string, number>; blockers: { ref: string | null; message: string }[] };
  warnings: { ref: string | null; message: string }[];
  tieout: TieOut;
}
