/**
 * Customers and vendors live on ONE shared master (core.customers / core.vendors; owner ruling
 * 2026-10-21). Merit Projects adds them through pm.create_customer / pm.create_vendor (1108),
 * which write identity and contact only and return the existing row for an exact
 * case-insensitive name match. Merit Books owns terms, credit, tax and compliance. Pure.
 */
import { z } from 'zod';

const optText = (max: number) =>
  z.string().trim().max(max).nullish().transform((s) => (s ? s : null));

const optEmail = z
  .string()
  .trim()
  .max(254)
  .nullish()
  .transform((s) => (s ? s : null))
  .refine((s) => s == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), 'Enter an email like name@company.com');

const Name = z.string().trim().min(1, 'Give it a name').max(200, 'Up to 200 characters');

export const NewCustomerBody = z.object({
  name: Name,
  email: optEmail,
  phone: optText(40),
  companyId: z.string().uuid().nullish().transform((s) => s ?? null),
  contactFirst: optText(100),
  contactLast: optText(100),
});
export type NewCustomer = z.infer<typeof NewCustomerBody>;

export const VENDOR_KINDS = ['SUBCONTRACTOR', 'SUPPLIER', 'OTHER'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];
export const VENDOR_KIND_WORDS: Readonly<Record<VendorKind, string>> = { SUBCONTRACTOR: 'Subcontractor', SUPPLIER: 'Supplier', OTHER: 'Other vendor' };

export const NewVendorBody = z.object({
  name: Name,
  email: optEmail,
  phone: optText(40),
  kind: z.enum(VENDOR_KINDS).default('SUBCONTRACTOR'),
  companyId: z.string().uuid().nullish().transform((s) => s ?? null),
});
export type NewVendor = z.infer<typeof NewVendorBody>;

/** The pm.create_customer argument object (names match the SQL signature). */
export function customerRpcArgs(c: NewCustomer) {
  return {
    p_name: c.name,
    p_email: c.email,
    p_phone: c.phone,
    p_location: c.companyId,
    p_contact_first: c.contactFirst,
    p_contact_last: c.contactLast,
  };
}

/** The pm.create_vendor argument object. */
export function vendorRpcArgs(v: NewVendor) {
  return { p_name: v.name, p_email: v.email, p_phone: v.phone, p_kind: v.kind, p_location: v.companyId };
}

/** A subcontract is with a subcontractor; a PO with a supplier. */
export function vendorKindFor(commitmentType: 'PO' | 'SUBCONTRACT'): VendorKind {
  return commitmentType === 'SUBCONTRACT' ? 'SUBCONTRACTOR' : 'SUPPLIER';
}

/** Shown wherever a vendor is added from Merit Projects. */
export const VENDOR_COMPLIANCE_NOTE = 'Merit Books will request their W-9 and certificate of insurance.';

/** Shown wherever a customer is added from Merit Projects. */
export const CUSTOMER_SHARED_NOTE = 'Added to your customer list, shared with Merit Books. Terms and credit are set there.';

/** True when the typed name already matches a listed option (no "Add" offer then). */
export function sameName(a: string, b: string): boolean {
  const k = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return k(a) === k(b);
}
