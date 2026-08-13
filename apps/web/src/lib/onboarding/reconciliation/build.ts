/**
 * Conversion Reconciliation — server-side assembly (the impure seam).
 *
 * Sources the two sides the pure modules compare:
 *   • Source figures come from the staged conversion import (the opening TB + any
 *     imported subledger/WIP detail on the ai_decisions session).
 *   • MeritBooks figures come from the LIVE book of record — v_trial_balance (posted
 *     GL), v_ar_aging, v_ap_aging.
 *
 * Every control account is resolved BY ROLE (lib/posting/account-roles.ts) — never a
 * hard-coded number — so a tenant that remapped its COA reconciles correctly. All
 * money is integer cents. The pure math lives in ./tie-out.ts and ./report.ts; this
 * file only fetches and orients.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import type { ConversionSessionData } from '../conversion';
import {
  tieSubledgerToControl,
  subledgerControlBlockers,
  type SubledgerControlTie,
} from './tie-out';
import {
  reconLine,
  buildSection,
  buildReconciliation,
  type ReconLine,
  type ReconSection,
  type ConversionReconciliation,
} from './report';

type DB = SupabaseClient;

/** Debit-positive net for one account number out of the assembled opening balances. */
function openingNetByNumber(data: ConversionSessionData, accountNumber: string): number {
  const l = data.openingBalances.find((b) => b.targetAccountNumber === accountNumber);
  return l ? (l.debitCents || 0) - (l.creditCents || 0) : 0;
}

