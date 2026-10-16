/**
 * QBO API objects → the provider-native RAW records the EXISTING mapping profile
 * (providers/mapping.ts, QBO_PROFILE) already understands. This is the only place
 * the live API's shape is flattened; after this the records are indistinguishable
 * from providers/fixtures.ts, so the deterministic transforms run unchanged.
 *
 *   accounts       { AcctNum, Name, AccountType, …extras }
 *   customers/vend { Id, DisplayName, PrimaryEmailAddr, PrimaryPhone }  (flattened)
 *   open AR        { CustomerName, DocNumber, TxnDate, DueDate, TotalAmt, Balance }
 *   open AP        { VendorName,   DocNumber, TxnDate, DueDate, TotalAmt, Balance }
 *   trial balance  { AcctNum, Name, Debit, Credit }   (decimal-dollar strings)
 *
 * Money stays as decimal-dollar STRINGS here (like the fixtures); mapping.ts converts
 * to integer cents. Netting inside the TB parse is done in integer cents.
 *
 * Pure — no I/O — unit-tested against realistic Intuit payloads.
 */

import type { RawRecord } from '../providers/mapping';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Decimal dollars (number or string) → integer cents, no float accumulation. */
export function dollarsStrToCents(v: unknown): number {
  const s = str(v);
  if (!s) return 0;
  const cleaned = s.replace(/[,$\s]/g, '');
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  const neg = m[1] === '-';
  const whole = m[2] ? Number(m[2]) : 0;
  const frac = (m[3] ?? '').padEnd(3, '0');
  // Round half-up on the third decimal.
  let cents = whole * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  if (neg) cents = -cents;
  return cents;
}

