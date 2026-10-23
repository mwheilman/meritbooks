import { describe, expect, it } from 'vitest';
import { companyOptionsToColumns, companyPaymentOptions, resolvePaymentTerms } from './payment-terms';

describe('payment terms cascade: invoice → job → customer → company (FPB §17.3)', () => {
  it('defaults: check + bank transfer, card off; card fee to customer, ACH fee absorbed', () => {
    expect(resolvePaymentTerms({})).toEqual({ methods: ['CHECK', 'ACH'], online: ['ACH'], cardPassThrough: true, achPassThrough: false });
  });

  it('a company-level "accept cards" switch reaches the invoice', () => {
    const t = resolvePaymentTerms({ entity: { payment_methods_allowed: ['CHECK', 'ACH', 'CARD'] } });
    expect(t.online).toEqual(['ACH', 'CARD']);
  });

  it('most specific wins: a customer that is check-only beats the company', () => {
    const t = resolvePaymentTerms({ customer: { payment_methods_allowed: ['CHECK'] }, entity: { payment_methods_allowed: ['ACH', 'CARD'] } });
    expect(t.online).toEqual([]);
    expect(t.methods).toEqual(['CHECK']);
  });

  it('fee payer resolves per level; invoice overrides company', () => {
    const t = resolvePaymentTerms({
      invoice: { card_surcharge_enabled: false },
      entity: { card_surcharge_enabled: true, ach_surcharge_enabled: true },
    });
    expect(t.cardPassThrough).toBe(false);
    expect(t.achPassThrough).toBe(true);
  });

  it('company options round-trip through the location columns', () => {
    const cols = companyOptionsToColumns({ cardEnabled: true, achEnabled: false, checkEnabled: true, cardFeePayer: 'company', achFeePayer: 'customer' });
    expect(cols).toEqual({ payment_methods_allowed: ['CHECK', 'CARD'], card_surcharge_enabled: false, ach_surcharge_enabled: true });
    expect(companyPaymentOptions(cols)).toMatchObject({ cardEnabled: true, achEnabled: false, checkEnabled: true, cardFeePayer: 'company', achFeePayer: 'customer', usingDefaults: false });
  });

  it('turning everything off keeps "mail a check" so an invoice can still be paid', () => {
    expect(companyOptionsToColumns({ cardEnabled: false, achEnabled: false, checkEnabled: false, cardFeePayer: 'customer', achFeePayer: 'company' }).payment_methods_allowed).toEqual(['CHECK']);
  });

  it('a company that never set methods reports the defaults', () => {
    expect(companyPaymentOptions(null)).toMatchObject({ cardEnabled: false, achEnabled: true, checkEnabled: true, cardFeePayer: 'customer', achFeePayer: 'company', usingDefaults: true });
  });
});
