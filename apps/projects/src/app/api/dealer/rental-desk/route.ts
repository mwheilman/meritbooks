export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Rental additions (1125): hour / half-day / minimum / accessory rates (DLR-63), availability across
 * stores + maintenance / down blocks + substitutes (DLR-64), contract-out paperwork (DLR-65), the
 * damage RO (DLR-66), cycle billing (DLR-67), fleet PM rules / due list / scheduling into gaps and
 * the re-rent inspection hold (DLR-68).
 */
const Instant = z.string().datetime({ offset: true });
const views = {
  quote: view('dlr_rental_quote', z.object({ unit: Uuid, start: Instant, end: Instant, accessories: z.string().max(400).optional() }),
    (q) => ({ p_unit: q.unit, p_start: q.start, p_end: q.end, p_accessories: q.accessories ? q.accessories.split(',').map((s) => s.trim()).filter(Boolean) : [] })),
  availability: view('dlr_rental_availability', z.object({ company: Uuid, category: Text(60).optional(), start: Instant, end: Instant, allStores: z.enum(['1', '0']).optional() }),
    (q) => ({ p_location: q.company, p_category: q.category || null, p_from: q.start, p_to: q.end, p_all_stores: q.allStores === '1' })),
  substitutes: view('dlr_rental_substitutes', z.object({ contract: Uuid }), (q) => ({ p_contract: q.contract })),
  out_check: view('dlr_rental_out_check', z.object({ contract: Uuid }), (q) => ({ p_contract: q.contract })),
  fleet_due: view('dlr_fleet_due', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'rental', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Check = z.array(z.object({ item: Req(120, 'The item'), ok: z.boolean(), note: Text(300).nullish() })).min(1).max(60);

const ops = {
  rate_ext: op('dlr_set_rate_ext', z.object({ rateId: Uuid, hourCents: PosCents.nullish(), halfDayCents: PosCents.nullish(), minHours: z.number().min(0).max(24).nullish(), minChargeCents: PosCents.nullish(),
    accessories: z.array(z.object({ code: z.string().regex(/^[A-Z0-9_-]{1,16}$/), label: Req(80, 'The label'), day_cents: PosCents })).max(30).default([]),
    fuelRule: z.enum(['FULL_TO_FULL', 'PREPAID', 'METERED']).default('FULL_TO_FULL'), cleaningCents: PosCents.nullish(), rentalClass: Text(40).nullish(), notes: Text(500).nullish() }),
  (b) => ({ p_rate: b.rateId, p_attrs: { hour_cents: b.hourCents ?? null, half_day_cents: b.halfDayCents ?? null, min_hours: b.minHours ?? null, min_charge_cents: b.minChargeCents ?? null,
    accessories: b.accessories, fuel_rule: b.fuelRule, cleaning_cents: b.cleaningCents ?? null, rental_class: b.rentalClass ?? null, notes: b.notes ?? null } })),
  block: op('dlr_block_rental_unit', z.object({ unitId: Uuid, kind: z.enum(['MAINTENANCE', 'DOWN', 'HOLD']), from: Instant, to: Instant, reason: Text(300).nullish(), woId: Uuid.nullish() })
    .refine((b) => Date.parse(b.to) > Date.parse(b.from), { message: 'The block ends before it starts', path: ['to'] }),
  (b) => ({ p_unit: b.unitId, p_kind: b.kind, p_from: b.from, p_to: b.to, p_reason: b.reason ?? null, p_wo: b.woId ?? null })),
  release_block: op('dlr_release_block', z.object({ blockId: Uuid }), (b) => ({ p_block: b.blockId })),
  paperwork: op('dlr_set_rental_paperwork', z.object({
    contractId: Uuid, licenseLast4: z.string().regex(/^[A-Za-z0-9]{2,4}$/).nullish(), licenseState: z.string().regex(/^[A-Z]{2}$/).nullish(), licenseExpiresOn: IsoDate.nullish(), licenseDocumentId: Uuid.nullish(),
    coiDocumentId: Uuid.nullish(), coiExpiresOn: IsoDate.nullish(), cardHoldRef: Text(40).nullish(), cardHoldCents: PosCents.nullish(), waiverChoice: z.enum(['ACCEPTED', 'DECLINED']).nullish(),
    safetyBriefed: z.boolean().nullish(), signerName: Text(120).nullish(), signatureDocumentId: Uuid.nullish(),
  }), (b) => ({ p_contract: b.contractId, p_attrs: { license_last4: b.licenseLast4 ?? null, license_state: b.licenseState ?? null, license_expires_on: b.licenseExpiresOn ?? null,
    license_document_id: b.licenseDocumentId ?? null, coi_document_id: b.coiDocumentId ?? null, coi_expires_on: b.coiExpiresOn ?? null, card_hold_ref: b.cardHoldRef ?? null,
    card_hold_cents: b.cardHoldCents ?? null, waiver_choice: b.waiverChoice ?? null, safety_briefed: b.safetyBriefed ?? null, signer_name: b.signerName ?? null, signature_document_id: b.signatureDocumentId ?? null } })),
  check_out: op('dlr_check_out_rental', z.object({ contractId: Uuid, meterOut: z.number().min(0).max(1e7), conditionOut: Text(1000).nullish() }), (b) => ({ p_contract: b.contractId, p_meter_out: b.meterOut, p_condition_out: b.conditionOut ?? null })),
  clear_rerent: op('dlr_clear_rerent', z.object({ holdId: Uuid, checklist: Check }), (b) => ({ p_hold: b.holdId, p_checklist: b.checklist })),
  pm_rule: op('dlr_save_fleet_pm_rule', z.object({ companyId: Uuid, id: Uuid.nullish(), label: Req(120, 'The label'), model: Text(80).nullish(), category: Text(60).nullish(), assetId: Uuid.nullish(),
    everyHours: z.number().positive().max(100000).nullish(), everyDays: z.number().int().positive().max(3650).nullish(), estHours: z.number().positive().max(200).default(2),
    checklist: z.array(Text(200)).max(60).default([]), isActive: z.boolean().nullish() }).refine((b) => b.everyHours || b.everyDays, { message: 'Set hours or days between services', path: ['everyHours'] }),
  (b) => ({ p_location: b.companyId, p_attrs: { id: b.id ?? null, label: b.label, model: b.model ?? null, category: b.category ?? null, asset_id: b.assetId ?? null, every_hours: b.everyHours ?? null,
    every_days: b.everyDays ?? null, est_hours: b.estHours, checklist: b.checklist, is_active: b.isActive ?? null } })),
  schedule_pm: op('dlr_schedule_fleet_pm', z.object({ unitId: Uuid, ruleId: Uuid, from: Instant, to: Instant, jobId: Uuid.nullish() }), (b) => ({ p_unit: b.unitId, p_rule: b.ruleId, p_from: b.from, p_to: b.to, p_job: b.jobId ?? null })),
  complete_pm: op('dlr_complete_fleet_pm', z.object({ unitId: Uuid, ruleId: Uuid, meter: z.number().min(0).max(1e7).nullish(), woId: Uuid.nullish(), notes: Text(500).nullish() }),
    (b) => ({ p_unit: b.unitId, p_rule: b.ruleId, p_meter: b.meter ?? null, p_wo: b.woId ?? null, p_notes: b.notes ?? null })),
  damage_ro: op('dlr_rental_damage_ro', z.object({ contractId: Uuid, jobId: Uuid.nullish(), chargeRenter: z.boolean().default(true), summary: Text(200).nullish(),
    lines: z.array(z.object({ kind: z.enum(['LABOR', 'PART', 'FEE']).default('LABOR'), description: Req(300, 'The repair'), qty: z.number().positive().max(1e4).default(1), unit_price_cents: PosCents.nullish(), flag_hours: z.number().min(0).max(200).nullish() })).max(30).default([]) }),
  (b) => ({ p_contract: b.contractId, p_attrs: { job_id: b.jobId ?? null, charge_renter: b.chargeRenter, summary: b.summary ?? null, lines: b.lines } })),
  cycle_billing: op('dlr_run_cycle_billing', z.object({ companyId: Uuid, through: Instant.nullish() }), (b) => ({ p_location: b.companyId, p_through: b.through ?? null })),
};

export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'rental', body: deskBody(ops) }, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));