/** Integer cents → "1234.56" ("" for zero), the fixture money format. */
export function centsToDollarStr(cents: number): string {
  if (!Number.isFinite(cents) || cents === 0) return '';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function money(v: unknown): string {
  const c = dollarsStrToCents(v);
  return c === 0 ? '0.00' : centsToDollarStr(c);
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export interface QboAccountSnapshot {
  id: string;
  /** AcctNum when the company uses numbers, else the full name (what QBO exports show). */
  code: string;
  name: string;
  accountType: string | null;
  accountSubType: string | null;
  /** QBO CurrentBalance in cents (QBO's natural sign for the account type). */
  currentBalanceCents: number;
  active: boolean;
}

export function toAccountSnapshot(a: Obj): QboAccountSnapshot {
  const name = str(a.FullyQualifiedName) ?? str(a.Name) ?? '';
  return {
    id: str(a.Id) ?? '',
    code: str(a.AcctNum) ?? name,
    name,
    accountType: str(a.AccountType),
    accountSubType: str(a.AccountSubType),
    // Own balance only (not WithSubAccounts) so summing a type never double-counts.
    currentBalanceCents: dollarsStrToCents(a.CurrentBalance),
    active: a.Active !== false,
  };
}

/** Account entity → fixture-shaped raw record. */
export function flattenAccount(a: Obj): RawRecord {
  const s = toAccountSnapshot(a);
  return {
    Id: s.id,
    AcctNum: s.code,
    Name: s.name,
    AccountType: s.accountType ?? '',
    AccountSubType: s.accountSubType ?? '',
    CurrentBalance: money(a.CurrentBalance),
  };
}

// ── Customers / vendors ──────────────────────────────────────────────────────

export function flattenParty(p: Obj): RawRecord {
  return {
    Id: str(p.Id) ?? '',
    DisplayName: str(p.DisplayName) ?? str(p.CompanyName) ?? '',
    PrimaryEmailAddr: str(obj(p.PrimaryEmailAddr)?.Address) ?? '',
    PrimaryPhone: str(obj(p.PrimaryPhone)?.FreeFormNumber) ?? '',
  };
}

// ── Open invoices / bills ────────────────────────────────────────────────────

function openItem(t: Obj, partyKey: 'CustomerRef' | 'VendorRef', prefix: string): RawRecord {
  return {
    Id: str(t.Id) ?? '',
    [partyKey === 'CustomerRef' ? 'CustomerName' : 'VendorName']: str(obj(t[partyKey])?.name) ?? '',
    DocNumber: str(t.DocNumber) ?? `${prefix}-${str(t.Id) ?? ''}`,
    TxnDate: str(t.TxnDate) ?? '',
    DueDate: str(t.DueDate) ?? str(t.TxnDate) ?? '',
    TotalAmt: money(t.TotalAmt),
    Balance: money(t.Balance),
  };
}

export function flattenInvoice(i: Obj): RawRecord {
  return openItem(i, 'CustomerRef', 'QBO-INV');
}
export function flattenBill(b: Obj): RawRecord {
  return openItem(b, 'VendorRef', 'QBO-BILL');
}

/** Keep only documents with a non-zero open balance. */
export function isOpen(t: Obj): boolean {
  return dollarsStrToCents(t.Balance) !== 0;
}

// ── Trial balance report ─────────────────────────────────────────────────────

interface ReportColData {
  value?: unknown;
  id?: unknown;
}
interface ReportRow {
  type?: unknown;
  group?: unknown;
  ColData?: ReportColData[];
  Rows?: { Row?: ReportRow[] };
  Summary?: unknown;
}
export interface QboReport {
  Header?: Obj;
  Columns?: { Column?: { ColTitle?: unknown; ColType?: unknown }[] };
  Rows?: { Row?: ReportRow[] };
}

/** One parsed TB line (cents), keyed back to the QBO account id when present. */
export interface QboTbLine {
  accountId: string | null;
  code: string;
  name: string;
  debitCents: number;
  creditCents: number;
}

/**
 * Parse an Intuit TrialBalance report into net debit/credit lines.
 *   • Finds the Debit/Credit columns by ColTitle (falls back to columns 1/2).
 *   • Walks nested sections; skips Summary / GrandTotal rows.
 *   • Joins each row to the Account list by ColData[0].id so the code is the real
 *     AcctNum (or full name) — not the display label.
 *   • Nets each line (a negative debit becomes a credit) and drops zero lines.
 */
export function parseTrialBalanceReport(
  report: QboReport,
  accountsById: Map<string, QboAccountSnapshot> = new Map(),
): QboTbLine[] {
  const cols = report.Columns?.Column ?? [];
  let dIdx = cols.findIndex((c) => /debit/i.test(String(c.ColTitle ?? '')));
  let cIdx = cols.findIndex((c) => /credit/i.test(String(c.ColTitle ?? '')));
  if (dIdx < 0) dIdx = 1;
  if (cIdx < 0) cIdx = 2;

  const out: QboTbLine[] = [];
  const walk = (rows: ReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.Rows?.Row) walk(row.Rows.Row);
      if (String(row.group ?? '') === 'GrandTotal') continue;
      if (row.type !== undefined && row.type !== 'Data') continue;
      const cd = row.ColData;
      if (!cd || cd.length === 0) continue;
      const label = str(cd[0]?.value);
      if (!label || /^total\b/i.test(label)) continue;
      const accountId = str(cd[0]?.id);
      const net = dollarsStrToCents(cd[dIdx]?.value) - dollarsStrToCents(cd[cIdx]?.value);
      if (net === 0) continue;
      const acct = accountId ? accountsById.get(accountId) : undefined;
      out.push({
        accountId,
        code: acct?.code ?? label,
        name: acct?.name ?? label,
        debitCents: net > 0 ? net : 0,
        creditCents: net < 0 ? -net : 0,
      });
    }
  };
  walk(report.Rows?.Row);
  return out;
}

/** TB lines → fixture-shaped raw records for transformTrialBalanceRow('quickbooks'). */
export function tbLinesToRaw(lines: QboTbLine[]): RawRecord[] {
  return lines.map((l) => ({
    AcctNum: l.code,
    Name: l.name,
    Debit: centsToDollarStr(l.debitCents),
    Credit: centsToDollarStr(l.creditCents),
  }));
}

/**
 * The TB window for opening balances as of `asOf`: from the start of the fiscal year
 * containing `asOf` through `asOf`. Balance-sheet lines are cumulative; P&L lines are
 * fiscal-YTD with prior years rolled into Retained Earnings — so the TB balances.
 */
export function fiscalYearStartFor(asOf: string, fiscalYearStartMonth: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!m) throw new Error(`Invalid date: ${asOf}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const fy = Math.min(12, Math.max(1, Math.trunc(fiscalYearStartMonth) || 1));
  const startYear = mo >= fy ? y : y - 1;
  return `${startYear}-${String(fy).padStart(2, '0')}-01`;
}