/** Resolve a control role → account number → live GL debit-positive net (0 when absent). */
async function controlLiveNet(
  db: DB,
  orgId: string,
  role: AccountRoleKey,
  glNetByNumber: Map<string, { name: string; net: number }>,
): Promise<{ accountNumber: string | null; net: number }> {
  try {
    const ref = await resolveRole(db, orgId, role);
    return { accountNumber: ref.account_number, net: glNetByNumber.get(ref.account_number)?.net ?? 0 };
  } catch (e) {
    if (e instanceof PostingError) return { accountNumber: null, net: 0 };
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GO-LIVE GATE — the extended subledger→control / WIP→GL ties.
//
// Computed BEFORE the opening entry posts, from the IMPORTED detail vs the control
// account's OPENING balance (both from the same import). This is the accuracy backbone
// that proves the subledger detail foots to its control before MeritBooks owns the
// ledger. Absent imported detail ⇒ no ties ⇒ no new blockers (backward-compatible).
// ─────────────────────────────────────────────────────────────────────────────

interface GateTieSpec { metric: number | undefined; role: AccountRoleKey; key: string; label: string }

/** Build the subledger→control ties for the go-live gate from the staged session. */
export async function buildGateSubledgerTies(
  db: DB,
  orgId: string,
  data: ConversionSessionData,
): Promise<SubledgerControlTie[]> {
  const detail = data.subledgerDetail;
  if (!detail) return [];

  const specs: GateTieSpec[] = [
    { metric: detail.arOpenByCustomerCents, role: 'AR_CONTROL', key: 'AR', label: 'Accounts Receivable (open, by customer)' },
    { metric: detail.apOpenByVendorCents, role: 'AP_CONTROL', key: 'AP', label: 'Accounts Payable (open, by vendor)' },
    { metric: detail.retainageReceivableCents, role: 'RETAINAGE_RECEIVABLE', key: 'RETAINAGE_REC', label: 'Retainage Receivable' },
    { metric: detail.retainagePayableCents, role: 'RETAINAGE_PAYABLE', key: 'RETAINAGE_PAY', label: 'Retainage Payable' },
    { metric: detail.wipCostsToDateCents, role: 'JOB_WIP', key: 'WIP_COSTS', label: 'WIP costs to date' },
    { metric: detail.unbilledCents, role: 'UNBILLED_RECEIVABLE', key: 'UNBILLED', label: 'Unbilled receivable (contract asset)' },
    { metric: detail.billingsInExcessCents, role: 'DEFERRED_REVENUE', key: 'BILLINGS_EXCESS', label: 'Billings in excess (contract liability)' },
    // Σ customer deposits = CUSTOMER_DEPOSITS control (2420, a liability). Resolved BY
    // ROLE like every other tie; absent detail adds no blocker (metric == null skips).
    { metric: detail.customerDepositsCents, role: 'CUSTOMER_DEPOSITS', key: 'CUSTOMER_DEPOSITS', label: 'Customer deposits (liability)' },
  ];

  const ties: SubledgerControlTie[] = [];
  for (const s of specs) {
    if (s.metric == null) continue;
    let controlAbs = 0;
    try {
      const ref = await resolveRole(db, orgId, s.role);
      controlAbs = Math.abs(openingNetByNumber(data, ref.account_number));
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
      // Control account unresolved → treat as 0 so an imported detail with no control
      // surfaces as a variance (the detail literally has nowhere to foot to).
    }
    ties.push(tieSubledgerToControl(s.key, s.label, s.role, Math.abs(s.metric), controlAbs));
  }
  return ties;
}

/** Convenience: the blocker strings the go-live gate appends. */
export async function gateSubledgerBlockers(
  db: DB,
  orgId: string,
  data: ConversionSessionData,
): Promise<string[]> {
  return subledgerControlBlockers(await buildGateSubledgerTies(db, orgId, data));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSION RECONCILIATION REPORT — MeritBooks (live) vs Source (import).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconciliationBuildResult {
  report: ConversionReconciliation;
  /** MeritBooks-internal subledger→control ties from LIVE data (informational + gate). */
  internalTies: SubledgerControlTie[];
  companyShortCode: string;
  asOfDate: string;
  posted: boolean;
}

async function sumAgingView(db: DB, view: 'v_ar_aging' | 'v_ap_aging', locationId: string): Promise<number> {
  const { data } = await db.from(view).select('balance_cents').eq('location_id', locationId).gt('balance_cents', 0);
  let total = 0;
  for (const r of (data ?? []) as { balance_cents: number | null }[]) total += Number(r.balance_cents ?? 0);
  return total;
}

/**
 * Assemble the full reconciliation for one conversion session. Deterministic given
 * the DB state + `generatedAt` (passed in, never read from the clock here).
 */
export async function buildConversionReconciliation(
  db: DB,
  orgId: string,
  session: { data: ConversionSessionData; postedGlEntryId: string | null },
  generatedAt: string,
): Promise<ReconciliationBuildResult> {
  const data = session.data;
  const locationId = data.companyId;

  // Live GL trial balance for this company (debit-positive net per account).
  const { data: tbRows } = await db
    .from('v_trial_balance')
    .select('account_number, account_name, total_debits, total_credits')
    .eq('location_id', locationId);
  const glNetByNumber = new Map<string, { name: string; net: number }>();
  for (const r of (tbRows ?? []) as { account_number: string; account_name: string | null; total_debits: number | null; total_credits: number | null }[]) {
    const num = String(r.account_number);
    const net = Number(r.total_debits ?? 0) - Number(r.total_credits ?? 0);
    glNetByNumber.set(num, { name: String(r.account_name ?? ''), net });
  }

  // ── Section 1: Opening Balance Sheet / Trial Balance ──────────────────────────
  const bsLines: ReconLine[] = [];
  const seen = new Set<string>();
  for (const ob of data.openingBalances) {
    const src = (ob.debitCents || 0) - (ob.creditCents || 0);
    const gl = glNetByNumber.get(ob.targetAccountNumber)?.net ?? 0;
    bsLines.push(reconLine(ob.targetAccountNumber, `${ob.targetAccountNumber}${ob.targetName ? ` — ${ob.targetName}` : ''}`, src, gl));
    seen.add(ob.targetAccountNumber);
  }
  // GL accounts with a balance that the source opening entry never touched (e.g.
  // post-conversion activity, or an account the mapping missed) — a non-zero variance.
  for (const [num, v] of glNetByNumber) {
    if (seen.has(num) || v.net === 0) continue;
    bsLines.push(reconLine(num, `${num}${v.name ? ` — ${v.name}` : ''}`, 0, v.net));
  }
  bsLines.sort((a, b) => a.key.localeCompare(b.key));
  const openingBs = buildSection('OPENING_BS', 'Opening Balance Sheet (Trial Balance)', bsLines, { applicable: true });

  // ── Section 2: A/R Aging ──────────────────────────────────────────────────────
  const arMerit = await sumAgingView(db, 'v_ar_aging', locationId);
  const arSource = data.subledgerDetail?.arOpenByCustomerCents;
  const arApplicable = arSource != null;
  const arSection = buildSection(
    'AR_AGING',
    'A/R Aging (trade receivables)',
    [reconLine('AR_TOTAL', 'Total open trade A/R', arSource ?? arMerit, arMerit)],
    {
      applicable: arApplicable,
      note: arApplicable
        ? undefined
        : 'No source A/R aging was imported for this conversion — showing the live A/R subledger total for reference (it ties to the 1100 control below).',
    },
  );

  // ── Section 3: A/P Aging ──────────────────────────────────────────────────────
  const apMerit = await sumAgingView(db, 'v_ap_aging', locationId);
  const apSource = data.subledgerDetail?.apOpenByVendorCents;
  const apApplicable = apSource != null;
  const apSection = buildSection(
    'AP_AGING',
    'A/P Aging (trade payables)',
    [reconLine('AP_TOTAL', 'Total open trade A/P', apSource ?? apMerit, apMerit)],
    {
      applicable: apApplicable,
      note: apApplicable
        ? undefined
        : 'No source A/P aging was imported for this conversion — showing the live A/P subledger total for reference.',
    },
  );

  // ── Section 4: WIP schedule (job businesses) ─────────────────────────────────
  // Source = imported WIP figures; MeritBooks = the contract accounts' live GL
  // balances (WIP→GL ties, spec §4). Applicable only when WIP detail was imported.
  const wipCostsSrc = data.subledgerDetail?.wipCostsToDateCents;
  const unbilledSrc = data.subledgerDetail?.unbilledCents;
  const billingsExcessSrc = data.subledgerDetail?.billingsInExcessCents;
  const wipApplicable = wipCostsSrc != null || unbilledSrc != null || billingsExcessSrc != null;

  const wipAsset = await controlLiveNet(db, orgId, 'JOB_WIP', glNetByNumber);
  const unbilled = await controlLiveNet(db, orgId, 'UNBILLED_RECEIVABLE', glNetByNumber);
  const billingsExcess = await controlLiveNet(db, orgId, 'DEFERRED_REVENUE', glNetByNumber);

  const wipLines: ReconLine[] = [];
  if (wipCostsSrc != null) wipLines.push(reconLine('WIP_COSTS', 'Σ costs to date → WIP / job-cost asset', wipCostsSrc, Math.abs(wipAsset.net)));
  if (unbilledSrc != null) wipLines.push(reconLine('UNBILLED', 'Σ unbilled → contract asset (1180)', unbilledSrc, Math.abs(unbilled.net)));
  if (billingsExcessSrc != null) wipLines.push(reconLine('BILLINGS_EXCESS', 'Σ billings in excess → contract liability (2410)', billingsExcessSrc, Math.abs(billingsExcess.net)));
  const wipSection: ReconSection = buildSection('WIP', 'WIP Schedule (contract accounts)', wipLines, {
    applicable: wipApplicable,
    note: wipApplicable ? undefined : 'Not a percentage-of-completion / job business, or no WIP detail was imported — WIP reconciliation does not apply.',
  });

  const report = buildReconciliation([openingBs, arSection, apSection, wipSection], generatedAt);

  // MeritBooks-internal subledger→control ties from LIVE data (always meaningful).
  const arControl = await controlLiveNet(db, orgId, 'AR_CONTROL', glNetByNumber);
  const apControl = await controlLiveNet(db, orgId, 'AP_CONTROL', glNetByNumber);
  const internalTies: SubledgerControlTie[] = [
    tieSubledgerToControl('AR', 'Trade A/R subledger', 'AR_CONTROL', Math.abs(arMerit), Math.abs(arControl.net)),
    tieSubledgerToControl('AP', 'Trade A/P subledger', 'AP_CONTROL', Math.abs(apMerit), Math.abs(apControl.net)),
  ];

  return {
    report,
    internalTies,
    companyShortCode: data.companyShortCode,
    asOfDate: data.asOfDate,
    posted: !!session.postedGlEntryId,
  };
}
