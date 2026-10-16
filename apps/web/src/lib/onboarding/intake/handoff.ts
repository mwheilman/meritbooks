/**
 * Smart Intake — the HANDOFF contract (FPB §5): a classified file is passed onward by
 * its storage path, never re-uploaded. This pure module decides, for each doc type,
 * the ONE next action and where the file goes:
 *
 *   opening   → the wizard's Opening step:  /onboarding?step=opening&intake=<path>
 *   formation → in-page Formation review (FormationIntake initialStoragePath)
 *   debt      → in-page loan review       (DebtParseReview initialStoragePath; /debt?intake=)
 *   budget    → in-page budget import     (BudgetImport initialStoragePath; /budgets?intake=)
 *   ar / ap   → in-page A/R or A/P review (Ar/ApReviewComponent initialStoragePath)
 *   file      → saved to the company's documents with a plain note (org chart, expense
 *               policy, anything without a wired parser yet) — nothing is lost.
 *
 * Client-safe and dependency-free so it is unit-tested directly (handoff.test.ts).
 */

import { INTAKE_ROUTES, type IntakeDocType } from './types';

export type HandoffKind = 'opening' | 'formation' | 'debt' | 'budget' | 'ar' | 'ap' | 'file';

/** The receiving A/R or A/P drop slot (matches lib/import/definitions keys). */
export type SubledgerKind = 'customers' | 'open_ar' | 'vendors' | 'open_ap';

/** The `public.documents.doc_type` vocabulary (migration 090 CHECK). */
export type DocumentsDocType =
  | 'BILL' | 'RECEIPT' | 'CONTRACT' | 'LEASE' | 'LOAN' | 'POLICY' | 'W9' | 'COI' | 'STATEMENT' | 'OTHER';

export interface IntakeHandoff {
  kind: HandoffKind;
  /** The one next action, as a button label ("Use for opening balances"). */
  actionLabel: string;
  /** One plain-English line under the label: what happens when they click. */
  description: string;
  /** A navigable URL that carries the file (`?intake=`), or null when the handoff is in-page only. */
  href: string | null;
  /** For ar/ap: which drop slot the file fills. */
  subledgerKind: SubledgerKind | null;
  /** How the file is filed in the Documents center when saved. */
  documentType: DocumentsDocType;
  /** The note stored on the documents row (and shown on the card) for `file` handoffs. */
  fileNote: string | null;
}

function withIntake(base: string, storagePath: string, extra?: Record<string, string>): string {
  const [path, query] = base.split('?');
  const params = new URLSearchParams(query ?? '');
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  params.set('intake', storagePath);
  return `${path}?${params.toString()}`;
}

/** The wizard Opening-step URL that carries a TB / GL file (the wizard slice reads `intake`). */
export function openingStepHref(storagePath: string): string {
  return withIntake('/onboarding', storagePath, { step: 'opening' });
}

const DOCS_TYPE: Partial<Record<IntakeDocType, DocumentsDocType>> = {
  LOAN: 'LOAN',
  LEASE: 'LEASE',
  BILL: 'BILL',
  BANK_STATEMENT: 'STATEMENT',
  W9: 'W9',
  COI: 'COI',
  CUSTOMER_CONTRACT: 'CONTRACT',
  OPERATING_AGREEMENT: 'CONTRACT',
  SUBSCRIPTION: 'CONTRACT',
  INSURANCE_POLICY: 'POLICY',
};

/** Plain-English "what we'll do with it later" notes for files we keep but don't parse yet. */
const FILE_NOTES: Partial<Record<IntakeDocType, string>> = {
  ORG_CHART: "Org chart — we'll use this to set up approval chains later.",
  EXPENSE_POLICY: "Expense policy — we'll use this to set up spending limits and approvals later.",
  WIP_SCHEDULE: 'WIP schedule — open Jobs & WIP to build your opening job positions from it.',
  LEASE: 'Lease — open Leases to set up the right-of-use asset and liability from it.',
  BILL: 'Vendor bill — open Bills to enter it.',
  BANK_STATEMENT: 'Bank statement — used to check cash at cutover.',
  W9: 'Vendor W-9 — kept on file for 1099 reporting.',
  COI: 'Certificate of insurance — kept on file for vendor compliance.',
  CUSTOMER_CONTRACT: 'Customer contract — kept on file for billing and revenue recognition.',
  INSURANCE_POLICY: 'Insurance policy — kept on file for prepaid insurance.',
  PREPAID: 'Prepaid expense support — kept on file.',
  SUBSCRIPTION: 'Subscription agreement — kept on file.',
  PAYROLL_REGISTER: 'Payroll register — kept on file for payroll setup.',
  UNKNOWN: "Kept on file — tell us what it is any time and we'll put it to work.",
};

