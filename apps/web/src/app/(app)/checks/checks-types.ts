/**
 * Client-side shapes of the /api/ap/checks/* responses (kept here, not imported from the
 * server modules, so the client bundle never reaches server code).
 */

import { money } from '@meritbooks/merit-ui';

export type CheckLayout = 'VOUCHER_TOP' | 'VOUCHER_MIDDLE' | 'VOUCHER_BOTTOM' | 'THREE_UP';
export type CheckStatus = 'PRINTED' | 'ISSUED' | 'MAILED' | 'CLEARED' | 'VOIDED' | 'SPOILED';
export type PositivePayFormat = 'GENERIC_CSV' | 'CHASE_STYLE_FIXED' | 'BOFA_STYLE_FIXED' | 'CUSTOM_CSV' | 'CUSTOM_FIXED';

export interface CheckAccount {
  id: string;
  locationId: string;
  name: string;
  institution: string;
  mask: string | null;
  layout: CheckLayout;
  /** A check-stock profile is on file — the picker opens on this account. */
  hasStockProfile?: boolean;
  hasMicr: boolean;
  hasSignature: boolean;
  nextNumber: number;
  outstandingCount: number;
  outstandingCents: number;
}

export interface AccountsResponse {
  accounts: CheckAccount[];
  mail: { configured: boolean; provider: string | null; note: string };
}

export interface ReadyPayment {
  billPaymentId: string;
  billId: string;
  billNumber: string | null;
  billDate: string | null;
  amountCents: number;
  paymentDate: string;
  preparedBy: string;
  approvedBy: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
}

export interface ReadyCheck {
  key: string;
  vendorId: string;
  payeeName: string;
  payeeAddress: string | null;
  hasAddress: boolean;
  amountCents: number;
  payments: ReadyPayment[];
  printable: boolean;
  blockedReason: string | null;
  blockKind: 'sod' | 'limit' | 'vendor_hold' | 'security_hold' | null;
}

export interface ReadyResponse {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string };
  nextNumber: number;
  checks: ReadyCheck[];
  totals: { count: number; amountCents: number; printableCount: number; printableCents: number };
  excluded: { handwritten: number; outsidePayRun: number; vendorHold: number };
  oneCheckPerBill: boolean;
  /** This user changed the account's check security settings < 24 h ago (no printing). */
  securityHold: { reason: string; holdUntil: string } | null;
  names: Record<string, string>;
}

export interface RegisterRow {
  id: string;
  checkNumber: number;
  checkDate: string;
  payeeName: string;
  amountCents: number;
  status: CheckStatus;
  statusLabel: string;
  stale: boolean;
  pastVoidDate: boolean;
  memo: string | null;
  bills: Array<{ billId: string; billNumber: string | null; amountCents: number }>;
  printedBy: string;
  printedAt: string;
  clearedAt: string | null;
  clearedBankTransactionId: string | null;
  clearNote: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  reversalMode: string | null;
  replacesCheckId: string | null;
  sentToBank: boolean;
}

export interface RegisterResponse {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string };
  rows: RegisterRow[];
  total: number;
  page: number;
  pageSize: number;
  nextNumber: number;
  staleAfterDays: number;
  summary: {
    outstandingCount: number;
    outstandingCents: number;
    clearedThisMonthCount: number;
    clearedThisMonthCents: number;
    staleCount: number;
    staleCents: number;
    voidCount: number;
    spoiledCount: number;
    notSentToBank: number;
    lowNumber: number | null;
    highNumber: number | null;
    gaps: number[];
    gapsLabel: string;
    gapsTruncated: boolean;
  };
  names: Record<string, string>;
}

export interface StockProfile {
  layout: CheckLayout;
  offset_x_pt: number | string;
  offset_y_pt: number | string;
  payer_name: string | null;
  payer_address: string | null;
  logo_url: string | null;
  bank_name: string | null;
  bank_address: string | null;
  bank_fraction: string | null;
  routing_mask: string | null;
  account_mask: string | null;
  micr_set_at: string | null;
  micr_set_by: string | null;
  signature_set_at: string | null;
  signature_set_by: string | null;
  signature2_set_at: string | null;
  signature2_set_by: string | null;
  second_signature_over_cents: number | null;
  max_check_cents: number | null;
  void_after_days: number;
  stale_after_days: number;
  one_check_per_bill: boolean;
  aux_on_us_digits: number;
  positive_pay_format: PositivePayFormat;
  positive_pay_mapping: Record<string, unknown> | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface StockResponse {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string; type: string };
  profile: StockProfile | null;
  nextNumber: number;
  hasMicr: boolean;
  hasSignature: boolean;
  hasSignature2: boolean;
  defaults: { payerName: string; logoUrl: string | null };
  /** Signature / bank-number / threshold changes awaiting a second admin (24 h print hold). */
  securityChanges: StockSecurityChange[];
  canConfirmSecurity: boolean;
  names: Record<string, string>;
}

export interface StockSecurityChange {
  id: string;
  change_kind: 'SIGNATURE' | 'SIGNATURE_REMOVED' | 'BANK_NUMBERS' | 'SECOND_SIGNATURE_THRESHOLD' | 'MAX_CHECK_AMOUNT';
  summary: string;
  changed_by: string;
  changed_at: string;
  hold_until: string;
}

export interface PositivePayResponse {
  history: Array<{
    id: string; format: string; mode: string; from_date: string | null; through_date: string | null;
    issue_count: number; void_count: number; issue_total_cents: number; void_total_cents: number;
    file_name: string; generated_by: string; created_at: string;
  }>;
  next: { format: PositivePayFormat; issueCount: number; voidCount: number; issueTotalCents: number; voidTotalCents: number };
  names: Record<string, string>;
}

export function accountLabel(a: { name: string; mask: string | null }): string {
  const last4 = (a.mask ?? '').replace(/\D/g, '').slice(-4);
  return last4 ? `${a.name} ••${last4}` : a.name;
}

export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function who(names: Record<string, string>, id: string | null | undefined, me: string | null | undefined): string {
  if (!id) return '—';
  if (me && id === me) return 'You';
  return names[id] ?? 'A teammate';
}

/**
 * POST JSON and receive a file (PDF / CSV / TXT). Opens PDFs in the pre-opened tab when
 * the browser allowed one, otherwise downloads. Throws the server's error message.
 */
export async function postForFile(url: string, body: unknown, fallbackName: string, tab?: Window | null): Promise<Headers> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    tab?.close();
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  if (tab && blob.type.includes('pdf')) {
    tab.location.href = href;
  } else {
    tab?.close();
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return res.headers;
}

/**
 * Check amounts always carry the "$" (checks, register, positive pay are read as prose and
 * on paper, not under a currency column header). Integer cents in, "$1,234.56" / "($12.00)" out.
 */
export function usd(cents: number): string {
  return money(Math.round(cents), { symbol: '$' });
}
