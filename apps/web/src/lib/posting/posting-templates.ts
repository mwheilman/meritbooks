/**
 * Posting-template registry.
 *
 * One template per transaction type. A template never writes raw debits/credits —
 * it describes the entry as ROLES + EFFECTS (increase/decrease) and the engine
 * derives direction from each account's type (account-direction.ts) and resolves
 * roles to real accounts (account-roles.ts). The output is a balanced
 * `JournalEntryLineInput[]` — the *editable draft* the review step shows
 * (Spec Part A.6 / G). `postTransaction` re-derives from the (possibly edited)
 * facts and commits through the existing `postJournalEntry` primitive.
 *
 * SCOPE (GATE 2 foundation, Session 21): the correct-by-construction templates
 * are implemented and tested. Settlement *matching* and *clearing* of the open
 * obligation (bill/AR/CC lifecycle), schedule generation (prepaid/depr/lease),
 * and multi-liability payroll are the NEXT step; their templates either produce
 * the correct ledger legs now (e.g. bill_payment = DR AP / CR cash) or throw a
 * descriptive PostingError rather than post a wrong entry. No silent guessing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput, type PostResult } from '../services/gl-posting';
import { debitCreditFor, type Effect } from './account-direction';
import {
  resolveRole,
  resolveCashSide,
  getAccountRef,
  PostingError,
  type AccountRef,
} from './account-roles';
import type { TransactionType, PaymentRail } from './transaction-types';
import { shouldDeferAtBilling } from './rev-rec-method';

type DB = SupabaseClient;

/** Facts the AI/processor produce; the template selects what it needs. */
export interface PostingFacts {
  org_id: string;
  location_id: string;
  entry_date: string; // YYYY-MM-DD
  /** Pre-tax base amount for the primary (category) account, in cents. */
  amount_cents: number;
  /** Sales/use tax in cents (revenue-side → tax payable; purchase-side → in cost). */
  tax_cents?: number;
  rail?: PaymentRail;
  /** The expense/revenue/asset account the AI/processor chose. */
  category_account_id?: string;
  /** Second account for transfers and contra postings (e.g. accumulated depreciation). */
  counter_account_id?: string;
  /** When true on a customer_invoice, credit Deferred Revenue (rev-rec relieves it). */
  defer_revenue?: boolean;
  /**
   * Advance handling override. Default for an advance is Deferred Revenue (2410) —
   * a contract liability earned out as you perform; your expectancy-damages claim
   * on acceptance makes it revenue-track. Set true ONLY for a genuine refundable
   * security/damage deposit not tied to a performance obligation → Customer
   * Deposits (2420).
   */
  as_customer_deposit?: boolean;
  /** Loan payment split (principal reduces the loan liability; interest is expensed). */
  principal_cents?: number;
  interest_cents?: number;
  /** Retainage withheld on a progress bill. */
  retainage_cents?: number;
  department_id?: string;
  class_id?: string;
  item_id?: string;
  job_id?: string;
  memo?: string;
}

export interface TransactionTemplate {
  type: TransactionType;
  sourceModule: string; // must not be MANUAL when the entry touches a control account
  /** Build the balanced draft lines. Throws PostingError if facts are insufficient. */
  build(db: DB, facts: PostingFacts): Promise<JournalEntryLineInput[]>;
}

// ---- helpers ---------------------------------------------------------------

function require<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) {
    throw new PostingError(`Missing required fact "${field}" for this transaction type`);
  }
  return value;
}

function requireRail(facts: PostingFacts): PaymentRail {
  return require(facts.rail, 'rail');
}

function dims(facts: PostingFacts) {
  return {
    location_id: facts.location_id,
    department_id: facts.department_id,
    class_id: facts.class_id,
    item_id: facts.item_id,
    job_id: facts.job_id,
  };
}

/** One line: resolve direction from the account's type and the intended effect. */
function line(
  account: AccountRef,
  effect: Effect,
  amountCents: number,
  facts: PostingFacts,
  memo: string
): JournalEntryLineInput {
  const { debit_cents, credit_cents } = debitCreditFor(
    account.account_type,
    effect,
    amountCents,
    account.account_sub_type
  );
  return { account_id: account.id, debit_cents, credit_cents, ...dims(facts), memo };
}

async function categoryRef(db: DB, facts: PostingFacts): Promise<AccountRef> {
  return getAccountRef(db, facts.org_id, require(facts.category_account_id, 'category_account_id'));
}

