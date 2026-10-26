import type { OnlineSummary } from './online-status';

/** Invoice list row (GET /api/invoices). */
export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  /** Display status key from lib/invoices/display-status.ts (ISSUED / OVERDUE derived). */
  status: string;
  statusLabel?: string;
  statusHint?: string | null;
  isProgressBill: boolean;
  daysOverdue: number;
  memo: string | null;
  customer: { id: string; name: string; email: string | null } | null;
  location: { id: string; name: string; shortCode: string } | null;
  job: { id: string; jobNumber: string; name: string } | null;
  /** What the customer did with the online link (viewed / paying / paid online). */
  online?: OnlineSummary;
}

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  paymentTermsDays: number;
}

export interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}