export function buildHandoff(docType: IntakeDocType, storagePath: string): IntakeHandoff {
  const documentType = DOCS_TYPE[docType] ?? 'OTHER';
  const base = { documentType, subledgerKind: null as SubledgerKind | null, fileNote: null as string | null };

  switch (docType) {
    case 'TRIAL_BALANCE':
    case 'GENERAL_LEDGER':
      return {
        ...base,
        kind: 'opening',
        actionLabel: 'Use for opening balances',
        description: 'Takes you to the opening-balances step with this file already loaded.',
        href: openingStepHref(storagePath),
      };
    case 'FORMATION_DOC':
    case 'EIN_LETTER':
    case 'OPERATING_AGREEMENT':
      return {
        ...base,
        kind: 'formation',
        actionLabel: 'Fill in the company’s legal details',
        description: 'We read the legal name, EIN, state and owners — you confirm.',
        href: null,
      };
    case 'LOAN':
      return {
        ...base,
        kind: 'debt',
        actionLabel: 'Set up this loan',
        description: 'We read the terms and bring the loan over at its current balance — you confirm.',
        href: withIntake(INTAKE_ROUTES.LOAN.route, storagePath),
      };
    case 'BUDGET':
      return {
        ...base,
        kind: 'budget',
        actionLabel: 'Load this budget',
        description: 'Matches each line to your accounts and shows a preview before saving.',
        href: withIntake(INTAKE_ROUTES.BUDGET.route, storagePath),
      };
    case 'CUSTOMER_LIST':
    case 'AR_AGING': {
      const subledgerKind: SubledgerKind = docType === 'AR_AGING' ? 'open_ar' : 'customers';
      return {
        ...base,
        kind: 'ar',
        subledgerKind,
        actionLabel: docType === 'AR_AGING' ? 'Bring in open receivables' : 'Bring in customers',
        description: docType === 'AR_AGING'
          ? 'Who owes you and how much — totals are checked against your A/R balance.'
          : 'Adds your customers so invoices and payments land on the right names.',
        href: withIntake(INTAKE_ROUTES[docType].route, storagePath, { kind: subledgerKind }),
      };
    }
    case 'VENDOR_LIST':
    case 'AP_AGING': {
      const subledgerKind: SubledgerKind = docType === 'AP_AGING' ? 'open_ap' : 'vendors';
      return {
        ...base,
        kind: 'ap',
        subledgerKind,
        actionLabel: docType === 'AP_AGING' ? 'Bring in open payables' : 'Bring in vendors',
        description: docType === 'AP_AGING'
          ? 'Who you owe and how much — totals are checked against your A/P balance.'
          : 'Adds your vendors so bills and payments land on the right names.',
        href: withIntake(INTAKE_ROUTES[docType].route, storagePath, { kind: subledgerKind }),
      };
    }
    default: {
      // Kept in the company's documents. WIP / leases / bills etc. also get a link to the
      // page that sets them up (those receivers don't read `?intake=` yet — the file is
      // still safe in Documents, so nothing is ever lost).
      const route = INTAKE_ROUTES[docType].route;
      const pageLink = route !== '/onboarding' && route !== '/documents' ? route : null;
      return {
        ...base,
        kind: 'file',
        actionLabel: 'Save to company documents',
        description: FILE_NOTES[docType] ?? 'Kept on file in your documents.',
        href: pageLink,
        fileNote: FILE_NOTES[docType] ?? null,
      };
    }
  }
}

// ── File-format compatibility ───────────────────────────────────────────────

const SHEET_EXT = new Set(['csv', 'txt', 'tsv', 'xlsx']);
const DOC_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Can the receiver for this handoff actually read this file? Spreadsheet importers
 * (opening balances, budget, A/R, A/P) need CSV/XLSX; the document readers (loan,
 * formation) need a PDF or image. Returns null when compatible, else a plain-English
 * fix ("Save it as .xlsx or CSV …"). `file` handoffs accept anything.
 */
export function formatProblem(kind: HandoffKind, fileName: string): string | null {
  const ext = extOf(fileName);
  if (kind === 'opening' || kind === 'budget' || kind === 'ar' || kind === 'ap') {
    if (SHEET_EXT.has(ext)) return null;
    if (ext === 'xls') return 'This is an old-style Excel file. Open it and “Save As” .xlsx (or export a CSV), then drop it again.';
    if (ext === 'pdf') return 'We read this kind of report from a spreadsheet. Export it from your accounting system as .xlsx or CSV and drop that.';
    return 'To bring this in automatically, save it as .xlsx or CSV and drop it again.';
  }
  if (kind === 'debt' || kind === 'formation') {
    return DOC_EXT.has(ext) ? null : 'To read this automatically, save it as a PDF and drop it again.';
  }
  return null;
}

/**
 * The handoff for a specific file: `buildHandoff`, downgraded to "keep it on file" when
 * the receiver can't read this format (with the fix in `description`). Nothing is lost.
 */
export function handoffForFile(docType: IntakeDocType, storagePath: string, fileName: string): IntakeHandoff & { formatProblem: string | null } {
  const h = buildHandoff(docType, storagePath);
  const problem = formatProblem(h.kind, fileName);
  if (!problem) return { ...h, formatProblem: null };
  return {
    ...h,
    kind: 'file',
    actionLabel: 'Save to company documents',
    description: problem,
    href: null,
    subledgerKind: null,
    fileNote: h.fileNote ?? `${INTAKE_ROUTES[docType].label} — kept on file (needs a ${h.kind === 'debt' || h.kind === 'formation' ? 'PDF' : 'spreadsheet'} copy to import).`,
    formatProblem: problem,
  };
}