/** The effect that posts a CREDIT to the given account (offsetting a debit). */
function creditEffect(account: AccountRef): Effect {
  const debitNormal =
    account.account_type === 'ASSET' ||
    account.account_type === 'COGS' ||
    account.account_type === 'OPEX' ||
    (account.account_type === 'OTHER' && account.account_sub_type === 'OTHER_EXPENSE');
  return debitNormal ? 'decrease' : 'increase';
}

// ---- builders --------------------------------------------------------------

/** DR category / CR cash-side(rail). Purchase tax folds into the cost. */
async function buildSimplePurchase(db: DB, facts: PostingFacts): Promise<JournalEntryLineInput[]> {
  const total = facts.amount_cents + (facts.tax_cents ?? 0);
  const category = await categoryRef(db, facts);
  const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
  return [
    line(category, 'increase', total, facts, facts.memo ?? 'Expense'),
    line(cash, 'decrease', total, facts, facts.memo ?? 'Payment'),
  ];
}

/** DR cash/AR for total / CR revenue (or deferred) / CR sales-tax-payable. */
async function buildRevenue(
  db: DB,
  facts: PostingFacts,
  receivable: 'cash' | 'ar',
  defer: boolean
): Promise<JournalEntryLineInput[]> {
  const tax = facts.tax_cents ?? 0;
  const total = facts.amount_cents + tax;
  const revenue = await categoryRef(db, facts); // a REVENUE account
  const lines: JournalEntryLineInput[] = [];

  const debitSide =
    receivable === 'ar'
      ? await resolveRole(db, facts.org_id, 'AR_CONTROL')
      : await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
  lines.push(line(debitSide, 'increase', total, facts, facts.memo ?? 'Receivable/cash'));

  const creditAcct = defer ? await resolveRole(db, facts.org_id, 'DEFERRED_REVENUE') : revenue;
  lines.push(
    line(creditAcct, 'increase', facts.amount_cents, facts, defer ? 'Deferred revenue (billings)' : 'Revenue')
  );

  if (tax > 0) {
    const taxPayable = await resolveRole(db, facts.org_id, 'SALES_TAX_PAYABLE');
    lines.push(line(taxPayable, 'increase', tax, facts, 'Sales tax payable'));
  }
  return lines;
}

/**
 * Resolve whether a bill defers: an explicit facts.defer_revenue wins; otherwise
 * the revenue type's rev-rec method decides (POINT_OF_SALE / AS_BILLED recognize
 * now, everything else defers and the rev-rec engine earns it out).
 */
async function resolveDefer(db: DB, facts: PostingFacts): Promise<boolean> {
  if (typeof facts.defer_revenue === 'boolean') return facts.defer_revenue;
  const revenueAccountId = require(facts.category_account_id, 'category_account_id');
  return shouldDeferAtBilling(db, {
    orgId: facts.org_id,
    locationId: facts.location_id,
    revenueAccountId,
    jobId: facts.job_id,
  });
}

