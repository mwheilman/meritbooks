import type {
  SourceLine,
  MappingTable,
  OpeningBalanceLine,
  BalanceCheck,
  BalanceSheetCheck,
  ConversionIntakeNotes,
} from '@/lib/onboarding/conversion';
import type { SubledgerControlTie } from '@/lib/onboarding/reconciliation/tie-out';

export interface Company { id: string; name: string; short_code: string }
export interface CoaAccount { accountNumber: string; name: string; accountType: string }

/** The review-screen view returned by GET/PATCH /api/onboarding/conversion/:id (and …/mapping). */
export interface SessionView {
  id: string;
  status: string;
  posted: boolean;
  postedGlEntryId?: string | null;
  companyId: string;
  companyShortCode: string;
  companyName?: string | null;
  asOfDate: string;
  takeoverDate?: string | null;
  sourceLines: SourceLine[];
  mapping: MappingTable;
  openingBalances: OpeningBalanceLine[];
  balance: BalanceCheck;
  balanceSheet?: BalanceSheetCheck;
  unmapped: string[];
  unknownTargets: string[];
  sourceTotals: { debitCents: number; creditCents: number };
  plAcknowledged?: boolean;
  intake?: ConversionIntakeNotes;
  /** EVERY go-live blocker (base TB + subledger→control ties), in dollars. */
  blockers: string[];
  subledgerTies?: SubledgerControlTie[];
  cutover?: { state: 'ready' | 'will_create' | 'locked'; message: string | null };
  tiedOut: boolean;
  tiedOutBy: string | null;
  tiedOutAt: string | null;
}

export interface PostResult {
  ok: boolean;
  glEntryId?: string;
  entryNumber?: string;
  lineCount?: number;
  totalDebitCents?: number;
  alreadyPosted?: boolean;
  periodsCreated?: number;
}

/** What POST /api/onboarding/import/tb returns (spreadsheet or document path). */
export interface TbImportResponse {
  source?: 'spreadsheet' | 'spreadsheet-raw';
  mapping?: Record<string, string>;
  headers?: string[];
  rows?: Record<string, string>[];
  rowNumbers?: number[];
  asOfDateHint?: string | null;
  notice?: string;
  dropped?: { row?: number; snippet?: string; reason?: string }[];
  detected?: { sheetName: string | null; headerRow: number; titleLines: string[] };
  meta?: { fileName?: string; lineCount?: number; droppedCount?: number };
  error?: string;
  /** e.g. 'GL_DETAIL_NOT_TB' — the file is a General Ledger detail export, not a TB. */
  code?: string;
  needsTrialBalance?: boolean;
}

/** A file read and ready for the "Check columns" step. */
export interface LoadedFile {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  rowNumbers: number[] | null;
  /** True when we recognized the columns ourselves (QuickBooks / standard layout). */
  recognized: boolean;
  asOfDateHint: string | null;
  notice: string | null;
  skipped: { row: number | null; reason: string }[];
  titleLines: string[];
}

export type Step = 'setup' | 'map' | 'review' | 'done';
export const NONE = '__none__';
