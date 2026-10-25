import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { fsOwn, fsWrite } from '@/lib/fieldservice/rpc';
import { Instant, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('block'), companyId: Uuid, employeeId: Uuid, kind: z.enum(['PTO', 'TRAINING', 'MEETING', 'SHOP', 'SUPPLY_HOUSE', 'OTHER']), start: Instant, end: Instant, note: Text(200).nullish() }),
  z.object({ op: z.literal('unblock'), id: Uuid }),
  z.object({ op: z.literal('on_call'), companyId: Uuid, employeeId: Uuid, businessUnitId: Uuid.nullish(), role: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY'), start: Instant, end: Instant }),
  z.object({ op: z.literal('off_call'), id: Uuid }),
  z.object({
    op: z.literal('profile'), companyId: Uuid, employeeId: Uuid, displayName: Text(60).nullish(), photoUrl: z.string().url().max(500).nullish(),
    homeZoneId: Uuid.nullish(), zoneIds: z.array(Uuid).max(50).default([]), businessUnitIds: z.array(Uuid).max(20).default([]),
    isDispatchable: z.boolean().default(true), isComfortAdvisor: z.boolean().default(false),
  }),
]);

/**
 * Non-job calendar blocks (PTO / training / meetings / shop — a dispatch over one is refused),
 * the on-call rotation and technician profiles (zones, BUs, the name customers see). FS-16/18.
 */
export const POST = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'block': {
      assertCompany(tenant, body.companyId);
      if (body.end <= body.start) throw new HttpError(422, 'The block ends before it starts.', 'VALIDATION');
      await fsWrite(pm.from('tech_events').insert({ location_id: body.companyId, employee_id: body.employeeId, kind: body.kind, slot: `[${body.start},${body.end})`, note: body.note || null }).select('id'), 'add block');
      return { ok: true };
    }
    case 'unblock': {
      const r = await fsOwn<{ id: string; location_id: string }>(db, 'tech_events', 'id, location_id', body.id, 'That block was not found.');
      assertCompany(tenant, r.location_id);
      await fsWrite(pm.from('tech_events').delete().eq('id', r.id).select('id'), 'remove block');
      return { ok: true };
    }
    case 'on_call': {
      assertCompany(tenant, body.companyId);
      if (body.end <= body.start) throw new HttpError(422, 'The shift ends before it starts.', 'VALIDATION');
      await fsWrite(pm.from('on_call_shifts').insert({ location_id: body.companyId, employee_id: body.employeeId, business_unit_id: body.businessUnitId ?? null, role: body.role, starts_at: body.start, ends_at: body.end }).select('id'), 'add on-call');
      return { ok: true };
    }
    case 'off_call': {
      const r = await fsOwn<{ id: string; location_id: string }>(db, 'on_call_shifts', 'id, location_id', body.id, 'That shift was not found.');
      assertCompany(tenant, r.location_id);
      await fsWrite(pm.from('on_call_shifts').delete().eq('id', r.id).select('id'), 'remove on-call');
      return { ok: true };
    }
    case 'profile': {
      assertCompany(tenant, body.companyId);
      await fsWrite(pm.from('tech_profiles').upsert({
        location_id: body.companyId, employee_id: body.employeeId, display_name: body.displayName || null, photo_url: body.photoUrl || null,
        home_zone_id: body.homeZoneId ?? null, zone_ids: body.zoneIds, business_unit_ids: body.businessUnitIds, is_dispatchable: body.isDispatchable,
        is_comfort_advisor: body.isComfortAdvisor,
      }, { onConflict: 'org_id,employee_id' }).select('id'), 'save technician');
      return { ok: true };
    }
  }
});
