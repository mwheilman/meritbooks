/**
 * Documents center — client-side shapes and pure display helpers (FPB-document-intelligence §8).
 */

import type { StatusKind } from '@meritbooks/merit-ui';
import { DOC_TYPE_LABEL, type DocumentRow } from '@/lib/documents/schema';
import { DOC_CLASS_LABEL, STATUS_LABEL, type IntelligenceDto, type LinkDto, type ProposalSummaryDto } from '@/lib/documents/intelligence/types';

export type Band = 'all' | 'review' | 'proposals' | 'unfiled';

export interface DocListResponse {
  data: DocumentRow[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

export interface IntelSummary {
  needs_review: number;
  proposals_pending: number;
  ai_deferred: number;
  not_analyzed: number;
}

export interface IntelResponse {
  data: IntelligenceDto[];
  proposals: ProposalSummaryDto[];
  links: LinkDto[];
  summary: IntelSummary;
}

export interface LocationOption {
  id: string;
  name: string;
}

/** One row of the center: the stored file + what we know about it. */
export interface CenterRow {
  doc: DocumentRow;
  intel: IntelligenceDto | null;
  proposals: ProposalSummaryDto[];
  links: LinkDto[];
}

export interface AnalyzeResponse {
  intelligence: IntelligenceDto | null;
  proposals: ProposalSummaryDto[];
  message: string;
  skipped: string | null;
}

export function typeLabel(r: CenterRow): string {
  if (r.intel && (r.intel.doc_class !== 'other' || r.intel.status !== 'needs_review')) return DOC_CLASS_LABEL[r.intel.doc_class];
  return DOC_TYPE_LABEL[r.doc.doc_type] ?? 'Other';
}

export function statusOf(r: CenterRow): { kind: StatusKind; word: string } {
  const i = r.intel;
  if (!i) {
    if (r.doc.entity_type && r.doc.entity_type !== 'location') return { kind: 'ready', word: 'Filed by module' };
    return { kind: 'track', word: 'Not analyzed' };
  }
  const later = i.next_retry_at ? ' · AI later' : '';
  switch (i.status) {
    case 'needs_review':
      return { kind: 'risk', word: `${STATUS_LABEL.needs_review}${later}` };
    case 'proposal_created':
      return { kind: 'track', word: `${STATUS_LABEL.proposal_created}${later}` };
    case 'accepted':
    case 'linked':
    case 'routed':
      return { kind: 'ready', word: STATUS_LABEL[i.status] };
    case 'duplicate':
    case 'dismissed':
      return { kind: 'blocked', word: STATUS_LABEL[i.status] };
    default:
      return { kind: 'track', word: `${STATUS_LABEL[i.status]}${later}` };
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const KEY_DATE_LABEL: Record<string, string> = {
  effective_date: 'Effective',
  expiration_date: 'Expires',
  maturity_date: 'Matures',
  due_date: 'Due',
  period_start: 'Period from',
  period_end: 'Period to',
  document_date: 'Dated',
};

/** Record types a person can link a document to (Link to existing record). */
export const LINK_TYPES: Array<{ value: string; label: string }> = [
  { value: 'lease', label: 'Lease' },
  { value: 'debt_instrument', label: 'Loan' },
  { value: 'policy', label: 'Insurance policy' },
  { value: 'prepaid', label: 'Prepaid schedule' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'fixed_asset', label: 'Fixed asset' },
  { value: 'bill', label: 'Bill' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'customer_contract', label: 'Recurring invoice' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'customer', label: 'Customer' },
  { value: 'payroll_run', label: 'Payroll run' },
  { value: 'bank_account', label: 'Bank account' },
  { value: 'location', label: 'Company' },
];