const TEMPLATES: Partial<Record<TransactionType, TransactionTemplate>> = {
  direct_expense: {
    type: 'direct_expense',
    sourceModule: 'RECEIPT',
    build: buildSimplePurchase,
  },

  cc_charge: {
    type: 'cc_charge',
    sourceModule: 'BANK_FEED',
    build: async (db, facts) => {
      const category = await categoryRef(db, facts);
      const cc = await resolveRole(db, facts.org_id, 'CREDIT_CARD_PAYABLE', facts.location_id);
      const total = facts.amount_cents + (facts.tax_cents ?? 0);
      return [
        line(category, 'increase', total, facts, facts.memo ?? 'Card charge'),
        line(cc, 'increase', total, facts, 'Credit card payable'),
      ];
    },
  },

  vendor_bill: {
    type: 'vendor_bill',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const category = await categoryRef(db, facts);
      const ap = await resolveRole(db, facts.org_id, 'AP_CONTROL');
      const total = facts.amount_cents + (facts.tax_cents ?? 0);
      return [
        line(category, 'increase', total, facts, facts.memo ?? 'Vendor bill'),
        line(ap, 'increase', total, facts, 'Accounts payable'),
      ];
    },
  },

  bill_payment: {
    type: 'bill_payment',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const ap = await resolveRole(db, facts.org_id, 'AP_CONTROL');
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(ap, 'decrease', facts.amount_cents, facts, 'Pay accounts payable'),
        line(cash, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Bill payment'),
      ];
    },
  },

  cc_payment: {
    type: 'cc_payment',
    sourceModule: 'BANK_FEED',
    build: async (db, facts) => {
      const cc = await resolveRole(db, facts.org_id, 'CREDIT_CARD_PAYABLE', facts.location_id);
      const bank = await resolveRole(db, facts.org_id, 'OPERATING_BANK', facts.location_id);
      return [
        line(cc, 'decrease', facts.amount_cents, facts, 'Pay credit card'),
        line(bank, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Statement payment'),
      ];
    },
  },

  cash_sale: {
    type: 'cash_sale',
    sourceModule: 'INVOICE',
    build: (db, facts) => buildRevenue(db, facts, 'cash', false),
  },

  customer_invoice: {
    type: 'customer_invoice',
    sourceModule: 'INVOICE',
    build: async (db, facts) => buildRevenue(db, facts, 'ar', await resolveDefer(db, facts)),
  },

  customer_payment: {
    type: 'customer_payment',
    sourceModule: 'INVOICE',
    build: async (db, facts) => {
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const ar = await resolveRole(db, facts.org_id, 'AR_CONTROL');
      return [
        line(cash, 'increase', facts.amount_cents, facts, facts.memo ?? 'Customer payment'),
        line(ar, 'decrease', facts.amount_cents, facts, 'Clear receivable'),
      ];
    },
  },

  bank_transfer: {
    type: 'bank_transfer',
    sourceModule: 'BANK_FEED',
    build: async (db, facts) => {
      const to = await getAccountRef(db, facts.org_id, require(facts.category_account_id, 'category_account_id'));
      const from = await getAccountRef(db, facts.org_id, require(facts.counter_account_id, 'counter_account_id'));
      return [
        line(to, 'increase', facts.amount_cents, facts, 'Transfer in'),
        line(from, 'decrease', facts.amount_cents, facts, 'Transfer out'),
      ];
    },
  },

  bank_fee: {
    type: 'bank_fee',
    sourceModule: 'BANK_FEED',
    build: buildSimplePurchase,
  },

  interest_income: {
    type: 'interest_income',
    sourceModule: 'BANK_FEED',
    build: async (db, facts) => {
      const income = await categoryRef(db, facts); // a REVENUE/OTHER_INCOME account
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(cash, 'increase', facts.amount_cents, facts, 'Interest received'),
        line(income, 'increase', facts.amount_cents, facts, facts.memo ?? 'Interest income'),
      ];
    },
  },

  prepaid_purchase: {
    type: 'prepaid_purchase',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const prepaid = await categoryRef(db, facts); // must be a prepaid ASSET account
      if (prepaid.account_type !== 'ASSET') {
        throw new PostingError('prepaid_purchase category must be a prepaid ASSET account');
      }
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const total = facts.amount_cents + (facts.tax_cents ?? 0);
      return [
        line(prepaid, 'increase', total, facts, facts.memo ?? 'Prepaid asset'),
        line(cash, 'decrease', total, facts, 'Payment'),
      ];
    },
  },

  asset_acquisition: {
    type: 'asset_acquisition',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const asset = await categoryRef(db, facts); // a FIXED_ASSET account
      if (asset.account_type !== 'ASSET') {
        throw new PostingError('asset_acquisition category must be a fixed-ASSET account');
      }
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const total = facts.amount_cents + (facts.tax_cents ?? 0);
      return [
        line(asset, 'increase', total, facts, facts.memo ?? 'Asset acquisition'),
        line(cash, 'decrease', total, facts, 'Payment'),
      ];
    },
  },

  depreciation: {
    type: 'depreciation',
    sourceModule: 'DEPRECIATION',
    build: async (db, facts) => {
      const expense = await categoryRef(db, facts); // Depreciation Expense
      const accum = await getAccountRef(
        db,
        facts.org_id,
        require(facts.counter_account_id, 'counter_account_id') // the matching Accum Depr account
      );
      return [
        line(expense, 'increase', facts.amount_cents, facts, facts.memo ?? 'Depreciation'),
        line(accum, 'increase', facts.amount_cents, facts, 'Accumulated depreciation'),
      ];
    },
  },

  owner_contribution: {
    type: 'owner_contribution',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const capital = await resolveRole(db, facts.org_id, 'OWNERS_CAPITAL');
      return [
        line(cash, 'increase', facts.amount_cents, facts, 'Owner contribution'),
        line(capital, 'increase', facts.amount_cents, facts, facts.memo ?? "Owner's capital"),
      ];
    },
  },

  owner_draw: {
    type: 'owner_draw',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const draw = await resolveRole(db, facts.org_id, 'OWNERS_DRAW');
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(draw, 'increase', facts.amount_cents, facts, facts.memo ?? "Owner's draw"),
        line(cash, 'decrease', facts.amount_cents, facts, 'Payment'),
      ];
    },
  },

  inventory_purchase: {
    type: 'inventory_purchase',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const inv = await categoryRef(db, facts);
      if (inv.account_type !== 'ASSET') throw new PostingError('inventory_purchase category must be an inventory ASSET account');
      const total = facts.amount_cents + (facts.tax_cents ?? 0);
      const onAccount = !facts.rail || facts.rail === 'on_account';
      const credit = onAccount
        ? await resolveRole(db, facts.org_id, 'AP_CONTROL')
        : await resolveCashSide(db, facts.org_id, facts.rail!, facts.location_id);
      return [
        line(inv, 'increase', total, facts, facts.memo ?? 'Inventory'),
        line(credit, creditEffect(credit), total, facts, onAccount ? 'Accounts payable' : 'Payment'),
      ];
    },
  },

  vendor_credit: {
    type: 'vendor_credit',
    sourceModule: 'BILL',
    build: async (db, facts) => {
      const ap = await resolveRole(db, facts.org_id, 'AP_CONTROL');
      const category = await categoryRef(db, facts);
      return [
        line(ap, 'decrease', facts.amount_cents, facts, 'Reduce accounts payable'),
        line(category, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Vendor credit'),
      ];
    },
  },

  cc_refund: {
    type: 'cc_refund',
    sourceModule: 'BANK_FEED',
    build: async (db, facts) => {
      const cc = await resolveRole(db, facts.org_id, 'CREDIT_CARD_PAYABLE', facts.location_id);
      const category = await categoryRef(db, facts);
      return [
        line(cc, 'decrease', facts.amount_cents, facts, 'Credit card refund'),
        line(category, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Reverse expense'),
      ];
    },
  },

  bad_debt: {
    type: 'bad_debt',
    sourceModule: 'AR',
    build: async (db, facts) => {
      const expense = await categoryRef(db, facts); // bad-debt expense
      const ar = await resolveRole(db, facts.org_id, 'AR_CONTROL');
      return [
        line(expense, 'increase', facts.amount_cents, facts, facts.memo ?? 'Bad debt'),
        line(ar, 'decrease', facts.amount_cents, facts, 'Write off receivable'),
      ];
    },
  },

  customer_refund: {
    type: 'customer_refund',
    sourceModule: 'INVOICE',
    build: async (db, facts) => {
      const revenue = await categoryRef(db, facts);
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const tax = facts.tax_cents ?? 0;
      const total = facts.amount_cents + tax;
      const lines = [line(revenue, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Refund / return')];
      if (tax > 0) {
        const taxPayable = await resolveRole(db, facts.org_id, 'SALES_TAX_PAYABLE');
        lines.push(line(taxPayable, 'decrease', tax, facts, 'Reverse sales tax'));
      }
      lines.push(line(cash, 'decrease', total, facts, 'Refund paid'));
      return lines;
    },
  },

  sales_tax_remittance: {
    type: 'sales_tax_remittance',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const taxPayable = await resolveRole(db, facts.org_id, 'SALES_TAX_PAYABLE');
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(taxPayable, 'decrease', facts.amount_cents, facts, 'Remit sales tax'),
        line(cash, 'decrease', facts.amount_cents, facts, facts.memo ?? 'Payment'),
      ];
    },
  },

  income_tax_accrual: {
    type: 'income_tax_accrual',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const expense = await categoryRef(db, facts); // income-tax expense
      const payable = await getAccountRef(db, facts.org_id, require(facts.counter_account_id, 'counter_account_id'));
      return [
        line(expense, 'increase', facts.amount_cents, facts, facts.memo ?? 'Income tax expense'),
        line(payable, 'increase', facts.amount_cents, facts, 'Income tax payable'),
      ];
    },
  },

  loan_draw: {
    type: 'loan_draw',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      const loan = await getAccountRef(db, facts.org_id, require(facts.counter_account_id, 'counter_account_id'));
      return [
        line(cash, 'increase', facts.amount_cents, facts, 'Loan proceeds'),
        line(loan, 'increase', facts.amount_cents, facts, facts.memo ?? 'Loan payable'),
      ];
    },
  },

  loan_payment: {
    type: 'loan_payment',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const principal = require(facts.principal_cents, 'principal_cents');
      const interest = require(facts.interest_cents, 'interest_cents');
      const loan = await getAccountRef(db, facts.org_id, require(facts.counter_account_id, 'counter_account_id'));
      const interestExp = await categoryRef(db, facts); // interest expense (8000)
      const cash = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(loan, 'decrease', principal, facts, 'Loan principal'),
        line(interestExp, 'increase', interest, facts, 'Interest expense'),
        line(cash, 'decrease', principal + interest, facts, facts.memo ?? 'Loan payment'),
      ];
    },
  },

  accrued_interest: {
    type: 'accrued_interest',
    sourceModule: 'MANUAL',
    build: async (db, facts) => {
      const interestExp = await categoryRef(db, facts); // interest expense
      const accrued = await getAccountRef(db, facts.org_id, require(facts.counter_account_id, 'counter_account_id'));
      return [
        line(interestExp, 'increase', facts.amount_cents, facts, facts.memo ?? 'Accrued interest'),
        line(accrued, 'increase', facts.amount_cents, facts, 'Interest payable'),
      ];
    },
  },

  deferred_revenue: {
    type: 'deferred_revenue',
    sourceModule: 'INVOICE',
    build: async (db, facts) => {
      // Customer advance: default to Deferred Revenue (2410), a contract liability
      // earned out as performance occurs. Override to Customer Deposits (2420) only
      // for a genuine refundable deposit not tied to a performance obligation.
      const creditRole = facts.as_customer_deposit ? 'CUSTOMER_DEPOSITS' : 'DEFERRED_REVENUE';
      const credit = await resolveRole(db, facts.org_id, creditRole);
      const debitSide = facts.rail
        ? await resolveCashSide(db, facts.org_id, facts.rail, facts.location_id)
        : await resolveRole(db, facts.org_id, 'AR_CONTROL');
      return [
        line(debitSide, 'increase', facts.amount_cents, facts, facts.memo ?? 'Advance received'),
        line(credit, 'increase', facts.amount_cents, facts, facts.as_customer_deposit ? 'Customer deposit' : 'Deferred revenue'),
      ];
    },
  },

  progress_billing: {
    type: 'progress_billing',
    sourceModule: 'INVOICE',
    build: async (db, facts) => {
      // Billing is decoupled from recognition. The credit goes to Deferred Revenue
      // (a contract liability the rev-rec engine earns out) UNLESS this revenue
      // type recognizes at billing (POINT_OF_SALE / AS_BILLED). The customer
      // withholds retainage, so only (draw − retainage) is current AR; tax is
      // collected on the current portion.
      const revenue = await categoryRef(db, facts);
      const ar = await resolveRole(db, facts.org_id, 'AR_CONTROL');
      const retainage = facts.retainage_cents ?? 0;
      const tax = facts.tax_cents ?? 0;
      const draw = facts.amount_cents;
      if (retainage > draw) throw new PostingError('Retainage cannot exceed the draw amount');

      const defer = await resolveDefer(db, facts);
      const creditAcct = defer ? await resolveRole(db, facts.org_id, 'DEFERRED_REVENUE') : revenue;

      const lines = [line(ar, 'increase', draw - retainage + tax, facts, 'Progress billing (current due)')];
      if (retainage > 0) {
        const retRecv = await resolveRole(db, facts.org_id, 'RETAINAGE_RECEIVABLE');
        lines.push(line(retRecv, 'increase', retainage, facts, 'Retainage withheld'));
      }
      lines.push(line(creditAcct, 'increase', draw, facts, defer ? 'Billings (deferred revenue)' : 'Progress revenue'));
      if (tax > 0) {
        const taxPayable = await resolveRole(db, facts.org_id, 'SALES_TAX_PAYABLE');
        lines.push(line(taxPayable, 'increase', tax, facts, 'Sales tax payable'));
      }
      return lines;
    },
  },

  retainage: {
    type: 'retainage',
    sourceModule: 'INVOICE',
    build: async (db, facts) => {
      // Release withheld retainage to a current receivable when it becomes due.
      const ar = await resolveRole(db, facts.org_id, 'AR_CONTROL');
      const retRecv = await resolveRole(db, facts.org_id, 'RETAINAGE_RECEIVABLE');
      return [
        line(ar, 'increase', facts.amount_cents, facts, facts.memo ?? 'Retainage released'),
        line(retRecv, 'decrease', facts.amount_cents, facts, 'Relieve retainage receivable'),
      ];
    },
  },

  undeposited_funds: {
    type: 'undeposited_funds',
    sourceModule: 'AR',
    build: async (db, facts) => {
      // Deposit step: move collected funds from Undeposited Funds into the bank.
      const bank = facts.rail
        ? await resolveCashSide(db, facts.org_id, facts.rail, facts.location_id)
        : await resolveRole(db, facts.org_id, 'OPERATING_BANK', facts.location_id);
      const undeposited = await resolveRole(db, facts.org_id, 'UNDEPOSITED_FUNDS');
      return [
        line(bank, 'increase', facts.amount_cents, facts, facts.memo ?? 'Bank deposit'),
        line(undeposited, 'decrease', facts.amount_cents, facts, 'Clear undeposited funds'),
      ];
    },
  },

  nsf_reversal: {
    type: 'nsf_reversal',
    sourceModule: 'AR',
    build: async (db, facts) => {
      // A customer payment bounced: re-establish the receivable, reduce the bank.
      const ar = await resolveRole(db, facts.org_id, 'AR_CONTROL');
      const bank = await resolveCashSide(db, facts.org_id, requireRail(facts), facts.location_id);
      return [
        line(ar, 'increase', facts.amount_cents, facts, facts.memo ?? 'NSF — receivable reinstated'),
        line(bank, 'decrease', facts.amount_cents, facts, 'Reverse bounced deposit'),
      ];
    },
  },
};

