/**
 * Vendor compliance screen — client-side types and small pure helpers. Server shapes are
 * imported as TYPES only (no server code reaches the client bundle).
 */

import type { QuietHoursSummary } from '@/lib/requests/quiet-display';
import type { PipKind } from '@meritbooks/merit-ui';
import type { Dashboard, DashboardRow, StripCell, TimelineItem } from '@/lib/vendor-compliance/dashboard';
import type { SubmissionRow } from '@/lib/vendor-compliance/review';
import type { BankChangeRow } from '@/lib/vendor-compliance/bank-change';
import type { RequirementSet, RuleOutcome } from '@/lib/vendor-compliance/requirements';

export type { Dashboard, DashboardRow, StripCell, TimelineItem, SubmissionRow, BankChangeRow, RequirementSet, RuleOutcome };

export interface VendorDetail {
  vendor: { id: string; name: string; display_name: string | null; email: string | null; phone: string | null; is_1099_eligible: boolean | null; w9_status: string | null };
  timeline: TimelineItem[];
  submissions: SubmissionRow[];
  bankChanges: BankChangeRow[];
  profile: { vendor_type: string | null; work_type: string | null } | null;
}

export interface QueueRow extends SubmissionRow {
  vendor_name: string;
  vendor_email: string | null;
}

export interface BankChangeListRow extends BankChangeRow {
  vendor_name: string;
  vendor_phone: string | null;
}

export interface RequirementsResponse {
  sets: RequirementSet[];
  companies: Array<{ id: string; name: string }>;
}

export interface ChaseItem {
  vendorId: string;
  vendorName: string;
  email: string | null;
  kind: 'w9' | 'coi';
  renewal: boolean;
  dueDate: string | null;
  reason: string | null;
  status: 'would_send' | 'no_email' | 'already_open' | 'cooling' | 'switch_off';
  liveStatus: 'would_send' | 'no_email' | 'already_open' | 'cooling' | 'switch_off';
  why: string;
}

export interface ChaseResponse {
  switches: { org: { w9: boolean; coi: boolean; renewal: boolean }; byCompany: Record<string, { w9?: boolean; coi?: boolean; renewal?: boolean }> };
  requirementSets: number;
  vendorsChecked: number;
  items: ChaseItem[];
  quietHours: QuietHoursSummary;
}

export interface ActionResponse {
  message?: string;
}

export const VENDOR_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'service_provider', label: '1099 service provider' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'subcontractor', label: 'Subcontractor' },
  { value: 'professional', label: 'Professional services' },
  { value: 'exempt', label: 'Exempt (landlord, utility, government)' },
  { value: 'foreign', label: 'Foreign vendor' },
];

export const vendorTypeLabel = (v: string | null | undefined) => VENDOR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? 'Unclassified';

export const COVERAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'GENERAL_LIABILITY', label: 'General liability' },
  { value: 'WORKERS_COMP', label: "Workers' comp" },
  { value: 'AUTO', label: 'Auto liability' },
  { value: 'UMBRELLA', label: 'Umbrella / excess' },
  { value: 'PROFESSIONAL', label: 'Professional liability' },
  { value: 'POLLUTION', label: 'Pollution' },
  { value: 'OTHER', label: 'Other' },
];

export const PHONE_SOURCE_OPTIONS: Array<{ value: 'vendor_master' | 'prior_document' | 'independent_lookup'; label: string }> = [
  { value: 'vendor_master', label: 'Number on the vendor record (before the change)' },
  { value: 'prior_document', label: 'Number on an earlier invoice or contract' },
  { value: 'independent_lookup', label: 'Looked up independently (website, directory)' },
];

/** Pip + word for one requirement cell (status is never colour alone). */
export function outcomeLook(o: RuleOutcome): { pip: PipKind; word: string } {
  switch (o) {
    case 'met':
      return { pip: 'ready', word: 'Met' };
    case 'expiring':
      return { pip: 'risk', word: 'Expiring' };
    case 'grace':
      return { pip: 'soft', word: 'In grace' };
    case 'pending':
      return { pip: 'open', word: 'In review' };
    case 'short':
      return { pip: 'blocked', word: 'Short' };
    case 'expired':
      return { pip: 'overdue', word: 'Expired' };
    case 'missing':
      return { pip: 'overdue', word: 'Missing' };
    default:
      return { pip: 'blocked', word: 'Not met' };
  }
}

/** The row's one status word. */
export function rowLook(r: Pick<DashboardRow, 'bankChangePending' | 'onHold' | 'missing' | 'pendingReview' | 'expiring' | 'compliant' | 'override'>): { pip: PipKind; word: string; attn: boolean } {
  if (r.bankChangePending) return { pip: 'blocked', word: 'Bank change', attn: true };
  if (r.onHold) return { pip: 'overdue', word: 'On hold', attn: true };
  if (r.missing) return { pip: 'blocked', word: r.override ? 'Override' : 'Missing', attn: !r.override };
  if (r.pendingReview > 0) return { pip: 'open', word: 'In review', attn: false };
  if (r.expiring) return { pip: 'risk', word: 'Expiring', attn: false };
  return { pip: 'ready', word: 'Compliant', attn: false };
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const diff = Math.round((d - Date.now()) / 60_000);
  const abs = Math.abs(diff);
  const unit = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  if (abs < 1) return 'now';
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

export function actorWord(a: string | null): string {
  if (!a) return 'Automatic';
  if (a.startsWith('vendor_token:')) return 'Vendor (portal)';
  if (a.startsWith('system:')) return a === 'system:ai' ? 'AI' : 'Automatic';
  if (a.startsWith('provider:')) return 'Email provider';
  if (a === 'recipient') return 'Vendor';
  return 'Team member';
}

/** Whole dollars typed by a person → integer cents (null for blank). */
export function dollarsToCentsInput(v: string): number | null {
  const s = v.replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function centsToInput(c: number | null | undefined): string {
  if (c === null || c === undefined) return '';
  return c % 100 === 0 ? String(c / 100) : `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}
