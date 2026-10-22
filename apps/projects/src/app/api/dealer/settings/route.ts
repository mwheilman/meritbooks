export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall } from '@/lib/pm/dealer/rpc';
import { PayoffGuardZ, Rate, RoleZ, Uuid } from '@/lib/pm/dealer/schemas';

const Roles = z.array(RoleZ).min(1, 'Pick at least one role').max(7);

const Body = z.object({
  companyId: Uuid,
  marginFloorPct: z.number().min(0).max(1).optional(),
  minFrontGrossCents: z.number().int().min(0).max(1e11).optional(),
  deskRoles: Roles.optional(),
  floorOverrideRoles: Roles.optional(),
  payoffGuard: PayoffGuardZ.optional(),
  payoffAckRoles: Roles.optional(),
  unwindRoles: Roles.optional(),
  tradeReducesTaxable: z.boolean().optional(),
  defaultTaxRate: Rate.nullable().optional(),
  unitStockLocationId: Uuid.nullable().optional(),
  partsStockLocationId: Uuid.nullable().optional(),
  allowNegativeParts: z.boolean().optional(),
  deliveryChecklist: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'Lower-case letters, digits and _'),
    label: z.string().trim().min(1, 'Name the step').max(120),
    required: z.boolean(),
  })).max(20).optional(),
});

/** Store rules for one company (pm.set_dealer_settings; operations manager, owner or admin). */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: 'dealer_settings', body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const s: Record<string, unknown> = {};
  const map: Array<[keyof typeof body, string]> = [
    ['marginFloorPct', 'margin_floor_pct'], ['minFrontGrossCents', 'min_front_gross_cents'], ['deskRoles', 'desk_roles'], ['floorOverrideRoles', 'floor_override_roles'],
    ['payoffGuard', 'payoff_guard'], ['payoffAckRoles', 'payoff_ack_roles'], ['unwindRoles', 'unwind_roles'], ['tradeReducesTaxable', 'trade_reduces_taxable'],
    ['defaultTaxRate', 'default_tax_rate'], ['unitStockLocationId', 'unit_stock_location_id'], ['partsStockLocationId', 'parts_stock_location_id'],
    ['allowNegativeParts', 'allow_negative_parts'], ['deliveryChecklist', 'delivery_checklist'],
  ];
  for (const [k, key] of map) if (body[k] !== undefined) s[key] = body[k];
  if (!Object.keys(s).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  if (Array.isArray(s.delivery_checklist) && new Set((s.delivery_checklist as Array<{ key: string }>).map((c) => c.key)).size !== (s.delivery_checklist as unknown[]).length) {
    throw new HttpError(422, 'Each checklist step needs its own key.', 'VALIDATION');
  }
  const saved = await dcall<Record<string, unknown>>(db, 'set_dealer_settings', { p_location: body.companyId, p_settings: s });
  return { ok: true, settings: saved };
});