/** Transaction types whose templates are intentionally deferred to a later step. */
const PENDING: TransactionType[] = [
  'payroll_run', 'payroll_remittance', 'asset_disposal',
  'accrual', 'deferral', 'lease_inception', 'lease_payment', 'internal_invoice',
  'purchase_order', 'po_receipt', 'inventory_adjustment', 'encumbrance',
];

export function getTemplate(type: TransactionType): TransactionTemplate {
  const t = TEMPLATES[type];
  if (t) return t;
  if (PENDING.includes(type)) {
    throw new PostingError(
      `Posting template for "${type}" is not implemented in the GATE 2 foundation step. ` +
        `It is registered in the catalog and scheduled for the lifecycle/exception step.`
    );
  }
  throw new PostingError(`Unknown transaction type "${type}"`);
}

/**
 * Build the editable draft lines for a transaction (no posting). This is what
 * the universal review step renders; the processor may edit any field before
 * commit (Spec Part A.6 / G).
 */
export async function buildTransactionLines(
  db: DB,
  type: TransactionType,
  facts: PostingFacts
): Promise<JournalEntryLineInput[]> {
  if (!Number.isInteger(facts.amount_cents) || facts.amount_cents < 0) {
    throw new PostingError(`amount_cents must be a non-negative integer, got ${facts.amount_cents}`);
  }
  const lines = await getTemplate(type).build(db, facts);
  const debits = lines.reduce((s, l) => s + l.debit_cents, 0);
  const credits = lines.reduce((s, l) => s + l.credit_cents, 0);
  if (debits !== credits) {
    throw new PostingError(`Template "${type}" produced an unbalanced draft: ${debits} vs ${credits}`);
  }
  return lines;
}

/**
 * Build and post a transaction. `created_by` takes null for system/AI actors
 * (Clerk ids are text; the GL author columns are uuid). Source-module is set
 * from the template so control-account guards pass.
 */
export async function postTransaction(
  db: DB,
  type: TransactionType,
  facts: PostingFacts,
  opts: { created_by: string | null; source_id?: string }
): Promise<PostResult> {
  const lines = await buildTransactionLines(db, type, facts);
  const template = getTemplate(type);
  return postJournalEntry(db, {
    org_id: facts.org_id,
    location_id: facts.location_id,
    entry_date: facts.entry_date,
    memo: facts.memo ?? template.type,
    source_module: template.sourceModule,
    source_id: opts.source_id,
    created_by: opts.created_by,
    lines,
  });
}

export { PostingError };
