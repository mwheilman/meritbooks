/**
 * Which template an invoice prints with — one resolver for the PDF, the email, the
 * hosted pay page and the design-screen preview.
 *
 * Most specific wins:
 *   1. the invoice's own template_id
 *   2. the customer's assigned template (customer_invoice_settings)
 *   3. the company's default template (location_id = invoice company, is_default)
 *   4. the organization-wide default (location_id null, is_default)
 *   5. the built-in template (Electric Blue, MODERN, standard columns)
 * A template from another company never applies (a stale assignment is skipped).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { BUILT_IN_TEMPLATE, TEMPLATE_SELECT, templateFromRow, type InvoiceTemplate } from './types';
import { applyBrandToTemplate, loadBrand } from '@/lib/branding/resolve';
import type { ResolvedBrand } from '@/lib/branding/types';

export type TemplateSource = 'INVOICE' | 'CUSTOMER' | 'COMPANY_DEFAULT' | 'ORG_DEFAULT' | 'BUILT_IN';

export interface ResolvedTemplate {
  template: InvoiceTemplate;
  source: TemplateSource;
}

export interface TemplateCandidates {
  invoiceTemplateId?: string | null;
  customerTemplateId?: string | null;
  locationId?: string | null;
  /** Every template in the org (or at least those that could apply). */
  templates: InvoiceTemplate[];
}

/** Can a template be used on an invoice of this company? (its own company, or org-wide) */
export function templateAppliesTo(t: InvoiceTemplate, locationId: string | null | undefined): boolean {
  return t.location_id === null || (!!locationId && t.location_id === locationId);
}

/** Pure resolution over already-loaded templates. */
export function pickTemplate(c: TemplateCandidates): ResolvedTemplate {
  const byId = (id: string | null | undefined) =>
    id ? c.templates.find((t) => t.id === id && templateAppliesTo(t, c.locationId)) ?? null : null;

  const inv = byId(c.invoiceTemplateId);
  if (inv) return { template: inv, source: 'INVOICE' };
  const cust = byId(c.customerTemplateId);
  if (cust) return { template: cust, source: 'CUSTOMER' };
  const company = c.locationId
    ? c.templates.find((t) => t.is_default && t.location_id === c.locationId) ?? null
    : null;
  if (company) return { template: company, source: 'COMPANY_DEFAULT' };
  const org = c.templates.find((t) => t.is_default && t.location_id === null) ?? null;
  if (org) return { template: org, source: 'ORG_DEFAULT' };
  return { template: BUILT_IN_TEMPLATE, source: 'BUILT_IN' };
}

/** Load the templates that could apply to a company (its own + org-wide). */
export async function loadCompanyTemplates(
  db: SupabaseClient,
  orgId: string,
  locationId: string | null,
): Promise<InvoiceTemplate[]> {
  let q = db.from('invoice_templates').select(TEMPLATE_SELECT).eq('org_id', orgId);
  q = locationId ? q.or(`location_id.eq.${locationId},location_id.is.null`) : q.is('location_id', null);
  const { data, error } = await q.order('name', { ascending: true });
  if (error) {
    console.error('[invoice templates] load failed', error.message);
    return [];
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(templateFromRow);
}

/** The customer's saved invoice settings (assigned template + default CC list). */
export async function loadCustomerInvoiceSettings(
  db: SupabaseClient,
  orgId: string,
  customerId: string | null,
): Promise<{ template_id: string | null; cc_emails: string[] }> {
  if (!customerId) return { template_id: null, cc_emails: [] };
  const { data } = await db
    .from('customer_invoice_settings')
    .select('template_id, cc_emails')
    .eq('org_id', orgId)
    .eq('customer_id', customerId)
    .maybeSingle();
  const row = data as { template_id: string | null; cc_emails: string[] | null } | null;
  return { template_id: row?.template_id ?? null, cc_emails: row?.cc_emails ?? [] };
}

/**
 * Resolve the template for one invoice (DB-backed), with the company brand applied
 * (FPB-branding §4.3: an inheriting template prints the brand's logo / colour / font).
 */
export async function resolveInvoiceTemplate(
  db: SupabaseClient,
  orgId: string,
  inv: { template_id?: string | null; customer_id?: string | null; location_id?: string | null },
): Promise<ResolvedTemplate & { customerCc: string[]; brand: ResolvedBrand }> {
  const [templates, cust, brand] = await Promise.all([
    loadCompanyTemplates(db, orgId, inv.location_id ?? null),
    loadCustomerInvoiceSettings(db, orgId, inv.customer_id ?? null),
    loadBrand(db, orgId, inv.location_id ?? null),
  ]);
  const resolved = pickTemplate({
    invoiceTemplateId: inv.template_id ?? null,
    customerTemplateId: cust.template_id,
    locationId: inv.location_id ?? null,
    templates,
  });
  return { template: applyBrandToTemplate(resolved.template, brand), source: resolved.source, customerCc: cust.cc_emails, brand };
}

/**
 * The company's branding default (logo / colour / remit-to) for documents that are not
 * an invoice (statements, estimates, 1099 copies). Company default → org default →
 * built-in, with the company brand applied (FPB-branding). Replaces the old one-row-per-company `.maybeSingle()` reads, which break as
 * soon as a company has two templates.
 */
export async function loadBrandTemplate(
  db: SupabaseClient,
  orgId: string,
  locationId: string | null,
): Promise<InvoiceTemplate> {
  const [templates, brand] = await Promise.all([
    loadCompanyTemplates(db, orgId, locationId),
    loadBrand(db, orgId, locationId),
  ]);
  return applyBrandToTemplate(pickTemplate({ locationId, templates }).template, brand);
}
