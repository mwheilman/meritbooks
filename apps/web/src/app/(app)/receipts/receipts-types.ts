/**
 * Shapes the /receipts screens read from the API (lib/receipts + app/api/receipts/*).
 */
import { money, type PipKind } from '@meritbooks/merit-ui';
import type { ChargeState, MatchStatus } from '@/lib/receipts/types';
import type { OlderCharge, OlderUnreceipted, OutstandingGroup, OutstandingStrip } from '@/lib/receipts/bookkeeper';
import type { ReceiptPolicy } from '@/lib/receipts/policy';
import type { QuietHoursSummary } from '@/lib/requests/quiet-display';

export type { OlderCharge, OlderUnreceipted, OutstandingGroup, OutstandingStrip, ReceiptPolicy };
export type OutstandingCharge = OutstandingGroup['charges'][number];

export interface ChaseResponse {
  groups: OutstandingGroup[];
  strip: OutstandingStrip;
  chase: { tenantEnabled: boolean; clientEnabled: boolean | null };
  /** Charges older than the chase window with no receipt (null if it could not be read). */
  older: OlderUnreceipted | null;
}

/** Receipt amounts always carry the "$" (summaries, captions and cells alike). */
export function usd(cents: number): string {
  return money(Math.round(cents), { symbol: '$' });
}

export interface ChargeRef {
  id: string;
  description: string;
  amountCents: number;
  date: string;
}

export interface ReceiptListRow {
  id: string;
  submitted_at: string;
  receipt_date: string | null;
  vendor_name: string | null;
  amount_cents: number | null;
  source: 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';
  status: string;
  ai_confidence: number | null;
  chase_reminder_count: number;
  match_status: MatchStatus;
  match_score: number | null;
  match_method: string | null;
  extraction_status: string;
  memo: string | null;
  flags: string[];
  location: { id: string; name: string; short_code: string } | null;
  account: { id: string; account_number: string; name: string } | null;
  holder_name: string | null;
  matched_charge: ChargeRef | null;
  suggested_charge: ChargeRef | null;
}

export interface ReceiptListResponse {
  data: ReceiptListRow[];
  counts: Record<'all' | 'unmatched' | 'suggested' | 'matched', number>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

export interface ReceiptDetail {
  id: string;
  source: string;
  file: { url: string; fileName: string; mimeType: string | null } | null;
  submittedAt: string;
  receiptDate: string | null;
  status: string;
  vendorName: string | null;
  amountCents: number | null;
  aiConfidence: number | null;
  accountLabel: string | null;
  locationId: string;
  locationName: string;
  locationCode: string;
  departmentLabel: string | null;
  jobLabel: string | null;
  memo: string | null;
  holder: { name: string; email: string | null } | null;
  chaseReminderCount: number;
  posted: boolean;
  matchStatus: MatchStatus;
  matchScore: number | null;
  matchMethod: string | null;
  matchedAt: string | null;
  matchedCharge: ChargeRef | null;
  suggestedCharge: ChargeRef | null;
  extractionStatus: string;
  extraction: { source: string | null; subtotalCents: number | null; taxCents: number | null; tipCents: number | null; cardLast4: string | null; note: string | null } | null;
  flags: string[];
}

export interface CandidatesResponse {
  candidates: Array<{
    charge: { id: string; description: string; amountCents: number; chargeDate: string; cardAssignmentId: string | null };
    score: { total: number; vendor: number; amount: number; date: number; amountBasis: string } | null;
  }>;
  autoMatchMin: number;
  suggestMin: number;
}

export interface CardholderRow {
  id: string;
  location_id: string;
  bank_account_id: string | null;
  card_last4: string | null;
  card_label: string | null;
  holder_type: 'member' | 'employee' | 'external';
  membership_id: string | null;
  employee_id: string | null;
  holder_name: string;
  holder_email: string | null;
  holder_phone: string | null;
  holder_timezone: string | null;
  manager_membership_id: string | null;
  active: boolean;
  starts_on: string | null;
  ends_on: string | null;
  chase_opt_out: boolean;
  opt_out_status: 'none' | 'pending' | 'approved' | 'rejected';
  opt_out_reason: string | null;
  opt_out_requested_by: string | null;
  open_count: number;
  open_cents: number;
}

export interface CardholderOptions {
  accounts: Array<{ id: string; label: string; type: string; institution: string; mask: string | null }>;
  members: Array<{ id: string; name: string; email: string | null; role: string }>;
  employees: Array<{ id: string; name: string; email: string | null; phone: string | null; title: string | null }>;
}

export interface PolicyResponse {
  tenant: ReceiptPolicy;
  client: ReceiptPolicy | null;
  clientOverrides: Record<string, unknown> | null;
  switches: {
    tenantEnabled: boolean;
    tenantChangedAt: string | null;
    tenantChangedBy: string | null;
    clientSetting: boolean | null;
    clientChangedAt: string | null;
    effective: boolean;
  };
  cadence: { firstReminderMinutes: number; channel: string | null; quietStart: string | null; quietEnd: string | null; timezone: string | null };
  quietHours: QuietHoursSummary | null;
}

export interface ActionResult {
  ok?: boolean;
  message?: string;
}

export const STATE_LOOK: Record<ChargeState, { pip: PipKind; word: string }> = {
  needed: { pip: 'open', word: 'Needs a receipt' },
  requested: { pip: 'track', word: 'Asked' },
  matched: { pip: 'ready', word: 'Receipt in' },
  not_required: { pip: 'closed', word: 'Not required' },
  below_threshold: { pip: 'closed', word: 'Under the limit' },
  chase_off: { pip: 'soft', word: 'Chase off' },
  no_cardholder: { pip: 'blocked', word: 'No cardholder' },
  opted_out: { pip: 'soft', word: 'Opted out' },
};

export const MATCH_LOOK: Record<MatchStatus, { pip: PipKind; word: string }> = {
  matched: { pip: 'ready', word: 'Matched' },
  suggested: { pip: 'risk', word: 'Confirm match' },
  unmatched: { pip: 'open', word: 'No charge yet' },
  not_required: { pip: 'closed', word: 'Kept, no charge' },
};

export const SOURCE_LABEL: Record<ReceiptListRow['source'], string> = {
  MOBILE_CAPTURE: 'Merit Workforce',
  EMAIL: 'Email',
  MANUAL_UPLOAD: 'Desk upload',
};

export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const future = ms < 0;
  const m = Math.round(Math.abs(ms) / 60_000);
  const txt = m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return future ? `in ${txt}` : `${txt} ago`;
}
