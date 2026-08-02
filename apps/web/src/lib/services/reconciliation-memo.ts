/**
 * Bank-reconciliation memo — deterministic fact assembly + prompts (FPB Bank
 * Reconciliation, Wave B). Canon §3: EVERY figure in the memo is computed in code;
 * the model only PHRASES the supplied numbers. If the gateway is unavailable or
 * budget-blocked, `deterministicMemo` produces a truthful memo so a draft always
 * exists. This module is pure — no Supabase, no gateway, no Date.now.
 */

import { formatMoney } from '@meritbooks/shared';

export const RECON_MEMO_FEATURE = 'RECON_MEMO';
// Match the flux-narrative seam: a phrasing task, not a reasoning-over-ledger task.
export const RECON_MEMO_MODEL = 'claude-sonnet-4-20250514';

/** Every deterministic figure the memo describes. All amounts are bigint cents. */
export interface ReconMemoFacts {
  accountName: string;
  accountMask: string;
  locationName: string;
  periodLabel: string;
  statementDate: string;

  beginningBalanceCents: number;
  statementEndingBalanceCents: number;
  glCashBalanceCents: number;

  clearedDepositsCents: number;
  clearedPaymentsCents: number;
  clearedNetCents: number;
  clearedBalanceCents: number;
  clearedCount: number;

  outstandingCount: number;

  differenceCents: number;
  ties: boolean;
  /** Unexplained residual (== differenceCents when it does not tie). Never posted. */
  plugCents: number;

  staleCount: number;
  staleOutstandingChecksCents: number;
  staleDepositsInTransitCents: number;
  staleThresholdDays: number;

  finalized: boolean;
  /** True when finalized via authorized override (a non-zero plug was accepted). */
  overridden: boolean;
  overrideReason: string | null;
}

function money(cents: number): string {
  return formatMoney(cents);
}

/** The fact sheet handed to the model — it phrases these, it does not alter them. */
export function buildMemoFacts(f: ReconMemoFacts): string {
  const lines: string[] = [
    `Account: ${f.accountName}${f.accountMask ? ` (…${f.accountMask})` : ''}${f.locationName ? ` — ${f.locationName}` : ''}`,
    `Period: ${f.periodLabel} (statement date ${f.statementDate})`,
    '',
    `Beginning balance: ${money(f.beginningBalanceCents)}`,
    `Statement ending balance: ${money(f.statementEndingBalanceCents)}`,
    `GL cash balance at period end: ${money(f.glCashBalanceCents)}`,
    '',
    `Cleared this period: ${f.clearedCount} line(s) — deposits ${money(f.clearedDepositsCents)}, payments ${money(f.clearedPaymentsCents)}, net ${money(f.clearedNetCents)}`,
    `Cleared balance (beginning + cleared net): ${money(f.clearedBalanceCents)}`,
    `Outstanding (uncleared) items: ${f.outstandingCount}`,
    '',
    f.ties
      ? `Result: TIES — difference is ${money(f.differenceCents)} ($0).`
      : `Result: DOES NOT TIE — unexplained difference (plug) is ${money(f.plugCents)}. This residual was surfaced, not posted.`,
  ];

  if (f.staleCount > 0) {
    lines.push(
      '',
      `Stale reconciling items (older than ${f.staleThresholdDays} days): ${f.staleCount} — aged outstanding checks ${money(f.staleOutstandingChecksCents)}, aged deposits in transit ${money(f.staleDepositsInTransitCents)}. These need investigation (possible lost/void check or missing deposit).`,
    );
  }

  if (f.finalized) {
    lines.push(
      '',
      f.overridden
        ? `Status: FINALIZED VIA AUTHORIZED OVERRIDE despite a non-zero difference. Override reason: ${f.overrideReason ?? '(none recorded)'}.`
        : 'Status: FINALIZED and locked (tied to $0).',
    );
  } else {
    lines.push('', 'Status: DRAFT (not yet finalized).');
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

/** Deterministic, no-speculation memo used when the AI gateway is unavailable. */
export function deterministicMemo(f: ReconMemoFacts): string {
  const parts: string[] = [];
  parts.push(
    `Reconciliation of ${f.accountName}${f.accountMask ? ` (…${f.accountMask})` : ''} for ${f.periodLabel}. ` +
      `Beginning balance ${money(f.beginningBalanceCents)}; statement ending balance ${money(f.statementEndingBalanceCents)}; ` +
      `GL cash balance ${money(f.glCashBalanceCents)}.`,
  );
  parts.push(
    `${f.clearedCount} line(s) cleared (deposits ${money(f.clearedDepositsCents)}, payments ${money(f.clearedPaymentsCents)}, net ${money(f.clearedNetCents)}), ` +
      `producing a cleared balance of ${money(f.clearedBalanceCents)} against ${f.outstandingCount} outstanding item(s).`,
  );
  if (f.ties) {
    parts.push('The reconciliation ties to the statement with a $0 difference.');
  } else {
    parts.push(
      `The reconciliation does not tie: an unexplained difference (plug) of ${money(f.plugCents)} remains and has been surfaced for investigation, not posted.`,
    );
  }
  if (f.staleCount > 0) {
    parts.push(
      `${f.staleCount} stale reconciling item(s) older than ${f.staleThresholdDays} days were flagged (aged outstanding checks ${money(f.staleOutstandingChecksCents)}, aged deposits in transit ${money(f.staleDepositsInTransitCents)}); each should be investigated for a lost/void check or a missing deposit.`,
    );
  }
  if (f.finalized) {
    parts.push(
      f.overridden
        ? `This reconciliation was finalized via authorized override despite the non-zero difference. Recorded reason: ${f.overrideReason ?? '(none recorded)'}.`
        : 'This reconciliation was finalized and locked.',
    );
  } else {
    parts.push('This reconciliation remains a draft.');
  }
  return parts.join(' ');
}

export const RECON_MEMO_SYSTEM =
  'You are a controller writing the reconciliation memo that documents a monthly bank reconciliation for the workpapers. ' +
  'You are given figures that have ALREADY been computed from the general ledger and the bank statement. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures, counts, and dates provided — never invent, recompute, round differently, or introduce any number not in the facts. ' +
  '(2) If the reconciliation does not tie, state the unexplained difference (the plug) plainly and note it was surfaced for investigation, NOT posted — never imply it was plugged or forced. ' +
  '(3) Call out stale reconciling items as items to investigate. ' +
  '(4) If it was finalized via override, note that an authorized override was used and quote the recorded reason. ' +
  '(5) Write 3-6 tight sentences of professional workpaper prose. No markdown, no headings, no bullet lists — just the paragraph.';

/** Build the user prompt that wraps the fact sheet. */
export function memoUserPrompt(facts: string): string {
  return `FACTS (already computed — phrase these, do not alter any number):\n\n${facts}\n\nWrite the reconciliation memo now.`;
}
