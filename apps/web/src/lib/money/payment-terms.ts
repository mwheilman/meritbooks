/**
 * The payment terms an invoice is ACTUALLY offered on (FPB-payments-fees §17.3 / FPB-invoices
 * §11a): which methods (check / bank transfer / card) and who bears each processing fee,
 * resolved most-specific-wins over invoice → job → customer → company.
 *
 * Before this, the hosted page and the pay intent read only the INVOICE level, so a
 * company-wide "accept cards" switch did nothing. This is the one server-side resolver
 * both must use; the pay intent enforces it (a method that is off is refused there, not
 * just hidden on the page).
 *
 * Defaults (owner decision, unchanged): card OFF unless enabled somewhere in the cascade,
 * bank transfer ON, the card fee passed to the customer, the bank-transfer fee absorbed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  onlineMethods,
  resolvePaymentMethods,
  resolveSurchargeEnabled,
  type PaymentMethod,
  type PaymentProviderId,
} from '@/lib/invoices/resolve-payment-methods';

export interface TermsLevel {
  payment_methods_allowed?: string[] | null;
  card_surcharge_enabled?: boolean | null;
  ach_surcharge_enabled?: boolean | null;
}

export interface TermsLevels {
  invoice?: TermsLevel | null;
  job?: TermsLevel | null;
  customer?: TermsLevel | null;
  entity?: TermsLevel | null;
}

export interface PaymentTerms {
  /** CHECK / ACH / CARD, stable order. */
  methods: PaymentMethod[];
  /** ACH / CARD — the ones that get a Pay button. */
  online: PaymentMethod[];
  /** true = the card fee is added to what the customer pays. */
  cardPassThrough: boolean;
  /** true = the bank-transfer fee is added to what the customer pays. */
  achPassThrough: boolean;
}

function firstBool(vals: Array<boolean | null | undefined>, dflt: boolean): boolean {
  for (const v of vals) if (v === true || v === false) return v;
  return dflt;
}

/** Pure cascade (unit-tested). */
export function resolvePaymentTerms(levels: TermsLevels, provider: PaymentProviderId = 'STRIPE'): PaymentTerms {
  const order = [levels.invoice, levels.job, levels.customer, levels.entity];
  const methods = resolvePaymentMethods(
    {
      invoice: levels.invoice?.payment_methods_allowed ?? null,
      job: levels.job?.payment_methods_allowed ?? null,
      customer: levels.customer?.payment_methods_allowed ?? null,
      entity: levels.entity?.payment_methods_allowed ?? null,
    },
    provider,
  );
  return {
    methods,
    online: onlineMethods(methods),
    cardPassThrough: resolveSurchargeEnabled({
      invoice: levels.invoice?.card_surcharge_enabled ?? null,
      job: levels.job?.card_surcharge_enabled ?? null,
      customer: levels.customer?.card_surcharge_enabled ?? null,
      entity: levels.entity?.card_surcharge_enabled ?? null,
    }),
    achPassThrough: firstBool(order.map((l) => l?.ach_surcharge_enabled), false),
  };
}

const COLS = 'payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled';

/** Load every cascade level for one invoice (service-role or RLS client) and resolve. */
export async function loadInvoicePaymentTerms(
  db: SupabaseClient,
  inv: {
    org_id: string;
    location_id: string | null;
    customer_id: string | null;
    job_id?: string | null;
    payment_methods_allowed?: string[] | null;
    card_surcharge_enabled?: boolean | null;
    ach_surcharge_enabled?: boolean | null;
  },
): Promise<PaymentTerms> {
  const level = async (table: 'locations' | 'customers' | 'jobs', id: string | null | undefined): Promise<TermsLevel | null> => {
    if (!id) return null;
    const { data } = await db.schema('core').from(table).select(COLS).eq('org_id', inv.org_id).eq('id', id).maybeSingle<TermsLevel>();
    return data ?? null;
  };
  const [entity, customer, job] = await Promise.all([
    level('locations', inv.location_id),
    level('customers', inv.customer_id),
    level('jobs', inv.job_id ?? null),
  ]);
  return resolvePaymentTerms({
    invoice: {
      payment_methods_allowed: inv.payment_methods_allowed ?? null,
      card_surcharge_enabled: inv.card_surcharge_enabled ?? null,
      ach_surcharge_enabled: inv.ach_surcharge_enabled ?? null,
    },
    job,
    customer,
    entity,
  });
}

/** Company-level toggles as the Payments screen shows them (no inheritance above company). */
export interface CompanyPaymentOptions {
  cardEnabled: boolean;
  achEnabled: boolean;
  checkEnabled: boolean;
  /** 'customer' = passed through as a surcharge; 'company' = absorbed. */
  cardFeePayer: 'customer' | 'company';
  achFeePayer: 'customer' | 'company';
  /** True when the company has never set its own methods (it uses the defaults). */
  usingDefaults: boolean;
}

export function companyPaymentOptions(entity: TermsLevel | null): CompanyPaymentOptions {
  const t = resolvePaymentTerms({ entity });
  return {
    cardEnabled: t.methods.includes('CARD'),
    achEnabled: t.methods.includes('ACH'),
    checkEnabled: t.methods.includes('CHECK'),
    cardFeePayer: t.cardPassThrough ? 'customer' : 'company',
    achFeePayer: t.achPassThrough ? 'customer' : 'company',
    usingDefaults: !(entity?.payment_methods_allowed && entity.payment_methods_allowed.length > 0),
  };
}

/** The company-level columns for a set of toggles (CHECK kept as it was). */
export function companyOptionsToColumns(o: { cardEnabled: boolean; achEnabled: boolean; checkEnabled: boolean; cardFeePayer: 'customer' | 'company'; achFeePayer: 'customer' | 'company' }): Required<TermsLevel> {
  const methods: PaymentMethod[] = [];
  if (o.checkEnabled) methods.push('CHECK');
  if (o.achEnabled) methods.push('ACH');
  if (o.cardEnabled) methods.push('CARD');
  return {
    // Nothing on at all is not a state an invoice can be paid in — keep "mail a check".
    payment_methods_allowed: methods.length > 0 ? methods : ['CHECK'],
    card_surcharge_enabled: o.cardFeePayer === 'customer',
    ach_surcharge_enabled: o.achFeePayer === 'customer',
  };
}
