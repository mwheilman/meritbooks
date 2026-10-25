export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { xrows } from '@/lib/dealer/rpc';
import { validTemplate } from '@/lib/dealer/catalog';
import { CompanyOnlyQ, Text, Uuid } from '@/lib/dealer/schemas';

export interface IntegrationRow {
  id: string;
  provider: 'PARTSMART' | 'PARTSTREAM' | 'OEM_WARRANTY' | 'OEM_REGISTRATION' | 'OEM_PARTS_ORDER';
  brand: string;
  enabled: boolean;
  status: 'NOT_CONNECTED' | 'STUB' | 'PORTAL_ASSIST' | 'CONNECTED';
  config: Record<string, string>;
  updated_at: string;
}

/** Parts catalogs and OEM interfaces for a store. Config holds addresses and dealer numbers only, never a credential. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: false, query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const rows = await xrows<IntegrationRow>(db.schema('pm').from('dlr_integrations').select('id, provider, brand, enabled, status, config, updated_at').eq('location_id', query.company).order('provider').order('brand'), 'integrations');
  return { integrations: rows };
});

const Body = z.object({
  companyId: Uuid,
  provider: z.enum(['PARTSMART', 'PARTSTREAM', 'OEM_WARRANTY']),
  brand: Text(24).default(''),
  enabled: z.boolean(),
  /** PORTAL_ASSIST until an OEM certifies a direct interface (CONNECTED is set by that adapter's onboarding, not here). */
  status: z.enum(['NOT_CONNECTED', 'PORTAL_ASSIST']).default('PORTAL_ASSIST'),
  urlTemplate: Text(500).nullish(),
  dealerNumber: Text(40).nullish(),
  portalUrl: Text(500).nullish(),
});

export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  if (body.urlTemplate && !validTemplate(body.urlTemplate)) throw new HttpError(422, 'Use the catalog’s https address with a lookup token such as {part} or {model}.', 'VALIDATION');
  if (body.portalUrl && !/^https:\/\/\S+$/.test(body.portalUrl)) throw new HttpError(422, 'The portal address must start with https://', 'VALIDATION');
  const config: Record<string, string> = {};
  if (body.urlTemplate) config.url_template = body.urlTemplate;
  if (body.dealerNumber) config.dealer_number = body.dealerNumber;
  if (body.portalUrl) config.portal_url = body.portalUrl;
  const brand = body.provider === 'OEM_WARRANTY' ? body.brand.toUpperCase() : '';
  if (body.provider === 'OEM_WARRANTY' && !brand) throw new HttpError(422, 'Pick the manufacturer.', 'VALIDATION');
  const r = await dwrite<Array<{ id: string }>>(db.schema('pm').from('dlr_integrations').upsert({ location_id: body.companyId, provider: body.provider, brand, enabled: body.enabled, status: body.status, config }, { onConflict: 'org_id,location_id,provider,brand' }).select('id'), 'save integration');
  return { id: r[0]?.id ?? null };
});
