/** Document templates (proposal … lien waiver): the data each one takes, and the render context. */
import type { Vocabulary } from '@/lib/pm/vocab';
import type { Brand, SignatureAnchor } from './layout';

export const TEMPLATE_KEYS = [
  'proposal', 'contract', 'change_order', 'pay_app_cover', 'work_order', 'daily_report', 'install_ticket',
  'purchase_order', 'buyers_order', 'draw_request', 'lien_waiver',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** pm.doc_files.kind each rendered template is filed as. */
export const TEMPLATE_DOC_KIND: Readonly<Record<TemplateKey, string>> = {
  proposal: 'proposal', contract: 'contract', change_order: 'change_order', pay_app_cover: 'pay_app', work_order: 'work_order',
  daily_report: 'daily_report', install_ticket: 'install_ticket', purchase_order: 'po', buyers_order: 'buyers_order',
  draw_request: 'draw_request', lien_waiver: 'lien_waiver',
};

/** Company overrides (pm.doc_template_settings.body). */
export interface TemplateSettings {
  title?: string;
  intro?: string;
  terms?: string;
  footer?: string;
  notice?: string;
  noticeTitle?: string;
  headerLines?: string[];
}

export interface TemplateContext {
  brand: Brand;
  vocab: Vocabulary;
  settings: TemplateSettings;
  /** yyyy-mm-dd */
  today: string;
}

export interface Party {
  name: string;
  lines?: string[];
  email?: string | null;
  phone?: string | null;
}

export interface MoneyLine {
  description: string;
  qty?: number | null;
  uom?: string | null;
  unitCents?: number | null;
  amountCents: number | null;
  note?: string | null;
}

export interface ProposalData {
  number: string;
  version?: number;
  date: string;
  validUntil?: string | null;
  jobName: string;
  customer: Party;
  site?: string | null;
  intro?: string | null;
  lines: MoneyLine[];
  allowanceCents?: number | null;
  totalCents: number;
  retainagePct?: number | null;
  notes?: string | null;
  /** Customers who sign (both spouses = 2). */
  customerSigners?: Array<string | null>;
}

export interface ContractData extends ProposalData {
  contractType?: string | null;
  startOn?: string | null;
  finishOn?: string | null;
  paymentSchedule?: Array<{ label: string; amountCents: number | null; pct?: number | null }>;
}

export interface ChangeOrderData {
  number: string;
  title: string;
  date: string;
  jobName: string;
  customer: Party;
  description?: string | null;
  reason?: string | null;
  amountCents: number | null;
  scheduleDays?: number | null;
  originalContractCents?: number | null;
  previousChangesCents?: number | null;
  lines?: MoneyLine[];
  customerSigners?: Array<string | null>;
}

export interface PayAppCoverData {
  applicationNo: number | null;
  periodEnd: string | null;
  date: string;
  jobName: string;
  owner: Party;
  originalContractCents: number | null;
  changeOrdersCents: number | null;
  totalCompletedCents: number;
  retainageCents: number;
  previousCertificatesCents: number;
  currentDueCents: number;
}

export interface WorkOrderData {
  number: string;
  kindLabel: string;
  date: string;
  scheduled?: string | null;
  customer: Party;
  site?: string | null;
  summary: string;
  description?: string | null;
  complaint?: string | null;
  cause?: string | null;
  resolution?: string | null;
  lines: MoneyLine[];
  showPrices: boolean;
  totalCents?: number | null;
}

export interface DailyReportData {
  date: string;
  jobName: string;
  kindLabel: string;
  author?: string | null;
  weather?: string | null;
  crewCount?: number | null;
  hours?: number | null;
  body: string;
  photos?: number;
}

export interface InstallTicketData extends WorkOrderData {
  checklist?: string[];
}

export interface PurchaseOrderData {
  number: string;
  title?: string | null;
  date: string;
  jobName: string;
  vendor: Party;
  shipTo?: string | null;
  lines: MoneyLine[];
  totalCents: number;
  terms?: string | null;
}

export interface BuyersOrderData {
  number: string;
  date: string;
  validUntil?: string | null;
  customer: Party;
  lines: MoneyLine[];
  trades: Array<{ description: string; allowanceCents: number; payoffCents: number }>;
  products: Array<{ description: string; priceCents: number }>;
  totals: {
    saleCents: number; feesCents: number; productsCents: number; taxCents: number; cashPriceCents: number;
    tradeAllowanceCents: number; tradePayoffCents: number; depositsCents: number; balanceDueCents: number;
  };
}

export interface DrawRequestData {
  drawNo: number | null;
  periodEnd: string;
  date: string;
  jobName: string;
  lender: Party;
  loanNumber?: string | null;
  requestedCents: number | null;
  retainageHeldCents?: number | null;
  equityAppliedCents?: number | null;
  lines?: MoneyLine[];
  notes?: string | null;
}

export type LienWaiverType = 'conditional_progress' | 'unconditional_progress' | 'conditional_final' | 'unconditional_final';

export interface LienWaiverData {
  waiverType: LienWaiverType;
  date: string;
  claimant: Party;
  customer: Party;
  jobName: string;
  jobAddress?: string | null;
  throughDate?: string | null;
  amountCents: number | null;
  exceptions?: string | null;
}

export interface TemplateDataMap {
  proposal: ProposalData;
  contract: ContractData;
  change_order: ChangeOrderData;
  pay_app_cover: PayAppCoverData;
  work_order: WorkOrderData;
  daily_report: DailyReportData;
  install_ticket: InstallTicketData;
  purchase_order: PurchaseOrderData;
  buyers_order: BuyersOrderData;
  draw_request: DrawRequestData;
  lien_waiver: LienWaiverData;
}

export interface RenderedDocument {
  key: TemplateKey;
  title: string;
  fileName: string;
  bytes: Uint8Array;
  pageCount: number;
  anchors: SignatureAnchor[];
}
