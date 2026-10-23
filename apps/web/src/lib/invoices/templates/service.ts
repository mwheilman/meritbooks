/**
 * Invoice template writes. invoice_templates and customer_invoice_settings are
 * SELECT-only for members (migration 176): every write here goes through the service
 * role AFTER the route's permission check, with org_id pinned to the session org and
 * the template's company asserted in the caller's client scope (lib/db/scoped-writer).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertOrgRefs, assertWriteScope, serviceWriter, WriteScopeError } from '@/lib/db/scoped-writer';
import { TEMPLATE_SELECT, templateFromRow, type InvoiceTemplate } from './types';
import { uniqueName, type TemplateBody } from './schema';
import { isTenantLogoUrl, LOGO_URL_ERROR } from './logo-url';

export class TemplateError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface WriteCtx {
  /** The caller's member (RLS) client — used for reads and the client-scope check. */
  caller: SupabaseClient;
  orgId: string;
  userId: string;
  /** Test seam: a service-role stand-in. */
  writer?: SupabaseClient | null;
}

async function loadOwn(ctx: WriteCtx, id: string): Promise<InvoiceTemplate> {
  const { data, error } = await serviceWriter(ctx.writer)
    .from('invoice_templates').select(TEMPLATE_SELECT).eq('org_id', ctx.orgId).eq('id', id).maybeSingle();
  if (error) throw new TemplateError(error.message, 500, 'LOAD_FAILED');
  if (!data) throw new TemplateError('Template not found', 404, 'NOT_FOUND');
  const t = templateFromRow(data as unknown as Record<string, unknown>);
  await assertWriteScope(ctx.caller, ctx.orgId, [t.location_id], { writer: ctx.writer });
  return t;
}

async function namesInScope(ctx: WriteCtx, locationId: string | null, exceptId?: string): Promise<string[]> {
  let q = serviceWriter(ctx.writer).from('invoice_templates').select('id, name').eq('org_id', ctx.orgId);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data } = await q;
  return ((data ?? []) as Array<{ id: string; name: string }>).filter((r) => r.id !== exceptId).map((r) => r.name);
}

function isUnique(err: { code?: string; message?: string } | null, needle: RegExp): boolean {
  return !!err && (err.code === '23505' || /duplicate key/i.test(err.message ?? '')) && needle.test(err.message ?? '');
}

/** A logo must be this org's own upload (never an arbitrary URL the PDF renderer would fetch). */
function assertLogo(orgId: string, logoUrl: string | null | undefined): void {
  if (logoUrl && !isTenantLogoUrl(logoUrl, orgId)) throw new TemplateError(LOGO_URL_ERROR, 422, 'LOGO_URL_NOT_ALLOWED');
}

function rowFromBody(b: Partial<TemplateBody>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = v;
  return out;
}

export async function createTemplate(
  ctx: WriteCtx,
  input: TemplateBody & { location_id: string | null; make_default?: boolean },
): Promise<InvoiceTemplate> {
  assertLogo(ctx.orgId, input.logo_url);
  await assertWriteScope(ctx.caller, ctx.orgId, [input.location_id], { writer: ctx.writer });
  const w = serviceWriter(ctx.writer);
  const taken = await namesInScope(ctx, input.location_id);
  if (taken.some((n) => n.toLowerCase() === input.name.toLowerCase())) {
    throw new TemplateError(`A template called "${input.name}" already exists here.`, 409, 'NAME_TAKEN');
  }
  // The first template in a scope becomes its default automatically.
  const makeDefault = input.make_default === true || taken.length === 0;
  if (makeDefault) await clearDefault(ctx, input.location_id);
  const { make_default: _md, location_id, ...body } = input;
  const { data, error } = await w
    .from('invoice_templates')
    .insert({ ...rowFromBody(body), org_id: ctx.orgId, location_id, is_default: makeDefault, updated_by: ctx.userId })
    .select(TEMPLATE_SELECT)
    .single();
  if (error) {
    if (isUnique(error, /name/)) throw new TemplateError(`A template called "${input.name}" already exists here.`, 409, 'NAME_TAKEN');
    throw new TemplateError(error.message, 500, 'INSERT_FAILED');
  }
  return templateFromRow(data as unknown as Record<string, unknown>);
}

export async function updateTemplate(ctx: WriteCtx, id: string, patch: Partial<TemplateBody>): Promise<InvoiceTemplate> {
  assertLogo(ctx.orgId, patch.logo_url);
  const current = await loadOwn(ctx, id);
  if (patch.name && patch.name.toLowerCase() !== current.name.toLowerCase()) {
    const taken = await namesInScope(ctx, current.location_id, id);
    if (taken.some((n) => n.toLowerCase() === patch.name!.toLowerCase())) {
      throw new TemplateError(`A template called "${patch.name}" already exists here.`, 409, 'NAME_TAKEN');
    }
  }
  const { data, error } = await serviceWriter(ctx.writer)
    .from('invoice_templates')
    .update({ ...rowFromBody(patch), updated_by: ctx.userId, updated_at: new Date().toISOString() })
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .select(TEMPLATE_SELECT)
    .single();
  if (error) throw new TemplateError(error.message, 500, 'UPDATE_FAILED');
  return templateFromRow(data as unknown as Record<string, unknown>);
}

