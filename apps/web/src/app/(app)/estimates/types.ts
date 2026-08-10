export type EstimateStatus =
  | 'DRAFT'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CONVERTED';

export interface EstimateRow {
  id: string;
  estimateNumber: string;
  status: EstimateStatus;
  estimateDate: string;
  expirationDate: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  notes: string | null;
  convertedInvoiceId: string | null;
  convertedAt: string | null;
  isPastExpiration: boolean;
  customer: { id: string; name: string; email: string | null } | null;
  location: { id: string; name: string; shortCode: string } | null;
}

export interface EstimateListResponse {
  data: EstimateRow[];
  counts: Record<string, { count: number; totalCents: number }>;
  pipeline: {
    openPipelineCents: number;
    acceptedCents: number;
    decidedCents: number;
    winRatePct: number;
  };
}

export interface EstimateDetailLine {
  id: string;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  revenueAccountId: string | null;
  account: { id: string; accountNumber: string; name: string } | null;
}

export interface EstimateDetail {
  id: string;
  estimateNumber: string;
  status: EstimateStatus;
  estimateDate: string;
  expirationDate: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  notes: string | null;
  convertedInvoiceId: string | null;
  convertedAt: string | null;
  convertedInvoice: { id: string; invoiceNumber: string } | null;
  customer: { id: string; name: string; email: string | null } | null;
  location: { id: string; name: string; shortCode: string } | null;
  job: { id: string; jobNumber: string; name: string } | null;
  lines: EstimateDetailLine[];
}

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
}

export interface AccountOption {
  id: string;
  account_number: string;
  name: string;
}

export interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
