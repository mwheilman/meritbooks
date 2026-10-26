/**
 * One view of the client's OLD chart at cutover, merged from what was staged: the trial
 * balance (balances — the authority) and the chart of accounts / account list (types,
 * detail types, active flag). Pure; shared by matching, the 24 checks and the certificate.
 */

import type { MeritAccountType, StagedAccount, StagedTbLine } from './types';
import { inferAccountType } from './recognize';
import { nameKey } from './mapping/memory';

export interface SourceAccountView {
  /** Stable key within a project: the account number when there is one, else the name. */
  key: string;
  number: string | null;
  name: string;
  type: MeritAccountType | null;
  sourceType: string | null;
  detailType: string | null;
  active: boolean;
  /** Debit-positive balance at cutover (from the trial balance when one was staged). */
  balanceCents: number;
  fromTb: boolean;
}

const hasDigit = (s: string) => /\d/.test(s);

/** Account number when the staged "number" is really a number (not the name repeated). */
function numberOf(n: string | null | undefined, name: string): string | null {
  const v = (n ?? '').trim();
  if (!v || v === name.trim() || !hasDigit(v)) return null;
  return v;
}

export function mergeSourceAccounts(accounts: ReadonlyArray<StagedAccount>, tbLines: ReadonlyArray<StagedTbLine>): SourceAccountView[] {
  const byNumber = new Map<string, StagedAccount>();
  const byName = new Map<string, StagedAccount>();
  for (const a of accounts) {
    const num = numberOf(a.number, a.name);
    if (num) byNumber.set(num, a);
    const nk = nameKey(a.name);
    if (nk) byName.set(nk, a);
  }
  const out = new Map<string, SourceAccountView>();
  const hasTb = tbLines.length > 0;

  for (const l of tbLines) {
    const num = numberOf(l.number, l.name);
    const meta = (num ? byNumber.get(num) : undefined) ?? byName.get(nameKey(l.name) ?? '');
    const key = num ?? l.name.trim();
    const prev = out.get(key);
    const balance = (l.debitCents || 0) - (l.creditCents || 0);
    const sourceType = l.sourceType ?? meta?.sourceType ?? null;
    const detailType = l.detailType ?? meta?.detailType ?? null;
    out.set(key, {
      key,
      number: num,
      name: meta?.name ?? l.name,
      type: l.type ?? meta?.type ?? inferAccountType({ number: num, name: l.name, sourceType, detailType }),
      sourceType,
      detailType,
      active: meta ? meta.active : l.active ?? true,
      balanceCents: (prev?.balanceCents ?? 0) + balance,
      fromTb: true,
    });
  }

  // Chart-only accounts (no TB line): carry their type; balance only when no TB was staged.
  for (const a of accounts) {
    const num = numberOf(a.number, a.name);
    const key = num ?? a.name.trim();
    if (out.has(key)) continue;
    if (!num && [...out.values()].some((v) => nameKey(v.name) === nameKey(a.name))) continue;
    out.set(key, {
      key,
      number: num,
      name: a.name,
      type: a.type ?? inferAccountType({ number: num, name: a.name, sourceType: a.sourceType, detailType: a.detailType }),
      sourceType: a.sourceType,
      detailType: a.detailType,
      active: a.active,
      balanceCents: hasTb ? 0 : a.balanceCents,
      fromTb: false,
    });
  }
  return [...out.values()].sort((x, y) => (x.number ?? x.name).localeCompare(y.number ?? y.name, 'en', { numeric: true }));
}

/** Σ debits / Σ credits of the merged view (debit-positive split). */
export function sourceTotals(rows: ReadonlyArray<{ balanceCents: number }>): { debitCents: number; creditCents: number } {
  let d = 0;
  let c = 0;
  for (const r of rows) {
    if (r.balanceCents > 0) d += r.balanceCents;
    else c -= r.balanceCents;
  }
  return { debitCents: d, creditCents: c };
}
