import { z } from 'zod';
import { Day, Text, Uuid } from './schemas';

/** Editable identity columns of pm.assets (1104 column grants). */
export const AssetFields = z.object({
  kind: z.enum(['CUSTOMER_EQUIPMENT', 'DEALER_UNIT', 'RENTAL_UNIT', 'COMPANY_EQUIPMENT']).default('CUSTOMER_EQUIPMENT'),
  customerId: Uuid.nullish(),
  serialNumber: Text(80).nullish(),
  make: Text(80).nullish(),
  model: Text(80).nullish(),
  modelYear: z.number().int().min(1900).max(2200).nullish(),
  description: Text(300).nullish(),
  siteLabel: Text(120).nullish(),
  siteAddress: Text(200).nullish(),
  siteCity: Text(80).nullish(),
  siteState: Text(40).nullish(),
  siteZip: Text(20).nullish(),
  installedOn: Day.nullish(),
  warrantyExpiresOn: Day.nullish(),
});

export function assetColumns(b: Partial<z.infer<typeof AssetFields>>): Record<string, unknown> {
  const map: Array<[keyof z.infer<typeof AssetFields>, string]> = [
    ['kind', 'kind'], ['customerId', 'customer_id'], ['serialNumber', 'serial_number'], ['make', 'make'], ['model', 'model'],
    ['modelYear', 'model_year'], ['description', 'description'], ['siteLabel', 'site_label'], ['siteAddress', 'site_address_line1'],
    ['siteCity', 'site_city'], ['siteState', 'site_state'], ['siteZip', 'site_zip'], ['installedOn', 'installed_on'], ['warrantyExpiresOn', 'warranty_expires_on'],
  ];
  const out: Record<string, unknown> = {};
  for (const [k, col] of map) if (b[k] !== undefined) out[col] = b[k] === '' ? null : b[k];
  return out;
}