async function clearDefault(ctx: WriteCtx, locationId: string | null): Promise<void> {
  let q = serviceWriter(ctx.writer).from('invoice_templates').update({ is_default: false }).eq('org_id', ctx.orgId).eq('is_default', true);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { error } = await q;
  if (error) throw new TemplateError(error.message, 500, 'UPDATE_FAILED');
}

/** Make a template the default for its company (or for the organization). */
export async function setDefaultTemplate(ctx: WriteCtx, id: string): Promise<InvoiceTemplate> {
  const t = await loadOwn(ctx, id);
  if (t.is_default) return t;
  await clearDefault(ctx, t.location_id);
  const { data, error } = await serviceWriter(ctx.writer)
    .from('invoice_templates')
    .update({ is_default: true, updated_by: ctx.userId, updated_at: new Date().toISOString() })
    .eq('org_id', ctx.orgId).eq('id', id)
    .select(TEMPLATE_SELECT).single();
  if (error) throw new TemplateError(error.message, 500, 'UPDATE_FAILED');
  return templateFromRow(data as unknown as Record<string, unknown>);
}

export async function duplicateTemplate(ctx: WriteCtx, id: string, targetLocationId?: string | null): Promise<InvoiceTemplate> {
  const src = await loadOwn(ctx, id);
  const loc = targetLocationId === undefined ? src.location_id : targetLocationId;
  if (loc !== src.location_id) await assertWriteScope(ctx.caller, ctx.orgId, [loc], { writer: ctx.writer });
  const name = uniqueName(`Copy of ${src.name}`, await namesInScope(ctx, loc));
  const { id: _i, org_id: _o, location_id: _l, is_default: _d, updated_at: _u, ...body } = src;
  return createTemplate(ctx, { ...body, name, location_id: loc, make_default: false });
}

/**
 * Delete a template. The default can't be deleted (make another the default first).
 * Invoices / customers that pointed at it fall back to the company default (FK set null).
 */
export async function deleteTemplate(ctx: WriteCtx, id: string): Promise<{ invoices: number; customers: number }> {
  const t = await loadOwn(ctx, id);
  if (t.is_default) {
    throw new TemplateError('This is the default template. Make another template the default first.', 409, 'IS_DEFAULT');
  }
  const w = serviceWriter(ctx.writer);
  const [{ count: invCount }, { count: custCount }] = await Promise.all([
    w.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId).eq('template_id', id),
    w.from('customer_invoice_settings').select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId).eq('template_id', id),
  ]);
  const { error } = await w.from('invoice_templates').delete().eq('org_id', ctx.orgId).eq('id', id);
  if (error) throw new TemplateError(error.message, 500, 'DELETE_FAILED');
  return { invoices: invCount ?? 0, customers: custCount ?? 0 };
}

/** Assign a template (or none = company default) and a default CC list to one customer. */
export async function setCustomerInvoiceSettings(
  ctx: WriteCtx,
  customerId: string,
  input: { template_id: string | null; cc_emails: string[] },
): Promise<{ template_id: string | null; cc_emails: string[] }> {
  await assertOrgRefs(ctx.orgId, [{ schema: 'core', table: 'customers', ids: [customerId], label: 'customer' }], { writer: ctx.writer });
  // The template must be this org's (and in the caller's scope). A customer may be billed
  // from several companies; a company-specific template only prints on that company's
  // invoices (resolve.ts skips it elsewhere).
  if (input.template_id) await loadOwn(ctx, input.template_id);
  const { data, error } = await serviceWriter(ctx.writer)
    .from('customer_invoice_settings')
    .upsert({
      org_id: ctx.orgId,
      customer_id: customerId,
      template_id: input.template_id,
      cc_emails: input.cc_emails,
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,customer_id' })
    .select('template_id, cc_emails')
    .single();
  if (error) throw new TemplateError(error.message, 500, 'SAVE_FAILED');
  const row = data as { template_id: string | null; cc_emails: string[] | null };
  return { template_id: row.template_id, cc_emails: row.cc_emails ?? [] };
}

export function templateErrorResponse(e: unknown): { status: number; body: { error: string; code: string } } | null {
  if (e instanceof TemplateError) return { status: e.status, body: { error: e.message, code: e.code } };
  if (e instanceof WriteScopeError) return { status: 403, body: { error: e.message, code: 'FORBIDDEN_SCOPE' } };
  return null;
}
