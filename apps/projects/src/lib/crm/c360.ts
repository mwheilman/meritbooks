/**
 * Customer 360 money from Merit Books (pm.v_customer_360, migration 1111; panel 06 BP-62/66/69).
 * Pure and client-safe. Books owns AR, invoices, payments and deposits; Projects reads them
 * through the definer view (masked per caller in the database) and draws them only when the
 * caller holds projects.contract_value — invoice and deposit amounts are contract-side money
 * (Wave 0a §2.1). Without it the section is absent, never a row of zeros.
 */
import type { RelationshipStage } from './types';

export interface BooksInvoice {
  id: string;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  totalCents: number | null;
  balanceCents: number | null;
  status: string | null;
}

export interface BooksPayment {
  id: string;
  date: string | null;
  amountCents: number | null;
  method: string | null;
}

export interface BooksDeposit {
  id: string;
  date: string | null;
  amountCents: number | null;
  appliedCents: number | null;
  status: string | null;
}

export interface BooksMoney {
  openArCents: number | null;
  overdueArCents: number | null;
  depositsHeldCents: number | null;
  lifetimeBilledCents: number | null;
  lastInvoiceOn: string | null;
  lastPaymentOn: string | null;
  invoices: BooksInvoice[];
  payments: BooksPayment[];
  deposits: BooksDeposit[];
}

export interface Relationship {
  stage: RelationshipStage;
  since: string | null;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function arr(v: unknown): Obj[] {
  if (typeof v === 'string') {
    try {
      return arr(JSON.parse(v));
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter(isObj) : [];
}

export function parseRelationship(v: unknown): Relationship | null {
  if (!isObj(v)) return null;
  const s = str(v.stage) ?? str(v.relationship_stage);
  if (s !== 'prospect' && s !== 'customer' && s !== 'former') return null;
  return { stage: s, since: str(v.since) ?? str(v.relationship_since) };
}

/** One v_customer_360 row → the Books money it carries (masked columns stay null). */
export function parseBooksMoney(row: unknown): BooksMoney | null {
  if (!isObj(row)) return null;
  return {
    openArCents: num(row.open_ar_cents),
    overdueArCents: num(row.overdue_ar_cents),
    depositsHeldCents: num(row.deposits_held_cents),
    lifetimeBilledCents: num(row.lifetime_billed_cents),
    lastInvoiceOn: str(row.last_invoice_on),
    lastPaymentOn: str(row.last_payment_on),
    invoices: arr(row.invoices).flatMap((i): BooksInvoice[] => (typeof i.id === 'string' ? [{
      id: i.id, number: str(i.number), date: str(i.date), dueDate: str(i.due_date), totalCents: num(i.total_cents), balanceCents: num(i.balance_cents), status: str(i.status),
    }] : [])),
    payments: arr(row.payments).flatMap((p): BooksPayment[] => (typeof p.id === 'string' ? [{ id: p.id, date: str(p.date), amountCents: num(p.amount_cents), method: str(p.method) }] : [])),
    deposits: arr(row.deposits).flatMap((d): BooksDeposit[] => (typeof d.id === 'string' ? [{
      id: d.id, date: str(d.date), amountCents: num(d.amount_cents), appliedCents: num(d.applied_cents), status: str(d.status),
    }] : [])),
  };
}

/** True when the database masked every figure (the caller has no money grant there). */
export function allMasked(m: BooksMoney): boolean {
  return m.openArCents == null && m.overdueArCents == null && m.depositsHeldCents == null && m.lifetimeBilledCents == null
    && m.invoices.every((i) => i.totalCents == null) && m.payments.every((p) => p.amountCents == null);
}

/**
 * What the browser receives: the money only with the grant, else null (the section is absent).
 * Defense in depth over the view's own masking.
 */
export function booksMoneyFor(m: BooksMoney | null, seesContract: boolean): BooksMoney | null {
  if (!m || !seesContract || allMasked(m)) return null;
  return m;
}

/** Days past due for an open invoice (0 when not due or paid). */
export function daysPastDue(i: Pick<BooksInvoice, 'dueDate' | 'balanceCents'>, todayIso: string): number {
  if (!i.dueDate || !i.balanceCents || i.balanceCents <= 0 || i.dueDate >= todayIso) return 0;
  return Math.round((Date.parse(`${todayIso}T12:00:00Z`) - Date.parse(`${i.dueDate}T12:00:00Z`)) / 86_400_000);
}

/** AR aging buckets from the open invoices (current, 1–30, 31–60, 61–90, 90+). */
export function agingBuckets(invoices: ReadonlyArray<BooksInvoice>, todayIso: string): Array<{ label: string; cents: number }> {
  const b = [0, 0, 0, 0, 0];
  for (const i of invoices) {
    const bal = i.balanceCents ?? 0;
    if (bal <= 0) continue;
    const d = daysPastDue(i, todayIso);
    b[d === 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4]! += bal;
  }
  return [
    { label: 'Current', cents: b[0]! }, { label: '1–30 days', cents: b[1]! }, { label: '31–60 days', cents: b[2]! },
    { label: '61–90 days', cents: b[3]! }, { label: 'Over 90 days', cents: b[4]! },
  ];
}
