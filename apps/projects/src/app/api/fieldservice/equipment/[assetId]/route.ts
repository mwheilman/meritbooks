import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { fsOwn, fsWrite } from '@/lib/fieldservice/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  equipmentType: z.enum(['AC_CONDENSER', 'HEAT_PUMP', 'FURNACE', 'AIR_HANDLER', 'COIL', 'BOILER', 'MINI_SPLIT', 'PACKAGE_UNIT', 'THERMOSTAT', 'WATER_HEATER', 'TANKLESS_WATER_HEATER', 'WATER_SOFTENER', 'SUMP_PUMP', 'SEWER_LINE', 'PANEL', 'GENERATOR', 'EV_CHARGER', 'IAQ', 'OTHER']).nullish(),
  make: Text(80).nullish(),
  model: Text(80).nullish(),
  serialNumber: Text(80).nullish(),
  tonnage: z.number().min(0).max(500).nullish(),
  btu: z.number().int().min(0).max(100_000_000).nullish(),
  seer2: z.number().min(0).max(60).nullish(),
  hspf2: z.number().min(0).max(30).nullish(),
  afue: z.number().min(0).max(100).nullish(),
  refrigerantType: Text(20).nullish(),
  refrigerantChargeOz: z.number().min(0).max(100000).nullish(),
  fuelType: z.enum(['GAS', 'PROPANE', 'ELECTRIC', 'OIL', 'DUAL', 'OTHER']).nullish(),
  voltage: z.number().int().min(0).max(100000).nullish(),
  phase: z.union([z.literal(1), z.literal(3)]).nullish(),
  manufacturedOn: Day.nullish(),
  installedOn: Day.nullish(),
  partsWarrantyEndsOn: Day.nullish(),
  laborWarrantyEndsOn: Day.nullish(),
  registrationStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'REGISTERED', 'MISSED']).optional(),
  registrationDeadline: Day.nullish(),
  registrationRef: Text(120).nullish(),
  qrCode: Text(80).nullish(),
  locationLabel: Text(80).nullish(),
  installWorkOrderId: Uuid.nullish(),
});

const MAP: Record<string, string> = {
  equipmentType: 'equipment_type', make: 'make', model: 'model', serialNumber: 'serial_number', tonnage: 'tonnage', btu: 'btu', seer2: 'seer2',
  hspf2: 'hspf2', afue: 'afue', refrigerantType: 'refrigerant_type', refrigerantChargeOz: 'refrigerant_charge_oz', fuelType: 'fuel_type',
  voltage: 'voltage', phase: 'phase', manufacturedOn: 'manufactured_on', installedOn: 'installed_on', partsWarrantyEndsOn: 'parts_warranty_ends_on',
  laborWarrantyEndsOn: 'labor_warranty_ends_on', registrationStatus: 'registration_status', registrationDeadline: 'registration_deadline',
  registrationRef: 'registration_ref', qrCode: 'qr_code', locationLabel: 'location_label', installWorkOrderId: 'install_work_order_id',
};

/** Installed-equipment record (FS-36/72/75/76): nameplate fields, warranty layers, OEM registration. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, params, body, tenant }) => {
  const a = await fsOwn<{ id: string; location_id: string }>(db, 'v_assets_masked', 'id, location_id', params.assetId!, 'That equipment was not found.');
  assertCompany(tenant, a.location_id);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined && MAP[k]) patch[MAP[k]!] = v === '' ? null : v;
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  const done = await fsWrite<Array<{ id: string }>>(db.schema('pm').from('assets').update(patch).eq('id', a.id).select('id'), 'update equipment');
  if (!done.length) throw new HttpError(403, 'Updating equipment needs customer edit (office) or store edit at this company. Tell the office what changed.', 'FORBIDDEN');
  return { ok: true };
});
